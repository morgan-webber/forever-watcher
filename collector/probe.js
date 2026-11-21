#!/usr/bin/env node
/**
 * One-off data-source probe for crafting/disenchant data. Writes probe/results.json.
 * Tests (1) Blizzard's profession/recipe endpoints in the static-forever namespace and
 * (2) wago.tools DB2 CSV exports for the Forever client build.
 */
import { promises as fs } from "node:fs";
import { createClient } from "./blizzard.js";

const out = { at: new Date().toISOString(), blizzard: {}, wago: {} };
const clip = (j) => JSON.stringify(j).slice(0, 1500);

async function blizzard() {
  const c = createClient({ clientId: process.env.BLIZZARD_CLIENT_ID, clientSecret: process.env.BLIZZARD_CLIENT_SECRET, log: () => {} });
  const tryGet = async (label, path, ns = "static-forever") => {
    try {
      const r = await c.get("us", path, ns, { locale: "en_US" });
      out.blizzard[label] = { path, ns, status: r.status, sample: r.json ? clip(r.json) : null };
      return r.json;
    } catch (e) {
      out.blizzard[label] = { path, ns, error: e.message };
      return null;
    }
  };
  const idx = await tryGet("professionIndex", "/data/wow/profession/index");
  const prof = idx?.professions?.find((p) => /tailoring|alchemy/i.test(p.name)) ?? idx?.professions?.[0];
  if (prof) {
    const p = await tryGet("profession", `/data/wow/profession/${prof.id}`);
    const tier = p?.skill_tiers?.[0];
    if (tier) {
      const t = await tryGet("skillTier", `/data/wow/profession/${prof.id}/skill-tier/${tier.id}`);
      const recipe = t?.categories?.[0]?.recipes?.[0];
      if (recipe) await tryGet("recipe", `/data/wow/recipe/${recipe.id}`);
    }
  }
  // Retail namespace for comparison, and a known classic-era recipe id guess.
  await tryGet("professionIndexClassic", "/data/wow/profession/index", "static-classic1x");
}

async function wago() {
  const get = async (url) => {
    const r = await fetch(url, { headers: { "User-Agent": "forever-watcher-probe (github.com/morgan-webber/forever-watcher)" } });
    return { status: r.status, text: await r.text() };
  };
  try {
    const b = await get("https://wago.tools/api/builds");
    out.wago.buildsStatus = b.status;
    const j = JSON.parse(b.text);
    const hits = {};
    for (const [prod, list] of Object.entries(j)) {
      const v = (list ?? []).filter((x) => String(x.version ?? "").startsWith("1.60"));
      if (v.length || /forever/i.test(prod)) hits[prod] = (list ?? []).slice(0, 3).map((x) => x.version);
    }
    out.wago.foreverProducts = hits;
    const ver = Object.values(hits).flat().find((v) => String(v).startsWith("1.60"));
    out.wago.build = ver ?? null;
    if (ver) {
      for (const table of ["SpellReagents", "SkillLineAbility", "SpellEffect", "ItemDisenchantLoot", "Item", "ItemSparse", "SkillLine", "SpellName"]) {
        try {
          const r = await get(`https://wago.tools/db2/${table}/csv?build=${encodeURIComponent(ver)}`);
          const lines = r.text.split("\n");
          out.wago[table] = { status: r.status, rows: lines.length - 1, head: lines.slice(0, 3).join("\n").slice(0, 800) };
        } catch (e) {
          out.wago[table] = { error: e.message };
        }
      }
    }
  } catch (e) {
    out.wago.error = e.message;
  }
}

await Promise.all([blizzard(), wago()]);
await fs.mkdir("probe", { recursive: true });
await fs.writeFile("probe/results.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 4000));
