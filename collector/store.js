import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** Reads JSON (gzipped when the path ends in .gz). Returns `fallback` when the file is missing. */
export async function readJson(file, fallback) {
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
  if (file.endsWith(".gz")) buf = await gunzip(buf);
  return JSON.parse(buf.toString("utf8"));
}

/** Writes JSON atomically (gzipped when the path ends in .gz). */
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let buf = Buffer.from(JSON.stringify(value));
  if (file.endsWith(".gz")) buf = await gzip(buf, { level: 9 });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, file);
}

export async function loadConfig(root) {
  const [settings, fees, alerts, vendorReagents] = await Promise.all([
    readJson(path.join(root, "config/settings.json"), {}),
    readJson(path.join(root, "config/fees.json"), {}),
    readJson(path.join(root, "config/alerts.json"), { enabled: false, rules: [] }),
    readJson(path.join(root, "config/vendor-reagents.json"), { names: [] }),
  ]);
  return { settings, fees, alerts, vendorReagents };
}
