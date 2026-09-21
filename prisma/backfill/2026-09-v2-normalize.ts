// Jednorazová normalizácia po prevode V1 → V2: dáta majú vyzerať, akoby boli od začiatku vo V2 (Michal 2026-09-22).
// Spúšťa sa PO 2026-09-assignments.ts a 2026-09-v1-sends.ts, PRED zmazaním starých stĺpcov (sql/03-drop-v1-columns.sql).
// Špecifikácia: .ai/migrations/v1-to-v2-live/DECISIONS.md D-009, 02-data-mapping.md §10.
//
// Obchody (pipelineEnteredAt):
//   1. prvý hovor WANTS_QUOTE / WANTS_DESIGN / WANTS_EMAIL → INTERESTED + meta.asked [PRICE | DESIGN | INFO]
//   2. „Chceli" z toho hovoru (ako V2): LeadRequest s časom a autorom hovoru, sourceActivityId = hovor, origin LIVE
//   3. história vlastníctva ako V2: DealOwnership HANDOFF (od nikoho → vlastník, urobil ten, kto volal)
//   4. prepočet požiadaviek (reconcileRequests) – čo klient neskôr dostal, je SENT
//   5. uzavretý obchod ako ho uzavrie V2: bez kroku; LOST / UNREACHABLE → otvorené požiadavky WITHDRAWN „obchod uzavretý"
// Fáza volania: krok (nextAction*) sa vymaže – V2 ho vo fáze volania nikdy nemá.
// Aktivity: „Cena: X → Y" (CONTACT_UPDATED) → PRICE_CHANGED; ostatné staré audity odoslaní sa zmažú; staré riadky
// EMAIL_SENT / QUOTE_SENT / DESIGN_SENT sa zmažú (nahradili ich prevedené OFFER_SENT).
//
// Nič sa nehádá: nečakaný vzor = BLOKER a beh skončí pred zápisom. Opakovateľné (každý krok najprv overí, či už nie je
// hotový). Bezpečnosť ako ostatné: cez tools/with-target.mjs, DRY-RUN predvolený, --apply --confirm <ep>, --verify.
//
//   node .ai/migrations/v1-to-v2-live/tools/with-target.mjs --expect ep-x -- npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint ep-x [--apply --confirm ep-x | --verify]
import "dotenv/config";
import prisma from "../../lib/db";
import { lockLeadRow, withLockTx, type Tx } from "../../lib/access/locks";
import { reconcileRequests } from "../../lib/domain/requestMutations";
import { updateLead } from "../../lib/domain/leadWrites";
import { parseOfferMeta } from "../../lib/domain/offers";
import type { RequestContent } from "../../app/generated/prisma/enums";

const ASK_OF: Record<string, RequestContent> = { WANTS_QUOTE: "PRICE", WANTS_DESIGN: "DESIGN", WANTS_EMAIL: "INFO" };
const POSITIVE_FIRST = ["WANTS_QUOTE", "WANTS_DESIGN", "WANTS_EMAIL", "INTERESTED"] as const;
const CLOSE_WITHDRAWS = ["LOST", "UNREACHABLE"];
const CLOSED = ["WON", "LOST", "UNREACHABLE"];
const OLD_AUDIT_NOTES = ["Klient oboznámený s cenou", "Oboznámenie s cenou zrušené", "Odoslanie cenovej ponuky zrušené"];
const WITHDRAW_REASON = "obchod uzavretý";
const NO_STEP = { nextActionKind: null, nextActionAt: null, nextActionHasTime: false, nextActionMode: "SCHEDULED", nextActionNote: null } as const;

type Args = { expectEndpoint?: string; confirm?: string; apply: boolean; verify: boolean };
function parseArgs(argv: string[]): Args {
    const a: Args = { apply: false, verify: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => {
            const v = argv[++i];
            if (!v || v.startsWith("--")) fail(`Chýba hodnota pre ${k}`);
            return v;
        };
        if (k === "--expect-endpoint") a.expectEndpoint = next();
        else if (k === "--confirm") a.confirm = next();
        else if (k === "--apply") a.apply = true;
        else if (k === "--verify") a.verify = true;
        else fail(`Neznámy argument: ${k}`);
    }
    return a;
}
function fail(msg: string): never {
    console.error(`ABORT: ${msg}`);
    process.exit(1);
}
const hasStep = (l: { nextActionKind: unknown; nextActionAt: unknown; nextActionNote: unknown }) =>
    Boolean(l.nextActionKind || l.nextActionAt || l.nextActionNote);

// „Cena: — → 499 €" / „Cena: 689 € → 639 €" (V1 aj V2 píšu ten istý tvar).
function parsePriceNote(note: string | null): { from: number | null; to: number | null } | null {
    const m = note?.match(/^Cena: (—|[\d.]+ €) → (—|[\d.]+ €)$/);
    if (!m) return null;
    const val = (s: string) => (s === "—" ? null : Number(s.replace(" €", "")));
    return { from: val(m[1]), to: val(m[2]) };
}

async function load() {
    const deals = await prisma.lead.findMany({
        where: { pipelineEnteredAt: { not: null } },
        select: {
            id: true, number: true, status: true, ownerId: true, handedOffById: true, pipelineEnteredAt: true, closedAt: true,
            nextActionKind: true, nextActionAt: true, nextActionNote: true,
            activities: {
                where: { OR: [{ type: "CALL", source: "CALL_QUEUE" }, { type: "STATUS_CHANGED" }] },
                select: { id: true, type: true, outcome: true, userId: true, createdAt: true, meta: true },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
            requests: { select: { id: true, state: true, migrationKey: true, sourceActivityId: true } },
            ownerships: { select: { id: true } },
        },
        orderBy: { number: "asc" },
    });
    const callStage = await prisma.lead.count({
        where: { pipelineEnteredAt: null, OR: [{ nextActionKind: { not: null } }, { nextActionAt: { not: null } }, { nextActionNote: { not: null } }] },
    });
    const priceNotes = await prisma.activity.findMany({ where: { type: "CONTACT_UPDATED", note: { startsWith: "Cena:" } }, select: { id: true, note: true, leadId: true } });
    const oldAudits = await prisma.activity.count({ where: { type: "CONTACT_UPDATED", note: { in: OLD_AUDIT_NOTES } } });
    const oldSends = await prisma.activity.findMany({ where: { type: { in: ["EMAIL_SENT", "QUOTE_SENT", "DESIGN_SENT"] } }, select: { id: true, type: true, leadId: true, createdAt: true } });
    const offers = await prisma.activity.findMany({ where: { type: "OFFER_SENT" }, select: { id: true, meta: true } });
    const undoNotes = await prisma.activity.findMany({ where: { note: "Odoslanie cenovej ponuky zrušené" }, select: { leadId: true, createdAt: true } });
    return { deals, callStage, priceNotes, oldAudits, oldSends, offers, undoNotes };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function plan(d: Loaded) {
    const blockers: string[] = [];
    const counts = { firstCallsToConvert: 0, asksToCreate: 0, ownershipToCreate: 0, closedStepsToClear: 0, closedWithOpenAsks: 0, callStageStepsToClear: d.callStage, priceNotesToConvert: 0, oldAuditsToDelete: d.oldAudits, oldSendsToDelete: d.oldSends.length, historicalMigratedToFix: 0 };
    const perLead: { id: string; number: number; call: { id: string; userId: string; createdAt: Date; outcome: string; meta: unknown }; ask: RequestContent }[] = [];
    for (const l of d.deals) {
        const firsts = l.activities.filter((a) => a.type === "CALL" && (POSITIVE_FIRST as readonly string[]).includes(a.outcome ?? ""));
        const call = firsts.find((a) => a.createdAt.getTime() === l.pipelineEnteredAt!.getTime());
        if (firsts.length !== 1 || !call) { blockers.push(`#${l.number}: prvý pozitívny hovor nie je jednoznačný (${firsts.length})`); continue; }
        let ask: RequestContent | undefined = ASK_OF[call.outcome ?? ""];
        if (call.outcome === "INTERESTED") {
            const asked = (call.meta as { asked?: RequestContent[] } | null)?.asked ?? [];
            if (asked.length !== 1) { blockers.push(`#${l.number}: INTERESTED bez jedného meta.asked`); continue; }
            ask = asked[0];
        } else counts.firstCallsToConvert++;
        if (!ask) { blockers.push(`#${l.number}: neznámy výsledok ${call.outcome}`); continue; }
        if (!l.requests.some((r) => r.migrationKey === `v2norm:ask:${call.id}`)) counts.asksToCreate++;
        if (!l.ownerships.length) {
            counts.ownershipToCreate++;
            if (!l.ownerId || !l.handedOffById) blockers.push(`#${l.number}: obchod bez vlastníka / bez handedOffBy`);
        }
        if (CLOSED.includes(l.status) && hasStep(l)) counts.closedStepsToClear++;
        if (CLOSE_WITHDRAWS.includes(l.status) && !l.closedAt) blockers.push(`#${l.number}: uzavretý bez closedAt`);
        perLead.push({ id: l.id, number: l.number, call: { ...call, outcome: call.outcome ?? "" }, ask });
    }
    for (const n of d.priceNotes) {
        if (!parsePriceNote(n.note)) blockers.push(`nečitateľná zmena ceny: "${n.note}" (activity ${n.id})`);
        else counts.priceNotesToConvert++;
    }
    // Staré odoslania smú zmiznúť, len ak ich pokrýva prevedené OFFER_SENT, alebo ide o zrušenú CP.
    const covered = new Set<string>();
    for (const o of d.offers) {
        const m = parseOfferMeta(o.meta);
        if (m?.migrated) {
            for (const s of m.migration?.sources ?? []) covered.add(s);
            if (m.historical) counts.historicalMigratedToFix++;
        }
    }
    const oldSendsByLead = new Map<string, typeof d.oldSends>();
    for (const s of d.oldSends) oldSendsByLead.set(s.leadId, [...(oldSendsByLead.get(s.leadId) ?? []), s]);
    for (const s of d.oldSends) {
        if (covered.has(s.id)) continue;
        const later = (oldSendsByLead.get(s.leadId) ?? []).filter((x) => x.type === "QUOTE_SENT" && x.createdAt > s.createdAt).map((x) => x.createdAt.getTime());
        const nextQuote = later.length ? Math.min(...later) : Infinity;
        const undone = s.type === "QUOTE_SENT" && d.undoNotes.some((u) => u.leadId === s.leadId && u.createdAt > s.createdAt && u.createdAt.getTime() < nextQuote);
        if (!undone) blockers.push(`starý ${s.type} ${s.id} nemá prevedené odoslanie – najprv 2026-09-v1-sends.ts`);
    }
    return { blockers, counts, perLead };
}

async function normalizeDeal(tx: Tx, p: ReturnType<typeof plan>["perLead"][number]) {
    if (!(await lockLeadRow(tx, p.id))) throw new Error(`lead #${p.number} zmizol`);
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: p.id } });
    let touched = false;
    // 1. prvý hovor v tvare V2
    if (p.call.outcome !== "INTERESTED") {
        const meta = { ...((p.call.meta as Record<string, unknown> | null) ?? {}), asked: [p.ask] };
        await tx.activity.update({ where: { id: p.call.id }, data: { outcome: "INTERESTED", meta } });
        touched = true;
    }
    // 2. „Chceli" z hovoru
    const key = `v2norm:ask:${p.call.id}`;
    if (!(await tx.leadRequest.findUnique({ where: { migrationKey: key } }))) {
        await tx.leadRequest.create({
            data: {
                leadId: p.id,
                content: p.ask,
                state: "OPEN",
                origin: "LIVE",
                requestedAt: p.call.createdAt,
                requestedById: p.call.userId,
                sourceActivityId: p.call.id,
                migrationKey: key,
            },
        });
        touched = true;
    }
    // 3. história vlastníctva
    if ((await tx.dealOwnership.count({ where: { leadId: p.id } })) === 0) {
        await tx.dealOwnership.create({
            data: { leadId: p.id, fromUserId: null, toUserId: lead.ownerId, byUserId: lead.handedOffById!, reason: "HANDOFF", createdAt: lead.pipelineEnteredAt! },
        });
        touched = true;
    }
    // 4. prepočet (čo neskôr dostali = SENT)
    await reconcileRequests(tx, p.id);
    // 5. uzavretý obchod ako ho uzavrie V2
    if (CLOSE_WITHDRAWS.includes(lead.status)) {
        const open = await tx.leadRequest.findMany({ where: { leadId: p.id, state: "OPEN" }, select: { id: true } });
        if (open.length) {
            const lastStatus = await tx.activity.findFirst({ where: { leadId: p.id, type: "STATUS_CHANGED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { userId: true } });
            await tx.leadRequest.updateMany({
                where: { id: { in: open.map((r) => r.id) } },
                data: { state: "WITHDRAWN", resolvedAt: lead.closedAt, resolvedById: lastStatus?.userId ?? lead.ownerId, resolvedActivityId: null, reason: WITHDRAW_REASON },
            });
            touched = true;
        }
    }
    const clearStep = CLOSED.includes(lead.status) && hasStep(lead);
    if (clearStep || touched) await updateLead(tx, p.id, clearStep ? NO_STEP : {}); // revízia +1 raz
}

async function cleanupActivities(tx: Tx, d: Loaded) {
    for (const n of d.priceNotes) {
        const v = parsePriceNote(n.note)!;
        await tx.activity.update({
            where: { id: n.id },
            data: { type: "PRICE_CHANGED", category: "BUSINESS", meta: { from: { amount: v.from, note: null }, to: { amount: v.to, note: null }, via: "EDIT", reason: null } },
        });
    }
    const audits = await tx.activity.deleteMany({ where: { type: "CONTACT_UPDATED", note: { in: OLD_AUDIT_NOTES } } });
    const sends = await tx.activity.deleteMany({ where: { type: { in: ["EMAIL_SENT", "QUOTE_SENT", "DESIGN_SENT"] } } });
    // Staršia skúška prevodu zapisovala historical: true – odoslanie so skutočným časom je bežné odoslanie.
    const hist = await tx.$executeRaw`
        UPDATE "Activity" SET meta = jsonb_set(meta, '{historical}', 'false')
         WHERE type = 'OFFER_SENT' AND meta->>'migrated' = 'true' AND meta->>'historical' = 'true'`;
    return { audits: audits.count, sends: sends.count, historicalFixed: hist };
}

async function clearCallStageSteps(tx: Tx) {
    const r = await tx.lead.updateMany({
        where: { pipelineEnteredAt: null, OR: [{ nextActionKind: { not: null } }, { nextActionAt: { not: null } }, { nextActionNote: { not: null } }] },
        data: { ...NO_STEP, revision: { increment: 1 } },
    });
    return r.count;
}

async function verify() {
    const q = async (sql: TemplateStringsArray) => Number((await prisma.$queryRaw<{ n: bigint }[]>(sql))[0].n);
    const checks: [string, number][] = [
        ["old first-call outcomes (WANTS_*) on queue calls", await q`SELECT count(*) n FROM "Activity" WHERE type = 'CALL' AND source = 'CALL_QUEUE' AND outcome IN ('WANTS_QUOTE','WANTS_DESIGN','WANTS_EMAIL')`],
        ["deals whose first call has no 'Chceli' row", await q`SELECT count(*) n FROM "Lead" l JOIN "Activity" a ON a."leadId" = l.id AND a.type = 'CALL' AND a."createdAt" = l."pipelineEnteredAt" AND a.outcome = 'INTERESTED' WHERE NOT EXISTS (SELECT 1 FROM "LeadRequest" r WHERE r."sourceActivityId" = a.id)`],
        ["deals without ownership history", await q`SELECT count(*) n FROM "Lead" l WHERE l."pipelineEnteredAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DealOwnership" o WHERE o."leadId" = l.id)`],
        ["closed deals with a step", await q`SELECT count(*) n FROM "Lead" WHERE "pipelineEnteredAt" IS NOT NULL AND status IN ('WON','LOST','UNREACHABLE') AND ("nextActionKind" IS NOT NULL OR "nextActionAt" IS NOT NULL OR "nextActionNote" IS NOT NULL)`],
        ["LOST/UNREACHABLE deals with OPEN asks", await q`SELECT count(*) n FROM "LeadRequest" r JOIN "Lead" l ON l.id = r."leadId" WHERE r.state = 'OPEN' AND l.status IN ('LOST','UNREACHABLE')`],
        ["call-stage leads with a step", await q`SELECT count(*) n FROM "Lead" WHERE "pipelineEnteredAt" IS NULL AND ("nextActionKind" IS NOT NULL OR "nextActionAt" IS NOT NULL OR "nextActionNote" IS NOT NULL)`],
        ["old send rows (EMAIL/QUOTE/DESIGN_SENT)", await q`SELECT count(*) n FROM "Activity" WHERE type IN ('EMAIL_SENT','QUOTE_SENT','DESIGN_SENT')`],
        ["old price / send audit notes", await q`SELECT count(*) n FROM "Activity" WHERE type = 'CONTACT_UPDATED' AND (note LIKE 'Cena:%' OR note IN ('Klient oboznámený s cenou','Oboznámenie s cenou zrušené','Odoslanie cenovej ponuky zrušené'))`],
        ["migrated sends still marked historical", await q`SELECT count(*) n FROM "Activity" WHERE type = 'OFFER_SENT' AND meta->>'migrated' = 'true' AND meta->>'historical' = 'true'`],
        ["'Chceli' rows with a migrated origin", await q`SELECT count(*) n FROM "LeadRequest" WHERE origin <> 'LIVE'`],
    ];
    let bad = 0;
    for (const [label, n] of checks) {
        console.log(`  ${n === 0 ? "OK  " : "FAIL"} ${label}: ${n}`);
        if (n) bad++;
    }
    return bad;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = process.env.DATABASE_URL;
    if (!url) fail("DATABASE_URL chýba (spúšťaj cez tools/with-target.mjs)");
    const host = new URL(url).hostname.split(".")[0];
    if (!args.expectEndpoint || host !== args.expectEndpoint) fail("--expect-endpoint nesedí s cieľom");
    if (host.endsWith("-pooler")) fail("použi DIRECT host");
    if (host.endsWith("m0xyun") && process.env.ZVONCEK_PRODUCTION_WINDOW !== host) fail("produkcia len v schválenom okne (--production-window)");
    if (args.apply && args.confirm !== host) fail("--apply vyžaduje --confirm <endpoint>");
    if (args.apply && args.verify) fail("--apply a --verify naraz nejde");
    console.log(`target=${host} mode=${args.apply ? "APPLY" : args.verify ? "VERIFY" : "DRY-RUN"}`);

    if (args.verify) {
        const bad = await verify();
        console.log(bad ? `\nRESULT: NOT CLEAN (${bad})` : "\nRESULT: clean");
        process.exit(bad ? 4 : 0);
    }

    const d = await load();
    const { blockers, counts, perLead } = plan(d);
    console.log("plan:", counts);
    if (blockers.length) {
        console.log(`BLOCKERS (${blockers.length}) – nič sa nezapíše:`);
        for (const b of blockers) console.log("  ", b);
        process.exit(2);
    }
    if (!args.apply) {
        console.log("\nDRY-RUN – nič nezapísané.");
        return;
    }
    for (const p of perLead) await withLockTx((tx) => normalizeDeal(tx, p));
    const cleaned = await prisma.$transaction(async (tx) => ({ ...(await cleanupActivities(tx, d)), callStage: await clearCallStageSteps(tx) }), { timeout: 60_000 });
    console.log(`\nAPPLIED: ${perLead.length} obchodov; activities`, cleaned, "– spusti --verify.");
}

main()
    .catch((e) => {
        console.error(`ABORT: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
