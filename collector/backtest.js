/**
 * Measures whether flagged trades would have worked.
 *
 * Every flagged flip/arbitrage is logged with its relist price and unit count. Once its horizon
 * has passed, it counts as a hit only if BOTH held in the sell house during the horizon:
 *   1. price held: at least half of the hourly market values were at or above the relist price;
 *   2. demand: the estimated units sold were at least the trade's unit count.
 * It's an approximation, published as such, but it's measured, not assumed.
 */
import { H, D, toDay } from "./history.js";

export function logOpportunities(log, opps, nowMs) {
  const recent = new Set(log.filter((e) => nowMs - e.t < 86_400_000).map((e) => `${e.type}|${e.region}|${e.key}|${e.buy}|${e.sell}`));
  for (const o of opps) {
    if (o.type === "vendor") continue;
    const id = `${o.type}|${o.region}|${o.key}|${o.buy}|${o.sell}`;
    if (recent.has(id)) continue;
    recent.add(id);
    log.push({ t: nowMs, type: o.type, region: o.region, key: o.key, buy: o.buy, sell: o.sell, sellAt: o.sellAt, units: o.units, cost: o.cost, ev: o.ev, r: null });
  }
}

/** histFor(region, houseId) -> history object or undefined */
export function evaluate(log, histFor, nowMs, { horizonDays, backtestWindowDays }) {
  const horizonMs = horizonDays * 86_400_000;
  for (const e of log) {
    if (e.r != null || nowMs - e.t < horizonMs) continue;
    const hist = histFor(e.region, e.sell);
    const item = hist?.items?.[e.key];
    if (!item) {
      e.r = 0;
      continue;
    }
    const from = Math.floor(e.t / 3_600_000);
    const to = from + horizonDays * 24;
    const pts = item.h.filter((p) => p[H.HOUR] > from && p[H.HOUR] <= to);
    const held = pts.length > 0 && pts.filter((p) => p[H.MV] >= e.sellAt).length / pts.length >= 0.5;
    const dFrom = toDay(e.t);
    const soldQty = item.d.filter((r) => r[D.DAY] >= dFrom && r[D.DAY] <= dFrom + horizonDays).reduce((s, r) => s + r[D.SOLD], 0);
    e.r = held && soldQty >= e.units ? 1 : 0;
  }
  const minT = nowMs - backtestWindowDays * 86_400_000;
  const kept = log.filter((e) => e.t >= minT);
  log.length = 0;
  log.push(...kept);
}

export function summarise(log) {
  const by = {};
  for (const e of log) {
    if (e.r == null) continue;
    const s = (by[e.type] ??= { evaluated: 0, hits: 0, predictedProfit: 0, hitProfit: 0, cost: 0 });
    s.evaluated++;
    s.predictedProfit += e.ev;
    s.cost += e.cost;
    if (e.r) {
      s.hits++;
      s.hitProfit += e.ev;
    }
  }
  for (const s of Object.values(by)) {
    s.hitRate = s.evaluated ? s.hits / s.evaluated : null;
    // Realised ROI if hits earn their predicted profit and misses are sold back at cost (zero profit).
    s.realisedRoi = s.cost ? s.hitProfit / s.cost : null;
  }
  const pending = log.filter((e) => e.r == null).length;
  return { byType: by, pending };
}
