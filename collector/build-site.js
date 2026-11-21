#!/usr/bin/env node
/** Copies the static site (site/) into the output directory. Data is written separately. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function copySite(root, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.cp(path.join(root, "site"), outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, ".nojekyll"), "");
  // Cache-bust the app and stylesheet so a new deploy never runs old code against new data.
  const v = (process.env.GITHUB_SHA ?? Date.now().toString(36)).slice(0, 10);
  const index = path.join(outDir, "index.html");
  const html = (await fs.readFile(index, "utf8")).replace(/(app\.js|styles\.css)"/g, `$1?v=${v}"`);
  await fs.writeFile(index, html);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await copySite(root, path.resolve(process.argv[2] ?? "_site"));
}
