/**
 * One collection run: fetch every house, update history and sales estimates, score
 * opportunities, evaluate the backtest, send alerts, and write the public data.
 */
import path from "node:path";
import { readJson, writeJson } from "./store.js";
import { groupHouses, parseHouseIndex, canTrade } from "./houses.js";
import { summarise, ladderize, statsOf, baseId } from "./summarise.js";
import { diffLifecycle } from "./lifecycle.js";
import { emptyHistory, recordSnapshot, recordSales, recordTracking, prune, clearSales } from "./history.js";
import { backfillItems } from "./items.js";
import { findOpportunities } from "./opportunities.js";
import { refreshRecipes, refreshClientItems, cleanCatalog } from "./catalog.js";
import { findCrafts, findDisenchants, resolveVendorIds } from "./crafting.js";
import { findSpeculation, logSpeculation, evaluateSpeculation } from "./speculation.js";
import { logOpportunities, evaluate, summarise as summariseBacktest } from "./backtest.js";
import { collectAlerts, postDiscord } from "./alerts.js";
import { publish } from "./publish.js";

/** One line per house in the GitHub Actions run summary (visible in the Actions tab). */
function note(tag, msg, level = "notice") {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=${tag}::${msg}`);
}

/** Cheap fingerprint of a snapshot: count, id sum and quantity sum. */
function fingerprint(raw) {
  let ids = 0;
  let qty = 0;
  for (const a of raw) {
    ids = (ids + Number(a.id ?? 0)) % 1e15;
    qty += Number(a.quantity ?? 1);
  }
  return `${raw.length}:${ids}:${qty}`;
}

const defaultFetchText = async (url) => {
  const r = await fetch(url, { headers: { "User-Agent": "forever-watcher (github.com/morgan-webber/forever-watcher)" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
};

export async function collect({ client, config, stateDir, outDir, nowMs = Date.now(), log = console.log, discordWebhook, siteUrl, demo = false, fetchImpl, fetchText = defaultFetchText, skipItems = false, skipPublish = false, skipCatalog = false }) {
  const { settings, fees, alerts: alertConfig, vendorReagents } = config;
  const S = (...p) => path.join(stateDir, ...p);
  const meta = await readJson(S("meta.json"), { houses: {}, lastScan: {}, housesCheckedAt: {} });
  const items = await readJson(S("items.json.gz"), {});
  const btLog = await readJson(S("backtest.json.gz"), []);
  const sent = await readJson(S("alerts-sent.json"), {});
  const specLog = await readJson(S("spec-log.json.gz"), []);
  const regions = {};
  const current = {};
  const allOpps = [];
  const allSpec = [];
  const stats = { fetched: 0, unchanged: 0, failed: 0 };
  // Sales model version: when the way sales are estimated changes, recorded sales are cleared so
  // averages don't mix the old and new estimates. Prices are kept.
  const SALES_MODEL = 2;
  const resetSales = (meta.salesModel ?? 1) !== SALES_MODEL;
  meta.salesModel = SALES_MODEL;

  // Catalog: Forever client item table (fallback item data) and Blizzard recipes.
  let clientItems = await readJson(S("client-items.json.gz"), null);
  let catalog = await readJson(S("catalog.json.gz"), null);
  if (!skipCatalog) {
    const firstRegion = Object.keys(settings.regions)[0];
    const ci = await refreshClientItems(clientItems, { fetchText, now: nowMs, log });
    if (ci !== clientItems) await writeJson(S("client-items.json.gz"), (clientItems = ci));
    const cat = await refreshRecipes(client, catalog, { region: firstRegion, locale: settings.regions[firstRegion].locale, now: nowMs, log });
    if (cat !== catalog) await writeJson(S("catalog.json.gz"), (catalog = cat));
  }
  catalog = cleanCatalog(catalog);
  const recipeItemIds = new Set();
  for (const r of catalog?.recipes ?? []) {
    if (r[4]) recipeItemIds.add(r[4]);
    for (const [id] of r[7]) recipeItemIds.add(id);
  }

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
      if (resetSales) {
        clearSales(hist);
        await writeJson(S("hist", `${tag}.json.gz`), hist);
        note(tag, "sales history cleared for the new sales model; prices kept");
      }
      const liveState = await readJson(S("live", `${tag}.json.gz`), { t: null, live: {} });
      const base = `/data/wow/ruleset/${settings.listRuleset}/auctions/${house.id}`;
      try {
        // Conditional requests save downloads, but a "not modified" answer is never trusted for
        // more than ~70 minutes: then both endpoints are fetched in full and a fingerprint of the
        // listings decides whether anything actually changed.
        const stale = !scan.full || nowMs - scan.full > 70 * 60_000;
        let a = await client.get(region, base, "dynamic-forever", { ifModifiedSince: stale ? undefined : scan.lmA });
        let c = await client.get(region, `${base}/commodities`, "dynamic-forever", { ifModifiedSince: stale ? undefined : scan.lmC });
        if (a.status === 304 && c.status === 304) {
          stats.unchanged++;
          note(tag, `not modified since ${scan.lmA ?? "?"} (full check ${Math.round((nowMs - scan.full) / 60000)} min ago)`);
        } else {
          if (a.status === 304) a = await client.get(region, base, "dynamic-forever");
          if (c.status === 304) c = await client.get(region, `${base}/commodities`, "dynamic-forever");
          scan.full = nowMs;
          const raw = [...(a.json?.auctions ?? []), ...(Array.isArray(a.json?.commodities) ? a.json.commodities : []), ...(c.json?.auctions ?? [])];
          const sig = fingerprint(raw);
          // Blizzard's data time: the newer Last-Modified of the two endpoints (else now).
          const dataT = Math.max(Date.parse(a.lastModified ?? "") || 0, Date.parse(c.lastModified ?? "") || 0) || nowMs;
          scan.lmA = a.lastModified ?? undefined;
          scan.lmC = c.lastModified ?? undefined;
          if (sig === scan.sig) {
            stats.unchanged++;
            note(tag, `downloaded, listings identical to the last snapshot (Blizzard data time ${new Date(dataT).toISOString()})`);
          } else {
            const sum = summarise(raw);
            // Sales are classified between consecutive snapshots; the gap is measured in Blizzard's
            // data time when it advances, else in our clock.
            const prevT = liveState.dataT ?? liveState.t;
            const curT = dataT > (liveState.dataT ?? 0) ? dataT : nowMs;
            const gapH = prevT ? (curT - prevT) / 3_600_000 : null;
            const gapOk = gapH != null && gapH > 0 && gapH <= settings.gapHours;
            const diff = diffLifecycle(liveState.live, sum.live, { gapOk });
            recordSnapshot(hist, nowMs, sum.stats, settings.hourlyKeepHours);
            if (gapOk) {
              recordSales(hist, nowMs, diff.sold, diff.expired, diff.posted);
              recordTracking(hist, nowMs, gapH);
            }
            prune(hist, nowMs, settings.dailyKeepDays);
            liveState.t = nowMs;
            liveState.dataT = curT;
            liveState.live = diff.next;
            scan.t = nowMs;
            scan.dataT = dataT;
            scan.sig = sig;
            scan.listings = sum.listings;
            await writeJson(S("hist", `${tag}.json.gz`), hist);
            await writeJson(S("live", `${tag}.json.gz`), liveState);
            stats.fetched++;
            const soldQty = [...diff.sold.values()].reduce((s, x) => s + x.qty, 0);
            log(`  ${house.id} ${house.name}: ${sum.listings} listings, ${sum.stats.size} items${gapOk ? `, ~${soldQty} units sold since last scan` : ", sales not classified (first scan or gap)"}`);
            note(tag, `new data: ${sum.listings} listings, Blizzard data time ${new Date(dataT).toISOString()}${gapOk ? `, ~${soldQty} units sold, ${diff.reposted} reposts ignored` : ""}`);
          }
        }
      } catch (e) {
        stats.failed++;
        log(`  ${house.id} failed: ${e.message}`);
        note(tag, `FAILED: ${e.message}`, "warning");
      }
      // Ladders from the live state, so unchanged houses still take part in scoring.
      const ladders = ladderize(Object.values(liveState.live));
      const st = statsOf(ladders);
      current[region].set(house.id, st);
      hists.set(house.id, hist);
      houseData.push({ house: { ...house, lastScan: scan.t ?? null, dataTime: scan.dataT ?? null, checked: scan.full ?? null, listings: scan.listings ?? 0 }, ladders, stats: st, hist });
    }

    // 3. Item metadata.
    if (!skipItems) {
      const ids = new Set();
      for (const h of houseData) for (const k of h.stats.keys()) ids.add(baseId(k));
      for (const id of recipeItemIds) ids.add(id);
      await backfillItems(client, items, [...ids], { region, locale: rc.locale, limit: settings.itemBackfillPerRun, now: nowMs, log, clientItems: clientItems?.items });
    }

    // 4. Opportunities: market trades, crafting and disenchanting.
    const vendorIds = resolveVendorIds(items, vendorReagents?.names);
    const opps = [
      ...findOpportunities(region, houseData, items, settings, fees, nowMs),
      ...findCrafts(region, houseData, items, catalog, settings, fees, nowMs, vendorIds),
      ...findDisenchants(region, houseData, items, settings, fees, nowMs),
    ].sort((a, b) => b.ev - a.ev).slice(0, settings.maxOppsPerRegion);
    log(`  ${opps.length} opportunities (${["flip", "vendor", "arbitrage", "craft", "disenchant"].map((t) => `${opps.filter((o) => o.type === t).length} ${t}`).join(", ")})`);
    allOpps.push(...opps);

    // Speculation watch.
    const spec = findSpeculation(houseData, nowMs, settings, { minScore: settings.specMinScore ?? 40 });
    logSpeculation(specLog, region, spec, nowMs);
    log(`  ${spec.length} speculation signals (${spec.filter((s) => s.score >= 70).length} strong)`);
    allSpec.push(...spec.map((s) => ({ ...s, region })));
    regions[region] = { houses: houseData.map((h) => h.house), allHouses: houses, hists, opps, focus, ladders: new Map(houseData.map((h) => [h.house.id, h.ladders])), houseData, vendorIds, spec };
  }

  // Tell the workflow when Blizzard publishes, so the next run can wake just after it.
  const dataTimes = Object.values(meta.lastScan).map((s) => s.dataT).filter((t) => t && nowMs - t < 3 * 3_600_000);
  if (dataTimes.length && process.env.GITHUB_OUTPUT) {
    const newest = new Date(Math.max(...dataTimes));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_OUTPUT, `wake_minute=${(newest.getUTCMinutes() + 6) % 60}\n`);
    log(`Blizzard's newest snapshot: ${newest.toISOString()}; next run wakes at :${String((newest.getUTCMinutes() + 6) % 60).padStart(2, "0")}`);
  }

  // 5. Backtest. Drop any logged arbitrage between the Alliance and Horde houses (not a real trade;
  // logged before that route was excluded).
  for (let i = btLog.length - 1; i >= 0; i--) {
    const e = btLog[i];
    if (e.type !== "arbitrage") continue;
    const hb = meta.houses[e.region]?.find((h) => h.id === e.buy);
    const hs = meta.houses[e.region]?.find((h) => h.id === e.sell);
    if (hb && hs && !canTrade(hb, hs)) btLog.splice(i, 1);
  }
  logOpportunities(btLog, allOpps, nowMs);
  evaluate(btLog, (region, hid) => regions[region]?.hists.get(hid), nowMs, settings);
  const backtest = summariseBacktest(btLog);
  backtest.speculation = evaluateSpeculation(specLog, (region, hid) => regions[region]?.hists.get(hid), nowMs);

  // 6. Alerts.
  const houseName = (region, hid) => meta.houses[region]?.find((h) => h.id === hid)?.name ?? `House ${hid}`;
  const messages = collectAlerts({ config: alertConfig, opps: allOpps.sort((a, b) => b.ev - a.ev), spec: allSpec, current, items, houseName, sent, nowMs, siteUrl });
  if (messages.length && discordWebhook) {
    const posts = await postDiscord(discordWebhook, messages, { fetchImpl, log });
    log(`alerts: ${messages.length} sent in ${posts} Discord post(s)`);
  } else if (messages.length) log(`alerts: ${messages.length} triggered (no DISCORD_WEBHOOK_URL set)`);

  // 7. Save state, publish.
  await writeJson(S("meta.json"), meta);
  await writeJson(S("items.json.gz"), items);
  await writeJson(S("backtest.json.gz"), btLog);
  await writeJson(S("alerts-sent.json"), sent);
  await writeJson(S("spec-log.json.gz"), specLog);
  if (!skipPublish) await publish({ outDir, regions, items, settings, fees, backtest, nowMs, demo, catalog });
  log(`done: ${stats.fetched} houses updated, ${stats.unchanged} unchanged, ${stats.failed} failed, ${client.callCount?.() ?? "?"} API calls`);
  return { stats, opps: allOpps, backtest, messages };
}
