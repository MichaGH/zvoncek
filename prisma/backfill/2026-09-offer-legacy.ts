// Jednorazový krok wave 3a (round 2 §2c, „Schema delta"): označí, čo pochádza zo starého systému odosielania.
//
// - Lead.hadLegacySends = true  pre leady so starými dôkazmi odoslania (quoteSentAt, aboutUsSentAt, priceDisclosed,
//   staré aktivity QUOTE_SENT / EMAIL_SENT / DESIGN_SENT, alebo návrh označený ako poslaný bez akéhokoľvek OFFER_SENT).
// - Design.legacySentAt = Design.sentAt  pre návrhy poslané starým spôsobom (žiadny OFFER_SENT ich neobsahuje).
//
// Hodnoty len NASTAVUJE (nikdy nemaže), takže je opakovateľný. Nový kód staré polia nezapisuje, takže druhý beh
// po nasadení zachytí len to, čo stihol zapísať starý kód medzi prvým behom a nasadením; --verify potom hlási 0.
//
// Bezpečnosť ako pri 2026-09-assignments.ts: DRY-RUN predvolený; --apply len na DIRECT hoste s --confirm <endpoint>;
// --expect-endpoint a --expect-db sa musia zhodovať s DATABASE_URL; URL ani heslo sa nevypisujú.
//
//   npx tsx prisma/backfill/2026-09-offer-legacy.ts --expect-endpoint ep-xxxx --expect-db neondb
//   npx tsx prisma/backfill/2026-09-offer-legacy.ts --expect-endpoint ep-xxxx --expect-db neondb --apply --confirm ep-xxxx
//   npx tsx prisma/backfill/2026-09-offer-legacy.ts --expect-endpoint ep-xxxx --expect-db neondb --verify
import "dotenv/config";
import { Client } from "pg";

type Args = { expectEndpoint?: string; expectDb?: string; confirm?: string; apply: boolean; verify: boolean };

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

// Návrh je „obsiahnutý v novom odoslaní", ak ho meta.designs niektorého OFFER_SENT uvádza (aj prečiarknutého –
// ten už bol zapísaný novým systémom, takže jeho dátum nie je starý).
const IN_NEW_SEND = `EXISTS (SELECT 1 FROM "Activity" a
        WHERE a."leadId" = d."leadId" AND a.type = 'OFFER_SENT'
          AND a.meta->'designs' @> jsonb_build_array(jsonb_build_object('id', d.id)))`;

const LEGACY_LEAD_WHERE = `l."hadLegacySends" = false AND (
        l."quoteSentAt" IS NOT NULL
     OR l."aboutUsSentAt" IS NOT NULL
     OR l."priceDisclosed" = true
     OR EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = l.id AND a.type IN ('QUOTE_SENT', 'EMAIL_SENT', 'DESIGN_SENT'))
     OR EXISTS (SELECT 1 FROM "Design" d WHERE d."leadId" = l.id AND d."sentAt" IS NOT NULL AND NOT ${IN_NEW_SEND}))`;

const LEGACY_DESIGN_WHERE = `d."legacySentAt" IS NULL AND d."sentAt" IS NOT NULL AND NOT ${IN_NEW_SEND}`;

async function counts(c: Client) {
    const r = await c.query<{ leads: number; designs: number; flagged: number; baselined: number }>(`
        SELECT (SELECT count(*)::int FROM "Lead" l WHERE ${LEGACY_LEAD_WHERE}) AS leads,
               (SELECT count(*)::int FROM "Design" d WHERE ${LEGACY_DESIGN_WHERE}) AS designs,
               (SELECT count(*)::int FROM "Lead" WHERE "hadLegacySends") AS flagged,
               (SELECT count(*)::int FROM "Design" WHERE "legacySentAt" IS NOT NULL) AS baselined`);
    return r.rows[0];
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) fail("DATABASE_URL nie je nastavené.");
    if (!args.expectEndpoint || !args.expectDb) fail("Povinné: --expect-endpoint a --expect-db.");
    const target = endpointOf(connectionString);
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

        const before = await counts(c);
        console.log(`to mark: leads=${before.leads} designs=${before.designs} | already: leads=${before.flagged} designs=${before.baselined}`);

        if (args.verify) {
            if (before.leads || before.designs) {
                console.error("VERIFY FAILED: niečo ešte nie je označené – spusti --apply.");
                process.exitCode = 1;
            } else console.log("VERIFY OK: nič nové na označenie.");
            return;
        }
        if (!args.apply) {
            console.log("DRY-RUN: nič sa nezapísalo.");
            return;
        }

        await c.query("BEGIN");
        try {
            // Poradie: najprv leady (ich podmienka číta Design.sentAt bez OFFER_SENT), potom baseline návrhov.
            const l = await c.query(`UPDATE "Lead" l SET "hadLegacySends" = true WHERE ${LEGACY_LEAD_WHERE}`);
            const d = await c.query(`UPDATE "Design" d SET "legacySentAt" = d."sentAt" WHERE ${LEGACY_DESIGN_WHERE}`);
            const after = await counts(c);
            if (after.leads || after.designs) throw new Error(`po zápise ostalo leads=${after.leads} designs=${after.designs}`);
            await c.query("COMMIT");
            console.log(`COMMITTED: leads marked=${l.rowCount} designs baselined=${d.rowCount}`);
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
