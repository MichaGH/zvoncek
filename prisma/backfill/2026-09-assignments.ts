// Backfill: priradenie práce volajúcim + značky obchodov (plán §11).
//
// Bezpečnosť:
// - DRY-RUN je predvolený. Zapisuje len s --apply --confirm <endpoint> na DIRECT (nie -pooler) hoste.
// - Vyžaduje --expect-endpoint a --expect-db, ktoré sa musia zhodovať s DATABASE_URL. URL/heslo nikdy nevypisuje.
// - Každý nezaradený / nejednoznačný lead = CONFLICT → celý beh sa preruší (vypíše len čísla leadov).
// - Opakovateľný: po apply druhý beh nájde len DEAL_OK / CALLWORK_OK / POOL / TERMINAL_OK.
//
// Použitie (čerstvý shell, DATABASE_URL = direct URL cieľa):
//   npx tsx prisma/backfill/2026-09-assignments.ts --identity --expect-endpoint ep-xxxx --expect-db neondb
//   npx tsx prisma/backfill/2026-09-assignments.ts --expect-endpoint ep-xxxx --expect-db neondb --owner-username michal
//   npx tsx prisma/backfill/2026-09-assignments.ts ... --owner-username michal --apply --confirm ep-xxxx
//   npx tsx prisma/backfill/2026-09-assignments.ts ... --owner-username michal --verify
import "dotenv/config";
import { Client } from "pg";
import { Role } from "../../app/generated/prisma/enums";
import { can } from "../../lib/permissions";

type Args = {
    expectEndpoint?: string;
    expectDb?: string;
    ownerUsername?: string;
    confirm?: string;
    apply: boolean;
    verify: boolean;
    identity: boolean;
};

function parseArgs(argv: string[]): Args {
    const args: Args = { apply: false, verify: false, identity: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (!v || v.startsWith("--")) fail(`Chýba hodnota pre ${a}`);
            return v;
        };
        if (a === "--expect-endpoint") args.expectEndpoint = next();
        else if (a === "--expect-db") args.expectDb = next();
        else if (a === "--owner-username") args.ownerUsername = next();
        else if (a === "--confirm") args.confirm = next();
        else if (a === "--apply") args.apply = true;
        else if (a === "--verify") args.verify = true;
        else if (a === "--identity") args.identity = true;
        else fail(`Neznámy argument: ${a}`);
    }
    return args;
}

function fail(message: string): never {
    console.error(`ABORT: ${message}`);
    process.exit(1);
}

const POSITIVE = `('WANTS_QUOTE','WANTS_DESIGN','WANTS_EMAIL','POSITIVE')`;
const OK_CLASSES = ["DEAL_OK", "CALLWORK_OK", "POOL", "TERMINAL_OK"];
const CLASSES = [
    "DEAL_TO_MIGRATE",
    "DEAL_OK",
    "DEAL_CLOSEDAT_FIX",
    "CALLWORK_TO_MIGRATE",
    "CALLWORK_OK",
    "POOL",
    "NEW_WITH_HISTORY",
    "TERMINAL_OK",
    "STRAY_ASSIGNMENT",
    "CONFLICT",
];

// Klasifikácia každého nezmazaného leadu. $1 = id vlastníka historických obchodov.
// Podmienky c1..c9 sú vzájomne výlučné; skript to navyše overuje (matches <= 1).
// Odchýlka od §11.3 riadok 5 (CALLWORK_OK): stačí AKÝKOĽVEK CALL_QUEUE hovor (aj vrátený), lebo vrátenie jediného
// hovoru nechá lead ako CALLING RETRY s priradením bez nevráteného hovoru (§15: „backfill ho zaradí ako call work").
const CLASSIFY_SQL = `
WITH act AS (
    SELECT a."leadId",
        count(*) FILTER (WHERE a.type = 'CALL' AND a.source = 'CALL_QUEUE' AND a."revertedAt" IS NULL
                           AND a.outcome IN ${POSITIVE})::int AS pos,
        bool_or(a.type = 'CALL') AS any_call,
        bool_or(a.type = 'CALL' AND a.source = 'CALL_QUEUE' AND a."revertedAt" IS NULL) AS queue_call,
        bool_or(a.type = 'CALL' AND a.source = 'CALL_QUEUE') AS any_queue_call,
        bool_or(a.source IN ('PIPELINE', 'CLIENTS')) AS deal_act,
        max(a."createdAt") FILTER (WHERE a.type = 'STATUS_CHANGED') AS last_status_changed_at
    FROM "Activity" a
    GROUP BY a."leadId"
),
firstpos AS (
    SELECT DISTINCT ON (a."leadId") a."leadId", a."createdAt" AS derived_at, a."userId" AS derived_by
    FROM "Activity" a
    WHERE a.type = 'CALL' AND a.source = 'CALL_QUEUE' AND a."revertedAt" IS NULL AND a.outcome IN ${POSITIVE}
    ORDER BY a."leadId", a."createdAt", a.id
),
lastq AS (
    SELECT DISTINCT ON (a."leadId") a."leadId", a."userId" AS last_queue_by, a."createdAt" AS last_queue_at
    FROM "Activity" a
    WHERE a.type = 'CALL' AND a.source = 'CALL_QUEUE' AND a."revertedAt" IS NULL
    ORDER BY a."leadId", a."createdAt" DESC, a.id DESC
),
base AS (
    SELECT l.id, l.number, l.status::text AS status, l."updatedAt", l."assignedCallerId", l."ownerId",
        COALESCE(act.pos, 0) AS pos,
        COALESCE(act.any_call, false) AS any_call,
        COALESCE(act.queue_call, false) AS queue_call,
        COALESCE(act.any_queue_call, false) AS any_queue_call,
        COALESCE(act.deal_act, false) AS deal_act,
        act.last_status_changed_at,
        fp.derived_at, fp.derived_by, lq.last_queue_by, lq.last_queue_at,
        (l."pipelineEnteredAt" IS NOT NULL) AS m,
        (l."pipelineEnteredAt" = fp.derived_at AND l."handedOffById" = fp.derived_by) IS TRUE AS mok,
        (l."assignedCallerId" IS NOT NULL) AS a,
        (l."ownerId" IS NULL OR l."ownerId" = $1) AS owner_ok,
        ((l.status IN ('WON', 'LOST', 'UNREACHABLE')) = (l."closedAt" IS NOT NULL)) AS closed_ok,
        (l."closedAt" IS NULL) AS closed_null,
        l.status IN ('ACTIVE', 'SNOOZED', 'WON', 'LOST', 'UNREACHABLE') AS deal_st,
        l.status IN ('WON', 'LOST', 'UNREACHABLE') AS closed_st,
        l.status IN ('CALLING', 'SNOOZED') AS call_st,
        l.status IN ('LOST', 'UNREACHABLE') AS term_st,
        l.status = 'NEW' AS new_st
    FROM "Lead" l
    LEFT JOIN act ON act."leadId" = l.id
    LEFT JOIN firstpos fp ON fp."leadId" = l.id
    LEFT JOIN lastq lq ON lq."leadId" = l.id
    WHERE l."deletedAt" IS NULL
),
cond AS (
    SELECT base.*,
        (pos = 1 AND NOT m AND deal_st AND owner_ok AND closed_null) AS c1,
        (pos = 1 AND mok AND deal_st AND NOT a AND closed_ok) AS c2,
        (pos = 1 AND mok AND deal_st AND NOT a AND NOT closed_ok) AS c3,
        (pos = 0 AND NOT m AND call_st AND NOT a AND queue_call AND NOT deal_act AND closed_null) AS c4,
        (pos = 0 AND NOT m AND call_st AND a AND any_queue_call AND NOT deal_act AND closed_null) AS c5,
        (NOT m AND new_st AND NOT any_call AND NOT deal_act AND closed_null) AS c6,
        (pos = 0 AND NOT m AND new_st AND NOT a AND queue_call AND NOT deal_act AND closed_null) AS c7,
        (pos = 0 AND NOT m AND term_st AND NOT a AND NOT deal_act AND closed_null) AS c8,
        (pos = 0 AND NOT m AND term_st AND a AND NOT deal_act AND closed_null) AS c9
    FROM base
)
SELECT cond.*,
    (c1::int + c2::int + c3::int + c4::int + c5::int + c6::int + c7::int + c8::int + c9::int) AS matches,
    CASE
        WHEN c1 THEN 'DEAL_TO_MIGRATE'
        WHEN c2 THEN 'DEAL_OK'
        WHEN c3 THEN 'DEAL_CLOSEDAT_FIX'
        WHEN c4 THEN 'CALLWORK_TO_MIGRATE'
        WHEN c5 THEN 'CALLWORK_OK'
        WHEN c6 THEN 'POOL'
        WHEN c7 THEN 'NEW_WITH_HISTORY'
        WHEN c8 THEN 'TERMINAL_OK'
        WHEN c9 THEN 'STRAY_ASSIGNMENT'
        ELSE 'CONFLICT'
    END AS class
FROM cond`;

// Nekotvené legacy hovory mimo obchodov, ktoré dostanú kotvu na vrátenie (§11.3 anchor pass).
const ANCHOR_CANDIDATES_SQL = `
WITH latest AS (
    SELECT DISTINCT ON (a."leadId") a.id, a."leadId", a."createdAt", a."leadRevision"
    FROM "Activity" a
    WHERE a.type = 'CALL' AND a.source = 'CALL_QUEUE' AND a."revertedAt" IS NULL
    ORDER BY a."leadId", a."createdAt" DESC, a.id DESC
)
SELECT latest.id AS activity_id, l.id AS lead_id, l.revision
FROM latest
JOIN "Lead" l ON l.id = latest."leadId"
WHERE l."deletedAt" IS NULL AND l."pipelineEnteredAt" IS NULL AND latest."leadRevision" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Activity" b WHERE b."leadId" = l.id AND b."createdAt" > latest."createdAt")`;

const INVARIANTS_SQL = `
SELECT
    (SELECT count(*)::int FROM "Lead" l WHERE l."deletedAt" IS NULL AND l.status = 'NEW'
        AND EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = l.id AND a.type = 'CALL')) AS new_with_call,
    (SELECT count(*)::int FROM "Lead" l WHERE l."deletedAt" IS NULL AND l."pipelineEnteredAt" IS NOT NULL
        AND (l.status IN ('WON', 'LOST', 'UNREACHABLE')) <> (l."closedAt" IS NOT NULL)) AS closed_mismatch,
    (SELECT count(*)::int FROM "Lead" l WHERE l."deletedAt" IS NULL AND l."pipelineEnteredAt" IS NULL
        AND l."closedAt" IS NOT NULL) AS closed_on_non_deal`;

type ClassRow = {
    id: string;
    number: number;
    status: string;
    class: string;
    matches: number;
    assignedCallerId: string | null;
    last_queue_by: string | null;
    last_status_changed_at: Date | null;
};

function endpointOf(connectionString: string): { endpoint: string; host: string; db: string; pooled: boolean } {
    const url = new URL(connectionString);
    const label = url.hostname.split(".")[0];
    return {
        endpoint: label.replace(/-pooler$/, ""),
        host: url.hostname,
        db: decodeURIComponent(url.pathname.replace(/^\//, "")),
        pooled: label.endsWith("-pooler"),
    };
}

async function classify(c: Client, ownerId: string): Promise<ClassRow[]> {
    const r = await c.query<ClassRow>(CLASSIFY_SQL, [ownerId]);
    return r.rows;
}

function summarize(rows: ClassRow[]) {
    const counts: Record<string, number> = Object.fromEntries(CLASSES.map((k) => [k, 0]));
    const byStatus: Record<string, Record<string, number>> = {};
    for (const row of rows) {
        counts[row.class]++;
        byStatus[row.class] ??= {};
        byStatus[row.class][row.status] = (byStatus[row.class][row.status] ?? 0) + 1;
    }
    return { counts, byStatus };
}

function printSummary(title: string, rows: ClassRow[], usernames: Map<string, string>) {
    const { counts, byStatus } = summarize(rows);
    console.log(`\n== ${title} ==`);
    for (const k of CLASSES) {
        const statuses = Object.entries(byStatus[k] ?? {})
            .map(([s, n]) => `${s} ${n}`)
            .join(", ");
        console.log(`  ${k.padEnd(20)} ${String(counts[k]).padStart(6)}${statuses ? `   (${statuses})` : ""}`);
    }

    // Priradenie po migrácii (CALLWORK_OK/POOL claim = aktuálny, CALLWORK_TO_MIGRATE/NEW_WITH_HISTORY = posledný volajúci).
    const perUser = new Map<string, Record<string, number>>();
    for (const row of rows) {
        let assignee: string | null = null;
        if (row.class === "CALLWORK_OK" || (row.class === "POOL" && row.assignedCallerId)) assignee = row.assignedCallerId;
        if (row.class === "CALLWORK_TO_MIGRATE" || row.class === "NEW_WITH_HISTORY") assignee = row.last_queue_by;
        if (!assignee) continue;
        const name = usernames.get(assignee) ?? assignee;
        const status = row.class === "NEW_WITH_HISTORY" ? "CALLING" : row.status;
        const entry = perUser.get(name) ?? {};
        entry[status] = (entry[status] ?? 0) + 1;
        perUser.set(name, entry);
    }
    if (perUser.size) {
        console.log("  assignment per user after migration:");
        for (const [name, entry] of perUser) {
            console.log(`    ${name.padEnd(18)} ${Object.entries(entry).map(([s, n]) => `${s} ${n}`).join(", ")}`);
        }
    }

    const multi = rows.filter((r) => Number(r.matches) > 1);
    if (multi.length) {
        console.log(`  !! leads matching more than one class (bug): ${multi.map((r) => `#${r.number}`).join(", ")}`);
    }
    const conflicts = rows.filter((r) => r.class === "CONFLICT");
    if (conflicts.length) {
        console.log(`  CONFLICT lead numbers: ${conflicts.map((r) => `#${r.number}`).join(", ")}`);
    }
    return { counts, multi, conflicts };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) fail("DATABASE_URL nie je nastavené.");
    if (!args.expectEndpoint || !args.expectDb) fail("Povinné: --expect-endpoint a --expect-db.");

    const target = endpointOf(connectionString);
    if (target.endpoint !== args.expectEndpoint) fail(`Endpoint nesedí (DATABASE_URL má iný endpoint než --expect-endpoint).`);
    if (target.db !== args.expectDb) fail(`Databáza nesedí (DATABASE_URL má inú databázu než --expect-db).`);
    if (args.apply) {
        if (target.pooled) fail("--apply vyžaduje DIRECT (nie -pooler) host.");
        if (args.confirm !== target.endpoint) fail("--apply vyžaduje --confirm <endpoint id> zadaný znova.");
        if (args.verify || args.identity) fail("--apply nejde kombinovať s --verify / --identity.");
    }

    const c = new Client({ connectionString });
    await c.connect();
    try {
        const info = await c.query<{ version: string; now: Date; db: string; leads: number }>(
            `SELECT current_setting('server_version') AS version, now() AS now, current_database() AS db,
                    (SELECT count(*)::int FROM "Lead" WHERE "deletedAt" IS NULL) AS leads`,
        );
        const i = info.rows[0];
        if (i.db !== args.expectDb) fail("current_database() nesedí s --expect-db.");
        console.log(
            `identity: endpoint=${target.endpoint} db=${i.db} host=${target.pooled ? "pooler" : "direct"} ` +
                `server=${i.version} now=${new Date(i.now).toISOString()} non-deleted leads=${i.leads}`,
        );
        if (args.identity) return;

        if (!args.ownerUsername) fail("Povinné: --owner-username (vlastník historických obchodov).");
        const owner = await c.query<{ id: string; role: Role; deletedAt: Date | null }>(
            `SELECT id, role, "deletedAt" FROM "User" WHERE username = $1`,
            [args.ownerUsername],
        );
        const o = owner.rows[0];
        if (!o) fail("Vlastník neexistuje.");
        if (o.deletedAt) fail("Vlastník je deaktivovaný.");
        if (o.role !== "ADMIN" && o.role !== "MANAGER") fail("Vlastník musí byť ADMIN alebo MANAGER.");

        const users = await c.query<{ id: string; username: string; role: Role; deletedAt: Date | null; teamId: string | null }>(
            `SELECT id, username, role, "deletedAt", "teamId" FROM "User"`,
        );
        const usernames = new Map(users.rows.map((u) => [u.id, u.username]));

        const outcomeCorrected = await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "Activity" WHERE type = 'OUTCOME_CORRECTED'`,
        );
        if (outcomeCorrected.rows[0].n > 0) fail(`Globálna podmienka: existuje ${outcomeCorrected.rows[0].n} OUTCOME_CORRECTED aktivít.`);

        // Tímy: upozornenie, ak volajúci bez deals.receive nemá smerovateľného vedúceho (hovory by boli nepriradené).
        const teams = await c.query<{ id: string; leaderId: string | null }>(`SELECT id, "leaderId" FROM "Team"`);
        const byId = new Map(users.rows.map((u) => [u.id, u]));
        for (const u of users.rows) {
            if (u.deletedAt || !can(u, "calls.work") || can(u, "deals.receive")) continue;
            const team = teams.rows.find((t) => t.id === u.teamId);
            const leader = team?.leaderId ? byId.get(team.leaderId) : undefined;
            if (!leader || leader.deletedAt || !can(leader, "deals.receive")) {
                console.log(`WARNING: ${u.username} (calls.work bez deals.receive) nemá smerovateľného vedúceho tímu → handoffy budú "Nepriradené".`);
            }
        }

        const deletedPositive = await c.query<{ number: number }>(
            `SELECT l.number FROM "Lead" l WHERE l."deletedAt" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "Activity" a WHERE a."leadId" = l.id AND a.type = 'CALL' AND a.source = 'CALL_QUEUE'
                  AND a."revertedAt" IS NULL AND a.outcome IN ${POSITIVE}) ORDER BY l.number`,
        );
        console.log(
            `report: deleted leads with positive first calls: ${deletedPositive.rows.length}` +
                (deletedPositive.rows.length ? ` (${deletedPositive.rows.map((r) => `#${r.number}`).join(", ")})` : ""),
        );

        if (!args.apply) {
            await c.query("BEGIN TRANSACTION READ ONLY");
            try {
                const rows = await classify(c, o.id);
                const { counts, multi, conflicts } = printSummary(args.verify ? "VERIFY" : "DRY-RUN", rows, usernames);
                const fallback = rows.filter(
                    (r) =>
                        (r.class === "DEAL_TO_MIGRATE" || r.class === "DEAL_CLOSEDAT_FIX") &&
                        ["WON", "LOST", "UNREACHABLE"].includes(r.status) &&
                        !r.last_status_changed_at,
                ).length;
                const excluded = new Set(
                    rows.filter((r) => r.class === "DEAL_TO_MIGRATE" || r.class === "NEW_WITH_HISTORY").map((r) => r.id),
                );
                const anchors = (await c.query<{ lead_id: string }>(ANCHOR_CANDIDATES_SQL)).rows.filter(
                    (r) => !excluded.has(r.lead_id),
                ).length;
                const inv = (await c.query(INVARIANTS_SQL)).rows[0];
                const change =
                    counts.DEAL_TO_MIGRATE +
                    counts.DEAL_CLOSEDAT_FIX +
                    counts.CALLWORK_TO_MIGRATE +
                    counts.NEW_WITH_HISTORY +
                    counts.STRAY_ASSIGNMENT;
                console.log(`  closedAt updatedAt-fallback: ${fallback}`);
                console.log(`  ANCHOR_PENDING: ${anchors}`);
                console.log(`  invariants now: ${JSON.stringify(inv)}`);
                console.log(`  would change ${change} lead rows + ${anchors} activity anchors`);
                if (multi.length || conflicts.length) {
                    console.log("\nRESULT: CONFLICT – apply would abort. Resolve the listed leads manually.");
                    process.exitCode = 2;
                } else if (args.verify) {
                    const notOk = CLASSES.filter((k) => !OK_CLASSES.includes(k) && counts[k] > 0);
                    console.log(notOk.length || anchors ? `\nRESULT: pending migration (${notOk.join(", ") || "anchors"})` : "\nRESULT: clean");
                    if (notOk.length || anchors) process.exitCode = 3;
                }
            } finally {
                await c.query("ROLLBACK");
            }
            return;
        }

        // ── APPLY ────────────────────────────────────────────────────────────────
        await c.query("BEGIN");
        try {
            await c.query(`SET LOCAL statement_timeout = '120s'`);
            await c.query(`SET LOCAL lock_timeout = '10s'`);

            await c.query(`CREATE TEMP TABLE bf ON COMMIT DROP AS ${CLASSIFY_SQL}`, [o.id]);
            const pre = (await c.query<ClassRow>(`SELECT * FROM bf`)).rows;
            const { counts, multi, conflicts } = printSummary("APPLY – classification", pre, usernames);
            if (multi.length) throw new Error("lead matched more than one class");
            if (conflicts.length) throw new Error(`${conflicts.length} CONFLICT lead(s)`);

            const expect = async (label: string, sql: string, params: unknown[], expected: number) => {
                const r = await c.query(sql, params);
                console.log(`  ${label.padEnd(22)} updated ${r.rowCount}`);
                if (r.rowCount !== expected) throw new Error(`${label}: expected ${expected}, updated ${r.rowCount}`);
                return r.rows as { id: string }[];
            };
            const closedAtExpr = `CASE WHEN l.status IN ('WON', 'LOST', 'UNREACHABLE')
                                       THEN COALESCE(bf.last_status_changed_at, l."updatedAt") ELSE NULL END`;

            await expect(
                "DEAL_TO_MIGRATE",
                `UPDATE "Lead" l SET "pipelineEnteredAt" = bf.derived_at, "handedOffById" = bf.derived_by,
                        "ownerId" = COALESCE(l."ownerId", $1), "assignedCallerId" = NULL, "assignedCallerAt" = NULL,
                        "closedAt" = ${closedAtExpr}, "revision" = l."revision" + 1
                   FROM bf
                  WHERE bf.id = l.id AND bf.class = 'DEAL_TO_MIGRATE'
                    AND l."pipelineEnteredAt" IS NULL AND l."closedAt" IS NULL AND l."deletedAt" IS NULL
                    AND (l."ownerId" IS NULL OR l."ownerId" = $1)
                    AND l.status IN ('ACTIVE', 'SNOOZED', 'WON', 'LOST', 'UNREACHABLE')
              RETURNING l.id`,
                [o.id],
                counts.DEAL_TO_MIGRATE,
            );
            await expect(
                "DEAL_CLOSEDAT_FIX",
                `UPDATE "Lead" l SET "closedAt" = ${closedAtExpr}, "revision" = l."revision" + 1
                   FROM bf
                  WHERE bf.id = l.id AND bf.class = 'DEAL_CLOSEDAT_FIX'
                    AND l."pipelineEnteredAt" IS NOT NULL AND l."assignedCallerId" IS NULL AND l."deletedAt" IS NULL
              RETURNING l.id`,
                [],
                counts.DEAL_CLOSEDAT_FIX,
            );
            await expect(
                "CALLWORK_TO_MIGRATE",
                `UPDATE "Lead" l SET "assignedCallerId" = bf.last_queue_by, "assignedCallerAt" = bf.last_queue_at,
                        "revision" = l."revision" + 1
                   FROM bf
                  WHERE bf.id = l.id AND bf.class = 'CALLWORK_TO_MIGRATE'
                    AND l."assignedCallerId" IS NULL AND l."pipelineEnteredAt" IS NULL AND l."deletedAt" IS NULL
                    AND l.status IN ('CALLING', 'SNOOZED') AND bf.last_queue_by IS NOT NULL
              RETURNING l.id`,
                [],
                counts.CALLWORK_TO_MIGRATE,
            );
            const newWithHistory = await expect(
                "NEW_WITH_HISTORY",
                `UPDATE "Lead" l SET status = 'CALLING', "callbackKind" = 'RETRY', "callbackAt" = NULL,
                        "callbackNote" = NULL, "callbackHasTime" = false,
                        "assignedCallerId" = bf.last_queue_by, "assignedCallerAt" = (now() AT TIME ZONE 'UTC'), "revision" = l."revision" + 1
                   FROM bf
                  WHERE bf.id = l.id AND bf.class = 'NEW_WITH_HISTORY'
                    AND l.status = 'NEW' AND l."assignedCallerId" IS NULL AND l."pipelineEnteredAt" IS NULL
                    AND l."deletedAt" IS NULL AND bf.last_queue_by IS NOT NULL
              RETURNING l.id`,
                [],
                counts.NEW_WITH_HISTORY,
            );
            if (newWithHistory.length) {
                const audit = await c.query(
                    `INSERT INTO "Activity" (id, "leadId", "userId", type, category, source, note, "createdAt")
                     SELECT gen_random_uuid()::text, x.id, $1, 'STATUS_CHANGED', 'AUDIT', 'ADMIN',
                            'Migrácia: nový kontakt s históriou hovorov → Skúsiť znova', (now() AT TIME ZONE 'UTC')
                       FROM unnest($2::text[]) AS x(id)`,
                    [o.id, newWithHistory.map((r) => r.id)],
                );
                if (audit.rowCount !== newWithHistory.length) throw new Error("NEW_WITH_HISTORY audit count mismatch");
            }
            await expect(
                "STRAY_ASSIGNMENT",
                `UPDATE "Lead" l SET "assignedCallerId" = NULL, "assignedCallerAt" = NULL, "revision" = l."revision" + 1
                   FROM bf
                  WHERE bf.id = l.id AND bf.class = 'STRAY_ASSIGNMENT'
                    AND l."assignedCallerId" IS NOT NULL AND l."pipelineEnteredAt" IS NULL AND l."deletedAt" IS NULL
                    AND l.status IN ('LOST', 'UNREACHABLE')
              RETURNING l.id`,
                [],
                counts.STRAY_ASSIGNMENT,
            );

            const anchors = await c.query(
                `WITH cand AS (${ANCHOR_CANDIDATES_SQL})
                 UPDATE "Activity" a SET "leadRevision" = cand.revision
                   FROM cand WHERE a.id = cand.activity_id AND a."leadRevision" IS NULL
                 RETURNING a.id`,
            );
            console.log(`  ${"ANCHORS".padEnd(22)} updated ${anchors.rowCount}`);

            const post = await classify(c, o.id);
            const postSummary = printSummary("APPLY – re-classification inside transaction", post, usernames);
            const notOk = CLASSES.filter((k) => !OK_CLASSES.includes(k) && postSummary.counts[k] > 0);
            if (notOk.length) throw new Error(`post-apply classes not clean: ${notOk.join(", ")}`);
            const pending = (await c.query(ANCHOR_CANDIDATES_SQL)).rowCount;
            if (pending !== 0) throw new Error(`ANCHOR_PENDING after apply: ${pending}`);
            const inv = (await c.query(INVARIANTS_SQL)).rows[0];
            if (inv.new_with_call !== 0 || inv.closed_mismatch !== 0 || inv.closed_on_non_deal !== 0) {
                throw new Error(`invariants violated: ${JSON.stringify(inv)}`);
            }

            await c.query("COMMIT");
            console.log("\nCOMMITTED.");
        } catch (error) {
            await c.query("ROLLBACK").catch(() => {});
            console.error(`\nROLLED BACK: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        }
    } finally {
        await c.end();
    }
}

main().catch((error) => {
    console.error(`ABORT: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
