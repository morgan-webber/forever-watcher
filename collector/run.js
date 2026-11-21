#!/usr/bin/env node
/**
 * Entry point for the hourly GitHub Actions run.
 *   node collector/run.js [--state state] [--out _site]
 * Env: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET, DISCORD_WEBHOOK_URL (optional), SITE_URL (optional).
 * With no Blizzard credentials it builds demo data instead, so the site still deploys.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "./blizzard.js";
import { loadConfig } from "./store.js";
import { collect } from "./collect.js";
import { buildDemo } from "./demo.js";
import { copySite } from "./build-site.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { state: { type: "string", default: "state" }, out: { type: "string", default: "_site" } } });
const stateDir = path.resolve(values.state);
const outDir = path.resolve(values.out);

const config = await loadConfig(root);
const { BLIZZARD_CLIENT_ID: id, BLIZZARD_CLIENT_SECRET: secret, DISCORD_WEBHOOK_URL: webhook, SITE_URL: siteUrl } = process.env;

await copySite(root, outDir);
if (!id || !secret) {
  console.log("No BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET set: building demo data.");
  await buildDemo({ config, outDir, days: 6 });
} else {
  const client = createClient({ clientId: id, clientSecret: secret });
  await collect({ client, config, stateDir, outDir, discordWebhook: webhook, siteUrl });
}
