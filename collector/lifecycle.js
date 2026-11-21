/**
 * Estimates sales by following auction ids between snapshots.
 *
 * Blizzard publishes no sales. An auction that disappears while it still had LONG or
 * VERY_LONG time left was almost certainly bought (or cancelled, which looks the same).
 * One that disappears from SHORT or MEDIUM is counted as expired. At hourly polling most
 * expiring auctions are last seen as MEDIUM (the SHORT window is under 30 minutes), so
 * counting MEDIUM as expired keeps sell-through from reading near 100%. It errs low on
 * purpose: understated sell-through makes profit estimates conservative. A commodity listing whose quantity drops between
 * snapshots had units bought. If the gap since the previous snapshot is too long, nothing
 * is classified, because expiries can't be told apart from sales.
 *
 * live state per house: { [auctionId]: [key, unit, qty, timeLeft] }
 */
const SOLD_LIKELY = new Set(["LONG", "VERY_LONG"]);

export function diffLifecycle(prevLive = {}, current, { gapOk = true } = {}) {
  const next = {};
  const sold = new Map(); // key -> { qty, n, value }
  const expired = new Map(); // key -> qty
  const add = (m, key, qty, n = 0, value = 0) => {
    const e = m.get(key) ?? { qty: 0, n: 0, value: 0 };
    e.qty += qty;
    e.n += n;
    e.value += value;
    m.set(key, e);
  };

  for (const a of current) {
    const prev = prevLive[a.id];
    next[a.id] = [a.key, a.unit, a.qty, a.tl];
    if (prev && gapOk && a.qty < prev[2]) {
      // Partial purchase of a commodity stack.
      const q = prev[2] - a.qty;
      add(sold, a.key, q, 1, (a.unit ?? prev[1] ?? 0) * q);
    }
  }

  if (gapOk) {
    for (const [id, [key, unit, qty, tl]] of Object.entries(prevLive)) {
      if (next[id]) continue;
      if (SOLD_LIKELY.has(tl)) add(sold, key, qty, 1, (unit ?? 0) * qty);
      else if (tl === "SHORT" || tl === "MEDIUM") add(expired, key, qty);
    }
  }
  return { next, sold, expired };
}
