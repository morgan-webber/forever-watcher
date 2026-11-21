import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHistory, recordSnapshot, recordSales, recordTracking } from "../collector/history.js";
import { findCrafts, findDisenchants, resolveVendorIds } from "../collector/crafting.js";
import { outcomes, deValue } from "../collector/disenchant.js";
import { statsOf } from "../collector/summarise.js";
import { parseCsv, cleanCatalog } from "../collector/catalog.js";

const settings = { flipThreshold: 0.7, horizonDays: 3, minProfitCopper: 1, minRoi: 0.1, arbMinProfitCopper: 1, minSoldPerDay: 0.5, maxOppsPerRegion: 50, baselineDays: 14, velocityDays: 7 };
const fees = { cutRate: 0.05, depositMinCopper: 1, depositVendorRate: 0 };
const H0 = Date.UTC(2026, 10, 1);
const now = H0 + 5 * 24 * 3_600_000;

function steadyHistory(prices) {
  const hist = emptyHistory();
  for (let i = 0; i < 5 * 24; i++) {
    const t = H0 + i * 3_600_000;
    recordSnapshot(hist, t, new Map(Object.entries(prices).map(([k, v]) => [k, { mv: v, min: v, qty: 100, n: 10 }])), 96);
    recordSales(hist, t, new Map(Object.keys(prices).map((k) => [k, { qty: 1, n: 1, value: prices[k] }])), new Map());
    recordTracking(hist, t, 1);
  }
  return hist;
}

test("craft: reagents bought off the ladder, vendor reagent priced at vendor, product capped by sales", () => {
  const hist = steadyHistory({ 2996: 1000 });
  const ladders = new Map([["2589", [[300, 1000]]], ["2996", [[1000, 50]]]]);
  const house = { house: { id: 111 }, ladders, stats: statsOf(ladders), hist };
  const items = { 2320: { n: "Coarse Thread", buy: 10, src: "forever" }, 2996: { n: "Bolt of Linen Cloth", sell: 40, src: "forever" } };
  const catalog = { professions: { 197: { name: "Tailoring" } }, recipes: [[2359, "Bolt of Linen Cloth", 197, "Cloth", 2996, 1, 1, [[2589, 2], [2320, 1]]]] };
  const vendorIds = resolveVendorIds(items, ["Coarse Thread"]);
  const [o] = findCrafts("us", [house], items, catalog, settings, fees, now, vendorIds);
  assert.ok(o, "craft found");
  assert.equal(o.crafts, 72, "24 sold/day x 3 days");
  assert.equal(o.cost, 72 * (2 * 300 + 10));
  assert.deepEqual(o.parts.map((p) => p[3]), ["ah", "vendor"]);
  assert.ok(o.sellAt <= 999);
});

test("craft: skipped when a reagent can't be bought in quantity and isn't a vendor item", () => {
  const hist = steadyHistory({ 2996: 1000 });
  const ladders = new Map([["2589", [[300, 3]]], ["2996", [[1000, 50]]]]);
  const house = { house: { id: 111 }, ladders, stats: statsOf(ladders), hist };
  const catalog = { professions: {}, recipes: [[2359, "Bolt", 197, "Cloth", 2996, 1, 1, [[2589, 2]]]] };
  assert.equal(findCrafts("us", [house], {}, catalog, settings, fees, now, new Set()).length, 0);
});

test("disenchant table: level 18 green armor and weapons, rare and epic lookups", () => {
  const armor = outcomes({ lvl: 18, cid: 4, q: "UNCOMMON" });
  assert.deepEqual(armor.map((o) => [o.name, o.p]), [["Strange Dust", 0.75], ["Greater Magic Essence", 0.2], ["Small Glimmering Shard", 0.05]]);
  assert.equal(outcomes({ lvl: 18, cid: 2, q: "UNCOMMON" })[1].p, 0.75);
  assert.equal(outcomes({ lvl: 58, cid: 4, q: "RARE" })[0].name, "Large Brilliant Shard");
  assert.equal(outcomes({ lvl: 58, cid: 4, q: "COMMON" }), null);
  assert.equal(outcomes({ lvl: 58, cid: 7, q: "UNCOMMON" }), null, "trade goods can't be disenchanted");
  const v = deValue({ lvl: 18, cid: 4, q: "UNCOMMON" }, (n) => ({ "Strange Dust": 2000, "Greater Magic Essence": 10000, "Small Glimmering Shard": 12000 })[n], 0);
  assert.equal(v.ev, Math.round(0.75 * 2.5 * 2000 + 0.2 * 1.5 * 10000 + 0.05 * 12000));
});

test("disenchant opportunity: buys greens priced under their material value", () => {
  const hist = steadyHistory({ 10940: 2000, 10939: 10000, 10978: 12000 });
  const ladders = new Map([["900004", [[2000, 1], [2500, 1], [50000, 1]]], ["10940", [[2000, 100]]], ["10939", [[10000, 100]]], ["10978", [[12000, 100]]]]);
  const house = { house: { id: 111 }, ladders, stats: statsOf(ladders), hist };
  const items = { 900004: { n: "Gloves", lvl: 18, cid: 4, q: "UNCOMMON" }, 10940: { n: "Strange Dust" }, 10939: { n: "Greater Magic Essence" }, 10978: { n: "Small Glimmering Shard" } };
  const [o] = findDisenchants("us", [house], items, settings, fees, now);
  assert.equal(o.type, "disenchant");
  assert.equal(o.units, 2, "skips the 5g listing");
  assert.ok(["A", "B", "C", "D"].includes(o.grade) && o.grade !== "A", "grade capped below A: odds are unverified");
});

test("csv parser handles quotes, commas and newlines in fields", () => {
  assert.deepEqual(parseCsv('ID,Name\n1,"Bolt, Linen"\n2,"Say ""hi"""\n'), [["ID", "Name"], ["1", "Bolt, Linen"], ["2", 'Say "hi"']]);
});

test("retail-sourced items are never disenchant-valued; internal professions are dropped", () => {
  assert.equal(outcomes({ lvl: 18, cid: 4, q: "UNCOMMON", src: "retail" }), null);
  const c = cleanCatalog({ professions: { 197: { name: "Tailoring" }, 2933: { name: "Test Profession [DNT]" } }, recipes: [[1, "Bolt", 197, "", 2, 1, 1, []], [2, "x", 2933, "", 3, 1, 1, []]] });
  assert.deepEqual(Object.keys(c.professions), ["197"]);
  assert.equal(c.recipes.length, 1);
});
