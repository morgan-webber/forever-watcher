/**
 * Speculation watch: items that look like they're being hoarded or squeezed before a price move.
 *
 * Per item, per house, a recent window (R) is compared with a baseline window (B):
 *   - supply and price, while there's under 7 days of daily history: now = the last 6 scanned
 *     hours, usual = the scans 24-72 hours ago; afterwards usual = the 8 days before yesterday.
 *     Hours a house was scanned but the item wasn't listed count as zero listed (sold out).
 *   - sales and new supply per day come from the daily totals (yesterday + today vs. the days
 *     before), which still count sales on hours the item sold out.
 *
 * Signals (each 0..1) and weights:
 *   supply drain  35  listed units now vs. usual (1 - now/usual)
 *   demand holds  20  estimated sales per day in R vs. B (0 at <= 0.8x, 1 at >= 1.5x)
 *   price rising  20  market value now vs. usual (1 at +25%)
 *   absorption    15  units bought vs. units newly posted in R (1 at 2x: buyers take twice the new supply)
 *   scarcity      10  days of supply left at the recent sales rate (1 at 0 days, 0 at 3+ days)
 * plus a count of big buyouts: hours in R where estimated sales took at least a fifth of what
 * was listed and at least 3x the usual hourly sales.
 *
 * Confidence reflects how much data backs it: tracked hours in both windows and sales sample size.
 */
import { H, D, toHour, toDay } from "./history.js";

const clamp = (x) => Math.max(0, Math.min(1, x));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Hours at which this house was scanned (any item has a point), cached per history object. */
const scannedCache = new WeakMap();
function scannedHours(hist) {
  if (!scannedCache.has(hist)) {
    const set = new Set();
    for (const e of Object.values(hist.items)) for (const p of e.h) set.add(p[H.HOUR]);
    scannedCache.set(hist, [...set].sort((x, y) => x - y));
  }
  return scannedCache.get(hist);
}

/** Units per day from daily rows over a set of days, normalised by tracked hours. */
function perDay(e, hist, days, col) {
  let units = 0;
  let hours = 0;
  for (const d of days) {
    const row = e.d.find((r) => r[D.DAY] === d);
    units += row?.[col] ?? 0;
    hours += hist.track?.[d] ?? 0;
  }
  return { rate: hours >= 6 ? (units / hours) * 24 : null, hours, units };
}

export function scoreItem(hist, key, nowMs, { minSoldPerDay = 0.5 } = {}) {
  const e = hist.items[key];
  if (!e?.h?.length) return null;
  const nowH = toHour(nowMs);
  const today = toDay(nowMs);
  const daily = e.d.filter((r) => r[D.DAY] < today && r[D.QTY] != null).length >= 7;
  const scanned = scannedHours(hist);
  const pt = new Map(e.h.map((p) => [p[H.HOUR], p]));
  // Hours this house was scanned but the item wasn't listed count as zero listed (sold out).
  const qtyAt = (h) => pt.get(h)?.[H.QTY] ?? 0;
  const last6 = scanned.filter((h) => h > nowH - 6 && h <= nowH);
  if (!last6.length) return null;
  const qtyNow = mean(last6.map(qtyAt));
  const lastMv = e.h.at(-1)[H.MV];
  const mvRecent = last6.map((h) => pt.get(h)?.[H.MV]).filter((v) => v != null);
  const mvNow = mvRecent.length ? mean(mvRecent) : lastMv;

  let qtyBase, mvBase, rDays, bDays, mode, sparkQty, sparkMv;
  if (!daily) {
    const B = scanned.filter((h) => h <= nowH - 24 && h > nowH - 72);
    const present = B.filter((h) => pt.has(h));
    if (B.length < 12 || present.length < 6) return null;
    qtyBase = mean(B.map(qtyAt));
    mvBase = mean(present.map((h) => pt.get(h)[H.MV]));
    rDays = [today - 1, today];
    bDays = [today - 3, today - 2];
    mode = "hourly";
    const window = scanned.filter((h) => h > nowH - 72);
    sparkQty = window.map(qtyAt);
    sparkMv = window.map((h) => pt.get(h)?.[H.MV] ?? null);
  } else {
    const B = e.d.filter((r) => r[D.DAY] <= today - 2 && r[D.DAY] > today - 10 && r[D.QTY] != null);
    if (B.length < 4) return null;
    qtyBase = mean(B.map((r) => r[D.QTY]));
    mvBase = mean(B.filter((r) => r[D.MV] != null).map((r) => r[D.MV]));
    rDays = [today - 1, today];
    bDays = Array.from({ length: 8 }, (_, i) => today - 9 + i);
    mode = "daily";
    sparkQty = e.d.slice(-14).map((r) => r[D.QTY]);
    sparkMv = e.d.slice(-14).map((r) => r[D.MV]);
  }
  const sold = perDay(e, hist, rDays, D.SOLD);
  const soldBase = perDay(e, hist, bDays, D.SOLD);
  const post = perDay(e, hist, rDays, D.POST);
  const soldR = sold.rate;
  const soldB = soldBase.rate;
  const postR = post.rate;
  if (!qtyBase || !mvBase || soldR == null || soldR < minSoldPerDay || qtyBase < 5) return null;

  // Big buyouts: an hour that took a large bite of the listed supply, well above usual.
  const usual = median(e.h.filter((p) => p[H.HOUR] <= nowH - 24).map((p) => p[H.SOLD] ?? 0));
  let buyouts = 0;
  for (let i = 1; i < e.h.length; i++) {
    const p = e.h[i];
    if (p[H.HOUR] <= nowH - 24) continue;
    const s = p[H.SOLD] ?? 0;
    if (s >= 10 && s >= e.h[i - 1][H.QTY] * 0.2 && s >= usual * 3) buyouts++;
  }

  const supply = clamp(1 - qtyNow / qtyBase);
  const demandRatio = soldB ? soldR / soldB : null;
  const demand = demandRatio == null ? 0.5 : clamp((demandRatio - 0.8) / 0.7);
  const priceChg = mvNow / mvBase - 1;
  const price = clamp(priceChg / 0.25);
  const absorption = postR != null ? soldR / Math.max(postR, 1) : null;
  const absorb = absorption == null ? 0 : clamp(absorption - 1);
  const daysOfSupply = soldR > 0 ? qtyNow / soldR : null;
  const scarce = daysOfSupply == null ? 0 : clamp((3 - daysOfSupply) / 3);
  const score = Math.round(100 * (0.35 * supply + 0.2 * demand + 0.2 * price + 0.15 * absorb + 0.1 * scarce));

  const tracked = sold.hours + soldBase.hours;
  const confidence = tracked >= 60 && sold.units >= 20 && soldB != null ? "high" : tracked >= 24 && sold.units >= 5 ? "medium" : "low";
  return {
    key, score, confidence, mode,
    qtyNow: Math.round(qtyNow), qtyBase: Math.round(qtyBase), supplyChange: qtyNow / qtyBase - 1,
    soldR, soldB, demandRatio, mvNow: Math.round(mvNow), mvBase: Math.round(mvBase), priceChange: priceChg,
    postR, absorption, daysOfSupply, buyouts, sparkQty, sparkMv,
  };
}

/**
 * Candidates per region: for each item, the house with the strongest signal. An item qualifies
 * when supply is down at least 25% or buyers take at least 1.3x the new supply, and it scores
 * at least `minScore`.
 */
export function findSpeculation(houses, nowMs, settings, { minScore = 40 } = {}) {
  const best = new Map();
  for (const h of houses) {
    for (const key of Object.keys(h.hist.items)) {
      const s = scoreItem(h.hist, key, nowMs, settings);
      if (!s || s.score < minScore) continue;
      if (!(s.supplyChange <= -0.25 || (s.absorption ?? 0) >= 1.3)) continue;
      const cur = best.get(key);
      if (!cur || s.score > cur.score) best.set(key, { ...s, house: h.house.id });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** Backtest log entries: flagged items, checked `days` later for a price rise of at least `rise`. */
export function logSpeculation(log, region, flagged, nowMs, minScore = 60) {
  const recent = new Set(log.filter((e) => nowMs - e.t < 3 * 86_400_000).map((e) => `${e.region}|${e.key}|${e.house}`));
  for (const s of flagged) {
    if (s.score < minScore || s.confidence === "low") continue;
    const id = `${region}|${s.key}|${s.house}`;
    if (recent.has(id)) continue;
    recent.add(id);
    log.push({ t: nowMs, region, key: s.key, house: s.house, mv: s.mvNow, score: s.score, r: null, peak: null });
  }
}

export function evaluateSpeculation(log, histFor, nowMs, { days = 3, rise = 0.1, keepDays = 30 } = {}) {
  for (const e of log) {
    if (e.r != null || nowMs - e.t < days * 86_400_000) continue;
    const item = histFor(e.region, e.house)?.items?.[e.key];
    const from = Math.floor(e.t / 3_600_000);
    const pts = (item?.h ?? []).filter((p) => p[H.HOUR] > from && p[H.HOUR] <= from + days * 24);
    const peak = pts.length ? Math.max(...pts.map((p) => p[H.MV])) : null;
    e.peak = peak;
    e.r = peak != null && peak >= e.mv * (1 + rise) ? 1 : 0;
  }
  const kept = log.filter((e) => nowMs - e.t < keepDays * 86_400_000);
  log.length = 0;
  log.push(...kept);
  const done = log.filter((e) => e.r != null);
  const hits = done.filter((e) => e.r === 1);
  return {
    evaluated: done.length, hits: hits.length, hitRate: done.length ? hits.length / done.length : null,
    avgPeakRise: hits.length ? mean(hits.map((e) => e.peak / e.mv - 1)) : null, pending: log.length - done.length, days, rise,
  };
}
