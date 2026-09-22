// Delta scenáre backfillu (plán §13 fáza 10) na dev/test branchi: simuluje zápisy starého kódu medzi behmi,
// spustí backfill a overí, že zmigruje presne tú deltu; potom CONFLICT musí prerušiť apply. Fixture na konci zmaže.
//
//   npx tsx prisma/backfill/check-backfill-delta.ts --expect-endpoint ep-xxxx --expect-db neondb --owner-username michal //       [--caller-username telesales]   # volajúci pre fixture (predvolene t_timea zo „svetového" seedu)
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const argv = process.argv.slice(2);
const arg = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
};
const expectEndpoint = arg("--expect-endpoint");
const expectDb = arg("--expect-db");
const ownerUsername = arg("--owner-username");
const callerUsername = arg("--caller-username") ?? "t_timea";
const pooled = new URL(process.env.DATABASE_URL ?? "postgres://x/none");
const endpoint = pooled.hostname.split(".")[0].replace(/-pooler$/, "");
if (!expectEndpoint || !expectDb || !ownerUsername || endpoint !== expectEndpoint) {
    console.error("ABORT: --expect-endpoint (must match DATABASE_URL), --expect-db and --owner-username are required (dev/test only).");
    process.exit(1);
}
const direct = new URL(pooled.toString());
direct.hostname = direct.hostname.replace(/^([^.]+)-pooler\./, "$1.");

const RUN = `bfd${Date.now().toString(36)}`;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` – ${detail}` : ""}`);
}

function backfill(extra: string[]): { code: number; out: string } {
    const r = spawnSync(
        "npx",
        ["tsx", "prisma/backfill/2026-09-assignments.ts", "--expect-endpoint", expectEndpoint!, "--expect-db", expectDb!, "--owner-username", ownerUsername!, ...extra],
        { encoding: "utf8", shell: true, env: { ...process.env, DATABASE_URL: direct.toString() } },
    );
    return { code: r.status ?? 1, out: `${r.stdout}\n${r.stderr}` };
}
function classCount(out: string, cls: string): number {
    const m = new RegExp(`^\\s+${cls}\\s+(\\d+)`, "m").exec(out);
    return m ? Number(m[1]) : -1;
}

async function main() {
    const c = new Client({ connectionString: pooled.toString() });
    await c.connect();
    const ids: string[] = [];
    try {
        const caller = (await c.query(`SELECT id FROM "User" WHERE username = $1`, [callerUsername])).rows[0]?.id as string;
        const owner = (await c.query(`SELECT id FROM "User" WHERE username = $1`, [ownerUsername])).rows[0]?.id as string;
        if (!caller || !owner) throw new Error(`fixture users missing (${callerUsername} / owner)`);

        const lead = async (label: string, sql: string, params: unknown[] = []) => {
            const id = `${RUN}_${label}`;
            await c.query(
                `INSERT INTO "Lead" (id, "companyName", phone, status, "createdAt", "updatedAt", revision)
                 VALUES ($1, $2, $3, 'NEW', (now() AT TIME ZONE 'UTC') - interval '10 days', (now() AT TIME ZONE 'UTC'), 0)`,
                [id, `CC-TEST ${RUN} ${label}`, `+000 ${RUN} ${label}`],
            );
            ids.push(id);
            if (sql) await c.query(sql.replaceAll("$LEAD", `'${id}'`), params);
            return id;
        };
        const call = (leadId: string, outcome: string, minutesAgo: number, userId = caller) =>
            c.query(
                `INSERT INTO "Activity" (id, "leadId", "userId", type, category, source, outcome, "createdAt")
                 VALUES (gen_random_uuid()::text, $1, $2, 'CALL', 'BUSINESS', 'CALL_QUEUE', $3::"CallOutcome", (now() AT TIME ZONE 'UTC') - make_interval(mins => $4))`,
                [leadId, userId, outcome, minutesAgo],
            );

        // 1. STRAY_ASSIGNMENT: call work zatvorená starým kódom (LOST), priradenie ostalo.
        const stray = await lead("stray", `UPDATE "Lead" SET status = 'LOST', "assignedCallerId" = $1, "assignedCallerAt" = (now() AT TIME ZONE 'UTC') WHERE id = $LEAD`, [caller]);
        await call(stray, "NOT_INTERESTED", 30);
        // 2. DEAL_CLOSEDAT_FIX: zmigrovaný obchod starým kódom LOST bez closedAt.
        const fix = await lead("closedfix", "");
        await call(fix, "WANTS_QUOTE", 60);
        await c.query(
            `UPDATE "Lead" l SET status = 'LOST', "ownerId" = $1, "handedOffById" = a."userId", "pipelineEnteredAt" = a."createdAt"
               FROM "Activity" a WHERE a."leadId" = l.id AND l.id = $2`,
            [owner, fix],
        );
        // 3. CALLWORK_TO_MIGRATE: POOL lead, starý kód NO_ANSWER bez priradenia.
        const cw = await lead("callwork", `UPDATE "Lead" SET status = 'CALLING', "callbackKind" = 'RETRY' WHERE id = $LEAD`);
        await call(cw, "NO_ANSWER", 20);
        // 4. DEAL_TO_MIGRATE: CALLWORK_OK lead, starý kód pozitívny hovor (priradenie ostalo).
        const dm = await lead("dealmig", `UPDATE "Lead" SET status = 'ACTIVE', "assignedCallerId" = $1 WHERE id = $LEAD`, [caller]);
        await call(dm, "NO_ANSWER", 90);
        await call(dm, "WANTS_EMAIL", 10);

        const dry = backfill([]);
        check(
            "delta dry-run: exactly one of each migrated class, no conflict",
            dry.code === 0 &&
                classCount(dry.out, "STRAY_ASSIGNMENT") === 1 &&
                classCount(dry.out, "DEAL_CLOSEDAT_FIX") === 1 &&
                classCount(dry.out, "CALLWORK_TO_MIGRATE") === 1 &&
                classCount(dry.out, "DEAL_TO_MIGRATE") === 1 &&
                classCount(dry.out, "CONFLICT") === 0,
            ["STRAY_ASSIGNMENT", "DEAL_CLOSEDAT_FIX", "CALLWORK_TO_MIGRATE", "DEAL_TO_MIGRATE", "CONFLICT"].map((k) => `${k}=${classCount(dry.out, k)}`).join(" "),
        );

        const apply = backfill(["--apply", "--confirm", expectEndpoint!]);
        const rows = (await c.query(`SELECT id, status::text, "assignedCallerId", "ownerId", "pipelineEnteredAt", "closedAt", "handedOffById" FROM "Lead" WHERE id = ANY($1)`, [ids])).rows;
        const byId = new Map(rows.map((r) => [r.id, r]));
        check(
            "delta apply: stray unassigned, closedAt fixed, call work assigned, deal migrated",
            apply.code === 0 && apply.out.includes("COMMITTED") &&
                byId.get(stray).assignedCallerId === null &&
                byId.get(fix).closedAt !== null &&
                byId.get(cw).assignedCallerId === caller &&
                byId.get(dm).pipelineEnteredAt !== null && byId.get(dm).assignedCallerId === null && byId.get(dm).ownerId === owner && byId.get(dm).handedOffById === caller,
            apply.code === 0 ? "committed" : apply.out.split("\n").filter((l) => /ROLLED|ABORT|CONFLICT/.test(l)).join(" | "),
        );
        const verify = backfill(["--verify"]);
        check("delta: re-run is clean", verify.code === 0 && verify.out.includes("RESULT: clean"), `exit=${verify.code}`);

        // 5. CONFLICT: pozitívny hovor, ale stav CALLING → dry-run hlási CONFLICT, apply sa celé vráti.
        const conflict = await lead("conflict", `UPDATE "Lead" SET status = 'CALLING', "callbackKind" = 'RETRY' WHERE id = $LEAD`);
        await call(conflict, "WANTS_DESIGN", 5);
        const cdry = backfill([]);
        const number = (await c.query(`SELECT number FROM "Lead" WHERE id = $1`, [conflict])).rows[0].number;
        check("conflict dry-run: CONFLICT reported by lead number, exit 2", cdry.code === 2 && cdry.out.includes(`#${number}`), `exit=${cdry.code}`);
        const before = (await c.query(`SELECT count(*)::int n FROM "Lead" WHERE "pipelineEnteredAt" IS NOT NULL`)).rows[0].n;
        const capply = backfill(["--apply", "--confirm", expectEndpoint!]);
        const after = (await c.query(`SELECT count(*)::int n FROM "Lead" WHERE "pipelineEnteredAt" IS NOT NULL`)).rows[0].n;
        const conflictLead = (await c.query(`SELECT status::text, "pipelineEnteredAt" FROM "Lead" WHERE id = $1`, [conflict])).rows[0];
        check(
            "conflict apply: aborted and rolled back, positive-call CALLING lead not turned into a deal",
            capply.code !== 0 && capply.out.includes("ROLLED BACK") && before === after && conflictLead.status === "CALLING" && conflictLead.pipelineEnteredAt === null,
            `exit=${capply.code}`,
        );
    } finally {
        await c.query(`DELETE FROM "Activity" WHERE "leadId" = ANY($1)`, [ids]);
        await c.query(`DELETE FROM "Lead" WHERE id = ANY($1)`, [ids]);
        await c.end();
        const final = backfill(["--verify"]);
        check("cleanup: test database classification clean again", final.code === 0 && final.out.includes("RESULT: clean"), `exit=${final.code}`);
    }
    console.log(failed ? `\n${failed} FAILED` : "\nall backfill delta checks passed");
    if (failed) process.exitCode = 1;
}

main();
