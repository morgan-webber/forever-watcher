/**
 * Discord alerts. Posts to the DISCORD_WEBHOOK_URL secret.
 * Two sources: top new opportunities (config/alerts.json -> opportunities) and price rules
 * (config/alerts.json -> rules). Each alert has a cooldown so it doesn't repeat every hour.
 */
import { gradeRank } from "./opportunities.js";
import { baseId } from "./summarise.js";

export function gold(c) {
  if (c == null) return "-";
  const neg = c < 0;
  c = Math.abs(Math.round(c));
  const g = Math.floor(c / 10000);
  const s = Math.floor((c % 10000) / 100);
  const cc = c % 100;
  const parts = [];
  if (g) parts.push(`${g.toLocaleString("en-US")}g`);
  if (s || g) parts.push(`${s}s`);
  parts.push(`${cc}c`);
  return (neg ? "-" : "") + parts.join(" ");
}

export function collectAlerts({ config, opps, current, items, houseName, sent, nowMs, siteUrl }) {
  const out = [];
  if (!config?.enabled) return out;
  const cooldown = (config.cooldownHours ?? 6) * 3_600_000;
  const fresh = (id) => !sent[id] || nowMs - sent[id] > cooldown;
  const name = (key) => items[baseId(key)]?.n ?? `Item ${key}`;
  const link = (region, key) => (siteUrl ? `${siteUrl}#/item/${region}/${key}` : "");

  const oc = config.opportunities;
  if (oc) {
    let n = 0;
    for (const o of opps) {
      if (n >= (oc.maxPerRun ?? 10)) break;
      if (o.ev < (oc.minProfitCopper ?? 0)) continue;
      if (gradeRank(o.grade) < gradeRank(oc.minGrade ?? "D")) continue;
      if (oc.types?.length && !oc.types.includes(o.type)) continue;
      if (oc.regions?.length && !oc.regions.includes(o.region)) continue;
      const id = `opp|${o.type}|${o.region}|${o.key}|${o.buy}|${o.sell}`;
      if (!fresh(id)) continue;
      sent[id] = nowMs;
      n++;
      const where = o.type === "arbitrage" ? `buy in ${houseName(o.region, o.buy)}, sell in ${houseName(o.region, o.sell)}` : `${houseName(o.region, o.buy)}`;
      out.push(
        `**${o.type.toUpperCase()}** ${name(o.key)} (${o.region.toUpperCase()}, ${where})\n` +
          `Buy ${o.units} at <= ${gold(o.buyMax)} (cost ${gold(o.cost)}), ` +
          (o.type === "vendor" ? `vendor for ${gold(o.sellAt)} each. ` : `relist at ${gold(o.sellAt)}. `) +
          `Expected profit **${gold(o.ev)}** (${Math.round(o.roi * 100)}% ROI), grade ${o.grade}. ${link(o.region, o.key)}`,
      );
    }
  }

  for (const r of config.rules ?? []) {
    if (r.item == null || r.region == null) continue;
    const key = String(r.item);
    for (const [hid, stats] of current[r.region] ?? []) {
      if (r.house !== "any" && Number(r.house) !== hid) continue;
      const st = stats.get(key);
      if (!st) continue;
      const hit = (r.below != null && st.min <= r.below) || (r.above != null && st.mv >= r.above);
      const id = `rule|${r.region}|${hid}|${key}|${r.below ?? ""}|${r.above ?? ""}`;
      if (!hit || !fresh(id)) continue;
      sent[id] = nowMs;
      out.push(
        `**PRICE ALERT** ${name(key)} in ${houseName(r.region, hid)} (${r.region.toUpperCase()}): ` +
          `min buyout ${gold(st.min)}, market value ${gold(st.mv)}, ${st.qty} listed. ${link(r.region, key)}`,
      );
    }
  }
  for (const [id, t] of Object.entries(sent)) if (nowMs - t > 7 * 86_400_000) delete sent[id];
  return out;
}

export async function postDiscord(webhook, messages, { fetchImpl = fetch, log = console.log } = {}) {
  if (!webhook || !messages.length) return 0;
  // Discord caps a message at 2000 characters; pack alerts into as few posts as fit.
  const posts = [];
  let cur = "";
  for (const m of messages) {
    if (cur && cur.length + m.length + 2 > 1900) {
      posts.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + m.slice(0, 1900);
  }
  if (cur) posts.push(cur);
  for (const content of posts) {
    const res = await fetchImpl(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, username: "Forever Watcher" }) });
    if (!res.ok) log(`  Discord webhook returned HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 600));
  }
  return posts.length;
}
