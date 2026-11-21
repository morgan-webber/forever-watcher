/**
 * Writes the static JSON the site reads, under <out>/data/.
 *   meta.json                          houses, scan times, fees, backtest, generation time
 *   opps-<region>.json                 ranked opportunities (with item names for display)
 *   index-<region>.json                [key, name, quality, icon, class] for search
 *   houses/<region>-<id>.json          current market table for one house
 *   items/<region>/<key>.json          history + metrics for one item across houses
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
      items: keys.size,
    };

    // Search index.
    const index = [...keys].map((k) => {
      const m = items[baseId(k)];
      return [k, m?.n ?? `Item ${baseId(k)}`, m?.q ?? "COMMON", m?.icon ?? null, m?.c ?? null, m?.sell ?? 0];
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
        if (!perItem.has(key)) perItem.set(key, {});
        perItem.get(key)[h.id] = {
          h: e.h,
          d: e.d,
          m: m && { baseline: m.baseline, soldPerDay: r3(m.soldPerDay), sellThrough: r3(m.sellThrough), cv: r3(m.cv), chg24: r3(m.chg24), historyDays: m.historyDays, listed },
        };
      }
      await write(path.join(dataDir, "houses", `${region}-${h.id}.json`), { house: h, rows });
    }
    for (const [key, houses] of perItem) {
      await write(path.join(dataDir, "items", region, `${key}.json`), { key, houses });
    }
  }
  await write(path.join(dataDir, "meta.json"), meta);
}

function pick(s) {
  const { flipThreshold, horizonDays, minProfitCopper, minRoi, arbMinProfitCopper, minSoldPerDay, baselineDays, velocityDays, hourlyKeepHours, groupNames } = s;
  return { flipThreshold, horizonDays, minProfitCopper, minRoi, arbMinProfitCopper, minSoldPerDay, baselineDays, velocityDays, hourlyKeepHours, groupNames };
}
