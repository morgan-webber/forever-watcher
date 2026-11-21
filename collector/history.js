/**
 * Per-house price history.
 *
 * hist = {
 *   items: { [key]: { h: [[hour, mv, min, qty, n, sold?]], d: [[day, mv, min, qty, sold, expired, soldValue]] } },
 *   track: { [day]: hoursOfLifecycleTracking },
 * }
 * hour = epoch hours, day = epoch days (UTC). Prices are copper per unit.
 */
export const H = { HOUR: 0, MV: 1, MIN: 2, QTY: 3, N: 4, SOLD: 5 };
export const D = { DAY: 0, MV: 1, MIN: 2, QTY: 3, SOLD: 4, EXP: 5, SOLDV: 6 };

export const toHour = (ms) => Math.floor(ms / 3_600_000);
export const toDay = (ms) => Math.floor(ms / 86_400_000);

export function emptyHistory() {
  return { items: {}, track: {} };
}

function dailyRow(entry, day) {
  let row = entry.d.at(-1);
  if (!row || row[D.DAY] !== day) {
    row = [day, null, null, null, 0, 0, 0];
    entry.d.push(row);
  }
  return row;
}

export function recordSnapshot(hist, nowMs, stats, keepHours) {
  const hour = toHour(nowMs);
  const day = toDay(nowMs);
  const minHour = hour - keepHours;
  for (const [key, s] of stats) {
    const e = (hist.items[key] ??= { h: [], d: [] });
    // A second scan in the same hour replaces the point but keeps the hour's sales count.
    const prev = e.h.at(-1)?.[H.HOUR] === hour ? e.h.pop() : null;
    e.h.push(prev?.[H.SOLD] ? [hour, s.mv, s.min, s.qty, s.n, prev[H.SOLD]] : [hour, s.mv, s.min, s.qty, s.n]);
  }
  for (const e of Object.values(hist.items)) {
    while (e.h.length && e.h[0][H.HOUR] <= minHour) e.h.shift();
    // Recompute today's daily price columns from today's hourly points.
    const today = e.h.filter((p) => Math.floor(p[H.HOUR] / 24) === day);
    if (!today.length) continue;
    const row = dailyRow(e, day);
    row[D.MV] = Math.round(today.reduce((s, p) => s + p[H.MV], 0) / today.length);
    row[D.MIN] = Math.min(...today.map((p) => p[H.MIN]));
    row[D.QTY] = Math.round(today.reduce((s, p) => s + p[H.QTY], 0) / today.length);
  }
}

export function recordSales(hist, nowMs, sold, expired) {
  const day = toDay(nowMs);
  const hour = toHour(nowMs);
  for (const [key, s] of sold) {
    const e = (hist.items[key] ??= { h: [], d: [] });
    const row = dailyRow(e, day);
    row[D.SOLD] += s.qty;
    row[D.SOLDV] += s.value;
    // Hourly volume: sales seen at this scan go on this hour's point (if the item is still listed).
    const p = e.h.at(-1);
    if (p && p[H.HOUR] === hour) p[H.SOLD] = (p[H.SOLD] ?? 0) + s.qty;
  }
  for (const [key, x] of expired) {
    const e = (hist.items[key] ??= { h: [], d: [] });
    dailyRow(e, day)[D.EXP] += x.qty;
  }
}

export function recordTracking(hist, nowMs, hours) {
  const day = toDay(nowMs);
  hist.track[day] = Math.min(24, (hist.track[day] ?? 0) + hours);
}

export function prune(hist, nowMs, keepDays) {
  const minDay = toDay(nowMs) - keepDays;
  for (const [key, e] of Object.entries(hist.items)) {
    while (e.d.length && e.d[0][D.DAY] < minDay) e.d.shift();
    if (!e.h.length && !e.d.length) delete hist.items[key];
  }
  for (const day of Object.keys(hist.track)) if (Number(day) < minDay) delete hist.track[day];
}

/**
 * Item-level metrics used by the opportunity engine and the site.
 * baseline: mean daily market value over the last `baselineDays` (excluding today when there
 * are at least 3 earlier days), else mean of hourly market values when there are >= 12 points.
 */
export function metrics(hist, key, nowMs, { baselineDays = 14, velocityDays = 7 } = {}) {
  const e = hist.items[key];
  if (!e) return null;
  const today = toDay(nowMs);
  const past = e.d.filter((r) => r[D.DAY] < today && r[D.DAY] >= today - baselineDays && r[D.MV] != null);
  let baseline = null;
  let baselineSource = null;
  let samples = 0;
  if (past.length >= 3) {
    baseline = Math.round(past.reduce((s, r) => s + r[D.MV], 0) / past.length);
    baselineSource = "daily";
    samples = past.length;
  } else if (e.h.length >= 12) {
    baseline = Math.round(e.h.reduce((s, p) => s + p[H.MV], 0) / e.h.length);
    baselineSource = "hourly";
    samples = e.h.length;
  }
  // Volatility: coefficient of variation of the series the baseline came from.
  let cv = null;
  const series = baselineSource === "daily" ? past.map((r) => r[D.MV]) : e.h.map((p) => p[H.MV]);
  if (baseline && series.length >= 3) {
    const sd = Math.sqrt(series.reduce((s, v) => s + (v - baseline) ** 2, 0) / series.length);
    cv = sd / baseline;
  }
  // Velocity over the tracked hours of the last `velocityDays` days (today included).
  let trackedHours = 0;
  for (let d = today - velocityDays + 1; d <= today; d++) trackedHours += hist.track[d] ?? 0;
  const recent = e.d.filter((r) => r[D.DAY] > today - velocityDays);
  const sold = recent.reduce((s, r) => s + r[D.SOLD], 0);
  const expired = recent.reduce((s, r) => s + r[D.EXP], 0);
  const soldEvents = sold; // quantity; good enough as a sample-size proxy
  const soldPerDay = trackedHours >= 6 ? sold / (trackedHours / 24) : null;
  const sellThrough = sold + expired >= 3 ? sold / (sold + expired) : null;
  // 24h change of market value.
  const last = e.h.at(-1);
  const dayAgo = e.h.find((p) => p[H.HOUR] >= (last?.[H.HOUR] ?? 0) - 24);
  const chg24 = last && dayAgo && dayAgo !== last && dayAgo[H.MV] ? last[H.MV] / dayAgo[H.MV] - 1 : null;
  const avgQty = past.length ? past.reduce((s, r) => s + (r[D.QTY] ?? 0), 0) / past.length : null;
  return { baseline, baselineSource, samples, cv, soldPerDay, sellThrough, soldEvents, trackedHours, chg24, avgQty, historyDays: past.length };
}
