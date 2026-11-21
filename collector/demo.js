#!/usr/bin/env node
/**
 * Demo / fixture mode. Simulates WoW: Forever auction houses (sellers posting, buyers buying,
 * listings expiring, the odd underpriced posting) behind a fake Battle.net client, then runs
 * the real collector over N simulated days. Used by the tests and to deploy a demo site before
 * Blizzard API credentials exist. Everything it produces is marked demo.
 */
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { collect } from "./collect.js";
import { loadConfig } from "./store.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Demo catalogue: [id, name, quality, class, vendorSell, basePrice (copper), demand units/hour, stack, commodity]
export const CATALOGUE = [
  [2589, "Linen Cloth", "COMMON", "Trade Goods", 13, 350, 40, 20, true],
  [2592, "Wool Cloth", "COMMON", "Trade Goods", 33, 900, 30, 20, true],
  [4306, "Silk Cloth", "COMMON", "Trade Goods", 150, 2400, 25, 20, true],
  [4338, "Mageweave Cloth", "COMMON", "Trade Goods", 250, 4800, 20, 20, true],
  [14047, "Runecloth", "COMMON", "Trade Goods", 400, 9500, 25, 20, true],
  [2770, "Copper Ore", "COMMON", "Trade Goods", 5, 1200, 20, 20, true],
  [2771, "Tin Ore", "COMMON", "Trade Goods", 25, 2600, 12, 20, true],
  [2772, "Iron Ore", "COMMON", "Trade Goods", 150, 5200, 10, 20, true],
  [3858, "Mithril Ore", "COMMON", "Trade Goods", 250, 8000, 10, 20, true],
  [10620, "Thorium Ore", "COMMON", "Trade Goods", 250, 14000, 9, 20, true],
  [2447, "Peacebloom", "COMMON", "Trade Goods", 10, 600, 25, 20, true],
  [765, "Silverleaf", "COMMON", "Trade Goods", 10, 700, 25, 20, true],
  [2449, "Earthroot", "COMMON", "Trade Goods", 15, 1500, 15, 20, true],
  [13468, "Black Lotus", "RARE", "Trade Goods", 1000, 1_400_000, 0.4, 20, true],
  [2318, "Light Leather", "COMMON", "Trade Goods", 15, 900, 20, 20, true],
  [2319, "Medium Leather", "COMMON", "Trade Goods", 25, 1500, 14, 20, true],
  [4234, "Heavy Leather", "COMMON", "Trade Goods", 60, 3000, 12, 20, true],
  [4304, "Thick Leather", "COMMON", "Trade Goods", 100, 5500, 12, 20, true],
  [8170, "Rugged Leather", "COMMON", "Trade Goods", 125, 9000, 14, 20, true],
  [10940, "Strange Dust", "COMMON", "Trade Goods", 0, 1800, 10, 20, true],
  [12363, "Arcane Crystal", "UNCOMMON", "Trade Goods", 0, 380_000, 0.8, 20, true],
  [13446, "Major Healing Potion", "COMMON", "Consumable", 250, 28_000, 4, 5, true],
  [13510, "Flask of the Titans", "COMMON", "Consumable", 1000, 900_000, 0.3, 1, false],
  [2996, "Bolt of Linen Cloth", "COMMON", "Trade Goods", 40, 1000, 15, 10, true],
  [2997, "Bolt of Woolen Cloth", "COMMON", "Trade Goods", 100, 3200, 10, 10, true],
  [4305, "Bolt of Silk Cloth", "COMMON", "Trade Goods", 400, 11000, 8, 10, true],
  [2840, "Copper Bar", "COMMON", "Trade Goods", 10, 1500, 15, 20, true],
  [2568, "Brown Linen Vest", "COMMON", "Armor", 20, 2600, 1.2, 1, false],
  [10939, "Greater Magic Essence", "UNCOMMON", "Trade Goods", 0, 9000, 3, 10, true],
  [10978, "Small Glimmering Shard", "UNCOMMON", "Trade Goods", 0, 12000, 2, 20, true],
  [2320, "Coarse Thread", "COMMON", "Trade Goods", 2, 0, 0, 20, true], // vendor-only: never posted
  [900001, "Demo Blade of the Bear", "UNCOMMON", "Weapon", 4200, 95_000, 0.25, 1, false],
  [900004, "Demo Gloves of the Eagle", "UNCOMMON", "Armor", 600, 9000, 0.8, 1, false],
  [900002, "Demo Cloak of the Owl", "UNCOMMON", "Armor", 1800, 42_000, 0.3, 1, false],
  [900003, "Demo Helm of the Monkey", "UNCOMMON", "Armor", 2600, 60_000, 0.2, 1, false],
];

const HOUSE_LIST = [
  [110, "Alliance Auction House"], [111, "Alliance Auction House"], [112, "Alliance Auction House"],
  [113, "Horde Auction House"], [114, "Horde Auction House"], [115, "Horde Auction House"],
  [116, "Blackwater Auction House"], [117, "Blackwater Auction House"], [118, "Blackwater Auction House"],
  [119, "Alliance Auction House"], [120, "Horde Auction House"], [121, "Blackwater Auction House"],
  [123, "Alliance Auction House"], [124, "Horde Auction House"], [125, "Blackwater Auction House"],
];
const EMPTY = new Set([112, 115, 118]);

function timeLeft(hoursLeft) {
  if (hoursLeft < 0.5) return "SHORT";
  if (hoursLeft < 2) return "MEDIUM";
  if (hoursLeft < 12) return "LONG";
  return "VERY_LONG";
}

/** A simulated market for one region. step(nowMs) advances it to that hour. */
export function createMarket(region, seed = 1) {
  const rand = rng(seed);
  const houses = new Map();
  let nextId = 1_000_000 * (region === "eu" ? 2 : 1);
  for (const [hid] of HOUSE_LIST) {
    if (EMPTY.has(hid)) continue;
    const scale = hid >= 119 ? 0.4 : 1; // smaller groups
    const items = CATALOGUE.map((c) => ({ c, factor: 0.85 + rand() * 0.3, demand: c[6] * scale }));
    houses.set(hid, { items, listings: [] });
  }
  let lastHour = null;

  function post(h, it, nowMs, price) {
    const [id, , , , , , , stack, commodity] = it.c;
    const qty = commodity ? 1 + Math.floor(rand() * stack) : 1;
    const dur = [12, 24, 48][Math.floor(rand() * 3)];
    const a = { id: nextId++, item: { id }, quantity: qty, expires: nowMs + dur * 3_600_000, commodity };
    if (commodity) a.unit_price = price;
    else a.buyout = price * qty;
    h.listings.push(a);
  }

  function step(nowMs) {
    const hour = Math.floor(nowMs / 3_600_000);
    const steps = lastHour == null ? 24 : Math.min(48, hour - lastHour);
    for (let s = steps - 1; s >= 0; s--) {
      const t = nowMs - s * 3_600_000;
      const daily = 1 + 0.08 * Math.sin(((t / 3_600_000) % 24) / 24 * 2 * Math.PI);
      for (const h of houses.values()) {
        h.listings = h.listings.filter((a) => a.expires > t);
        for (const it of h.items) {
          const P = it.c[5] * it.factor * daily;
          // Sellers.
          if (!it.c[5]) continue; // vendor-only item
          const posts = Math.max(0, Math.round(it.demand * (0.8 + rand() * 0.6)));
          for (let i = 0; i < Math.max(posts > 0 ? 1 : 0, Math.round(posts / 4)); i++) {
            let price = P * Math.exp((rand() - 0.4) * 0.3);
            const r = rand();
            if (r < 0.03) price = P * (0.35 + rand() * 0.25); // underpriced posting
            else if (r < 0.04 && it.c[4] > 0) price = it.c[4] * (0.5 + rand() * 0.3); // below vendor
            post(h, it, t, Math.max(1, Math.round(price)));
          }
          // Buyers take the cheapest units up to demand, if priced under 1.3x value.
          let want = it.demand * (0.6 + rand() * 0.8);
          const mine = h.listings.filter((a) => a.item.id === it.c[0]).sort((x, y) => (x.unit_price ?? x.buyout / x.quantity) - (y.unit_price ?? y.buyout / y.quantity));
          for (const a of mine) {
            if (want < 1) break;
            const unit = a.unit_price ?? a.buyout / a.quantity;
            if (unit > P * 1.3) break;
            const n = Math.min(a.quantity, Math.floor(want));
            want -= n;
            if (n >= a.quantity) a.quantity = 0;
            else if (a.commodity) a.quantity -= n;
          }
          h.listings = h.listings.filter((a) => a.quantity > 0);
        }
      }
    }
    lastHour = hour;
  }

  function snapshot(hid, nowMs, commodities) {
    const h = houses.get(hid);
    if (!h) return [];
    return h.listings
      .filter((a) => a.commodity === commodities)
      .map((a) => {
        const out = { id: a.id, item: { id: a.item.id }, quantity: a.quantity, time_left: timeLeft((a.expires - nowMs) / 3_600_000) };
        if (commodities) out.unit_price = a.unit_price;
        else out.buyout = a.buyout;
        return out;
      });
  }
  return { step, snapshot };
}

/** A fake Battle.net client backed by simulated markets. */
export function createDemoClient(seed = 7) {
  const markets = { us: createMarket("us", seed), eu: createMarket("eu", seed + 1) };
  let now = 0;
  let calls = 0;
  const byId = new Map(CATALOGUE.map((c) => [c[0], c]));
  return {
    setNow(ms) {
      now = ms;
      for (const m of Object.values(markets)) m.step(ms);
    },
    callCount: () => calls,
    async get(region, apiPath, ns) {
      calls++;
      const lm = new Date(Math.floor(now / 3_600_000) * 3_600_000).toUTCString();
      let m;
      if (/\/auctions\/$/.test(apiPath)) return { status: 200, lastModified: lm, json: { auctions: HOUSE_LIST.map(([id, name]) => ({ key: { href: `x/auctions/${id}` }, name, id })) } };
      if ((m = apiPath.match(/\/auctions\/(\d+)\/commodities$/))) {
        const list = markets[region].snapshot(Number(m[1]), now, true);
        return { status: 200, lastModified: lm, json: list.length ? { auctions: list } : {} };
      }
      if ((m = apiPath.match(/\/auctions\/(\d+)$/))) {
        const hid = Number(m[1]);
        const list = markets[region].snapshot(hid, now, false);
        const name = HOUSE_LIST.find(([id]) => id === hid)?.[1];
        return { status: 200, lastModified: lm, json: { id: hid, name, ...(list.length ? { auctions: list } : {}) } };
      }
      if ((m = apiPath.match(/\/item\/(\d+)$/))) {
        const c = byId.get(Number(m[1]));
        if (!c || (ns === "static-forever" && c[0] % 3 === 0 && c[0] !== 2320)) return { status: 404, json: null }; // mimic forever gaps
        const cls = { Weapon: 2, Armor: 4, "Trade Goods": 7, Consumable: 0 }[c[3]] ?? 15;
        return { status: 200, json: { name: c[1], quality: { type: c[2] }, item_class: { name: c[3], id: cls }, sell_price: c[4], purchase_price: c[0] === 2320 ? 10 : c[4] * 4, max_count: c[7], level: c[0] >= 900000 ? 18 : c[0] === 2568 ? 10 : 5, required_level: c[0] >= 900000 ? 13 : 0 } };
      }
      if (apiPath === "/data/wow/profession/index") return { status: 200, json: { _links: { self: { href: "https://us.api.blizzard.com/data/wow/profession/?namespace=static-1.60.1_70399-forever-us" } }, professions: [{ id: 197, name: "Tailoring" }, { id: 186, name: "Mining" }] } };
      if ((m = apiPath.match(/\/profession\/(\d+)$/))) return { status: 200, json: { id: Number(m[1]), type: { type: "PRIMARY" }, skill_tiers: [{ id: Number(m[1]) * 10 }] } };
      if ((m = apiPath.match(/\/profession\/(\d+)\/skill-tier\/\d+$/))) {
        const list = Number(m[1]) === 197 ? [2359, 2370, 2376, 2385] : [2657];
        return { status: 200, json: { categories: [{ name: Number(m[1]) === 197 ? "Cloth" : "Smelting", recipes: list.map((id) => ({ id })) }] } };
      }
      if ((m = apiPath.match(/\/recipe\/(\d+)$/))) {
        const R = { 2359: ["Bolt of Linen Cloth", 2996, [[2589, 2]]], 2370: ["Bolt of Woolen Cloth", 2997, [[2592, 3]]], 2376: ["Bolt of Silk Cloth", 4305, [[4306, 4]]], 2385: ["Brown Linen Vest", 2568, [[2996, 1], [2320, 1]]], 2657: ["Smelt Copper", 2840, [[2770, 1]]] }[m[1]];
        if (!R) return { status: 404, json: null };
        return { status: 200, json: { id: Number(m[1]), name: R[0], crafted_item: { id: R[1] }, reagents: R[2].map(([id, quantity]) => ({ reagent: { id }, quantity })), crafted_quantity: { value: 1 } } };
      }
      if (/\/media\/item\//.test(apiPath)) return { status: 404, json: null };
      return { status: 404, json: null };
    },
  };
}

// The client item table isn't simulated: an empty table means everything comes from the (fake) API.
const demoFetchText = async (url) => (url.endsWith("/api/builds") ? JSON.stringify({ wowf: [{ version: "1.60.1.99999" }] }) : "ID,Display_lang,OverallQualityID,ItemLevel,RequiredLevel,SellPrice,BuyPrice,ClassID,SubclassID\n");

export async function buildDemo({ config, outDir, stateDir, days = 6, endMs = Date.now(), log = () => {}, seed = 7 }) {
  const tmpState = stateDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "fw-demo-")));
  const client = createDemoClient(seed);
  const hours = days * 24;
  const start = Math.floor(endMs / 3_600_000) * 3_600_000 - hours * 3_600_000;
  let result;
  for (let i = 0; i <= hours; i++) {
    const t = start + i * 3_600_000;
    client.setNow(t);
    result = await collect({ client, config, stateDir: tmpState, outDir, nowMs: t, log: i === hours ? log : () => {}, demo: true, skipPublish: i !== hours, fetchText: demoFetchText });
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { copySite } = await import("./build-site.js");
  const out = path.resolve(process.argv[2] ?? "_site");
  await copySite(root, out);
  const config = await loadConfig(root);
  const t0 = Date.now();
  const r = await buildDemo({ config, outDir: out, days: Number(process.argv[3] ?? 6), log: console.log });
  console.log(`demo built in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${r.opps.length} opportunities`);
}
