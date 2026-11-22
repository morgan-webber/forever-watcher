/**
 * Profit opportunity engine. Scores trades per region after every snapshot.
 *
 * Types:
 *  - flip:      listings priced at or below flipThreshold x the item's baseline market value,
 *               bought and relisted in the same house.
 *  - vendor:    listings priced below the item's vendor sell price (instant, no AH cut).
 *  - arbitrage: buy in one house, relist in another of the same group (ruleset). Only faction
 *               house <-> Blackwater: goods can't move between the Alliance and Horde houses.
 *
 * Expected value per trade (copper):
 *   EV = units * P_sell * (1 - cut) - cost - (1/p - 1) * deposit
 * where P_sell is conservative (min of baseline and the next competing listing, minus 1c),
 * p is the per-listing sell-through rate (0.5 when unknown, floored at 0.2), and the last term
 * is the deposits you expect to forfeit to expiries before the stack sells.
 * Units are capped at what the market absorbs: soldPerDay * horizonDays.
 */
import { metrics } from "./history.js";
import { baseId } from "./summarise.js";
import { routeNote, canTrade, cutFor } from "./houses.js";

const GRADES = ["D", "C", "B", "A"];

export function grade(m) {
  let pts = 0;
  if (m.historyDays >= 7) pts += 2;
  else if (m.historyDays >= 3) pts += 1;
  if (m.soldEvents >= 20) pts += 2;
  else if (m.soldEvents >= 5) pts += 1;
  if (m.cv != null && m.cv < 0.25) pts += 2;
  else if (m.cv != null && m.cv < 0.5) pts += 1;
  return pts >= 5 ? "A" : pts === 4 ? "B" : pts >= 2 ? "C" : "D";
}
export const gradeRank = (g) => GRADES.indexOf(g);

export function depositFor(vendorSell, units, fees) {
  return Math.max(fees.depositMinCopper ?? 100, Math.round((fees.depositVendorRate ?? 0.15) * (vendorSell || 0) * units));
}

/** Buys from the cheap end of a ladder while unit <= maxPrice, up to maxUnits. */
export function take(ladder, maxPrice, maxUnits) {
  let units = 0;
  let cost = 0;
  let top = 0;
  let i = 0;
  for (; i < ladder.length && units < maxUnits; i++) {
    const [u, q] = ladder[i];
    if (u > maxPrice) break;
    const n = Math.min(q, maxUnits - units);
    units += n;
    cost += u * n;
    top = u;
    if (n < q) break; // partly bought: this listing stays as the next floor
  }
  // The cheapest listing left after our purchase: who we compete with when relisting.
  const floor = i < ladder.length ? ladder[i][0] : null;
  return { units, cost, top, floor };
}

export function ev({ units, cost, sellAt, p, deposit, cut }) {
  const pp = Math.max(0.2, p ?? 0.5);
  return Math.round(units * sellAt * (1 - cut) - cost - (1 / pp - 1) * deposit);
}

/**
 * houses: [{ house, ladders: Map, stats: Map, hist }]
 * items: metadata db keyed by item id
 */
export function findOpportunities(region, houses, items, settings, fees, nowMs) {
  const s = settings;
  const out = [];
  const mcache = new Map();
  const M = (h, key) => {
    const k = `${h.house.id}:${key}`;
    if (!mcache.has(k)) mcache.set(k, metrics(h.hist, key, nowMs, s));
    return mcache.get(k);
  };

  for (const h of houses) {
    for (const [key, ladder] of h.ladders) {
      const meta = items[baseId(key)];
      // Vendor flips: certain, instant. Only with Forever's own vendor price: retail item data
      // (the fallback when static-forever 404s) carries much higher sell prices for many items.
      const vendor = meta?.sell ?? 0;
      if (vendor > 0 && (meta.src === "forever" || meta.src === "client") && ladder[0][0] < vendor) {
        const t = take(ladder, vendor - 1, Infinity);
        const profit = vendor * t.units - t.cost;
        if (profit >= s.minProfitCopper / 10 && t.units > 0) {
          out.push({
            type: "vendor", region, key, buy: h.house.id, sell: null, units: t.units, buyMax: t.top, sellAt: vendor,
            cost: t.cost, ev: profit, roi: profit / t.cost, days: 0, p: 1,
            grade: "A",
            note: "sell to any vendor",
          });
        }
      }

      // Flips within the house.
      const m = M(h, key);
      if (!m?.baseline || m.soldPerDay == null || m.soldPerDay < s.minSoldPerDay) continue;
      const maxUnits = Math.max(1, Math.floor(m.soldPerDay * s.horizonDays));
      const t = take(ladder, Math.floor(m.baseline * s.flipThreshold), maxUnits);
      if (!t.units) continue;
      const sellAt = Math.max(1, Math.min(m.baseline, (t.floor ?? m.baseline) - 1));
      const deposit = depositFor(meta?.src === "forever" || meta?.src === "client" ? vendor : 0, t.units, fees);
      const value = ev({ units: t.units, cost: t.cost, sellAt, p: m.sellThrough, deposit, cut: cutFor(h.house, fees) });
      if (value < s.minProfitCopper || value / t.cost < s.minRoi) continue;
      out.push({
        type: "flip", region, key, buy: h.house.id, sell: h.house.id, units: t.units, buyMax: t.top, sellAt,
        cost: t.cost, ev: value, roi: value / t.cost, days: t.units / m.soldPerDay, p: m.sellThrough,
        grade: grade(m), baseline: m.baseline, soldPerDay: m.soldPerDay,
        note: m.sellThrough == null ? "sell-through unknown, assumed 50%" : "",
      });
    }
  }

  // Cross-house arbitrage within a group: faction house <-> Blackwater only.
  const groups = new Map();
  for (const h of houses) {
    if (!groups.has(h.house.group)) groups.set(h.house.group, []);
    groups.get(h.house.group).push(h);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const B of members) {
      for (const [key, ladderB] of B.ladders) {
        const mB = M(B, key);
        if (!mB?.baseline || mB.soldPerDay == null || mB.soldPerDay < s.minSoldPerDay) continue;
        const sellAt = Math.max(1, Math.min(mB.baseline, ladderB[0][0] - 1));
        const cut = cutFor(B.house, fees);
        const maxBuy = Math.floor((sellAt * (1 - cut)) / (1 + s.minRoi));
        const maxUnits = Math.max(1, Math.floor(mB.soldPerDay * s.horizonDays));
        let best = null;
        for (const A of members) {
          if (A === B || !canTrade(A.house, B.house)) continue;
          const ladderA = A.ladders.get(key);
          if (!ladderA || ladderA[0][0] > maxBuy) continue;
          const t = take(ladderA, maxBuy, maxUnits);
          if (!t.units) continue;
          const deposit = depositFor(items[baseId(key)]?.sell ?? 0, t.units, fees);
          const value = ev({ units: t.units, cost: t.cost, sellAt, p: mB.sellThrough, deposit, cut });
          if (value < s.arbMinProfitCopper || value / t.cost < s.minRoi) continue;
          if (!best || value > best.ev) {
            best = {
              type: "arbitrage", region, key, buy: A.house.id, sell: B.house.id, units: t.units, buyMax: t.top, sellAt,
              cost: t.cost, ev: value, roi: value / t.cost, days: t.units / mB.soldPerDay, p: mB.sellThrough,
              grade: grade(mB), baseline: mB.baseline, soldPerDay: mB.soldPerDay, note: routeNote(A.house, B.house),
            };
          }
        }
        if (best) out.push(best);
      }
    }
  }

  out.sort((a, b) => b.ev - a.ev);
  return out.slice(0, s.maxOppsPerRegion);
}
