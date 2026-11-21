/**
 * Crafting and disenchanting opportunities.
 *
 * Crafting (per house, per recipe whose product trades there):
 *   crafts   = product sold/day x horizon / units per craft (at least 1)
 *   cost     = reagents bought by walking each reagent's current listings for the full quantity
 *              (vendor reagents at the vendor price when cheaper)
 *   revenue  = crafts x units per craft x relist price x (1 - cut)
 *   EV       = revenue - cost - expected forfeited deposits
 * A recipe is skipped when any reagent can't be priced (not listed in enough quantity and not a
 * vendor reagent), since it would have to be farmed.
 *
 * Disenchanting (per house, per disenchantable listing):
 *   value per item = sum(p x avg qty x material value in that house) x (1 - cut), Classic odds
 *   buys listings priced at or under value / (1 + minRoi), capped by how fast the materials sell.
 */
import { metrics } from "./history.js";
import { baseId } from "./summarise.js";
import { take, depositFor, grade, gradeRank } from "./opportunities.js";
import { deValue, DE_MATERIALS } from "./disenchant.js";

export function resolveVendorIds(items, names = []) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const ids = new Set();
  for (const [id, m] of Object.entries(items)) if (m?.n && want.has(m.n.toLowerCase()) && m.buy > 0) ids.add(Number(id));
  return ids;
}

export function nameIndex(items) {
  const map = new Map();
  for (const [id, m] of Object.entries(items)) {
    if (!m?.n) continue;
    const k = m.n.toLowerCase();
    // Prefer Forever-sourced entries when names collide.
    if (!map.has(k) || m.src === "forever") map.set(k, Number(id));
  }
  return map;
}

/** Unit price of an item in a house for valuation: market value (robust), else lowest listing. */
function unitValue(h, id) {
  const st = h.stats.get(String(id));
  return st ? st.mv : null;
}

function capGrade(g, cap) {
  return gradeRank(g) > gradeRank(cap) ? cap : g;
}

export function findCrafts(region, houses, items, catalog, settings, fees, nowMs, vendorIds) {
  if (!catalog?.recipes?.length) return [];
  const cut = fees.cutRate ?? 0.05;
  const out = [];
  for (const h of houses) {
    for (const [rid, rname, prof, cat, craftedId, qMin, qMax, reagents] of catalog.recipes) {
      if (!craftedId || !reagents.length) continue;
      const key = String(craftedId);
      const m = metrics(h.hist, key, nowMs, settings);
      if (!m?.baseline || m.soldPerDay == null || m.soldPerDay < settings.minSoldPerDay) continue;
      const perCraft = (qMin + qMax) / 2;
      const crafts = Math.max(1, Math.floor((m.soldPerDay * settings.horizonDays) / perCraft));
      const floor = h.ladders.get(key)?.[0]?.[0] ?? m.baseline;
      const sellAt = Math.max(1, Math.min(m.baseline, floor - 1));
      let cost = 0;
      const parts = [];
      let ok = true;
      for (const [id, n] of reagents) {
        const need = n * crafts;
        const vendor = vendorIds.has(id) ? items[id]?.buy ?? null : null;
        const ladder = h.ladders.get(String(id));
        const ah = ladder ? take(ladder, Infinity, need) : null;
        if (vendor != null && (!ah || ah.units < need || ah.cost >= vendor * need)) {
          cost += vendor * need;
          parts.push([id, n, vendor, "vendor"]);
        } else if (ah && ah.units >= need) {
          cost += ah.cost;
          parts.push([id, n, Math.round(ah.cost / need), "ah"]);
        } else {
          ok = false;
          break;
        }
      }
      if (!ok || cost <= 0) continue;
      const units = crafts * perCraft;
      const deposit = depositFor(items[craftedId]?.src === "forever" || items[craftedId]?.src === "client" ? items[craftedId]?.sell ?? 0 : 0, units, fees);
      const pp = Math.max(0.2, m.sellThrough ?? 0.5);
      const value = Math.round(units * sellAt * (1 - cut) - cost - (1 / pp - 1) * deposit);
      if (value < settings.minProfitCopper || value / cost < settings.minRoi) continue;
      out.push({
        type: "craft", region, key, buy: h.house.id, sell: h.house.id, units: Math.round(units), crafts, recipe: rid, recipeName: rname,
        prof, profName: catalog.professions?.[prof]?.name ?? null, sellAt, buyMax: null, cost, ev: value, roi: value / cost,
        days: units / m.soldPerDay, p: m.sellThrough, grade: grade(m), parts,
        note: `${catalog.professions?.[prof]?.name ?? "Profession"}: ${rname}`,
      });
    }
  }
  return out;
}

export function findDisenchants(region, houses, items, settings, fees, nowMs) {
  const cut = fees.cutRate ?? 0.05;
  const byName = nameIndex(items);
  const out = [];
  for (const h of houses) {
    const matCache = new Map();
    const mat = (name) => {
      if (matCache.has(name)) return matCache.get(name);
      const id = byName.get(name.toLowerCase());
      const m = id ? metrics(h.hist, String(id), nowMs, settings) : null;
      const v = id ? { id, unit: m?.baseline ?? unitValue(h, id), m } : null;
      matCache.set(name, v);
      return v;
    };
    for (const [key, ladder] of h.ladders) {
      const meta = items[baseId(key)];
      const de = deValue(meta, (name) => mat(name)?.unit ?? null, cut);
      if (!de || de.ev <= 0 || de.unpricedShare > 0.25) continue;
      // Cap by how fast the main materials sell in this house (20 items at most per listing run).
      let cap = 20;
      for (const part of de.parts) {
        if (part.p < 0.2) continue;
        const spd = mat(part.name)?.m?.soldPerDay;
        if (spd != null) cap = Math.min(cap, Math.max(1, Math.floor((spd * settings.horizonDays) / (part.p * part.avg))));
      }
      const maxBuy = Math.floor(de.ev / (1 + settings.minRoi));
      if (ladder[0][0] > maxBuy) continue;
      const t = take(ladder, maxBuy, cap);
      if (!t.units) continue;
      const value = de.ev * t.units - t.cost;
      if (value < settings.minProfitCopper) continue;
      const main = de.parts.reduce((a, b) => (b.p > a.p ? b : a));
      const mm = mat(main.name)?.m;
      out.push({
        type: "disenchant", region, key, buy: h.house.id, sell: h.house.id, units: t.units, buyMax: t.top, sellAt: de.ev,
        cost: t.cost, ev: value, roi: value / t.cost, days: 0, p: null,
        grade: capGrade(mm ? grade(mm) : "D", "B"),
        parts: de.parts.map((p) => [mat(p.name)?.id ?? null, p.name, p.p, p.lo, p.hi, p.unit]),
        note: `Classic odds, unverified · item level ${meta.lvl}`,
      });
    }
  }
  return out;
}

/**
 * Recipe table for the site: every recipe with a product, priced per house at market value.
 * Row: [recipeId, name, profId, category, craftedId, qtyAvg, reagents [[id, n, vendor?]],
 *       per house: [costPerCraft|null, productValue|null, profitPerCraft|null, productSoldPerDay|null]]
 */
export function recipeTable(houses, items, catalog, settings, fees, nowMs, vendorIds) {
  if (!catalog?.recipes?.length) return [];
  const cut = fees.cutRate ?? 0.05;
  const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  return catalog.recipes.map(([rid, name, prof, cat, craftedId, qMin, qMax, reagents]) => {
    const per = houses.map((h) => {
      let cost = 0;
      for (const [id, n] of reagents) {
        const ah = unitValue(h, id);
        const vendor = vendorIds.has(id) ? items[id]?.buy ?? null : null;
        const unit = vendor != null && (ah == null || vendor < ah) ? vendor : ah;
        if (unit == null) { cost = null; break; }
        cost += unit * n;
      }
      const value = craftedId ? unitValue(h, craftedId) : null;
      const m = craftedId ? metrics(h.hist, String(craftedId), nowMs, settings) : null;
      const qty = (qMin + qMax) / 2;
      const profit = cost != null && value != null ? Math.round(qty * value * (1 - cut) - cost) : null;
      return [cost == null ? null : Math.round(cost), value, profit, r3(m?.soldPerDay)];
    });
    return [rid, name, prof, cat, craftedId, (qMin + qMax) / 2, reagents.map(([id, n]) => [id, n, vendorIds.has(id) ? 1 : 0]), per];
  });
}

export { DE_MATERIALS };
