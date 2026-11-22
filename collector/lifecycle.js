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
 * Reposts: sellers constantly cancel and relist (usually to undercut). A cancelled LONG listing
 * looks exactly like a sale, so when listings of an item disappear and NEW listings of the same
 * item with the same stack size appear in the same scan, those are paired off as reposts and
 * counted as neither sold nor expired. This errs low on purpose (a genuine sale plus a fresh
 * posting of the same stack size is also paired off).
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

  // New listings by item + stack size, available to pair against disappearances.
  const fresh = new Map();
  for (const a of current) {
    if (prevLive[a.id]) continue;
    const k = `${a.key}|${a.qty}`;
    fresh.set(k, (fresh.get(k) ?? 0) + 1);
  }
  let reposted = 0;

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
      const k = `${key}|${qty}`;
      const n = fresh.get(k) ?? 0;
      if (n > 0) {
        fresh.set(k, n - 1);
        reposted++;
        continue;
      }
      if (SOLD_LIKELY.has(tl)) add(sold, key, qty, 1, (unit ?? 0) * qty);
      else if (tl === "SHORT" || tl === "MEDIUM") add(expired, key, qty);
    }
  }
  // Genuinely new supply: new listings left after pairing off reposts (units by item).
  const posted = new Map();
  if (gapOk) {
    for (const [k, n] of fresh) {
      if (n <= 0) continue;
      const cut = k.lastIndexOf("|");
      const key = k.slice(0, cut);
      posted.set(key, (posted.get(key) ?? 0) + n * Number(k.slice(cut + 1)));
    }
  }
  return { next, sold, expired, reposted, posted };
}
