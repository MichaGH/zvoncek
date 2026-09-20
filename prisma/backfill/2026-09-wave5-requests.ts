// Wave 5 backfill: „čo klient pýtal" pre staré obchody (wave-5-proposal.md §11).
//
// Michalovo pravidlo, prijaté ako obchodná pravda: pri starých záznamoch platí, že VŠETKO, čo klient DOSTAL, si aj
// vyžiadal. Naviac obchod, ktorý má otvorený odosielací krok a zodpovedajúce odoslanie nemá, nesie nesplnenú
// požiadavku – inak by sa rozpracovaná práca po nasadení stratila.
//
//   kanonické OFFER_SENT s ABOUT_US  → LeadRequest(INFO, SENT)      origin MIGRATED_RECEIPT
//   kanonické OFFER_SENT s PRICE     → LeadRequest(PRICE, SENT)     origin MIGRATED_RECEIPT
//   kanonické OFFER_SENT s DESIGN    → LeadRequest(DESIGN, SENT)    origin MIGRATED_RECEIPT
//   otvorený obchod, krok SEND_*, bez zodpovedajúceho odoslania → LeadRequest(OPEN) origin MIGRATED_OPEN_STEP
//
// ZÁMERNE sa NEVYTVÁRA:
//   - PRICELIST – v živej produkcii cenník neexistoval (db-changes.md §3.3, Michal 2026-09-20). Riadky vzniknú len
//     pre leady, ktoré Michal vymenuje v --pricelist-leads <súbor s id na riadok>.
//   - REVIEW – starý systém taký obsah nemal.
//
// BEŽÍ AŽ PO prevode starých odoslaní na kanonické OFFER_SENT (db-changes.md §3.3). Bez toho by staré emaily,
// CP a návrhy neboli vidieť ako odoslania a skript by z nich nič neodvodil – preto hlási, koľko leadov má staré
// dôkazy odoslania bez jediného kanonického záznamu, a s --apply v takom prípade skončí.
//
// Identita a opakovateľnosť (R02-3): každý riadok má deterministický `migrationKey`, takže opakovaný ani prerušený
// beh nevytvorí duplikát; `provenance` nesie zdroj a istotu; `requestedById` je NULL – historický aktér nie je známy
// a nikdy sa nepripíše dnešnému vlastníkovi. Migrované riadky sú vylúčené zo štatistík dopytu (origin <> LIVE).
//
// Bezpečnosť ako pri 2026-09-offer-legacy.ts: DRY-RUN predvolený; --apply len na DIRECT hoste s --confirm <endpoint>;
// --expect-endpoint a --expect-db sa musia zhodovať s DATABASE_URL; produkčný endpoint je odmietnutý NEZÁVISLE od
// argumentov; URL ani heslo sa nevypisujú.
//
//   npx tsx prisma/backfill/2026-09-wave5-requests.ts --expect-endpoint ep-xxxx --expect-db neondb
//   npx tsx prisma/backfill/2026-09-wave5-requests.ts --expect-endpoint ep-xxxx --expect-db neondb --apply --confirm ep-xxxx
//   npx tsx prisma/backfill/2026-09-wave5-requests.ts --expect-endpoint ep-xxxx --expect-db neondb --verify
import "dotenv/config";
import { readFileSync } from "node:fs";
import { Client } from "pg";

type Args = {
    expectEndpoint?: string;
    expectDb?: string;
    confirm?: string;
    pricelistLeads?: string;
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
        else if (a === "--pricelist-leads") args.pricelistLeads = next();
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

// Obsah požiadavky ↔ obsah odoslania, ktoré ju spĺňa (§5). PRICELIST a REVIEW sem zámerne nepatria.
const RECEIPT_SOURCES = [
    { content: "INFO", sent: "ABOUT_US" },
    { content: "PRICE", sent: "PRICE" },
    { content: "DESIGN", sent: "DESIGN" },
] as const;

const STEP_SOURCES = [
    { kind: "SEND_QUOTE", content: "PRICE", sent: "PRICE" },
    { kind: "SEND_DESIGN", content: "DESIGN", sent: "DESIGN" },
    { kind: "SEND_EMAIL", content: "INFO", sent: "ABOUT_US" },
] as const;

// Platné (neprečiarknuté) odoslanie daného obsahu. Okamih: spätný záznam nesie historický deň, inak čas zápisu –
// to isté pravidlo ako offerInstant() v lib/domain/offers.ts, aby prepočet po migrácii nič neprehodil.
const instantSql = `CASE WHEN (a.meta->>'historical')::boolean IS TRUE
        THEN ((a.meta->>'sentOn')::date)::timestamp
        ELSE a."createdAt" END`;

function receiptRows(content: string, sent: string): string {
    return `
        SELECT DISTINCT ON (a."leadId")
               a."leadId", a.id AS "activityId", a."userId", ${instantSql} AS instant, a.meta->>'sentOn' AS "sentOn"
          FROM "Activity" a
         WHERE a.type = 'OFFER_SENT' AND a."revertedAt" IS NULL
           AND a.meta->'contents' ? '${sent}'
         ORDER BY a."leadId", ${instantSql} ASC, a.id ASC`;
}

// Jeden riadok na (obchod, obsah) z PRVÉHO odoslania – klient si to vyžiadal raz, nie pri každom emaili.
function insertReceipts(content: string, sent: string): string {
    return `
        INSERT INTO "LeadRequest" (id, "leadId", content, state, origin, "requestedAt", "requestedById",
                                   "sourceActivityId", "resolvedAt", "resolvedById", "resolvedActivityId",
                                   "migrationKey", provenance, "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, r."leadId", '${content}', 'SENT', 'MIGRATED_RECEIPT', r.instant, NULL,
               NULL, r.instant, r."userId", r."activityId",
               'w5:receipt:' || r."leadId" || ':${content}',
               jsonb_build_object('source', 'OFFER_SENT', 'activityId', r."activityId", 'sentOn', r."sentOn",
                                  'rule', 'received implies asked', 'confidence', 'high'),
               now(), now()
          FROM (${receiptRows(content, sent)}) r
         WHERE NOT EXISTS (SELECT 1 FROM "LeadRequest" x WHERE x."leadId" = r."leadId" AND x.content = '${content}')
        ON CONFLICT ("migrationKey") DO NOTHING`;
}

// Otvorený obchod s odosielacím krokom, pre ktorý neexistuje zodpovedajúce platné odoslanie = nesplnená požiadavka.
function openStepRows(kind: string, content: string, sent: string): string {
    return `
        SELECT l.id AS "leadId", COALESCE(l."pipelineEnteredAt", l."createdAt") AS instant
          FROM "Lead" l
         WHERE l."deletedAt" IS NULL AND l."pipelineEnteredAt" IS NOT NULL
           AND l.status IN ('ACTIVE', 'SNOOZED')
           AND l."nextActionKind" = '${kind}'
           AND NOT EXISTS (
                 SELECT 1 FROM "Activity" a
                  WHERE a."leadId" = l.id AND a.type = 'OFFER_SENT' AND a."revertedAt" IS NULL
                    AND a.meta->'contents' ? '${sent}')`;
}

function insertOpenStep(kind: string, content: string, sent: string): string {
    return `
        INSERT INTO "LeadRequest" (id, "leadId", content, state, origin, "requestedAt", "requestedById",
                                   "migrationKey", provenance, "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, s."leadId", '${content}', 'OPEN', 'MIGRATED_OPEN_STEP', s.instant, NULL,
               'w5:step:' || s."leadId" || ':${content}',
               jsonb_build_object('source', 'nextActionKind', 'kind', '${kind}',
                                  'rule', 'open send step without a receipt', 'confidence', 'inferred'),
               now(), now()
          FROM (${openStepRows(kind, content, sent)}) s
         WHERE NOT EXISTS (SELECT 1 FROM "LeadRequest" x WHERE x."leadId" = s."leadId" AND x.content = '${content}')
        ON CONFLICT ("migrationKey") DO NOTHING`;
}

// Zoznam id ide ako parameter $1 (nikdy sa nevlepuje do SQL) – volajúci ho odovzdá pri c.query.
function insertPricelist(): string {
    return `
        INSERT INTO "LeadRequest" (id, "leadId", content, state, origin, "requestedAt", "requestedById",
                                   "migrationKey", provenance, "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, l.id, 'PRICELIST', 'OPEN', 'MIGRATED_RECEIPT',
               COALESCE(l."pipelineEnteredAt", l."createdAt"), NULL,
               'w5:pricelist:' || l.id,
               jsonb_build_object('source', 'manual list', 'rule', 'named by Michal', 'confidence', 'manual'),
               now(), now()
          FROM "Lead" l
         WHERE l.id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM "LeadRequest" x WHERE x."leadId" = l.id AND x.content = 'PRICELIST')
        ON CONFLICT ("migrationKey") DO NOTHING`;
}

async function count(c: Client, sql: string, params: unknown[] = []): Promise<number> {
    const r = await c.query<{ n: string }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params as never[]);
    return Number(r.rows[0].n);
}

// Koľko práce ešte čaká (dry-run aj --verify čítajú to isté).
async function pending(c: Client, pricelistIds: string[]) {
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
    const pricelist = pricelistIds.length
        ? await count(
              c,
              `SELECT l.id FROM "Lead" l WHERE l.id = ANY($1::text[])
                AND NOT EXISTS (SELECT 1 FROM "LeadRequest" x WHERE x."leadId" = l.id AND x.content = 'PRICELIST')`,
              [pricelistIds],
          )
        : 0;
    return { receipts, steps, pricelist };
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
    return Object.values(p.receipts).reduce((a, b) => a + b, 0) + Object.values(p.steps).reduce((a, b) => a + b, 0) + p.pricelist;
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
        if (target.pooled) fail("--apply vyžaduje DIRECT (nie -pooler) host.");
        if (args.confirm !== target.endpoint) fail("--apply vyžaduje --confirm <endpoint id> zadaný znova.");
        if (args.verify) fail("--apply nejde kombinovať s --verify.");
    }

    const pricelistIds = args.pricelistLeads
        ? readFileSync(args.pricelistLeads, "utf8")
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith("#"))
        : [];

    const c = new Client({ connectionString });
    await c.connect();
    try {
        const who = await c.query<{ db: string; now: Date }>("SELECT current_database() AS db, now() AS now");
        if (who.rows[0].db !== args.expectDb) fail("current_database() nesedí s --expect-db.");
        console.log(`identity: endpoint=${target.endpoint} db=${who.rows[0].db} host=${target.pooled ? "pooler" : "direct"} now=${new Date(who.rows[0].now).toISOString()}`);

        const blocked = await unconverted(c);
        const before = await pending(c, pricelistIds);
        const existing = await c.query<{ origin: string; n: number }>(
            `SELECT origin, count(*)::int AS n FROM "LeadRequest" GROUP BY origin ORDER BY origin`,
        );
        console.log(`to create: receipts=${JSON.stringify(before.receipts)} openSteps=${JSON.stringify(before.steps)} pricelist=${before.pricelist}`);
        console.log(`already: ${existing.rows.map((r) => `${r.origin}=${r.n}`).join(" ") || "none"}`);
        console.log(`unconverted legacy sends (blocker): ${blocked}`);
        if (pricelistIds.length === 0) console.log("note: no --pricelist-leads → no PRICELIST rows (live production had no cenník).");

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
            if (pricelistIds.length) created += (await c.query(insertPricelist(), [pricelistIds])).rowCount ?? 0;
            const after = await pending(c, pricelistIds);
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
