/**
 * Writes the static JSON the site reads, under <out>/data/.
 *   meta.json                          houses, scan times, fees, backtest, generation time
 *   opps-<region>.json                 ranked opportunities (with item names for display)
 *   index-<region>.json                [baseId, name, quality, icon, class, vendor, variants] for search
 *   houses/<region>-<id>.json          current market table for one house
 *   items/<region>/<baseId>.json       history + metrics per variant (bonus list) per house
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { metrics, H, toHour } from "./history.js";
import { baseId } from "./summarise.js";

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

export async function publish({ outDir, regions, items, settings, fees, backtest, nowMs, demo }) {
  const dataDir = path.join(outDir, "data");
  await fs.rm(dataDir, { recursive: true, force: true });
  const nowHour = toHour(nowMs);
  const meta = { generatedAt: new Date(nowMs).toISOString(), demo: !!demo, fees, settings: pick(settings), backtest, regions: {} };

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
          m: m && { baseline: m.baseline, soldPerDay: r3(m.soldPerDay), sellThrough: r3(m.sellThrough), cv: r3(m.cv), chg24: r3(m.chg24), historyDays: m.historyDays, listed },
        };
      }
      await write(path.join(dataDir, "houses", `${region}-${h.id}.json`), { house: h, rows });
    }
    for (const [b, vmap] of perItem) {
      await write(path.join(dataDir, "items", region, `${b}.json`), { base: b, variants: vmap });
    }
  }
  await write(path.join(dataDir, "meta.json"), meta);
}

function pick(s) {
  const { flipThreshold, horizonDays, minProfitCopper, minRoi, arbMinProfitCopper, minSoldPerDay, baselineDays, velocityDays, hourlyKeepHours, groupNames } = s;
  return { flipThreshold, horizonDays, minProfitCopper, minRoi, arbMinProfitCopper, minSoldPerDay, baselineDays, velocityDays, hourlyKeepHours, groupNames };
}
