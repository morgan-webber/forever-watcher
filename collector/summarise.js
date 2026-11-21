/**
 * Turns one house's raw listings (auctions + commodities) into per-item stats.
 * All prices are integer copper per unit.
 */

/** Item key: the item id, plus its sorted bonus list for gear variants ("2589", "15215-1.2.3"). */
export function itemKey(item) {
  const id = item?.id;
  if (!id) return null;
  const bonus = item.bonus_lists;
  if (Array.isArray(bonus) && bonus.length) return `${id}-${[...bonus].sort((a, b) => a - b).join(".")}`;
  return String(id);
}

export const baseId = (key) => Number(String(key).split("-")[0]);

/** Normalises one raw listing. Returns null when unusable. unit is null for bid-only auctions. */
export function normalise(a) {
  const key = itemKey(a.item);
  if (!key || a.id == null) return null;
  const qty = Math.max(1, Number(a.quantity) || 1);
  let unit = null;
  if (a.unit_price > 0) unit = Math.round(a.unit_price);
  else if (a.buyout > 0) unit = Math.round(a.buyout / qty);
  return { id: Number(a.id), key, unit, qty, tl: a.time_left ?? null };
}

/** Quantity-weighted percentile of a sorted [unit, qty][] ladder. */
function percentile(ladder, total, p) {
  const target = Math.max(1, Math.ceil(total * p));
  let seen = 0;
  for (const [u, q] of ladder) {
    seen += q;
    if (seen >= target) return u;
  }
  return ladder.at(-1)[0];
}

/**
 * Market value: a robust "what it really sells for" price.
 * Take the cheapest 15% of units, extended so at least the 3 cheapest listings are included
 * (each extra listing contributes a capped share so one huge stack can't dominate). Drop
 * units priced below 0.5x or above 1.5x the slice's median (troll and bait listings), and
 * return the quantity-weighted mean of the rest. A lone 1c listing can't set the value.
 */
export function marketValue(ladder, total) {
  const want = Math.max(1, Math.ceil(total * 0.15));
  const minListings = Math.min(3, ladder.length);
  const share = Math.max(1, Math.round(want / 3));
  const slice = [];
  let took = 0;
  for (const [u, q] of ladder) {
    if (took >= want && slice.length >= minListings) break;
    const n = took < want ? Math.min(q, want - took) : Math.min(q, share);
    slice.push([u, n]);
    took += n;
  }
  const med = percentile(slice, took, 0.5);
  let sum = 0;
  let cnt = 0;
  for (const [u, n] of slice) {
    if (u > med * 1.5 || u < med * 0.5) continue;
    sum += u * n;
    cnt += n;
  }
  return Math.round(cnt ? sum / cnt : med);
}

/** entries: iterable of [key, unit, qty] (unit null = bid-only, skipped). Returns Map key -> sorted [[unit, qty]]. */
export function ladderize(entries) {
  const ladders = new Map();
  for (const [key, unit, qty] of entries) {
    if (unit == null) continue;
    let l = ladders.get(key);
    if (!l) ladders.set(key, (l = []));
    l.push([unit, qty]);
  }
  for (const l of ladders.values()) l.sort((x, y) => x[0] - y[0]);
  return ladders;
}

export function statsOf(ladders) {
  const stats = new Map();
  for (const [key, ladder] of ladders) {
    const qty = ladder.reduce((s, [, q]) => s + q, 0);
    stats.set(key, {
      min: ladder[0][0],
      mv: marketValue(ladder, qty),
      p25: percentile(ladder, qty, 0.25),
      med: percentile(ladder, qty, 0.5),
      qty,
      n: ladder.length,
    });
  }
  return stats;
}

/** Raw API listings -> { live: normalised listings, ladders, stats, listings } */
export function summarise(rawListings) {
  const live = [];
  for (const raw of rawListings) {
    const a = normalise(raw);
    if (a) live.push(a);
  }
  const ladders = ladderize(live.map((a) => [a.key, a.unit, a.qty]));
  return { live, ladders, stats: statsOf(ladders), listings: live.length };
}
