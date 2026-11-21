/**
 * Item metadata cache: { [itemId]: { n, q, c, sc, sell, buy, stack, icon, src, t } }
 * n name, q quality, c class, sc subclass, sell vendor sell price (copper), icon slug,
 * src "forever" | "retail" | "missing", t epoch ms of last lookup.
 *
 * static-forever 404s for a large share of items (about 43% in one house); those fall back
 * to the retail item endpoint for name, quality and class. Retail stats may differ from
 * Forever's, so only descriptive fields are used.
 */
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
  };
}

export async function backfillItems(client, db, ids, { region, locale, limit, now = Date.now(), log = console.log, concurrency = 8 }) {
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
    e.icon = (await iconFor(client, region, locale, id, e.src === "retail" ? "static" : "static-forever")) ?? null;
    e.iconChecked = true;
  };
  // A few lookups in flight at once; the client spaces requests to stay under 100/s.
  const jobs = [...batch.map((id) => () => work(id)), ...iconBatch.map((id) => () => iconWork(id))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
  log(`  items: ${batch.length} looked up (${ok} forever, ${fallback} retail fallback, ${missing} missing), ${todo.length - batch.length} still queued; ${iconBatch.length} icons refreshed`);
  return { looked: batch.length, queued: todo.length - batch.length };
}
