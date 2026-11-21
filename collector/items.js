/**
 * Item metadata cache: { [itemId]: { n, q, c, sc, sell, buy, stack, icon, src, t } }
 * n name, q quality, c class, sc subclass, sell vendor sell price (copper), icon slug,
 * src "forever" | "retail" | "missing", t epoch ms of last lookup.
 *
 * static-forever 404s for a large share of items (about 43% in one house); those fall back
 * to the retail item endpoint for name, quality and class. Retail stats may differ from
 * Forever's, so only descriptive fields are used.
 */
import { fromClient } from "./catalog.js";

const RETRY_MISSING_MS = 7 * 86_400_000;

/** The icon URL exactly as Blizzard's media endpoint returns it. */
async function iconFor(client, region, locale, id, ns) {
  try {
    const m = await client.get(region, `/data/wow/media/item/${id}`, ns, { locale });
    return m.json?.assets?.find((a) => a.key === "icon")?.value ?? m.json?.assets?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function lookup(client, region, locale, id, ns) {
  const r = await client.get(region, `/data/wow/item/${id}`, ns, { locale });
  if (r.status === 404 || !r.json) return null;
  const j = r.json;
  const icon = await iconFor(client, region, locale, id, ns);
  return {
    n: j.name ?? `Item ${id}`,
    q: j.quality?.type ?? "COMMON",
    c: j.item_class?.name ?? null,
    sc: j.item_subclass?.name ?? null,
    sell: j.sell_price ?? 0,
    buy: j.purchase_price ?? 0,
    stack: j.max_count ?? null,
    icon,
    lvl: j.level ?? null,
    rl: j.required_level ?? null,
    cid: j.item_class?.id ?? null,
  };
}

export async function backfillItems(client, db, ids, { region, locale, limit, now = Date.now(), log = console.log, concurrency = 8, clientItems = null }) {
  // Upgrade earlier entries from the Forever client table: retail fallbacks become Forever data,
  // and Forever entries gain item level and class if they predate those fields.
  let upgraded = 0;
  if (clientItems) {
    for (const id of ids) {
      const e = db[id];
      const row = clientItems[id];
      if (!e || !row) continue;
      if (e.src === "retail" || e.src === "missing") {
        db[id] = { ...fromClient(row), icon: e.icon ?? null, iconChecked: e.iconChecked, src: "client", t: now };
        upgraded++;
      } else if (e.lvl === undefined) {
        const c = fromClient(row);
        Object.assign(e, { lvl: c.lvl, rl: c.rl, cid: c.cid });
        upgraded++;
      }
    }
  }
  const todo = [];
  for (const id of ids) {
    const e = db[id];
    if (!e || (e.src === "missing" && now - e.t > RETRY_MISSING_MS)) todo.push(id);
  }
  // Entries cached before icons were stored as full URLs: refresh just the icon.
  const iconTodo = ids.filter((id) => db[id] && db[id].src !== "missing" && db[id].icon !== undefined && !String(db[id].icon ?? "").startsWith("http") && !db[id].iconChecked);
  const batch = todo.slice(0, limit);
  const iconBatch = iconTodo.slice(0, Math.max(0, limit - batch.length) * 2);
  let ok = 0;
  let fallback = 0;
  let missing = 0;
  const work = async (id) => {
    try {
      let meta = await lookup(client, region, locale, id, "static-forever");
      let src = "forever";
      if (!meta && clientItems?.[id]) {
        // Forever API has no entry: use the Forever client table; take only the icon from retail.
        meta = { ...fromClient(clientItems[id]), icon: await iconFor(client, region, locale, id, "static") };
        src = "client";
      }
      if (!meta) {
        meta = await lookup(client, region, locale, id, "static");
        src = "retail";
      }
      if (meta) {
        db[id] = { ...meta, src, t: now };
        src === "forever" ? ok++ : fallback++;
      } else {
        db[id] = { n: `Item ${id}`, q: "COMMON", sell: 0, src: "missing", t: now };
        missing++;
      }
    } catch (e) {
      log(`  item ${id}: ${e.message}`);
    }
  };
  const iconWork = async (id) => {
    const e = db[id];
    e.icon = (await iconFor(client, region, locale, id, e.src === "forever" ? "static-forever" : "static")) ?? null;
    e.iconChecked = true;
  };
  // A few lookups in flight at once; the client spaces requests to stay under 100/s.
  const jobs = [...batch.map((id) => () => work(id)), ...iconBatch.map((id) => () => iconWork(id))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
  log(`  items: ${batch.length} looked up (${ok} forever, ${fallback} fallback, ${missing} missing), ${todo.length - batch.length} still queued; ${iconBatch.length} icons refreshed; ${upgraded} upgraded from the client table`);
  return { looked: batch.length, queued: todo.length - batch.length };
}
