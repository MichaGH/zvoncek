// Runs one command against the migration target without ever printing its connection string.
//
//   node .ai/migrations/v1-to-v2-live/tools/with-target.mjs --expect ep-xxxx -- npx tsx prisma/backfill/…
//
// Reads MIGRATION_REHEARSAL_DATABASE_URL from .env.migration (gitignored) and passes it to the child as DATABASE_URL.
// Refuses: a pooler host, an endpoint other than --expect, and the production endpoint unless --production-window is
// also given (only in the approved production window, runbook 06-production-cutover.md).
// --local-app: for `next start` on localhost against a rehearsal clone (sets AUTH_TRUST_HOST; never for production).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0) fail("usage: with-target.mjs --expect <endpoint> [--production-window] -- <command…>");
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
const expect = opts[opts.indexOf("--expect") + 1];
const productionWindow = opts.includes("--production-window");
if (!opts.includes("--expect") || !expect || expect.startsWith("--")) fail("--expect <endpoint> is required");

const raw = readFileSync(new URL("../../../../.env.migration", import.meta.url), "utf8");
const m = raw.match(/^MIGRATION_REHEARSAL_DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
if (!m) fail("MIGRATION_REHEARSAL_DATABASE_URL missing in .env.migration");
const url = new URL(m[1]);
const label = url.hostname.split(".")[0];
if (label.endsWith("-pooler")) fail("use the DIRECT connection string (host must not contain -pooler)");
if (label !== expect) fail(`endpoint mismatch: target is ${label}, --expect says ${expect}`);
const isProduction = label.endsWith("m0xyun");
if (isProduction && !productionWindow) fail("target is PRODUCTION – refused without --production-window");
if (!isProduction && productionWindow) fail("--production-window given but the target is not production");

console.error(`[with-target] ${isProduction ? "PRODUCTION WINDOW" : "rehearsal"} endpoint=${label} db=${url.pathname.slice(1)}`);
const r = spawnSync(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: m[1], ZVONCEK_PRODUCTION_WINDOW: isProduction ? label : "", ...(opts.includes("--local-app") && !isProduction ? { AUTH_TRUST_HOST: "true" } : {}) },
});
process.exit(r.status ?? 1);

function fail(msg) {
    console.error(`[with-target] ABORT: ${msg}`);
    process.exit(1);
}
