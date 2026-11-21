/**
 * Disenchant outcomes. Blizzard publishes no disenchant data (not in the API, not in the client
 * files), so these are the Classic tables from warcraft.wiki.gg "Disenchanting tables" (vanilla
 * rows, by ITEM level). Forever may differ: every result built on them is labelled unverified.
 *
 * Row: [minItemLevel, maxItemLevel, [[material, probability, minQty, maxQty], ...]]
 */
export const DE_SOURCE = "Classic disenchanting tables (warcraft.wiki.gg), by item level; unverified for Forever";

const U = (dust, essence, shard) => [dust, essence, shard].filter(Boolean);
export const DE_TABLE = {
  armor: [
    [5, 15, U(["Strange Dust", 0.8, 1, 2], ["Lesser Magic Essence", 0.2, 1, 2])],
    [16, 20, U(["Strange Dust", 0.75, 2, 3], ["Greater Magic Essence", 0.2, 1, 2], ["Small Glimmering Shard", 0.05, 1, 1])],
    [21, 25, U(["Strange Dust", 0.75, 4, 6], ["Lesser Astral Essence", 0.15, 1, 2], ["Small Glimmering Shard", 0.1, 1, 1])],
    [26, 30, U(["Soul Dust", 0.75, 1, 2], ["Greater Astral Essence", 0.2, 1, 2], ["Large Glimmering Shard", 0.05, 1, 1])],
    [31, 35, U(["Soul Dust", 0.75, 2, 5], ["Lesser Mystic Essence", 0.2, 1, 2], ["Small Glowing Shard", 0.05, 1, 1])],
    [36, 40, U(["Vision Dust", 0.75, 1, 2], ["Greater Mystic Essence", 0.2, 1, 2], ["Large Glowing Shard", 0.05, 1, 1])],
    [41, 45, U(["Vision Dust", 0.75, 2, 5], ["Lesser Nether Essence", 0.2, 1, 2], ["Small Radiant Shard", 0.05, 1, 1])],
    [46, 50, U(["Dream Dust", 0.75, 1, 2], ["Greater Nether Essence", 0.2, 1, 2], ["Large Radiant Shard", 0.05, 1, 1])],
    [51, 55, U(["Dream Dust", 0.75, 2, 5], ["Lesser Eternal Essence", 0.2, 1, 2], ["Small Brilliant Shard", 0.05, 1, 1])],
    [56, 60, U(["Illusion Dust", 0.75, 1, 2], ["Greater Eternal Essence", 0.2, 1, 2], ["Large Brilliant Shard", 0.05, 1, 1])],
    [61, 65, U(["Illusion Dust", 0.75, 2, 5], ["Greater Eternal Essence", 0.2, 2, 3], ["Large Brilliant Shard", 0.05, 1, 1])],
  ],
  weapon: [
    [6, 15, U(["Strange Dust", 0.2, 1, 2], ["Lesser Magic Essence", 0.8, 1, 2])],
    [16, 20, U(["Strange Dust", 0.2, 2, 3], ["Greater Magic Essence", 0.75, 1, 2], ["Small Glimmering Shard", 0.05, 1, 1])],
    [21, 25, U(["Strange Dust", 0.15, 4, 6], ["Lesser Astral Essence", 0.75, 1, 2], ["Small Glimmering Shard", 0.1, 1, 1])],
    [26, 30, U(["Soul Dust", 0.2, 1, 2], ["Greater Astral Essence", 0.75, 1, 2], ["Large Glimmering Shard", 0.05, 1, 1])],
    [31, 35, U(["Soul Dust", 0.2, 2, 5], ["Lesser Mystic Essence", 0.75, 1, 2], ["Small Glowing Shard", 0.05, 1, 1])],
    [36, 40, U(["Vision Dust", 0.2, 1, 2], ["Greater Mystic Essence", 0.75, 1, 2], ["Large Glowing Shard", 0.05, 1, 1])],
    [41, 45, U(["Vision Dust", 0.2, 2, 5], ["Lesser Nether Essence", 0.75, 1, 2], ["Small Radiant Shard", 0.05, 1, 1])],
    [46, 50, U(["Dream Dust", 0.2, 1, 2], ["Greater Nether Essence", 0.75, 1, 2], ["Large Radiant Shard", 0.05, 1, 1])],
    [51, 55, U(["Dream Dust", 0.22, 2, 5], ["Lesser Eternal Essence", 0.75, 1, 2], ["Small Brilliant Shard", 0.03, 1, 1])],
    [56, 60, U(["Illusion Dust", 0.22, 1, 2], ["Greater Eternal Essence", 0.75, 1, 2], ["Large Brilliant Shard", 0.03, 1, 1])],
    [61, 65, U(["Illusion Dust", 0.22, 2, 5], ["Greater Eternal Essence", 0.75, 2, 3], ["Large Brilliant Shard", 0.03, 1, 1])],
  ],
  rare: [
    [1, 25, [["Small Glimmering Shard", 1, 1, 1]]],
    [26, 30, [["Large Glimmering Shard", 1, 1, 1]]],
    [31, 35, [["Small Glowing Shard", 1, 1, 1]]],
    [36, 40, [["Large Glowing Shard", 1, 1, 1]]],
    [41, 45, [["Small Radiant Shard", 1, 1, 1]]],
    [46, 50, [["Large Radiant Shard", 1, 1, 1]]],
    [51, 55, [["Small Brilliant Shard", 1, 1, 1]]],
    [56, 65, [["Large Brilliant Shard", 0.995, 1, 1], ["Nexus Crystal", 0.005, 1, 1]]],
  ],
  epic: [
    [40, 45, [["Small Radiant Shard", 1, 2, 4]]],
    [46, 50, [["Large Radiant Shard", 1, 2, 4]]],
    [51, 55, [["Small Brilliant Shard", 1, 2, 4]]],
    [56, 60, [["Nexus Crystal", 1, 1, 1]]],
    [61, 88, [["Nexus Crystal", 1, 1, 2]]],
  ],
};

export const DE_MATERIALS = [...new Set(Object.values(DE_TABLE).flatMap((rows) => rows.flatMap((r) => r[2].map((o) => o[0]))))];

/** Outcomes for an item, or null if it can't be disenchanted per the table. */
export function outcomes(meta) {
  if (!meta?.lvl) return null;
  const isWeapon = meta.cid === 2 || meta.c === "Weapon";
  const isArmor = meta.cid === 4 || meta.c === "Armor";
  if (!isWeapon && !isArmor) return null;
  const table = meta.q === "UNCOMMON" ? DE_TABLE[isWeapon ? "weapon" : "armor"] : meta.q === "RARE" ? DE_TABLE.rare : meta.q === "EPIC" ? DE_TABLE.epic : null;
  const row = table?.find(([lo, hi]) => meta.lvl >= lo && meta.lvl <= hi);
  return row ? row[2].map(([name, p, lo, hi]) => ({ name, p, avg: (lo + hi) / 2, lo, hi })) : null;
}

/**
 * Expected value of one disenchant. priceOf(name) -> copper per unit or null.
 * Returns { ev, parts, unpricedShare } where ev is after the AH cut on selling the materials.
 */
export function deValue(meta, priceOf, cut) {
  const outs = outcomes(meta);
  if (!outs) return null;
  let ev = 0;
  let unpricedShare = 0;
  const parts = outs.map((o) => {
    const unit = priceOf(o.name);
    if (unit == null) unpricedShare += o.p;
    else ev += o.p * o.avg * unit * (1 - cut);
    return { ...o, unit };
  });
  return { ev: Math.round(ev), parts, unpricedShare };
}
