// Read-only before/after report for review: V1 snapshot clone vs migrated V2 clone, per deal.
//   node .ai/migrations/v1-to-v2-live/tools/compare-before-after.mjs <output.md>
// BEFORE must be an UNTOUCHED V1 copy (both 2026-09-21/22 clones are migrated now – create a fresh one).
// BEFORE = MIGRATION_REHEARSAL_DATABASE_STD_URL (untouched V1 copy), AFTER = MIGRATION_REHEARSAL_DATABASE_URL (migrated).
// Both from .env.migration; production (m0xyun) and pooler hosts are refused. Only lead numbers, statuses, dates,
// amounts and usernames are written – no company names, contacts, notes or URLs. Keep the output outside the repo.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(new URL("../../../../package.json", import.meta.url));
const { Client } = require("pg");
const out = process.argv[2];
if (!out) fail("usage: compare-before-after.mjs <output.md>");
const env = readFileSync(new URL("../../../../.env.migration", import.meta.url), "utf8");
const url = (name) => {
    const m = env.match(new RegExp(`^${name}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"));
    if (!m) fail(`${name} missing in .env.migration`);
    const host = new URL(m[1]).hostname.split(".")[0];
    if (/m0xyun/.test(host) || host.endsWith("-pooler")) fail(`${name}: refused host ${host}`);
    return { url: m[1], host };
};
const BEFORE = url("MIGRATION_REHEARSAL_DATABASE_STD_URL");
const AFTER = url("MIGRATION_REHEARSAL_DATABASE_URL");
const D = `'YYYY-MM-DD HH24:MI'`;
const bt = (col) => `to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Bratislava', ${D})`;

async function read(target, sqls) {
    const c = new Client({ connectionString: target.url });
    await c.connect();
    await c.query("BEGIN TRANSACTION READ ONLY");
    const res = {};
    for (const [k, sql] of Object.entries(sqls)) res[k] = (await c.query(sql)).rows;
    await c.query("ROLLBACK");
    await c.end();
    return res;
}

const common = {
    leads: `SELECT l.id, l.number, l.status::text, l."deletedAt" IS NOT NULL del, l.price::text price,
                   l."nextActionKind"::text kind, l."nextActionMode"::text mode, ${bt('l."nextActionAt"')} "stepAt",
                   o.username owner
              FROM "Lead" l LEFT JOIN "User" o ON o.id = l."ownerId"`,
    counts: `SELECT status::text, count(*)::int n FROM "Lead" GROUP BY 1 ORDER BY 1`,
};
const before = await read(BEFORE, {
    ...common,
    sends: `SELECT a."leadId", a.type::text, ${bt('a."createdAt"')} at, a.note, u.username who
              FROM "Activity" a JOIN "User" u ON u.id = a."userId"
             WHERE a.type IN ('EMAIL_SENT','QUOTE_SENT','DESIGN_SENT')
                OR a.note IN ('Odoslanie cenovej ponuky zrušené','Klient oboznámený s cenou')
             ORDER BY a."createdAt"`,
    fields: `SELECT id, ${bt('"aboutUsSentAt"')} about, ${bt('"quoteSentAt"')} quote, ${bt('"designSentAt"')} design, "priceDisclosed" disclosed FROM "Lead"`,
});
const after = await read(AFTER, {
    ...common,
    stage: `SELECT l.id, ${bt('l."pipelineEnteredAt"')} entered, c.username caller, h.username "handedOffBy", l.revision
              FROM "Lead" l LEFT JOIN "User" c ON c.id = l."assignedCallerId" LEFT JOIN "User" h ON h.id = l."handedOffById"`,
    offers: `SELECT a."leadId", ${bt('a."createdAt"')} at, a.meta->>'sentOn' "sentOn", a.meta->'contents' contents,
                    a.meta->'price'->>'amount' amount, jsonb_array_length(COALESCE(a.meta->'designs','[]'::jsonb)) designs,
                    a.meta->'migration'->>'amountSource' "amountSource", a.meta->'migration'->'sources' sources, u.username who
               FROM "Activity" a JOIN "User" u ON u.id = a."userId" WHERE a.type = 'OFFER_SENT' ORDER BY a."createdAt"`,
    requests: `SELECT "leadId", content::text, state::text, origin::text, ${bt('"requestedAt"')} at FROM "LeadRequest" ORDER BY "requestedAt"`,
    summary: `SELECT id, ${bt('"offerAboutUsAt"')} about, ${bt('"offerPriceAt"')} price, ${bt('"designSentAt"')} design FROM "Lead"`,
    team: `SELECT t.name, l.username leader, (SELECT string_agg(u.username, ',' ORDER BY u.username) FROM "User" u WHERE u."teamId" = t.id) members
             FROM "Team" t LEFT JOIN "User" l ON l.id = t."leaderId" ORDER BY 1`,
    callwork: `SELECT u.username, l.status::text, count(*)::int n FROM "Lead" l JOIN "User" u ON u.id = l."assignedCallerId"
                WHERE l."pipelineEnteredAt" IS NULL GROUP BY 1,2 ORDER BY 1,2`,
});

const by = (rows, key = "leadId") => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) ?? []), r]), new Map());
const one = (rows) => new Map(rows.map((r) => [r.id, r]));
const bLead = one(before.leads), aLead = one(after.leads), aStage = one(after.stage);
const bFields = one(before.fields);
const bSends = by(before.sends), aOffers = by(after.offers), aReq = by(after.requests);

const problems = [];
if (bLead.size !== aLead.size) problems.push(`lead count before ${bLead.size} ≠ after ${aLead.size}`);
for (const [id, b] of bLead) {
    const a = aLead.get(id);
    if (!a) { problems.push(`#${b.number} missing after`); continue; }
    for (const k of ["status", "del", "price"]) {
        if (String(b[k]) !== String(a[k])) problems.push(`#${b.number} ${k}: ${b[k]} → ${a[k]}`);
    }
    // D-009: the step stays on open deals; closed deals and call-stage contacts must end WITHOUT a step (V2 clears it).
    const entered = aStage.get(id)?.entered;
    const mustClear = !entered || ["WON", "LOST", "UNREACHABLE"].includes(a.status);
    if (mustClear ? a.kind !== null || a.stepAt !== null : ["kind", "mode", "stepAt"].some((k) => String(b[k]) !== String(a[k]))) {
        problems.push(`#${b.number} step: ${b.kind}/${b.mode}/${b.stepAt} → ${a.kind}/${a.mode}/${a.stepAt} (${mustClear ? "must be cleared" : "must be unchanged"})`);
    }
    if (b.owner && b.owner !== a.owner) problems.push(`#${b.number} owner ${b.owner} → ${a.owner}`);
}

const fmtV1 = (id) => {
    const f = bFields.get(id);
    const rows = (bSends.get(id) ?? []).map((s) => {
        if (s.type === "EMAIL_SENT") return `${s.at} Email o nás (${s.who})`;
        if (s.type === "QUOTE_SENT") return `${s.at} CP "${s.note ?? ""}" (${s.who})`;
        if (s.type === "DESIGN_SENT") return `${s.at} návrh odoslaný (${s.who})`;
        return `${s.at} [${s.note}]`;
    });
    const flags = [f.about && `aboutUsSentAt=${f.about}`, f.quote && `quoteSentAt=${f.quote}`, f.design && `designSentAt=${f.design}`, f.disclosed && "priceDisclosed"].filter(Boolean);
    return [...rows, flags.length ? `fields: ${flags.join(", ")}` : null].filter(Boolean).join("<br>") || "—";
};
const label = { ABOUT_US: "Info", PRICE: "Cena", DESIGN: "Návrh", PRICELIST: "Cenník", REVIEW: "Rozbor" };
const fmtV2 = (id) =>
    (aOffers.get(id) ?? [])
        .map((o) => `${o.at} ${o.contents.map((c) => label[c] ?? c).join(" + ")}${o.amount ? ` ${o.amount} €` : ""}${o.designs > 1 ? ` (${o.designs} návrhy)` : ""}${o.amountSource === "DECISION" ? " [decision]" : ""} (${o.who})`)
        .join("<br>") || "—";
const fmtReq = (id) => (aReq.get(id) ?? []).map((r) => `${label[r.content] ?? r.content}: ${r.state === "SENT" ? "dostal" : r.state === "OPEN" ? "**treba poslať**" : r.state}`).join(", ") || "—";

const deals = [...aLead.values()].filter((l) => aStage.get(l.id).entered).sort((x, y) => x.number - y.number);
const lines = [];
lines.push(`# Zvonček V1 → V2 migration — before/after review (${new Date().toISOString().slice(0, 16)}Z)`);
lines.push("");
lines.push(`BEFORE = untouched V1 copy \`${BEFORE.host}\`; AFTER = migrated V2 copy \`${AFTER.host}\`. Both are copies of live taken 2026-09-21 ~12:21 (read-only here).`);
lines.push("Times are Europe/Bratislava. Rules: `.ai/migrations/v1-to-v2-live/DECISIONS.md` D-003 and `02-data-mapping.md`.");
lines.push("");
lines.push("## Automatic comparison (must be empty)");
lines.push("");
lines.push("Status, deletion, price and existing owners identical; steps unchanged on open deals and cleared on closed deals / call-stage contacts (D-009). Structural V2 promises are checked by `2026-09-v2-normalize.ts --verify`.");
lines.push("");
lines.push(problems.length ? problems.map((p) => `- ${p}`).join("\n") : "- **No differences.**");
lines.push("");
lines.push("## Totals");
lines.push("");
lines.push(`- Leads before/after: ${bLead.size} / ${aLead.size}. Deals after: ${deals.length}.`);
lines.push(`- Converted sends (OFFER_SENT): ${after.offers.length}. "Chceli" rows: ${after.requests.length} (${after.requests.filter((r) => r.state === "OPEN").length} open).`);
lines.push(`- Status counts before: ${before.counts.map((c) => `${c.status} ${c.n}`).join(", ")}`);
lines.push(`- Status counts after: ${after.counts.map((c) => `${c.status} ${c.n}`).join(", ")}`);
lines.push(`- Teams after: ${after.team.map((t) => `${t.name} (leader ${t.leader}; ${t.members})`).join(" · ")}`);
lines.push(`- Call-stage work after: ${after.callwork.map((c) => `${c.username} ${c.status} ${c.n}`).join(", ")}`);
lines.push("");
lines.push("## Every deal (lead with a positive first call)");
lines.push("");
lines.push("| # | Status | Step (kind · mode · date) | Price | Owner before → after | V1: what was recorded | V2: Klient dostal | V2: Chceli |");
lines.push("|---|---|---|---|---|---|---|---|");
for (const a of deals) {
    const b = bLead.get(a.id);
    lines.push(`| ${a.number} | ${a.status} | ${a.kind ?? "—"} · ${a.mode} · ${a.stepAt ?? "—"} | ${a.price ?? "—"} | ${b.owner ?? "(none)"} → ${a.owner ?? "(none)"} | ${fmtV1(a.id)} | ${fmtV2(a.id)} | ${fmtReq(a.id)} |`);
}
lines.push("");
writeFileSync(out, lines.join("\n"), "utf8");
console.log(`written ${out}: ${deals.length} deals, ${problems.length} differences`);

function fail(msg) {
    console.error(`ABORT: ${msg}`);
    process.exit(1);
}
