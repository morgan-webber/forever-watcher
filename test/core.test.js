import { test } from "node:test";
import assert from "node:assert/strict";
import { summarise, itemKey, marketValue } from "../collector/summarise.js";
import { diffLifecycle } from "../collector/lifecycle.js";
import { emptyHistory, recordSnapshot, recordSales, recordTracking, metrics, clearSales } from "../collector/history.js";
import { findOpportunities, depositFor } from "../collector/opportunities.js";
import { groupHouses, parseHouseIndex } from "../collector/houses.js";
import { gold } from "../collector/alerts.js";

test("itemKey keeps gear variants apart", () => {
  assert.equal(itemKey({ id: 2589 }), "2589");
  assert.equal(itemKey({ id: 15215, bonus_lists: [3, 1] }), "15215-1.3");
});

test("summarise prices auctions per unit and skips bid-only for prices", () => {
  const r = summarise([
    { id: 1, item: { id: 5 }, buyout: 500, quantity: 5 },
    { id: 2, item: { id: 5 }, unit_price: 90, quantity: 20 },
    { id: 3, item: { id: 5 }, bid: 3 },
  ]);
  assert.equal(r.listings, 3);
  const s = r.stats.get("5");
  assert.equal(s.min, 90);
  assert.equal(s.qty, 25);
});

test("market value ignores troll listings at both ends", () => {
  assert.ok(marketValue([[100, 10], [105, 10], [110, 10], [100000, 1]], 31) <= 105);
  const v = marketValue([[1, 1], [100, 5], [105, 5], [110, 5]], 16);
  assert.ok(v >= 100 && v <= 110, `lone 1c listing must not set the value (got ${v})`);
});

test("lifecycle: LONG disappearances are sales, SHORT/MEDIUM expiries, partial buys counted", () => {
  const prev = { 1: ["5", 100, 1, "LONG"], 2: ["5", 100, 1, "SHORT"], 3: ["6", 50, 20, "VERY_LONG"], 4: ["5", 100, 1, "MEDIUM"] };
  const cur = [{ id: 3, key: "6", unit: 50, qty: 15, tl: "VERY_LONG" }];
  const d = diffLifecycle(prev, cur, { gapOk: true });
  assert.equal(d.sold.get("5").qty, 1);
  assert.equal(d.expired.get("5").qty, 2);
  assert.equal(d.sold.get("6").qty, 5);
  const none = diffLifecycle(prev, cur, { gapOk: false });
  assert.equal(none.sold.size, 0);
});

test("groupHouses assigns the nth house of each faction to group n", () => {
  const list = parseHouseIndex({ auctions: [
    { id: 110, name: "Alliance Auction House" }, { id: 113, name: "Horde Auction House" }, { id: 116, name: "Blackwater Auction House" },
    { id: 111, name: "Alliance Auction House" }, { id: 114, name: "Horde Auction House" }, { id: 117, name: "Blackwater Auction House" },
  ] });
  const g = groupHouses(list, { 2: "Normal" });
  assert.deepEqual(g.filter((h) => h.group === 2).map((h) => h.id), [111, 114, 117]);
  assert.equal(g.find((h) => h.id === 114).groupName, "Normal");
});

test("flip is found, capped by sales velocity, and priced under the next competitor", () => {
  const hist = emptyHistory();
  const H0 = Date.UTC(2026, 10, 1);
  // 5 days of steady prices around 100c and ~24 sales/day.
  for (let i = 0; i < 5 * 24; i++) {
    const t = H0 + i * 3_600_000;
    recordSnapshot(hist, t, new Map([["5", { mv: 100, min: 95, qty: 200, n: 10 }]]), 96);
    recordSales(hist, t, new Map([["5", { qty: 1, n: 1, value: 100 }]]), new Map([["5", { qty: 1 }]]));
    recordTracking(hist, t, 1);
  }
  const now = H0 + 5 * 24 * 3_600_000;
  const ladder = [[40, 10], [45, 20], [98, 50], [100, 50]];
  const houses = [{ house: { id: 110, group: 1, faction: "alliance" }, ladders: new Map([["5", ladder]]), hist }];
  const settings = { flipThreshold: 0.7, horizonDays: 3, minProfitCopper: 1, minRoi: 0.1, arbMinProfitCopper: 1, minSoldPerDay: 0.5, maxOppsPerRegion: 10, baselineDays: 14, velocityDays: 7 };
  const opps = findOpportunities("us", houses, {}, settings, { cutRate: 0.05, depositMinCopper: 1, depositVendorRate: 0 }, now);
  const flip = opps.find((o) => o.type === "flip");
  assert.ok(flip, "flip found");
  const m = metrics(hist, "5", now, settings);
  assert.ok(flip.units <= Math.floor(m.soldPerDay * 3));
  assert.ok(flip.sellAt <= 97, "undercuts the 98c competitor");
  assert.ok(flip.buyMax <= 70);

  // When more cheap stock is listed than the market absorbs in the horizon, the leftover cheap
  // listings undercut the relist, so no flip should be flagged.
  houses[0].ladders = new Map([["5", [[40, 10], [45, 500], [98, 50]]]]);
  const none = findOpportunities("us", houses, {}, settings, { cutRate: 0.05, depositMinCopper: 1, depositVendorRate: 0 }, now);
  assert.equal(none.filter((o) => o.type === "flip").length, 0);
});

test("deposit has a minimum and gold formats copper", () => {
  assert.equal(depositFor(0, 10, { depositMinCopper: 100, depositVendorRate: 0.15 }), 100);
  assert.equal(gold(1234567), "123g 45s 67c");
});

test("hourly points carry estimated sales and keep them across a same-hour rescan", () => {
  const hist = emptyHistory();
  const t = Date.UTC(2026, 10, 21, 10, 5);
  recordSnapshot(hist, t, new Map([["5", { mv: 100, min: 90, qty: 50, n: 5 }]]), 96);
  recordSales(hist, t, new Map([["5", { qty: 7, n: 2, value: 700 }]]), new Map());
  assert.equal(hist.items["5"].h.at(-1)[5], 7);
  recordSnapshot(hist, t + 20 * 60000, new Map([["5", { mv: 101, min: 91, qty: 45, n: 5 }]]), 96);
  assert.equal(hist.items["5"].h.length, 1);
  assert.equal(hist.items["5"].h[0][5], 7, "sales survive the rescan");
  assert.equal(hist.items["5"].h[0][1], 101);
});

test("lifecycle: cancel-and-repost of the same stack size is not counted as a sale", () => {
  const prev = { 1: ["5", 100, 20, "LONG"], 2: ["5", 100, 20, "LONG"], 3: ["5", 100, 5, "VERY_LONG"] };
  // Both 20-stacks reposted under new ids at a lower price; the 5-stack really sold.
  const cur = [{ id: 10, key: "5", unit: 95, qty: 20, tl: "VERY_LONG" }, { id: 11, key: "5", unit: 95, qty: 20, tl: "VERY_LONG" }];
  const d = diffLifecycle(prev, cur, { gapOk: true });
  assert.equal(d.reposted, 2);
  assert.equal(d.sold.get("5").qty, 5);
});

test("clearSales keeps prices and drops sales", () => {
  const hist = emptyHistory();
  const t = Date.UTC(2026, 10, 21, 10);
  recordSnapshot(hist, t, new Map([["5", { mv: 100, min: 90, qty: 50, n: 5 }]]), 96);
  recordSales(hist, t, new Map([["5", { qty: 7, n: 2, value: 700 }]]), new Map([["5", { qty: 3 }]]));
  recordTracking(hist, t, 1);
  clearSales(hist);
  const e = hist.items["5"];
  assert.equal(e.h[0].length, 5);
  assert.equal(e.h[0][1], 100);
  assert.deepEqual([e.d[0][4], e.d[0][5], e.d[0][6]], [0, 0, 0]);
  assert.deepEqual(hist.track, {});
});

test("arbitrage only between a faction house and Blackwater, never Alliance <-> Horde", () => {
  const hist = () => {
    const h = emptyHistory();
    const H0 = Date.UTC(2026, 10, 1);
    for (let i = 0; i < 5 * 24; i++) {
      const t = H0 + i * 3_600_000;
      recordSnapshot(h, t, new Map([["5", { mv: 1000, min: 1000, qty: 200, n: 10 }]]), 96);
      recordSales(h, t, new Map([["5", { qty: 1, n: 1, value: 1000 }]]), new Map());
      recordTracking(h, t, 1);
    }
    return h;
  };
  const now = Date.UTC(2026, 10, 1) + 5 * 24 * 3_600_000;
  const cheap = new Map([["5", [[300, 50]]]]);
  const dear = new Map([["5", [[1000, 50]]]]);
  const settings = { flipThreshold: 0.1, horizonDays: 3, minProfitCopper: 1, minRoi: 0.1, arbMinProfitCopper: 1, minSoldPerDay: 0.5, maxOppsPerRegion: 50, baselineDays: 14, velocityDays: 7 };
  const fees = { cutRate: 0.05, depositMinCopper: 1, depositVendorRate: 0 };
  const run = (sellerFaction) => findOpportunities("us", [
    { house: { id: 111, group: 2, faction: "alliance" }, ladders: cheap, hist: hist() },
    { house: { id: 114, group: 2, faction: sellerFaction }, ladders: dear, hist: hist() },
  ], {}, settings, fees, now).filter((o) => o.type === "arbitrage");
  assert.equal(run("horde").length, 0, "Alliance -> Horde is impossible");
  const viaBlackwater = run("neutral");
  assert.equal(viaBlackwater.length, 1, "Alliance -> Blackwater is a real trade");
  assert.match(viaBlackwater[0].note, /Alliance character/);
});
