import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../collector/blizzard.js";

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith("https://oauth.battle.net/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    for (const [re, handler] of routes) if (re.test(u)) return handler(u, init, calls);
    return new Response("{}", { status: 404 });
  };
  return { fn, calls };
}

test("client sends bearer token, namespace, locale and If-Modified-Since; returns 304 untouched", async () => {
  const { fn, calls } = mockFetch([[/auctions\/110/, (u, init) => (init.headers["If-Modified-Since"] ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ auctions: [] }), { status: 200, headers: { "last-modified": "Fri, 20 Nov 2026 22:00:00 GMT" } }))]]);
  const c = createClient({ clientId: "a", clientSecret: "b", fetchImpl: fn, minGapMs: 0 });
  const r1 = await c.get("us", "/data/wow/ruleset/2/auctions/110", "dynamic-forever", { locale: "en_US" });
  assert.equal(r1.status, 200);
  assert.equal(r1.lastModified, "Fri, 20 Nov 2026 22:00:00 GMT");
  const req = calls.find((x) => x.url.includes("auctions/110"));
  assert.match(req.url, /namespace=dynamic-forever-us/);
  assert.match(req.url, /locale=en_US/);
  assert.equal(req.init.headers.Authorization, "Bearer tok");
  const r2 = await c.get("us", "/data/wow/ruleset/2/auctions/110", "dynamic-forever", { ifModifiedSince: r1.lastModified });
  assert.equal(r2.status, 304);
  assert.equal(calls.filter((x) => x.url.startsWith("https://oauth")).length, 1, "token cached");
});

test("client retries 429 and 5xx, returns 404 without throwing", async () => {
  let n = 0;
  const { fn } = mockFetch([[/item\/1\?/, () => (++n < 2 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response(JSON.stringify({ name: "x" }), { status: 200 }))]]);
  const c = createClient({ clientId: "a", clientSecret: "b", fetchImpl: fn, minGapMs: 0, log: () => {} });
  const r = await c.get("us", "/data/wow/item/1", "static-forever");
  assert.equal(r.json.name, "x");
  const miss = await c.get("us", "/data/wow/item/2", "static-forever");
  assert.equal(miss.status, 404);
});
