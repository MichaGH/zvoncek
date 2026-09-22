import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("C:/000_DEV/0_ZVONCEK/zvoncek/package.json");
const { Client } = require("pg");
const raw = readFileSync("C:/000_DEV/0_ZVONCEK/zvoncek/.env.migration", "utf8");
const m = raw.match(/MIGRATION_REHEARSAL_DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/);
if (!m) { console.error("ABORT: variable missing"); process.exit(1); }
// Read-only inventory helper. Usage: EXPECT_ENDPOINT=ep-xxxx node .ai/migrations/v1-to-v2-live/inventory/04-census.mjs
// Reads .env.migration (MIGRATION_REHEARSAL_DATABASE_URL); refuses production (m0xyun), pooler, or an unexpected endpoint.
const url = new URL(m[1]);
const label = url.hostname.split(".")[0];
// Production only for the read-only pre-check in the approved window (every query runs in a READ ONLY transaction).
if (/m0xyun/.test(url.hostname) && process.env.ALLOW_PRODUCTION_READ !== "1") { console.error("ABORT: production endpoint (set ALLOW_PRODUCTION_READ=1 only in the approved window)"); process.exit(1); }
if (label.endsWith("-pooler")) { console.error("ABORT: pooler"); process.exit(1); }
const expected = process.env.EXPECT_ENDPOINT;
if (!expected || label !== expected) { console.error("ABORT: set EXPECT_ENDPOINT to the clone endpoint id (got " + label + ")"); process.exit(1); }
export async function run(fn) {
  const c = new Client({ connectionString: m[1] });
  await c.connect();
  await c.query("BEGIN TRANSACTION READ ONLY");
  try { await fn(c); } finally { await c.query("ROLLBACK"); await c.end(); }
}
export const endpoint = label;
