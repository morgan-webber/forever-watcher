/**
 * Writes the static JSON the site reads, under <out>/data/.
 *   meta.json                          houses, scan times, fees, backtest, generation time
 *   opps-<region>.json                 ranked opportunities (with item names for display)
 *   index-<region>.json                [baseId, name, quality, icon, class, vendor, variants] for search
 *   houses/<region>-<id>.json          current market table for one house
 *   items/<region>/<baseId>.json       history + metrics + current listing ladder per variant per house
 *   market-<region>.json               every listed item: current prices per house, trends, sparkline
 *   pulse-<region>.json                market-wide activity per house over time
 *   recipes-<region>.json              every recipe priced per house (reagent cost, product value, profit)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { metrics, H, D, toHour, toDay } from "./history.js";
import { baseId } from "./summarise.js";
import { recipeTable, nameIndex } from "./crafting.js";
import { deValue, DE_SOURCE } from "./disenchant.js";

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

export async function publish({ outDir, regions, items, settings, fees, backtest, nowMs, demo, catalog }) {
  const dataDir = path.join(outDir, "data");
  await fs.rm(dataDir, { recursive: true, force: true });
  const nowHour = toHour(nowMs);
  const meta = { generatedAt: new Date(nowMs).toISOString(), demo: !!demo, fees, settings: pick(settings), backtest, regions: {}, catalog: catalog ? { build: catalog.build, recipes: catalog.recipes.length, fetchedAt: catalog.fetchedAt } : null, deSource: DE_SOURCE };
  const byName = nameIndex(items);

  for (const [region, R] of Object.entries(regions)) {
    const keys = new Set();
    for (const hist of R.hists.values()) for (const k of Object.keys(hist.items)) keys.add(k);
    const itemName = (key) => items[baseId(key)]?.n ?? `Item ${baseId(key)}`;

    meta.regions[region] = {
      houses: R.houses.map((h) => ({ ...h, items: Object.keys(R.hists.get(h.id)?.items ?? {}).length })),
      allHouses: R.allHouses,
      focus: R.focus ?? [],
      items: new Set([...keys].map(baseId)).size,
    };

    // Search index.
    const variants = new Map();
    for (const k of keys) variants.set(baseId(k), (variants.get(baseId(k)) ?? 0) + 1);
    const index = [...variants].map(([id, nv]) => {
      const m = items[id];
      return [String(id), m?.n ?? `Item ${id}`, m?.q ?? "COMMON", m?.icon ?? null, m?.c ?? null, m?.src === "forever" ? m.sell ?? 0 : null, nv];
    });
    await write(path.join(dataDir, `index-${region}.json`), index);

    // Opportunities.
    const opps = (R.opps ?? []).map((o) => ({ ...o, roi: r3(o.roi), days: r3(o.days), p: r3(o.p), soldPerDay: r3(o.soldPerDay), name: itemName(o.key), q: items[baseId(o.key)]?.q ?? "COMMON", icon: items[baseId(o.key)]?.icon ?? null }));
    await write(path.join(dataDir, `opps-${region}.json`), opps);

    // Per-house market tables and per-item files.
    const perItem = new Map();
    for (const h of R.houses) {
      const hist = R.hists.get(h.id);
      if (!hist) continue;
      const rows = [];
      for (const [key, e] of Object.entries(hist.items)) {
        const m = metrics(hist, key, nowMs, settings);
        const last = e.h.at(-1);
        const listed = last && last[H.HOUR] >= nowHour - 2;
        if (listed) rows.push([key, last[H.MIN], last[H.MV], last[H.QTY], last[H.N], m?.baseline ?? null, r3(m?.soldPerDay), r3(m?.sellThrough), r3(m?.chg24)]);
        const b = baseId(key);
        if (!perItem.has(b)) perItem.set(b, {});
        const vmap = perItem.get(b);
        vmap[key] ??= {};
        vmap[key][h.id] = {
          h: e.h,
          d: e.d,
          l: listed ? (R.ladders?.get(h.id)?.get(key) ?? []).slice(0, 40) : [],
          m: m && { baseline: m.baseline, soldPerDay: r3(m.soldPerDay), sellThrough: r3(m.sellThrough), cv: r3(m.cv), chg24: r3(m.chg24), historyDays: m.historyDays, listed },
        };
      }
      await write(path.join(dataDir, "houses", `${region}-${h.id}.json`), { house: h, rows });
    }
    const { market, pulse, span } = buildMarket(R, nowMs, settings);
    await write(path.join(dataDir, `market-${region}.json`), { houses: R.houses.map((h) => h.id), rows: market });
    await write(path.join(dataDir, `pulse-${region}.json`), pulse);
    meta.regions[region].historyHours = span.hours;
    meta.regions[region].trackedHours = span.tracked;

    // Recipes priced per house.
    if (catalog?.recipes?.length && R.houseData) {
      const rows = recipeTable(R.houseData, items, catalog, settings, fees, nowMs, R.vendorIds ?? new Set());
      const ids = new Set();
      for (const r of rows) {
        if (r[4]) ids.add(r[4]);
        for (const [id] of r[6]) ids.add(id);
      }
      const names = Object.fromEntries([...ids].map((id) => [id, [items[id]?.n ?? null, items[id]?.q ?? null, items[id]?.icon ?? null, (R.vendorIds?.has(id) ? items[id]?.buy : null) ?? null]]));
      await write(path.join(dataDir, `recipes-${region}.json`), { houses: R.houses.map((h) => h.id), professions: catalog.professions, names, rows });
    }

    // Disenchant breakdown per house for disenchantable items (Classic odds).
    const cut = fees.cutRate ?? 0.05;
    const deFor = (b) => {
      const m = items[b];
      if (!m?.lvl || !R.houseData) return null;
      const houses = {};
      let outs = null;
      for (const hd of R.houseData) {
        const priceOf = (name) => {
          const id = byName.get(name.toLowerCase());
          return id ? hd.stats.get(String(id))?.mv ?? null : null;
        };
        const v = deValue(m, priceOf, cut);
        if (!v) return null;
        outs = v.parts.map((p) => [byName.get(p.name.toLowerCase()) ?? null, p.name, p.p, p.lo, p.hi]);
        houses[hd.house.id] = [v.ev, v.parts.map((p) => p.unit), r3(v.unpricedShare)];
      }
      return outs ? { lvl: m.lvl, q: m.q, outs, houses } : null;
    };
    for (const [b, vmap] of perItem) {
      await write(path.join(dataDir, "items", region, `${b}.json`), { base: b, variants: vmap, de: deFor(b) });
    }
  }
  await write(path.join(dataDir, "meta.json"), meta);
}

function pick(s) {
  const { flipThreshold, horizonDays, minProfitCopper, minRoi, arbMinProfitCopper, minSoldPerDay, baselineDays, velocityDays, hourlyKeepHours, groupNames } = s;
  return { flipThreshold, horizonDays, minProfitCopper, minRoi, arbMinProfitCopper, minSoldPerDay, baselineDays, velocityDays, hourlyKeepHours, groupNames };
}

/** 7-day change of daily market value (today vs the closest day at least 7 days back). */
function change7(e, nowMs) {
  const today = toDay(nowMs);
  const cur = e.d.at(-1);
  if (!cur || cur[D.MV] == null) return null;
  for (let i = e.d.length - 1; i >= 0; i--) {
    const r = e.d[i];
    if (r[D.DAY] <= today - 7 && r[D.MV]) return cur[D.MV] / r[D.MV] - 1;
  }
  return null;
}

/** Hourly market values downsampled to one point per 4 hours (last value in each bucket). */
function spark(e) {
  const out = [];
  let bucket = null;
  for (const p of e.h) {
    const b = Math.floor(p[H.HOUR] / 4);
    if (b !== bucket) out.push(p[H.MV]);
    else out[out.length - 1] = p[H.MV];
    bucket = b;
  }
  return out;
}

function buildMarket(R, nowMs, settings) {
  const nowHour = toHour(nowMs);
  const ids = R.houses.map((h) => h.id);
  const keys = new Set();
  for (const id of ids) for (const [k, e] of Object.entries(R.hists.get(id)?.items ?? {})) if (e.h.at(-1)?.[H.HOUR] >= nowHour - 2) keys.add(k);
  const market = [];
  for (const key of keys) {
    const per = [];
    let main = null;
    let mainQty = -1;
    let gold = 0;
    let spdSum = 0;
    let anySpd = false;
    for (const id of ids) {
      const hist = R.hists.get(id);
      const e = hist?.items?.[key];
      const last = e?.h.at(-1);
      if (!last || last[H.HOUR] < nowHour - 2) {
        per.push(null);
        continue;
      }
      const m = metrics(hist, key, nowMs, settings);
      per.push([last[H.MIN], last[H.MV], last[H.QTY], last[H.N], r3(m?.soldPerDay)]);
      if (m?.soldPerDay != null) {
        anySpd = true;
        spdSum += m.soldPerDay;
        gold += m.soldPerDay * last[H.MV];
      }
      // The reference house for trends: the one with the most sales, then the most listed.
      const score = (m?.soldPerDay ?? 0) * 1e9 + last[H.QTY];
      if (score > mainQty) {
        mainQty = score;
        main = { e, m, last, i: per.length - 1 };
      }
    }
    const m = main.m;
    market.push([
      key, per, m?.baseline ?? null, r3(m?.chg24), r3(change7(main.e, nowMs)), anySpd ? r3(spdSum) : null, r3(m?.sellThrough), r3(m?.cv),
      anySpd ? Math.round(gold) : null, m?.avgQty ? r3(main.last[H.QTY] / m.avgQty) : null,
      // Sparklines only where there's enough trade to make one meaningful (keeps the file small).
      main.last[H.QTY] >= 5 || spdSum >= 0.5 ? spark(main.e) : null,
      main.i,
    ]);
  }
  // Pulse: totals per house per hour (listed units, listings) and per day (estimated sales).
  let minHour = Infinity;
  let tracked = 0;
  const pulse = { houses: [] };
  for (const h of R.houses) {
    const hist = R.hists.get(h.id);
    const hours = new Map();
    const days = new Map();
    for (const e of Object.values(hist?.items ?? {})) {
      for (const p of e.h) {
        const t = hours.get(p[H.HOUR]) ?? [0, 0];
        t[0] += p[H.QTY];
        t[1] += p[H.N];
        hours.set(p[H.HOUR], t);
        if (p[H.HOUR] < minHour) minHour = p[H.HOUR];
      }
      for (const r of e.d) {
        const t = days.get(r[D.DAY]) ?? [0, 0];
        t[0] += r[D.SOLD];
        t[1] += r[D.SOLDV];
        days.set(r[D.DAY], t);
      }
    }
    tracked = Math.max(tracked, Object.values(hist?.track ?? {}).reduce((a, b) => a + b, 0));
    pulse.houses.push({
      id: h.id,
      hours: [...hours].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, ...v]),
      days: [...days].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, ...v]),
    });
  }
  return { market, pulse, span: { hours: Number.isFinite(minHour) ? nowHour - minHour + 1 : 0, tracked: r3(tracked) } };
}
