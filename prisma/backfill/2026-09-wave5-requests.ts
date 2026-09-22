// Wave 5 backfill: „čo klient pýtal" pre staré obchody (wave-5-proposal.md §11).
//
// Michalovo pravidlo, prijaté ako obchodná pravda: pri starých záznamoch platí, že VŠETKO, čo klient DOSTAL, si aj
// vyžiadal. Naviac obchod, ktorý má otvorený odosielací krok a zodpovedajúce odoslanie nemá, nesie nesplnenú
// požiadavku – inak by sa rozpracovaná práca po nasadení stratila.
//
//   kanonické OFFER_SENT s ABOUT_US  → LeadRequest(INFO, SENT)      origin MIGRATED_RECEIPT
//   kanonické OFFER_SENT s PRICELIST → LeadRequest(PRICELIST, SENT) origin MIGRATED_RECEIPT
//   kanonické OFFER_SENT s PRICE     → LeadRequest(PRICE, SENT)     origin MIGRATED_RECEIPT
//   kanonické OFFER_SENT s DESIGN    → LeadRequest(DESIGN, SENT)    origin MIGRATED_RECEIPT
//   otvorený obchod, krok SEND_*, bez zodpovedajúceho odoslania → LeadRequest(OPEN) origin MIGRATED_OPEN_STEP
//
// CENNÍK (R01-1): v živej produkcii cenník neexistoval (db-changes.md §3.3, Michal 2026-09-20), takže tento skript
// nikdy nehádá, komu ho poslali. Príjemcov vymenúva Michal pri PREVODE STARÝCH ODOSLANÍ – tam sa `PRICELIST` pridá do
// obsahu konkrétneho kanonického OFFER_SENT (leadId + activityId). Odtiaľ ho tento skript vidí ako každé iné prijaté
// odoslanie a vytvorí prepojený riadok SENT. Samostatný zoznam „cenník poslaný" tu zámerne NIE JE: vyrábal by
// OTVORENÚ požiadavku (falošnú prácu) bez odoslania, ktoré ju spĺňa.
//
// ZÁMERNE sa NEVYTVÁRA REVIEW – starý systém taký obsah nemal.
//
// BEŽÍ AŽ PO prevode starých odoslaní na kanonické OFFER_SENT (db-changes.md §3.3). Bez toho by staré emaily,
// CP a návrhy neboli vidieť ako odoslania a skript by z nich nič neodvodil – preto hlási, koľko leadov má staré
// dôkazy odoslania bez jediného kanonického záznamu, a s --apply v takom prípade skončí.
//
// Identita a opakovateľnosť (R02-3): každý riadok má deterministický `migrationKey`, takže opakovaný ani prerušený
// beh nevytvorí duplikát; `provenance` nesie zdroj a istotu; `requestedById` je NULL – historický aktér nie je známy
// a nikdy sa nepripíše dnešnému vlastníkovi. Migrované riadky sú vylúčené zo štatistík dopytu (origin <> LIVE).
// SQL príkazy sú v wave5-requests-sql.ts, aby ich test spúšťal presne tie isté.
//
// Bezpečnosť ako pri ostatných backfilloch: DRY-RUN predvolený; --apply len na DIRECT hoste s --confirm <endpoint>;
// --expect-endpoint a --expect-db sa musia zhodovať s DATABASE_URL; produkčný endpoint je odmietnutý NEZÁVISLE od
// argumentov; URL ani heslo sa nevypisujú.
//
//   npx tsx prisma/backfill/2026-09-wave5-requests.ts --expect-endpoint ep-xxxx --expect-db neondb
//   npx tsx prisma/backfill/2026-09-wave5-requests.ts --expect-endpoint ep-xxxx --expect-db neondb --apply --confirm ep-xxxx
//   npx tsx prisma/backfill/2026-09-wave5-requests.ts --expect-endpoint ep-xxxx --expect-db neondb --verify
import "dotenv/config";
import { Client } from "pg";
import { insertOpenStep, insertReceipts, openStepRows, RECEIPT_SOURCES, receiptRows, STEP_SOURCES } from "./wave5-requests-sql";

type Args = {
    expectEndpoint?: string;
    expectDb?: string;
    confirm?: string;
    apply: boolean;
    verify: boolean;
};

// Produkcia sa nemigruje z bežnej relácie – ani omylom, ani „správnymi" argumentmi (db-changes.md §3.3 krok 2).
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
    return {
        endpoint: label.replace(/-pooler$/, ""),
        db: decodeURIComponent(url.pathname.replace(/^\//, "")),
        pooled: label.endsWith("-pooler"),
    };
}

async function count(c: Client, sql: string, params: unknown[] = []): Promise<number> {
    const r = await c.query<{ n: string }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params as never[]);
    return Number(r.rows[0].n);
}

// Koľko práce ešte čaká (dry-run aj --verify čítajú to isté).
async function pending(c: Client) {
    const receipts: Record<string, number> = {};
    for (const s of RECEIPT_SOURCES) {
        receipts[s.content] = await count(
            c,
            `SELECT r."leadId" FROM (${receiptRows(s.content, s.sent)}) r
              WHERE NOT EXISTS (SELECT 1 FROM "LeadRequest" x WHERE x."leadId" = r."leadId" AND x.content = '${s.content}')`,
        );
    }
    const steps: Record<string, number> = {};
    for (const s of STEP_SOURCES) {
        steps[s.kind] = await count(
            c,
            `SELECT s."leadId" FROM (${openStepRows(s.kind, s.content, s.sent)}) s
              WHERE NOT EXISTS (SELECT 1 FROM "LeadRequest" x WHERE x."leadId" = s."leadId" AND x.content = '${s.content}')`,
        );
    }
    return { receipts, steps };
}

// Leady so starými dôkazmi odoslania, ktoré ešte nemajú ani jeden kanonický OFFER_SENT – pre ne by migrácia
// vyrobila neúplný obraz, preto je to blokujúca výnimka (db-changes.md §3.3).
async function unconverted(c: Client): Promise<number> {
    return count(
        c,
        `SELECT l.id FROM "Lead" l
          WHERE l."deletedAt" IS NULL
            AND (l."quoteSentAt" IS NOT NULL OR l."aboutUsSentAt" IS NOT NULL OR l."priceDisclosed" = true
                 OR EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = l.id AND a.type IN ('QUOTE_SENT','EMAIL_SENT','DESIGN_SENT')))
            AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = l.id AND a.type = 'OFFER_SENT')`,
    );
}

function total(p: Awaited<ReturnType<typeof pending>>): number {
    return Object.values(p.receipts).reduce((a, b) => a + b, 0) + Object.values(p.steps).reduce((a, b) => a + b, 0);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) fail("DATABASE_URL nie je nastavené.");
    if (!args.expectEndpoint || !args.expectDb) fail("Povinné: --expect-endpoint a --expect-db.");
    const target = endpointOf(connectionString);
    // Produkcia len v schválenom okne V1 → V2: wrapper .ai/migrations/v1-to-v2-live/tools/with-target.mjs s
    // --production-window nastaví ZVONCEK_PRODUCTION_WINDOW na presne tento endpoint. Inak odmietnuté ako doteraz.
    if (FORBIDDEN_ENDPOINT_SUFFIXES.some((s) => target.endpoint.endsWith(s)) && process.env.ZVONCEK_PRODUCTION_WINDOW !== target.endpoint) {
        fail("Cieľ je produkčný endpoint – mimo schváleného okna sa tu nespúšťa.");
    }
    if (target.endpoint !== args.expectEndpoint) fail("Endpoint nesedí (DATABASE_URL má iný endpoint než --expect-endpoint).");
    if (target.db !== args.expectDb) fail("Databáza nesedí (DATABASE_URL má inú databázu než --expect-db).");
    if (args.apply) {
        if (target.pooled) fail("--apply vyžaduje DIRECT (nie -pooler) host.");
        if (args.confirm !== target.endpoint) fail("--apply vyžaduje --confirm <endpoint id> zadaný znova.");
        if (args.verify) fail("--apply nejde kombinovať s --verify.");
    }

    const c = new Client({ connectionString });
    await c.connect();
    try {
        const who = await c.query<{ db: string; now: Date }>("SELECT current_database() AS db, now() AS now");
        if (who.rows[0].db !== args.expectDb) fail("current_database() nesedí s --expect-db.");
        console.log(`identity: endpoint=${target.endpoint} db=${who.rows[0].db} host=${target.pooled ? "pooler" : "direct"} now=${new Date(who.rows[0].now).toISOString()}`);

        const blocked = await unconverted(c);
        const before = await pending(c);
        const existing = await c.query<{ origin: string; n: number }>(
            `SELECT origin, count(*)::int AS n FROM "LeadRequest" GROUP BY origin ORDER BY origin`,
        );
        console.log(`to create: receipts=${JSON.stringify(before.receipts)} openSteps=${JSON.stringify(before.steps)}`);
        console.log(`already: ${existing.rows.map((r) => `${r.origin}=${r.n}`).join(" ") || "none"}`);
        console.log(`unconverted legacy sends (blocker): ${blocked}`);

        if (args.verify) {
            const left = total(before);
            if (left) {
                console.error(`VERIFY FAILED: ${left} riadkov ešte chýba – spusti --apply.`);
                process.exitCode = 1;
            } else console.log("VERIFY OK: nič nové na vytvorenie.");
            return;
        }
        if (!args.apply) {
            console.log("DRY-RUN: nič sa nezapísalo.");
            return;
        }
        if (blocked > 0) {
            fail(`${blocked} leadov má staré dôkazy odoslania bez kanonického OFFER_SENT – najprv prevod odoslaní (db-changes.md §3.3).`);
        }

        await c.query("BEGIN");
        try {
            let created = 0;
            for (const s of RECEIPT_SOURCES) created += (await c.query(insertReceipts(s.content, s.sent))).rowCount ?? 0;
            for (const s of STEP_SOURCES) created += (await c.query(insertOpenStep(s.kind, s.content, s.sent))).rowCount ?? 0;
            const after = await pending(c);
            if (total(after) !== 0) throw new Error(`po zápise ostalo ${total(after)} riadkov`);
            await c.query("COMMIT");
            console.log(`COMMITTED: created=${created}`);
        } catch (error) {
            await c.query("ROLLBACK");
            throw error;
        }
    } finally {
        await c.end();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
