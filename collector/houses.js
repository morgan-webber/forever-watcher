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

/**
 * Who can trade where: Alliance characters use the Alliance house and Blackwater; Horde characters
 * use the Horde house and Blackwater. Goods can't move between the Alliance and Horde houses, so
 * cross-house trades are only ever faction house <-> Blackwater, within one group (ruleset).
 */
export function canTrade(a, b) {
  if (a.group !== b.group) return false;
  if (a.id === b.id) return true;
  return a.faction === "neutral" || b.faction === "neutral";
}

/** The faction whose characters can make this trade. */
export function tradeFaction(a, b) {
  const f = a.faction === "neutral" ? b.faction : a.faction;
  return f === "neutral" ? "either faction" : f === "alliance" ? "Alliance" : "Horde";
}

export function routeNote(a, b) {
  return `one ${tradeFaction(a, b)} character: ${a.faction === "neutral" ? "Blackwater" : "faction house"} to ${b.faction === "neutral" ? "Blackwater" : "faction house"}`;
}

/** AH cut when selling in this house (Blackwater can be set separately). */
export function cutFor(house, fees) {
  return house?.faction === "neutral" ? fees.neutralCutRate ?? fees.cutRate ?? 0.05 : fees.cutRate ?? 0.05;
}
