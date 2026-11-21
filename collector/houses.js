/**
 * Forever has no realms. Each region lists 15 auction houses under any ruleset id:
 * five each of Alliance, Horde and Blackwater (neutral). Community testing indicates the
 * houses form groups (one per ruleset): the nth Alliance, nth Horde and nth Blackwater house
 * by id share a ruleset. Arbitrage is only offered between houses in the same group.
 */
export function factionOf(name = "") {
  const n = name.toLowerCase();
  if (n.includes("alliance")) return "alliance";
  if (n.includes("horde")) return "horde";
  if (n.includes("blackwater") || n.includes("neutral")) return "neutral";
  return "unknown";
}

export function groupHouses(list, groupNames = {}) {
  const sorted = [...list].sort((a, b) => a.id - b.id);
  const seen = {};
  return sorted.map((h) => {
    const faction = factionOf(h.name);
    seen[faction] = (seen[faction] ?? 0) + 1;
    const group = seen[faction];
    return { id: h.id, name: h.name, faction, group, groupName: groupNames[group] ?? `Group ${group}` };
  });
}

/** Parses the house index response: { auctions: [{ key, name, id }] }. */
export function parseHouseIndex(json) {
  const arr = json?.auctions ?? json?.auction_houses ?? [];
  return arr
    .map((h) => ({ id: Number(h.id ?? String(h.key?.href ?? "").match(/auctions\/(\d+)/)?.[1]), name: String(h.name ?? "") }))
    .filter((h) => Number.isFinite(h.id));
}

/** Can one character trade between these two houses without a cross-faction transfer? */
export function routeNote(a, b) {
  if (a.faction === b.faction) return "same house faction";
  if (a.faction === "neutral" || b.faction === "neutral") return "one character can do it";
  return "cross-faction: relay through Blackwater";
}
