// HISTORICKÉ – UŽ SA NESPUSTÍ. Prevod prebehol na testovacej vetve 2026-09-20 (12 častí z 12 úloh, nulový drift)
// a krokom S-13b zmizli stĺpce `DealTask.contents` / `result`, z ktorých čítal. Súbor ostáva ako presný záznam
// toho, čo sa spustilo; `main()` sa preto hneď na začiatku zastaví. Časti sú odvtedy ZDROJOM PRAVDY a nikdy sa
// neodvodzujú znova (§6.3).
//
// Wave 4 prevod TESTOVACÍCH dát: DealTask.contents / result → DealTaskPart (wave-4-proposal.md §6.3).
//
// PRODUKCIA TENTO SKRIPT NIKDY NESPUSTÍ. Tabuľky úloh v produkcii vôbec neexistujú, takže dostane rovno finálnu
// schému rodič + časti v jednom prírastkovom kroku; prevod testovacích dát nie je súčasťou rolloutu.
//
// Do prepnutia kódu (§9 krok 7) je DealTaskPart ČISTÉ ODVODENIE: nič ho nečíta a nič iné doň nepíše. Prevod preto
// zmaže všetky časti a vytvorí ich nanovo – je presne reprodukovateľný a dá sa opakovať bez driftu. Po prepnutí
// sa stáva zdrojom pravdy a už sa NIKDY neodvodzuje znova.
//
// Bezpečnosť ako pri ostatných backfilloch: DRY-RUN predvolený; --apply vyžaduje --confirm <endpoint>; produkčný
// endpoint je odmietnutý NEZÁVISLE od argumentov; URL ani heslo sa nevypisujú. Pri nejednoznačnosti sa NIČ nezapíše,
// vypíšu sa presné riadky a skript skončí (R02-10) – vymazanie a znovunaplnenie testu je Michalovo rozhodnutie,
// nikdy automatický krok plánu.
//
//   npx tsx prisma/backfill/2026-09-wave4-parts.ts --expect-endpoint ep-xxxx --expect-db neondb
//   npx tsx prisma/backfill/2026-09-wave4-parts.ts --expect-endpoint ep-xxxx --expect-db neondb --apply --confirm ep-xxxx
//   npx tsx prisma/backfill/2026-09-wave4-parts.ts --expect-endpoint ep-xxxx --expect-db neondb --verify
import "dotenv/config";
import { Client } from "pg";
import { ABORTS, DELETE_ALL_PARTS, DRIFT_CHECKS, INSERT_PARTS, POST_CUTOVER_SQL, REWRITE_DISMISSALS } from "./wave4-parts-sql";

type Args = { expectEndpoint?: string; expectDb?: string; confirm?: string; apply: boolean; verify: boolean };

// Produkcia sa nekonvertuje z bežnej relácie – ani omylom, ani „správnymi" argumentmi.
const FORBIDDEN_ENDPOINT_SUFFIXES = ["m0xyun"];

function fail(message: string): never {
    console.error(`ABORT: ${message}`);
    process.exit(1);
}

function parseArgs(argv: string[]): Args {
    const args: Args = { apply: false, verify: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (!v || v.startsWith("--")) fail(`Chýba hodnota pre ${a}`);
            return v;
        };
        if (a === "--expect-endpoint") args.expectEndpoint = next();
        else if (a === "--expect-db") args.expectDb = next();
        else if (a === "--confirm") args.confirm = next();
        else if (a === "--apply") args.apply = true;
        else if (a === "--verify") args.verify = true;
        else fail(`Neznámy argument: ${a}`);
    }
    return args;
}

function endpointOf(connectionString: string) {
    const url = new URL(connectionString);
    const label = url.hostname.split(".")[0];
    return { endpoint: label.replace(/-pooler$/, ""), db: decodeURIComponent(url.pathname.replace(/^\//, "")) };
}

async function ids(c: Client, sql: string, limit = 20): Promise<string[]> {
    const r = await c.query<{ id: string }>(`SELECT q.id FROM (${sql}) q LIMIT ${limit}`);
    return r.rows.map((x) => x.id);
}

// Nejednoznačnosti – vypísať presné riadky, nezapísať nič.
export async function findBlockers(c: Client): Promise<{ id: string; why: string; rows: string[] }[]> {
    const out: { id: string; why: string; rows: string[] }[] = [];
    for (const a of ABORTS) {
        const rows = await ids(c, a.sql);
        if (rows.length) out.push({ id: a.id, why: a.why, rows });
    }
    return out;
}

// Dôkaz, že prevod už prebehol a nový kód píše časti sám – potom je opakovaný prevod deštruktívny (§6.3).
export async function postCutover(c: Client): Promise<string[]> {
    return ids(c, POST_CUTOVER_SQL);
}

// Nulový drift: rodič a jeho časti hovoria to isté (§6.3 kroky 3 a 5).
export async function findDrift(c: Client): Promise<{ id: string; why: string; rows: string[] }[]> {
    const out: { id: string; why: string; rows: string[] }[] = [];
    for (const d of DRIFT_CHECKS) {
        const rows = await ids(c, d.sql);
        if (rows.length) out.push({ id: d.id, why: d.why, rows });
    }
    return out;
}

// Prevod v JEDNEJ transakcii: zmaž, vytvor nanovo, prepíš staré potvrdenia, over nulový drift.
export async function convert(c: Client): Promise<{ deleted: number; created: number; dismissals: number }> {
    const deleted = (await c.query(DELETE_ALL_PARTS)).rowCount ?? 0;
    const created = (await c.query(INSERT_PARTS)).rowCount ?? 0;
    const dismissals = (await c.query(REWRITE_DISMISSALS)).rowCount ?? 0;
    const drift = await findDrift(c);
    if (drift.length) throw new Error(`drift po prevode: ${drift.map((d) => `${d.id} (${d.rows.length})`).join(", ")}`);
    return { deleted, created, dismissals };
}

async function inventory(c: Client) {
    const tasks = await c.query<{ type: string; status: string; n: number }>(
        `SELECT type::text, status::text, count(*)::int AS n FROM "DealTask" GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    const parts = await c.query<{ status: string; n: number }>(
        `SELECT status::text, count(*)::int AS n FROM "DealTaskPart" GROUP BY 1 ORDER BY 1`,
    );
    const expected = await c.query<{ n: number }>(
        `SELECT coalesce(sum((SELECT count(DISTINCT x) FROM unnest(t.contents) x)), 0)::int AS n FROM "DealTask" t WHERE t.type = 'HELP'`,
    );
    return { tasks: tasks.rows, parts: parts.rows, expected: expected.rows[0].n };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) fail("DATABASE_URL nie je nastavené.");
    if (!args.expectEndpoint || !args.expectDb) fail("Povinné: --expect-endpoint a --expect-db.");
    const target = endpointOf(connectionString);
    if (FORBIDDEN_ENDPOINT_SUFFIXES.some((s) => target.endpoint.endsWith(s))) {
        fail("Cieľ je produkčný endpoint – tento skript sa na produkcii nespúšťa.");
    }
    if (target.endpoint !== args.expectEndpoint) fail("Endpoint nesedí (DATABASE_URL má iný endpoint než --expect-endpoint).");
    if (target.db !== args.expectDb) fail("Databáza nesedí (DATABASE_URL má inú databázu než --expect-db).");
    if (args.apply) {
        if (args.confirm !== target.endpoint) fail("--apply vyžaduje --confirm <endpoint id> zadaný znova.");
        if (args.verify) fail("--apply nejde kombinovať s --verify.");
    }

    const c = new Client({ connectionString });
    await c.connect();
    try {
        const who = await c.query<{ db: string; now: Date }>("SELECT current_database() AS db, now() AS now");
        if (who.rows[0].db !== args.expectDb) fail("current_database() nesedí s --expect-db.");
        console.log(`identity: endpoint=${target.endpoint} db=${who.rows[0].db} now=${new Date(who.rows[0].now).toISOString()}`);

        const before = await inventory(c);
        console.log(`tasks: ${before.tasks.map((t) => `${t.type}/${t.status}=${t.n}`).join(" ") || "none"}`);
        console.log(`parts now: ${before.parts.map((p) => `${p.status}=${p.n}`).join(" ") || "none"} · expected after convert: ${before.expected}`);

        const blockers = await findBlockers(c);
        if (blockers.length) {
            for (const b of blockers) console.error(`BLOCKER ${b.id}: ${b.why} → ${b.rows.join(", ")}`);
            fail("nejednoznačné dáta – nič sa nezapísalo; rozhodni ručne (§6.3 bod 7).");
        }
        console.log("blockers: none");

        const live = await postCutover(c);
        if (live.length) {
            console.log(`post-cutover: ${live.length} úloh má skutočný stav častí – prevod je hotový, časti sú zdrojom pravdy.`);
            if (args.apply) fail("prevod už prebehol; opakovanie by zmazalo skutočnú prácu (§6.3).");
            if (args.verify) {
                console.log("VERIFY: kontroly driftu po prepnutí kódu neplatia – čítajú sa časti, nie rodič.");
                return;
            }
        }

        if (args.verify) {
            const drift = await findDrift(c);
            if (drift.length) {
                for (const d of drift) console.error(`DRIFT ${d.id}: ${d.why} → ${d.rows.join(", ")}`);
                process.exitCode = 1;
            } else console.log("VERIFY OK: nulový drift medzi úlohami a ich časťami.");
            return;
        }
        if (!args.apply) {
            console.log("DRY-RUN: nič sa nezapísalo.");
            return;
        }

        await c.query("BEGIN");
        try {
            const r = await convert(c);
            await c.query("COMMIT");
            console.log(`COMMITTED: deleted=${r.deleted} created=${r.created} dismissalsRewritten=${r.dismissals}`);
        } catch (error) {
            await c.query("ROLLBACK");
            throw error;
        }
        const after = await inventory(c);
        console.log(`parts after: ${after.parts.map((p) => `${p.status}=${p.n}`).join(" ") || "none"}`);
    } finally {
        await c.end();
    }
}

if (process.argv[1] && process.argv[1].includes("2026-09-wave4-parts")) {
    // Zastavené natrvalo: prevod prebehol a stĺpce, z ktorých čítal, už neexistujú (S-13b).
    fail("prevod je hotový a stĺpce, z ktorých čítal, už neexistujú (S-13b) – tento súbor je len záznam.");
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
