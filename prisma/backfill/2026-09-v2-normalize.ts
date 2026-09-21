// Jednorazová normalizácia po prevode V1 → V2: dáta majú vyzerať, akoby ich od začiatku písala V2 (D-009, Michal 2026-09-22).
// Poradie: 2026-09-assignments.ts → 2026-09-v1-sends.ts (+ --verify) → TENTO skript (--apply, --verify)
//          → TENTO skript --strip (zmaže značky prevodu) → sql/03-drop-v1-columns.sql. Spec: 02-data-mapping.md §10.
//
// Obchod (pipelineEnteredAt), presne ako ho zapisuje V2:
//   1. prvý hovor WANTS_QUOTE / WANTS_DESIGN / WANTS_EMAIL → INTERESTED, meta { asked: [PRICE | DESIGN | INFO], fp }
//   2. „Chceli" z toho hovoru: LeadRequest (čas a autor hovoru, sourceActivityId, origin LIVE) → reconcileRequests
//   3. odovzdanie: OWNER_CHANGED „Priradené automaticky: <vlastník>" + DealOwnership HANDOFF (čas hovoru, autor hovoru)
//   4. uzavretý obchod: LOST / UNREACHABLE → otvorené požiadavky WITHDRAWN + CLIENT_ASK_CHANGED „Nepošle sa (obchod
//      uzavretý)"; WON / LOST / UNREACHABLE s krokom → krok zmazaný + NEXT_ACTION_CLEARED. Čas = closedAt, autor = kto
//      obchod uzavrel (posledný STATUS_CHANGED).
// Fáza volania: krok sa vymaže (V2 ho tam nikdy nemá; pri takom leade V2 ani plánovací riadok nepíše).
// Aktivity: „Cena: X → Y" → PRICE_CHANGED; staré audity odoslaní a riadky EMAIL/QUOTE/DESIGN_SENT sa zmažú.
// --strip: po overení odstráni značky prevodu (OFFER_SENT meta.migrated/migration, LeadRequest.migrationKey) – potom
// sa už prevod nedá overiť ani zopakovať; dôkaz ostáva v bode obnovy a v reporte.
//
// Nič sa nehádá: nečakaný vzor = BLOKER pred zápisom. Bezpečnosť: tools/with-target.mjs, DRY-RUN predvolený,
// --apply / --strip s --confirm <ep>, --verify. Produkcia len s --production-window.
import "dotenv/config";
import prisma from "../../lib/db";
import { lockLeadRow, withLockTx, type Tx } from "../../lib/access/locks";
import { createAuditActivity, createPlanningActivity } from "../../lib/activityLog";
import { REQUEST_CONTENT_LABEL } from "../../lib/domain/clientRequests";
import { STATUS_LABEL } from "../../lib/dictionaries";
import { reconcileRequests } from "../../lib/domain/requestMutations";
import { updateLead } from "../../lib/domain/leadWrites";
import { canonical } from "../../lib/domain/tasks";
import { parseOfferMeta } from "../../lib/domain/offers";
import type { LeadStatus, RequestContent } from "../../app/generated/prisma/enums";
import type { Prisma } from "../../app/generated/prisma/client";

export const ASK_OF: Record<string, RequestContent> = { WANTS_QUOTE: "PRICE", WANTS_DESIGN: "DESIGN", WANTS_EMAIL: "INFO" };
const POSITIVE_FIRST = ["WANTS_QUOTE", "WANTS_DESIGN", "WANTS_EMAIL", "INTERESTED"];
const CLOSE_WITHDRAWS: LeadStatus[] = ["LOST", "UNREACHABLE"];
const CLOSED: LeadStatus[] = ["WON", "LOST", "UNREACHABLE"];
const OLD_AUDIT_NOTES = ["Klient oboznámený s cenou", "Oboznámenie s cenou zrušené", "Odoslanie cenovej ponuky zrušené"];
export const WITHDRAW_REASON = "obchod uzavretý";
const NO_STEP = { nextActionKind: null, nextActionAt: null, nextActionHasTime: false, nextActionMode: "SCHEDULED", nextActionNote: null } as const;
const askKey = (callId: string) => `v2norm:ask:${callId}`;
const hasStep = (l: { nextActionKind: unknown; nextActionAt: unknown; nextActionNote: unknown }) =>
    Boolean(l.nextActionKind || l.nextActionAt || l.nextActionNote);
const ownerNote = (u: { firstName: string; lastName: string }) => `Priradené automaticky: ${`${u.firstName} ${u.lastName}`.trim()}`;

function fail(msg: string): never {
    console.error(`ABORT: ${msg}`);
    process.exit(1);
}

// „Cena: — → 499 €" / „Cena: 689 € → 639 €" (V1 aj V2 píšu ten istý tvar).
export function parsePriceNote(note: string | null): { from: number | null; to: number | null } | null {
    const m = note?.match(/^Cena: (—|[\d.]+ €) → (—|[\d.]+ €)$/);
    if (!m) return null;
    const val = (s: string) => (s === "—" ? null : Number(s.replace(" €", "")));
    return { from: val(m[1]), to: val(m[2]) };
}

export const DEAL_SELECT = {
    id: true, number: true, status: true, ownerId: true, handedOffById: true, pipelineEnteredAt: true, closedAt: true,
    nextActionKind: true, nextActionAt: true, nextActionNote: true,
    activities: {
        where: { OR: [{ type: "CALL", source: "CALL_QUEUE" }, { type: "STATUS_CHANGED" }] },
        select: { id: true, type: true, outcome: true, userId: true, createdAt: true, meta: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    },
} satisfies Prisma.LeadSelect;
type DealRow = Awaited<ReturnType<typeof loadDeals>>[number];
export async function loadDeals(db: Tx | typeof prisma, where: { id?: string } = {}) {
    return db.lead.findMany({ where: { pipelineEnteredAt: { not: null }, ...where }, select: DEAL_SELECT, orderBy: { number: "asc" } });
}

export type DealPlan = { id: string; number: number; call: { id: string; userId: string; createdAt: Date; outcome: string; meta: unknown }; ask: RequestContent };

// Plán jedného obchodu – buď položka, alebo bloker.
export function planDeal(l: DealRow): { item?: DealPlan; blocker?: string } {
    const firsts = l.activities.filter((a) => a.type === "CALL" && POSITIVE_FIRST.includes(a.outcome ?? ""));
    const call = firsts.find((a) => a.createdAt.getTime() === l.pipelineEnteredAt!.getTime());
    if (firsts.length !== 1 || !call) return { blocker: `#${l.number}: prvý pozitívny hovor nie je jednoznačný (${firsts.length})` };
    let ask: RequestContent | undefined = ASK_OF[call.outcome ?? ""];
    if (call.outcome === "INTERESTED") {
        const asked = (call.meta as { asked?: RequestContent[] } | null)?.asked ?? [];
        if (asked.length !== 1) return { blocker: `#${l.number}: INTERESTED bez jedného meta.asked` };
        ask = asked[0];
    }
    if (!ask) return { blocker: `#${l.number}: neznámy výsledok ${call.outcome}` };
    if (!l.ownerId || !l.handedOffById) return { blocker: `#${l.number}: obchod bez vlastníka / bez handedOffBy` };
    if (CLOSED.includes(l.status) && !l.closedAt) return { blocker: `#${l.number}: uzavretý bez closedAt` };
    return { item: { id: l.id, number: l.number, call: { ...call, outcome: call.outcome ?? "" }, ask } };
}

// Zapíše jeden obchod v tvare V2. Opakovateľné: každá časť najprv overí, či už nie je hotová; revízia +1 len pri zmene.
export async function normalizeDeal(tx: Tx, p: DealPlan) {
    if (!(await lockLeadRow(tx, p.id))) throw new Error(`lead #${p.number} zmizol`);
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: p.id } });
    let touched = false;
    // 1. prvý hovor v tvare V2
    if (p.call.outcome !== "INTERESTED") {
        const asked = [p.ask];
        await tx.activity.update({ where: { id: p.call.id }, data: { outcome: "INTERESTED", meta: { asked, fp: canonical({ asked }) } } });
        touched = true;
    }
    // 2. „Chceli" z hovoru, potom prepočet voči odoslaniam
    if (!(await tx.leadRequest.count({ where: { leadId: p.id, sourceActivityId: p.call.id } }))) {
        await tx.leadRequest.create({
            data: { leadId: p.id, content: p.ask, state: "OPEN", origin: "LIVE", requestedAt: p.call.createdAt, requestedById: p.call.userId, sourceActivityId: p.call.id, migrationKey: askKey(p.call.id) },
        });
        await reconcileRequests(tx, p.id);
        touched = true;
    }
    // 3. odovzdanie ako pri prvom hovore vo V2
    if (!(await tx.dealOwnership.count({ where: { leadId: p.id } }))) {
        const owner = await tx.user.findUniqueOrThrow({ where: { id: lead.ownerId! }, select: { firstName: true, lastName: true } });
        await tx.activity.create({
            data: { ...createAuditActivity({ leadId: p.id, userId: p.call.userId, type: "OWNER_CHANGED", source: "CALL_QUEUE", note: ownerNote(owner) }), createdAt: lead.pipelineEnteredAt! },
        });
        await tx.dealOwnership.create({
            data: { leadId: p.id, fromUserId: null, toUserId: lead.ownerId, byUserId: p.call.userId, reason: "HANDOFF", createdAt: lead.pipelineEnteredAt! },
        });
        touched = true;
    }
    // 4. uzavretie ako vo V2 (closeDeal): stiahnuté požiadavky + zmazaný krok, čas = closedAt, autor = kto uzavrel
    if (CLOSED.includes(lead.status)) {
        const closer = (await tx.activity.findFirst({ where: { leadId: p.id, type: "STATUS_CHANGED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { userId: true } }))?.userId ?? lead.ownerId!;
        if (CLOSE_WITHDRAWS.includes(lead.status)) {
            const open = await tx.leadRequest.findMany({ where: { leadId: p.id, state: "OPEN" }, select: { id: true, content: true }, orderBy: { id: "asc" } });
            if (open.length) {
                await tx.leadRequest.updateMany({
                    where: { id: { in: open.map((r) => r.id) } },
                    data: { state: "WITHDRAWN", resolvedAt: lead.closedAt, resolvedById: closer, resolvedActivityId: null, reason: WITHDRAW_REASON },
                });
                await tx.activity.create({
                    data: {
                        leadId: p.id, userId: closer, type: "CLIENT_ASK_CHANGED", category: "BUSINESS", source: "PIPELINE", createdAt: lead.closedAt!,
                        note: `Nepošle sa (obchod uzavretý): ${open.map((r) => REQUEST_CONTENT_LABEL[r.content]).join(", ")} (${WITHDRAW_REASON})`,
                        meta: { added: [], withdrawn: open.map((r) => ({ id: r.id, content: r.content })), reason: WITHDRAW_REASON, via: lead.status },
                    },
                });
                touched = true;
            }
        }
        if (hasStep(lead)) {
            await tx.activity.create({
                data: { ...createPlanningActivity({ leadId: p.id, userId: closer, type: "NEXT_ACTION_CLEARED", source: "PIPELINE", note: `Ďalší krok zmazaný (${STATUS_LABEL[lead.status].toLowerCase()})` }), createdAt: lead.closedAt! },
            });
            await updateLead(tx, p.id, NO_STEP);
            return;
        }
    }
    if (touched) await updateLead(tx, p.id, {}); // revízia +1 raz (updateLead nezvýši druhý raz v tej istej transakcii)
}

async function loadGlobal() {
    const callStage = await prisma.lead.count({ where: { pipelineEnteredAt: null, OR: [{ nextActionKind: { not: null } }, { nextActionAt: { not: null } }, { nextActionNote: { not: null } }] } });
    const priceNotes = await prisma.activity.findMany({ where: { type: "CONTACT_UPDATED", note: { startsWith: "Cena:" } }, select: { id: true, note: true } });
    const oldAudits = await prisma.activity.count({ where: { type: "CONTACT_UPDATED", note: { in: OLD_AUDIT_NOTES } } });
    const oldSends = await prisma.activity.findMany({ where: { type: { in: ["EMAIL_SENT", "QUOTE_SENT", "DESIGN_SENT"] } }, select: { id: true, type: true, leadId: true, createdAt: true } });
    const offers = await prisma.activity.findMany({ where: { type: "OFFER_SENT" }, select: { meta: true } });
    const undoNotes = await prisma.activity.findMany({ where: { note: "Odoslanie cenovej ponuky zrušené" }, select: { leadId: true, createdAt: true } });
    return { callStage, priceNotes, oldAudits, oldSends, offers, undoNotes };
}

function planGlobal(g: Awaited<ReturnType<typeof loadGlobal>>) {
    const blockers: string[] = [];
    for (const n of g.priceNotes) if (!parsePriceNote(n.note)) blockers.push(`nečitateľná zmena ceny: "${n.note}"`);
    // Staré odoslanie smie zmiznúť, len ak ho pokrýva prevedené OFFER_SENT, alebo je to zrušená CP.
    const covered = new Set<string>();
    for (const o of g.offers) for (const s of parseOfferMeta(o.meta)?.migration?.sources ?? []) covered.add(s);
    for (const s of g.oldSends) {
        if (covered.has(s.id)) continue;
        const nextQuote = Math.min(...g.oldSends.filter((x) => x.leadId === s.leadId && x.type === "QUOTE_SENT" && x.createdAt > s.createdAt).map((x) => x.createdAt.getTime()), Infinity);
        const undone = s.type === "QUOTE_SENT" && g.undoNotes.some((u) => u.leadId === s.leadId && u.createdAt > s.createdAt && u.createdAt.getTime() < nextQuote);
        if (!undone) blockers.push(`starý ${s.type} ${s.id} nemá prevedené odoslanie – najprv 2026-09-v1-sends.ts`);
    }
    return blockers;
}

async function cleanupActivities(tx: Tx, g: Awaited<ReturnType<typeof loadGlobal>>) {
    for (const n of g.priceNotes) {
        const v = parsePriceNote(n.note)!;
        await tx.activity.update({ where: { id: n.id }, data: { type: "PRICE_CHANGED", category: "BUSINESS", meta: { from: { amount: v.from, note: null }, to: { amount: v.to, note: null }, via: "EDIT", reason: null } } });
    }
    const audits = await tx.activity.deleteMany({ where: { type: "CONTACT_UPDATED", note: { in: OLD_AUDIT_NOTES } } });
    const sends = await tx.activity.deleteMany({ where: { type: { in: ["EMAIL_SENT", "QUOTE_SENT", "DESIGN_SENT"] } } });
    const hist = await tx.$executeRaw`UPDATE "Activity" SET meta = jsonb_set(meta, '{historical}', 'false') WHERE type = 'OFFER_SENT' AND meta ? 'migration' AND meta->>'historical' = 'true'`;
    const callStage = await tx.lead.updateMany({
        where: { pipelineEnteredAt: null, OR: [{ nextActionKind: { not: null } }, { nextActionAt: { not: null } }, { nextActionNote: { not: null } }] },
        data: { ...NO_STEP, revision: { increment: 1 } },
    });
    return { priceNotes: g.priceNotes.length, audits: audits.count, sends: sends.count, historicalFixed: hist, callStage: callStage.count };
}

// Overenie každej sľúbenej vlastnosti; každý riadok musí byť 0.
export async function verifyChecks(db: typeof prisma, leadId?: string): Promise<[string, number][]> {
    const scope = leadId ?? null;
    const q = async (sql: TemplateStringsArray, ...v: unknown[]) => Number(((await db.$queryRaw(sql, ...v)) as { n: bigint }[])[0].n);
    return [
        ["old first-call outcomes (WANTS_*)", await q`SELECT count(*) n FROM "Activity" WHERE type = 'CALL' AND source = 'CALL_QUEUE' AND outcome IN ('WANTS_QUOTE','WANTS_DESIGN','WANTS_EMAIL') AND (${scope}::text IS NULL OR "leadId" = ${scope})`],
        ["first call not V2-shaped (INTERESTED, one asked, fp)", await q`SELECT count(*) n FROM "Lead" l JOIN "Activity" a ON a."leadId" = l.id AND a.type = 'CALL' AND a.source = 'CALL_QUEUE' AND a."createdAt" = l."pipelineEnteredAt" WHERE (${scope}::text IS NULL OR l.id = ${scope}) AND NOT (a.outcome = 'INTERESTED' AND jsonb_array_length(a.meta->'asked') = 1 AND a.meta->>'fp' = '{"asked":' || (a.meta->'asked')::text || '}')`],
        ["first call without exactly one matching 'Chceli' row (content, time, caller, LIVE)", await q`SELECT count(*) n FROM "Lead" l JOIN "Activity" a ON a."leadId" = l.id AND a.type = 'CALL' AND a.source = 'CALL_QUEUE' AND a."createdAt" = l."pipelineEnteredAt" WHERE (${scope}::text IS NULL OR l.id = ${scope}) AND (SELECT count(*) FROM "LeadRequest" r WHERE r."sourceActivityId" = a.id AND r.content::text = a.meta->'asked'->>0 AND r."requestedAt" = a."createdAt" AND r."requestedById" = a."userId" AND r.origin = 'LIVE') <> 1`],
        ["deal without HANDOFF (from none → owner, by caller, at entry)", await q`SELECT count(*) n FROM "Lead" l WHERE l."pipelineEnteredAt" IS NOT NULL AND (${scope}::text IS NULL OR l.id = ${scope}) AND NOT EXISTS (SELECT 1 FROM "DealOwnership" o WHERE o."leadId" = l.id AND o.reason = 'HANDOFF' AND o."fromUserId" IS NULL AND o."toUserId" = l."ownerId" AND o."byUserId" = l."handedOffById" AND o."createdAt" = l."pipelineEnteredAt")`],
        ["deal without OWNER_CHANGED 'Priradené automaticky' at entry", await q`SELECT count(*) n FROM "Lead" l WHERE l."pipelineEnteredAt" IS NOT NULL AND (${scope}::text IS NULL OR l.id = ${scope}) AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = l.id AND a.type = 'OWNER_CHANGED' AND a.note LIKE 'Priradené automaticky: %' AND a."createdAt" = l."pipelineEnteredAt")`],
        ["closed deals with a step", await q`SELECT count(*) n FROM "Lead" WHERE "pipelineEnteredAt" IS NOT NULL AND status IN ('WON','LOST','UNREACHABLE') AND ("nextActionKind" IS NOT NULL OR "nextActionAt" IS NOT NULL OR "nextActionNote" IS NOT NULL) AND (${scope}::text IS NULL OR id = ${scope})`],
        ["closed deals whose latest step row is not NEXT_ACTION_CLEARED", await q`SELECT count(*) n FROM "Lead" l WHERE l.status IN ('WON','LOST','UNREACHABLE') AND l."pipelineEnteredAt" IS NOT NULL AND (${scope}::text IS NULL OR l.id = ${scope}) AND (SELECT a.type FROM "Activity" a WHERE a."leadId" = l.id AND a.type IN ('NEXT_ACTION_SET','NEXT_ACTION_CHANGED','NEXT_ACTION_CLEARED') ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1) IN ('NEXT_ACTION_SET','NEXT_ACTION_CHANGED')`],
        ["OPEN asks on LOST/UNREACHABLE", await q`SELECT count(*) n FROM "LeadRequest" r JOIN "Lead" l ON l.id = r."leadId" WHERE r.state = 'OPEN' AND l.status IN ('LOST','UNREACHABLE') AND (${scope}::text IS NULL OR l.id = ${scope})`],
        ["withdrawn asks not closed like V2 (reason, closedAt, resolver, CLIENT_ASK_CHANGED)", await q`SELECT count(*) n FROM "LeadRequest" r JOIN "Lead" l ON l.id = r."leadId" WHERE r.state = 'WITHDRAWN' AND (${scope}::text IS NULL OR l.id = ${scope}) AND NOT (r.reason = 'obchod uzavretý' AND r."resolvedAt" = l."closedAt" AND r."resolvedById" IS NOT NULL AND EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = l.id AND a.type = 'CLIENT_ASK_CHANGED' AND a."createdAt" = l."closedAt" AND a.meta->'withdrawn' @> jsonb_build_array(jsonb_build_object('id', r.id))))`],
        ["call-stage leads with a step", await q`SELECT count(*) n FROM "Lead" WHERE "pipelineEnteredAt" IS NULL AND ("nextActionKind" IS NOT NULL OR "nextActionAt" IS NOT NULL OR "nextActionNote" IS NOT NULL) AND (${scope}::text IS NULL OR id = ${scope})`],
        ["old send rows (EMAIL/QUOTE/DESIGN_SENT)", await q`SELECT count(*) n FROM "Activity" WHERE type IN ('EMAIL_SENT','QUOTE_SENT','DESIGN_SENT') AND (${scope}::text IS NULL OR "leadId" = ${scope})`],
        ["old price / send audit notes", await q`SELECT count(*) n FROM "Activity" WHERE type = 'CONTACT_UPDATED' AND (note LIKE 'Cena:%' OR note IN ('Klient oboznámený s cenou','Oboznámenie s cenou zrušené','Odoslanie cenovej ponuky zrušené')) AND (${scope}::text IS NULL OR "leadId" = ${scope})`],
        ["historical converted sends", await q`SELECT count(*) n FROM "Activity" WHERE type = 'OFFER_SENT' AND meta ? 'migration' AND meta->>'historical' = 'true' AND (${scope}::text IS NULL OR "leadId" = ${scope})`],
        ["'Chceli' rows with a migrated origin", await q`SELECT count(*) n FROM "LeadRequest" WHERE origin <> 'LIVE' AND (${scope}::text IS NULL OR "leadId" = ${scope})`],
    ];
}

async function stripMarkers() {
    return prisma.$transaction(async (tx) => ({
        offers: await tx.$executeRaw`UPDATE "Activity" SET meta = meta - 'migrated' - 'migration' WHERE type = 'OFFER_SENT' AND (meta ? 'migrated' OR meta ? 'migration')`,
        requests: await tx.$executeRaw`UPDATE "LeadRequest" SET "migrationKey" = NULL, provenance = NULL WHERE "migrationKey" LIKE 'v2norm:%' OR "migrationKey" LIKE 'w5:%'`,
    }));
}

async function main() {
    const argv = process.argv.slice(2);
    const val = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
    const mode = argv.includes("--apply") ? "APPLY" : argv.includes("--verify") ? "VERIFY" : argv.includes("--strip") ? "STRIP" : "DRY-RUN";
    const url = process.env.DATABASE_URL;
    if (!url) fail("DATABASE_URL chýba (spúšťaj cez tools/with-target.mjs)");
    const host = new URL(url).hostname.split(".")[0];
    if (val("--expect-endpoint") !== host) fail("--expect-endpoint nesedí s cieľom");
    if (host.endsWith("-pooler")) fail("použi DIRECT host");
    if (host.endsWith("m0xyun") && process.env.ZVONCEK_PRODUCTION_WINDOW !== host) fail("produkcia len v schválenom okne (--production-window)");
    if ((mode === "APPLY" || mode === "STRIP") && val("--confirm") !== host) fail(`--${mode.toLowerCase()} vyžaduje --confirm <endpoint>`);
    console.log(`target=${host} mode=${mode}`);

    if (mode === "VERIFY") {
        let bad = 0;
        for (const [label, n] of await verifyChecks(prisma)) {
            console.log(`  ${n === 0 ? "OK  " : "FAIL"} ${label}: ${n}`);
            if (n) bad++;
        }
        console.log(bad ? `\nRESULT: NOT CLEAN (${bad})` : "\nRESULT: clean");
        process.exit(bad ? 4 : 0);
    }
    if (mode === "STRIP") {
        const left = await prisma.activity.count({ where: { type: { in: ["EMAIL_SENT", "QUOTE_SENT", "DESIGN_SENT"] } } });
        if (left) fail("najprv --apply a --verify (staré odoslania ešte existujú)");
        console.log("STRIPPED:", await stripMarkers());
        return;
    }

    const deals = await loadDeals(prisma);
    const planned = deals.map(planDeal);
    const g = await loadGlobal();
    const blockers = [...planned.flatMap((p) => (p.blocker ? [p.blocker] : [])), ...planGlobal(g)];
    const items = planned.flatMap((p) => (p.item ? [p.item] : []));
    const byId = new Map(deals.map((d) => [d.id, d]));
    console.log("plan:", {
        deals: items.length,
        firstCallsToConvert: items.filter((p) => p.call.outcome !== "INTERESTED").length,
        closedWithStep: items.filter((p) => CLOSED.includes(byId.get(p.id)!.status) && hasStep(byId.get(p.id)!)).length,
        callStageStepsToClear: g.callStage,
        priceNotesToConvert: g.priceNotes.length,
        oldAuditsToDelete: g.oldAudits,
        oldSendsToDelete: g.oldSends.length,
    });
    if (blockers.length) {
        console.log(`BLOCKERS (${blockers.length}) – nič sa nezapíše:`);
        for (const b of blockers) console.log("  ", b);
        process.exit(2);
    }
    if (mode === "DRY-RUN") {
        console.log("\nDRY-RUN – nič nezapísané.");
        return;
    }
    for (const p of items) await withLockTx((tx) => normalizeDeal(tx, p));
    const cleaned = await prisma.$transaction((tx) => cleanupActivities(tx, g), { timeout: 60_000 });
    console.log(`\nAPPLIED: ${items.length} obchodov; activities`, cleaned, "– spusti --verify.");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("prisma/backfill/2026-09-v2-normalize.ts")) {
    main()
        .catch((e) => {
            console.error(`ABORT: ${e instanceof Error ? e.message : String(e)}`);
            process.exitCode = 1;
        })
        .finally(() => prisma.$disconnect());
}
