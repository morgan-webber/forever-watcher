/**
 * One collection run: fetch every house, update history and sales estimates, score
 * opportunities, evaluate the backtest, send alerts, and write the public data.
 */
import path from "node:path";
import { readJson, writeJson } from "./store.js";
import { groupHouses, parseHouseIndex } from "./houses.js";
import { summarise, ladderize, statsOf, baseId } from "./summarise.js";
import { diffLifecycle } from "./lifecycle.js";
import { emptyHistory, recordSnapshot, recordSales, recordTracking, prune } from "./history.js";
import { backfillItems } from "./items.js";
import { findOpportunities } from "./opportunities.js";
import { logOpportunities, evaluate, summarise as summariseBacktest } from "./backtest.js";
import { collectAlerts, postDiscord } from "./alerts.js";
import { publish } from "./publish.js";

export async function collect({ client, config, stateDir, outDir, nowMs = Date.now(), log = console.log, discordWebhook, siteUrl, demo = false, fetchImpl, skipItems = false, skipPublish = false }) {
  const { settings, fees, alerts: alertConfig } = config;
  const S = (...p) => path.join(stateDir, ...p);
  const meta = await readJson(S("meta.json"), { houses: {}, lastScan: {}, housesCheckedAt: {} });
  const items = await readJson(S("items.json.gz"), {});
  const btLog = await readJson(S("backtest.json.gz"), []);
  const sent = await readJson(S("alerts-sent.json"), {});
  const regions = {};
  const current = {};
  const allOpps = [];
  const stats = { fetched: 0, unchanged: 0, failed: 0 };

  for (const [region, rc] of Object.entries(settings.regions)) {
    log(`[${region}]`);
    // 1. House list, refreshed daily.
    let houses = meta.houses[region];
    if (!houses?.length || nowMs - (meta.housesCheckedAt[region] ?? 0) > 86_400_000) {
      try {
        const r = await client.get(region, `/data/wow/ruleset/${settings.listRuleset}/auctions/`, "dynamic-forever", { locale: rc.locale });
        const list = parseHouseIndex(r.json);
        if (list.length) {
          const next = groupHouses(list, settings.groupNames?.[region]);
          if (houses?.length && next.map((h) => h.id).join() !== houses.map((h) => h.id).join()) log(`  house list changed: ${next.map((h) => h.id).join(",")}`);
          houses = next;
          meta.houses[region] = houses;
          meta.housesCheckedAt[region] = nowMs;
        }
      } catch (e) {
        log(`  house index failed: ${e.message}`);
      }
    }
    if (!houses?.length) {
      log("  no houses known, skipping region");
      continue;
    }
    houses = houses.map((h) => ({ ...h, groupName: settings.groupNames?.[region]?.[h.group] ?? h.groupName }));
    meta.houses[region] = houses;

    const hists = new Map();
    const houseData = [];
    current[region] = new Map();

    // 2. Each house in the focus groups (settings.focusGroups; empty = all groups).
    const focus = settings.focusGroups?.[region] ?? [];
    for (const house of houses.filter((h) => !focus.length || focus.includes(h.group))) {
      const tag = `${region}-${house.id}`;
      const scan = (meta.lastScan[tag] ??= {});
      const hist = await readJson(S("hist", `${tag}.json.gz`), emptyHistory());
      const liveState = await readJson(S("live", `${tag}.json.gz`), { t: null, live: {} });
      const base = `/data/wow/ruleset/${settings.listRuleset}/auctions/${house.id}`;
      try {
        let a = await client.get(region, base, "dynamic-forever", { ifModifiedSince: scan.lmA });
        let c = await client.get(region, `${base}/commodities`, "dynamic-forever", { ifModifiedSince: scan.lmC });
        if (a.status === 304 && c.status === 304) {
          stats.unchanged++;
        } else {
          if (a.status === 304) a = await client.get(region, base, "dynamic-forever");
          if (c.status === 304) c = await client.get(region, `${base}/commodities`, "dynamic-forever");
          const raw = [...(a.json?.auctions ?? []), ...(Array.isArray(a.json?.commodities) ? a.json.commodities : []), ...(c.json?.auctions ?? [])];
          const sum = summarise(raw);
          const gapH = liveState.t ? (nowMs - liveState.t) / 3_600_000 : null;
          const gapOk = gapH != null && gapH <= settings.gapHours;
          const diff = diffLifecycle(liveState.live, sum.live, { gapOk });
          recordSnapshot(hist, nowMs, sum.stats, settings.hourlyKeepHours);
          if (gapOk) {
            recordSales(hist, nowMs, diff.sold, diff.expired);
            recordTracking(hist, nowMs, gapH);
          }
          prune(hist, nowMs, settings.dailyKeepDays);
          liveState.t = nowMs;
          liveState.live = diff.next;
          scan.lmA = a.lastModified ?? undefined;
          scan.lmC = c.lastModified ?? undefined;
          scan.t = nowMs;
          scan.listings = sum.listings;
          await writeJson(S("hist", `${tag}.json.gz`), hist);
          await writeJson(S("live", `${tag}.json.gz`), liveState);
          stats.fetched++;
          const soldQty = [...diff.sold.values()].reduce((s, x) => s + x.qty, 0);
          log(`  ${house.id} ${house.name}: ${sum.listings} listings, ${sum.stats.size} items${gapOk ? `, ~${soldQty} units sold since last scan` : ", sales not classified (first scan or gap)"}`);
        }
      } catch (e) {
        stats.failed++;
        log(`  ${house.id} failed: ${e.message}`);
      }
      // Ladders from the live state, so unchanged houses still take part in scoring.
      const ladders = ladderize(Object.values(liveState.live));
      const st = statsOf(ladders);
      current[region].set(house.id, st);
      hists.set(house.id, hist);
      houseData.push({ house: { ...house, lastScan: scan.t ?? null, listings: scan.listings ?? 0 }, ladders, stats: st, hist });
    }

    // 3. Item metadata.
    if (!skipItems) {
      const ids = new Set();
      for (const h of houseData) for (const k of h.stats.keys()) ids.add(baseId(k));
      await backfillItems(client, items, [...ids], { region, locale: rc.locale, limit: settings.itemBackfillPerRun, now: nowMs, log });
    }

    // 4. Opportunities.
    const opps = findOpportunities(region, houseData, items, settings, fees, nowMs);
    log(`  ${opps.length} opportunities (${["flip", "vendor", "arbitrage"].map((t) => `${opps.filter((o) => o.type === t).length} ${t}`).join(", ")})`);
    allOpps.push(...opps);
    regions[region] = { houses: houseData.map((h) => h.house), allHouses: houses, hists, opps, focus };
  }

  // 5. Backtest.
  logOpportunities(btLog, allOpps, nowMs);
  evaluate(btLog, (region, hid) => regions[region]?.hists.get(hid), nowMs, settings);
  const backtest = summariseBacktest(btLog);

  // 6. Alerts.
  const houseName = (region, hid) => meta.houses[region]?.find((h) => h.id === hid)?.name ?? `House ${hid}`;
  const messages = collectAlerts({ config: alertConfig, opps: allOpps.sort((a, b) => b.ev - a.ev), current, items, houseName, sent, nowMs, siteUrl });
  if (messages.length && discordWebhook) {
    const posts = await postDiscord(discordWebhook, messages, { fetchImpl, log });
    log(`alerts: ${messages.length} sent in ${posts} Discord post(s)`);
  } else if (messages.length) log(`alerts: ${messages.length} triggered (no DISCORD_WEBHOOK_URL set)`);

  // 7. Save state, publish.
  await writeJson(S("meta.json"), meta);
  await writeJson(S("items.json.gz"), items);
  await writeJson(S("backtest.json.gz"), btLog);
  await writeJson(S("alerts-sent.json"), sent);
  if (!skipPublish) await publish({ outDir, regions, items, settings, fees, backtest, nowMs, demo });
  log(`done: ${stats.fetched} houses updated, ${stats.unchanged} unchanged, ${stats.failed} failed, ${client.callCount?.() ?? "?"} API calls`);
  return { stats, opps: allOpps, backtest, messages };
}
