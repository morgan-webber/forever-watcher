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

function iconSlug(url) {
  return url ? String(url).split("/").pop().replace(/\.(jpg|png)$/i, "") : null;
}

async function lookup(client, region, locale, id, ns) {
  const r = await client.get(region, `/data/wow/item/${id}`, ns, { locale });
  if (r.status === 404 || !r.json) return null;
  const j = r.json;
  let icon = null;
  try {
    const m = await client.get(region, `/data/wow/media/item/${id}`, ns, { locale });
    icon = iconSlug(m.json?.assets?.find((a) => a.key === "icon")?.value ?? m.json?.assets?.[0]?.value);
  } catch {
    /* icon is optional */
  }
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
  const batch = todo.slice(0, limit);
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
  // A few lookups in flight at once; the client spaces requests to stay under 100/s.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
    while (next < batch.length) await work(batch[next++]);
  }));
  log(`  items: ${batch.length} looked up (${ok} forever, ${fallback} retail fallback, ${missing} missing), ${todo.length - batch.length} still queued`);
  return { looked: batch.length, queued: todo.length - batch.length };
}
