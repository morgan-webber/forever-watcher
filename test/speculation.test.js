import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHistory, recordSnapshot, recordSales, recordTracking } from "../collector/history.js";
import { scoreItem, findSpeculation, logSpeculation, evaluateSpeculation } from "../collector/speculation.js";

const T0 = Date.UTC(2026, 10, 20, 0);
const hr = (i) => T0 + i * 3_600_000;

/** 72 hours: 48 steady hours, then 24 hours shaped by `late(i)` -> { qty, mv, sold, posted }. */
function build(late) {
  const hist = emptyHistory();
  for (let i = 0; i < 72; i++) {
    const s = i < 48 ? { qty: 1000, mv: 100, sold: 2, posted: 2 } : late(i - 48);
    recordSnapshot(hist, hr(i), new Map([["7", { mv: s.mv, min: s.mv, qty: s.qty, n: 20 }]]), 96);
    recordSales(hist, hr(i), new Map([["7", { qty: s.sold, n: 1, value: s.sold * s.mv }]]), new Map(), new Map([["7", s.posted]]));
    recordTracking(hist, hr(i), 1);
  }
  return hist;
}

test("hoarding pattern scores high: supply drains, buyers outpace new supply, price climbs, a buyout hour", () => {
  const hist = build((i) => ({ qty: Math.max(250, 1000 - i * 35), mv: 100 + i * 1.5, sold: i === 5 ? 300 : 5, posted: 1 }));
  const s = scoreItem(hist, "7", hr(71));
  assert.ok(s, "scored");
  assert.equal(s.mode, "hourly");
  assert.ok(s.score >= 70, `score ${s.score}`);
  assert.ok(s.supplyChange < -0.5);
  assert.ok(s.absorption > 1.3);
  assert.ok(s.priceChange > 0.2);
  assert.equal(s.buyouts, 1);
});

test("a steady market is not flagged", () => {
  const hist = build(() => ({ qty: 1000, mv: 100, sold: 2, posted: 2 }));
  const s = scoreItem(hist, "7", hr(71));
  assert.ok(s.score < 25, `score ${s.score}`);
  assert.equal(findSpeculation([{ house: { id: 111 }, hist }], hr(71), { minSoldPerDay: 0.5 }).length, 0);
});

test("speculation backtest: a flagged item counts as a hit when price rises 10% within 3 days", () => {
  const log = [];
  logSpeculation(log, "us", [{ key: "7", house: 111, score: 80, confidence: "medium", mvNow: 100 }], hr(0));
  const hist = emptyHistory();
  for (let i = 1; i <= 80; i++) recordSnapshot(hist, hr(i), new Map([["7", { mv: i === 30 ? 115 : 100, min: 100, qty: 10, n: 1 }]]), 96);
  const res = evaluateSpeculation(log, () => hist, hr(80));
  assert.equal(res.evaluated, 1);
  assert.equal(res.hits, 1);
});
