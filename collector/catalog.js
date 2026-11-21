/**
 * Game catalog: recipes (Blizzard API) and the client item table (fallback item data).
 *
 * Recipes come from Blizzard's Game Data API, static-forever namespace:
 *   /data/wow/profession/index -> /profession/{id} -> /profession/{id}/skill-tier/{tier}
 *   -> /recipe/{id} (reagents, crafted item, crafted quantity).
 * Crawled when missing, when the static build changes, or weekly.
 *
 * The client item table is Blizzard's own ItemSparse/Item game data from the Forever client,
 * mirrored by wago.tools. It is used only where the item API has no Forever entry (it 404s for
 * a large share of items), so names, quality, item level and vendor prices stay Forever's.
 */
const WEEK = 7 * 86_400_000;
export const QUALITY = ["POOR", "COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "ARTIFACT", "HEIRLOOM"];
export const ITEM_CLASS = { 0: "Consumable", 1: "Container", 2: "Weapon", 3: "Gem", 4: "Armor", 5: "Reagent", 6: "Projectile", 7: "Trade Goods", 9: "Recipe", 11: "Quiver", 12: "Quest", 13: "Key", 15: "Miscellaneous" };

const buildOf = (json) => String(json?._links?.self?.href ?? "").match(/namespace=static-([\d._]+)-forever/)?.[1] ?? null;

export async function refreshRecipes(client, current, { region = "us", locale = "en_US", now = Date.now(), log = console.log, concurrency = 8, force = false } = {}) {
  const idx = await client.get(region, "/data/wow/profession/index", "static-forever", { locale });
  if (!idx.json) {
    log(`  recipes: profession index unavailable (HTTP ${idx.status})`);
    return current;
  }
  const build = buildOf(idx.json);
  if (!force && current?.recipes?.length && current.build === build && now - current.fetchedAt < WEEK) return current;

  const professions = {};
  const tiers = [];
  for (const p of idx.json.professions ?? []) {
    const d = await client.get(region, `/data/wow/profession/${p.id}`, "static-forever", { locale });
    professions[p.id] = { name: p.name, type: d.json?.type?.type ?? null };
    for (const t of d.json?.skill_tiers ?? []) tiers.push({ prof: p.id, tier: t.id });
  }
  const refs = [];
  for (const t of tiers) {
    const d = await client.get(region, `/data/wow/profession/${t.prof}/skill-tier/${t.tier}`, "static-forever", { locale });
    for (const c of d.json?.categories ?? []) for (const r of c.recipes ?? []) refs.push({ id: r.id, prof: t.prof, cat: c.name });
  }
  const seen = new Set();
  const unique = refs.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
  const recipes = [];
  let next = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < unique.length) {
      const ref = unique[next++];
      try {
        const r = await client.get(region, `/data/wow/recipe/${ref.id}`, "static-forever", { locale });
        const j = r.json;
        if (!j) { failed++; continue; }
        const crafted = j.crafted_item ?? j.alliance_crafted_item ?? j.horde_crafted_item ?? null;
        const q = j.crafted_quantity ?? {};
        recipes.push([
          j.id, j.name, ref.prof, ref.cat, crafted?.id ?? null,
          q.value ?? q.minimum ?? 1, q.value ?? q.maximum ?? 1,
          (j.reagents ?? []).map((x) => [x.reagent?.id, x.quantity]).filter((x) => x[0]),
        ]);
      } catch {
        failed++;
      }
    }
  }));
  recipes.sort((a, b) => a[0] - b[0]);
  log(`  recipes: ${recipes.length} recipes across ${Object.keys(professions).length} professions (build ${build ?? "?"}${failed ? `, ${failed} failed` : ""})`);
  if (!recipes.length) return current;
  return { build, fetchedAt: now, professions, recipes };
}

/** Minimal CSV parser (quoted fields, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function table(text, cols) {
  const rows = parseCsv(text);
  const head = rows.shift() ?? [];
  const at = Object.fromEntries(Object.entries(cols).map(([k, name]) => [k, head.indexOf(name)]));
  return { rows, at };
}

/**
 * Forever client item table via wago.tools. Returns { build, fetchedAt, items: { id: [name, quality,
 * itemLevel, requiredLevel, sellPrice, classId, subclassId, buyPrice] } } or the current value if unchanged.
 */
export async function refreshClientItems(current, { fetchText, now = Date.now(), log = console.log } = {}) {
  try {
    const builds = JSON.parse(await fetchText("https://wago.tools/api/builds"));
    const build = (builds.wowf ?? []).map((b) => b.version).find((v) => String(v).startsWith("1.")) ?? null;
    if (!build) {
      log("  client items: no Forever (wowf) build listed on wago.tools");
      return current;
    }
    if (current?.build === build && current.items && now - current.fetchedAt < 4 * WEEK) return current;
    const csv = (t) => fetchText(`https://wago.tools/db2/${t}/csv?build=${encodeURIComponent(build)}`);
    const [sparse, item] = await Promise.all([csv("ItemSparse"), csv("Item")]);
    const S = table(sparse, { id: "ID", name: "Display_lang", q: "OverallQualityID", lvl: "ItemLevel", rl: "RequiredLevel", sell: "SellPrice", buy: "BuyPrice" });
    const I = table(item, { id: "ID", cls: "ClassID", sub: "SubclassID" });
    if (S.at.id < 0 || S.at.name < 0) {
      log("  client items: ItemSparse columns not recognised; skipping");
      return current;
    }
    const cls = new Map(I.rows.map((r) => [Number(r[I.at.id]), [Number(r[I.at.cls]), Number(r[I.at.sub])]]));
    const items = {};
    for (const r of S.rows) {
      const id = Number(r[S.at.id]);
      if (!id) continue;
      const c = cls.get(id) ?? [null, null];
      const num = (k) => (S.at[k] >= 0 ? Number(r[S.at[k]]) || 0 : null);
      items[id] = [r[S.at.name], num("q"), num("lvl"), num("rl"), num("sell"), c[0], c[1], num("buy")];
    }
    log(`  client items: ${Object.keys(items).length} items from Forever client build ${build}`);
    return { build, fetchedAt: now, items };
  } catch (e) {
    log(`  client items: ${e.message}`);
    return current;
  }
}

/** Item metadata from a client-table row, in the items-db shape. */
export function fromClient(row) {
  const [n, q, lvl, rl, sell, cid, , buy] = row;
  return { n, q: QUALITY[q] ?? "COMMON", c: ITEM_CLASS[cid] ?? null, cid, sell: sell ?? 0, buy: buy ?? 0, lvl, rl };
}
