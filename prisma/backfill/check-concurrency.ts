// Funkčné + súbežné kontroly (plán §13 fáza 9). LEN dev/test branch – nikdy produkcia.
// Vytvára vlastné fixture (používatelia `cc_*`, kontakty „CC-TEST") a na konci ich zmaže.
//
//   npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint ep-xxxx [--only claims,stale] [--iterations 100]
import "dotenv/config";
import bcrypt from "bcrypt";
import type { Role } from "../../app/generated/prisma/enums";
import prisma from "../../lib/db";
import type { AccessUser } from "../../lib/access/user";
import { logCallAs } from "../../lib/commands/calls";
import { claimBatchAs } from "../../lib/commands/claims";
import { revertCallResultAs } from "../../lib/commands/history";
import { CLAIM_BATCH_SIZE } from "../../lib/domain/callAssignment";

// ── Guard ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
}
const expectEndpoint = arg("--expect-endpoint");
const only = arg("--only")?.split(",");
const ITER = Number(arg("--iterations") ?? 100);
const url = new URL(process.env.DATABASE_URL ?? "postgres://x/none");
const endpoint = url.hostname.split(".")[0].replace(/-pooler$/, "");
if (!expectEndpoint || endpoint !== expectEndpoint) {
    console.error("ABORT: --expect-endpoint must match DATABASE_URL endpoint (dev/test branch only).");
    process.exit(1);
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
const RUN = Date.now().toString(36);
const createdUsers: string[] = [];
const createdLeads: string[] = [];
const createdTeams: string[] = [];
let passwordHash = "";
let userSeq = 0;
let leadSeq = 0;
const OLD = new Date("2001-01-01T00:00:00Z");

async function makeUser(role: Role, opts: { teamId?: string | null } = {}): Promise<AccessUser> {
    userSeq++;
    const u = await prisma.user.create({
        data: {
            username: `cc_${RUN}_${userSeq}`.slice(0, 20),
            firstName: `CC${userSeq}`,
            lastName: role,
            password: passwordHash,
            role,
            teamId: opts.teamId ?? null,
        },
        select: { id: true, role: true, teamId: true, firstName: true, lastName: true, username: true },
    });
    createdUsers.push(u.id);
    return u;
}

async function makeTeam(leaderId: string | null): Promise<string> {
    const t = await prisma.team.create({ data: { name: `CC-TEST ${RUN} ${createdTeams.length}`, leaderId } });
    createdTeams.push(t.id);
    return t.id;
}

// Pool leads, vekovo najstaršie (aby ich claim bral pred seed dátami).
async function makePoolLeads(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        leadSeq++;
        const l = await prisma.lead.create({
            data: {
                companyName: `CC-TEST ${RUN} #${leadSeq}`,
                phone: `+000 ${RUN} ${leadSeq}`,
                createdAt: new Date(OLD.getTime() + leadSeq * 1000),
            },
            select: { id: true },
        });
        ids.push(l.id);
        createdLeads.push(l.id);
    }
    return ids;
}

// Lead priamo priradený volajúcemu (bez claimu).
async function makeAssignedLead(userId: string, status: "NEW" | "CALLING" = "NEW"): Promise<string> {
    const [id] = await makePoolLeads(1);
    await prisma.lead.update({
        where: { id },
        data: { assignedCallerId: userId, assignedCallerAt: new Date(), status, callbackKind: status === "CALLING" ? "RETRY" : null },
    });
    return id;
}

async function cleanup() {
    if (createdLeads.length) {
        await prisma.dealRequest.deleteMany({ where: { leadId: { in: createdLeads } } });
        await prisma.activity.deleteMany({ where: { leadId: { in: createdLeads } } });
        await prisma.lead.deleteMany({ where: { id: { in: createdLeads } } });
    }
    if (createdTeams.length) {
        await prisma.user.updateMany({ where: { teamId: { in: createdTeams } }, data: { teamId: null } });
        await prisma.team.deleteMany({ where: { id: { in: createdTeams } } });
    }
    if (createdUsers.length) {
        await prisma.activity.deleteMany({ where: { userId: { in: createdUsers } } });
        await prisma.dealRequest.deleteMany({ where: { OR: [{ createdById: { in: createdUsers } }, { resolvedById: { in: createdUsers } }] } });
        await prisma.lead.updateMany({ where: { assignedCallerId: { in: createdUsers } }, data: { assignedCallerId: null, assignedCallerAt: null } });
        await prisma.lead.updateMany({ where: { ownerId: { in: createdUsers } }, data: { ownerId: null } });
        await prisma.lead.updateMany({ where: { handedOffById: { in: createdUsers } }, data: { handedOffById: null } });
        await prisma.lead.updateMany({ where: { createdById: { in: createdUsers } }, data: { createdById: null } });
        await prisma.team.updateMany({ where: { leaderId: { in: createdUsers } }, data: { leaderId: null } });
        await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    }
}

// ── Mini test runner ───────────────────────────────────────────────────────────
type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` – ${detail}` : ""}`);
}
const key = () => crypto.randomUUID();
function codeOf(r: unknown): string {
    if (r && typeof r === "object" && "error" in r) return `ERR:${(r as { code?: string }).code ?? "generic"}`;
    return "OK";
}
function tally(rs: unknown[]): Record<string, number> {
    const t: Record<string, number> = {};
    for (const r of rs) {
        const k = codeOf(r);
        t[k] = (t[k] ?? 0) + 1;
    }
    return t;
}
async function leadRev(id: string) {
    return (await prisma.lead.findUniqueOrThrow({ where: { id }, select: { revision: true } })).revision;
}

const tests: Record<string, () => Promise<void>> = {};

// 2 používatelia × 20 paralelných claimov → žiadne prekrytie, každý ≤ 10, ďalšia dávka až po prázdnej.
tests.claims = async () => {
    const a = await makeUser("TELESALES");
    const b = await makeUser("TELESALES");
    await makePoolLeads(40);
    const runs = await Promise.all([
        ...Array.from({ length: 20 }, () => claimBatchAs(a)),
        ...Array.from({ length: 20 }, () => claimBatchAs(b)),
    ]);
    const heldA = await prisma.lead.findMany({ where: { assignedCallerId: a.id, status: "NEW" }, select: { id: true } });
    const heldB = await prisma.lead.findMany({ where: { assignedCallerId: b.id, status: "NEW" }, select: { id: true } });
    const overlap = heldA.filter((x) => heldB.some((y) => y.id === x.id)).length;
    const successes = runs.filter((r) => "claimed" in r && r.claimed > 0).length;
    const unexpected = runs.filter((r) => "error" in r && r.code !== "RETRYABLE").length;
    check(
        "claims: 2 users × 20 parallel",
        overlap === 0 && heldA.length <= CLAIM_BATCH_SIZE && heldB.length <= CLAIM_BATCH_SIZE && successes <= 2 && unexpected === 0 && heldA.length > 0 && heldB.length > 0,
        `A=${heldA.length} B=${heldB.length} overlap=${overlap} successes=${successes} outcomes=${JSON.stringify(tally(runs))}`,
    );

    const again = await claimBatchAs(a);
    check("claims: second batch refused while batch not empty", "reason" in again && again.reason === "BATCH_NOT_EMPTY", JSON.stringify(again));

    for (const l of heldA) {
        const r = await logCallAs(a, { leadId: l.id, outcome: "NO_ANSWER", expectedRevision: await leadRev(l.id), idempotencyKey: key() });
        if ("error" in r) throw new Error(`logCall failed: ${r.error}`);
    }
    const next = await claimBatchAs(a);
    check("claims: next batch after the batch is fully called", "claimed" in next && next.claimed > 0, JSON.stringify(next));
    const retries = await prisma.lead.count({ where: { assignedCallerId: a.id, status: "CALLING", callbackKind: "RETRY" } });
    check("claims: retries stay with the caller", retries === heldA.length, `retries=${retries}`);
};

// Ten istý používateľ, 2 paralelné logCall s rôznymi kľúčmi a tou istou revíziou → presne 1 CALL.
tests.stale = async () => {
    const u = await makeUser("TELESALES");
    let bad = 0;
    const n = Math.min(ITER, 30);
    for (let i = 0; i < n; i++) {
        const id = await makeAssignedLead(u.id);
        const rev = await leadRev(id);
        const rs = await Promise.all([
            logCallAs(u, { leadId: id, outcome: "NO_ANSWER", expectedRevision: rev, idempotencyKey: key() }),
            logCallAs(u, { leadId: id, outcome: "NOT_INTERESTED", expectedRevision: rev, idempotencyKey: key() }),
        ]);
        const calls = await prisma.activity.count({ where: { leadId: id, type: "CALL" } });
        const staleOk = rs.filter((r) => "error" in r).every((r) => "error" in r && (r.code === "STALE" || r.code === "NOT_ASSIGNED" || r.code === "RETRYABLE"));
        if (calls !== 1 || !staleOk) {
            bad++;
            console.log(`   iteration ${i}: calls=${calls} ${JSON.stringify(tally(rs))}`);
        }
    }
    check(`stale tabs: 2 parallel outcomes, same revision (${n}×)`, bad === 0, `bad=${bad}`);
};

// Opakovanie toho istého odoslania (sieťová chyba po commite) → zaznamenané raz, hlásené ako úspech.
tests.idempotency = async () => {
    const u = await makeUser("TELESALES");
    const id = await makeAssignedLead(u.id);
    const rev = await leadRev(id);
    const k = key();
    const first = await logCallAs(u, { leadId: id, outcome: "NO_ANSWER", expectedRevision: rev, idempotencyKey: k });
    const retry = await logCallAs(u, { leadId: id, outcome: "NO_ANSWER", expectedRevision: rev, idempotencyKey: k });
    const calls = await prisma.activity.count({ where: { leadId: id, type: "CALL" } });
    check("idempotency: same key twice → one CALL, both success", codeOf(first) === "OK" && codeOf(retry) === "OK" && calls === 1, `calls=${calls}`);

    const id2 = await makeAssignedLead(u.id);
    const k2 = key();
    const par = await Promise.all([
        logCallAs(u, { leadId: id2, outcome: "NO_ANSWER", expectedRevision: await leadRev(id2), idempotencyKey: k2 }),
        logCallAs(u, { leadId: id2, outcome: "NO_ANSWER", expectedRevision: await leadRev(id2), idempotencyKey: k2 }),
    ]);
    const calls2 = await prisma.activity.count({ where: { leadId: id2, type: "CALL" } });
    check("idempotency: same key in parallel → one CALL, both success", calls2 === 1 && par.every((r) => codeOf(r) === "OK"), `calls=${calls2} ${JSON.stringify(tally(par))}`);

    const mismatch = await logCallAs(u, { leadId: id, outcome: "NOT_INTERESTED", expectedRevision: rev, idempotencyKey: k });
    check("idempotency: same key, different outcome → IDEMPOTENCY_CONFLICT", codeOf(mismatch) === "ERR:IDEMPOTENCY_CONFLICT", codeOf(mismatch));
};

// Prvý hovor a hneď vrátenie → povolené (leadRevision evidencia nezvýšila revíziu). Dvojité vrátenie paralelne → jedno.
tests.revert = async () => {
    const u = await makeUser("TELESALES");
    for (const outcome of ["NO_ANSWER", "NOT_INTERESTED", "BAD_NUMBER"] as const) {
        const id = await makeAssignedLead(u.id);
        const r = await logCallAs(u, { leadId: id, outcome, expectedRevision: await leadRev(id), idempotencyKey: key() });
        const act = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "CALL" }, select: { id: true } });
        const rv = await revertCallResultAs(u, act.id, await leadRev(id));
        const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { status: true, callbackKind: true, assignedCallerId: true } });
        check(
            `revert: immediately after ${outcome}`,
            codeOf(r) === "OK" && codeOf(rv) === "OK" && lead.status === "CALLING" && lead.callbackKind === "RETRY" && lead.assignedCallerId === u.id,
            `${codeOf(rv)} ${JSON.stringify(lead)}`,
        );
    }

    const id = await makeAssignedLead(u.id);
    await logCallAs(u, { leadId: id, outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const act = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "CALL" }, select: { id: true } });
    const rev = await leadRev(id);
    const both = await Promise.all([revertCallResultAs(u, act.id, rev), revertCallResultAs(u, act.id, rev)]);
    const reverted = await prisma.activity.count({ where: { leadId: id, type: "CALL_REVERTED" } });
    check("revert: twice in parallel → one CALL_REVERTED", reverted === 1, `${JSON.stringify(tally(both))} reverted=${reverted}`);
    const third = await revertCallResultAs(u, act.id, await leadRev(id));
    check("revert: repeated revert rejected", codeOf(third) !== "OK", `${codeOf(third)} ${"error" in third ? third.error : ""}`);

    // Poznámka manažéra/zmena kontaktu po hovore → vrátenie odmietnuté (revízia sa zmenila).
    const id3 = await makeAssignedLead(u.id);
    await logCallAs(u, { leadId: id3, outcome: "NO_ANSWER", expectedRevision: await leadRev(id3), idempotencyKey: key() });
    const act3 = await prisma.activity.findFirstOrThrow({ where: { leadId: id3, type: "CALL" }, select: { id: true } });
    const { updateLeadContactAs } = await import("../../lib/commands/calls");
    await updateLeadContactAs(u, id3, { email: "cc@test.invalid" });
    const rv3 = await revertCallResultAs(u, act3.id, await leadRev(id3));
    check("revert: rejected after a later contact edit", codeOf(rv3) !== "OK", `${codeOf(rv3)} ${"error" in rv3 ? rv3.error : ""}`);
};

// Handoff: TELESALES v tíme s vedúcim (deals.receive) → vedúci; bez tímu → nepriradené; SALES_REP → sám. WANTS_DESIGN → 1 DESIGN request.
tests.handoff = async () => {
    const leader = await makeUser("ADMIN");
    const teamId = await makeTeam(leader.id);
    const inTeam = await makeUser("TELESALES", { teamId });
    const alone = await makeUser("TELESALES");
    const rep = await makeUser("SALES_REP");

    const l1 = await makeAssignedLead(inTeam.id);
    const r1 = await logCallAs(inTeam, { leadId: l1, outcome: "WANTS_DESIGN", expectedRevision: await leadRev(l1), idempotencyKey: key(), note: "chcú e-shop" });
    const d1 = await prisma.lead.findUniqueOrThrow({ where: { id: l1 }, select: { ownerId: true, pipelineEnteredAt: true, handedOffById: true, assignedCallerId: true, status: true, revision: true } });
    const call1 = await prisma.activity.findFirstOrThrow({ where: { leadId: l1, type: "CALL" }, select: { createdAt: true, leadRevision: true } });
    const req1 = await prisma.dealRequest.count({ where: { leadId: l1, kind: "DESIGN", status: "OPEN" } });
    check(
        "handoff: team member → team leader, marker = call createdAt, DESIGN request",
        "recipient" in r1 && r1.recipient?.id === leader.id && d1.ownerId === leader.id && d1.handedOffById === inTeam.id &&
            d1.assignedCallerId === null && d1.status === "ACTIVE" && d1.pipelineEnteredAt?.getTime() === call1.createdAt.getTime() &&
            req1 === 1 && call1.leadRevision === d1.revision,
        JSON.stringify({ r1, ownerOk: d1.ownerId === leader.id, req1, leadRevision: call1.leadRevision, revision: d1.revision }),
    );

    const l2 = await makeAssignedLead(alone.id);
    const r2 = await logCallAs(alone, { leadId: l2, outcome: "WANTS_QUOTE", expectedRevision: await leadRev(l2), idempotencyKey: key() });
    const d2 = await prisma.lead.findUniqueOrThrow({ where: { id: l2 }, select: { ownerId: true } });
    check("handoff: no team → unassigned (not blocked)", "recipient" in r2 && r2.recipient === null && d2.ownerId === null, JSON.stringify(r2));

    const l3 = await makeAssignedLead(rep.id);
    const r3 = await logCallAs(rep, { leadId: l3, outcome: "WANTS_EMAIL", expectedRevision: await leadRev(l3), idempotencyKey: key() });
    const d3 = await prisma.lead.findUniqueOrThrow({ where: { id: l3 }, select: { ownerId: true } });
    check("handoff: SALES_REP → own deal", "recipient" in r3 && r3.recipient?.id === rep.id && d3.ownerId === rep.id, JSON.stringify(r3));

    // Vrátenie handoffu hneď po hovore → späť volajúcemu ako RETRY, požiadavky zrušené.
    const act = await prisma.activity.findFirstOrThrow({ where: { leadId: l1, type: "CALL" }, select: { id: true } });
    const rv = await revertCallResultAs(inTeam, act.id, await leadRev(l1));
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l1 }, select: { status: true, pipelineEnteredAt: true, ownerId: true, assignedCallerId: true } });
    const openReq = await prisma.dealRequest.count({ where: { leadId: l1, status: "OPEN" } });
    check(
        "handoff revert: back to caller as retry, requests cancelled",
        codeOf(rv) === "OK" && after.status === "CALLING" && after.pipelineEnteredAt === null && after.ownerId === null && after.assignedCallerId === inTeam.id && openReq === 0,
        `${codeOf(rv)} ${JSON.stringify(after)} open=${openReq}`,
    );
};

// Cudzí lead: volajúci nemôže logovať ani upraviť kontakt, ktorý mu nie je priradený.
tests.scope = async () => {
    const a = await makeUser("TELESALES");
    const b = await makeUser("TELESALES");
    const id = await makeAssignedLead(a.id);
    const r = await logCallAs(b, { leadId: id, outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    check("scope: logCall on someone else's lead → NOT_ASSIGNED", codeOf(r) === "ERR:NOT_ASSIGNED", codeOf(r));
    const { updateLeadContactAs } = await import("../../lib/commands/calls");
    const e = await updateLeadContactAs(b, id, { phone: "000" });
    check("scope: contact edit on someone else's lead → NOT_FOUND", codeOf(e) === "ERR:NOT_FOUND", codeOf(e));
    const pos = await logCallAs(a, { leadId: id, outcome: "POSITIVE" as never, expectedRevision: await leadRev(id), idempotencyKey: key() });
    check("scope: logCall rejects POSITIVE", codeOf(pos) !== "OK", codeOf(pos));
};

// Obchod vytvorený skutočným handoffom (SALES_REP → vlastný obchod).
async function makeDeal(rep: AccessUser, outcome: "WANTS_QUOTE" | "WANTS_EMAIL" | "WANTS_DESIGN" = "WANTS_QUOTE"): Promise<string> {
    const id = await makeAssignedLead(rep.id);
    const r = await logCallAs(rep, { leadId: id, outcome, expectedRevision: await leadRev(id), idempotencyKey: key() });
    if ("error" in r) throw new Error(`handoff failed: ${r.error}`);
    return id;
}

// Požiadavky: jedna OPEN na druh, DONE len cez biznis akciu, zamietnutie s dôvodom, uzavretie nenechá OPEN.
tests.requests = async () => {
    const pipeline = await import("../../lib/commands/pipeline");
    const work = await import("../../lib/commands/dealWork");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);

    for (let i = 0; i < 2; i++) {
        const r = await work.logFollowUpAs(rep, { leadId: id, outcome: "WANTS_DESIGN", expectedRevision: await leadRev(id), idempotencyKey: key(), note: `pokus ${i}` });
        if ("error" in r) throw new Error(r.error);
    }
    const design = await prisma.dealRequest.findMany({ where: { leadId: id, kind: "DESIGN", status: "OPEN" } });
    check("requests: repeated WANTS_DESIGN → one open DESIGN, note appended", design.length === 1 && (design[0].note ?? "").includes("pokus 1"), JSON.stringify(design.map((d) => d.note)));

    const manualDone = await pipeline.resolveDealRequestAs(manager, design[0].id, "DONE", null);
    check("requests: manual DONE for DESIGN rejected", codeOf(manualDone) === "ERR:FORBIDDEN", codeOf(manualDone));
    const noReason = await pipeline.resolveDealRequestAs(manager, design[0].id, "CANCELLED", "  ");
    check("requests: decline without reason rejected", codeOf(noReason) !== "OK", codeOf(noReason));

    // PRICE request → obchodník uloží cenu → DONE; CP odoslaná → CALL o 7 dní.
    const pr = await work.createDealRequestAs(rep, id, "PRICE", "neviem cenu");
    const saved = await work.saveDealQuoteAs(rep, id, { price: 790, priceNote: null });
    const priceReq = await prisma.dealRequest.findFirstOrThrow({ where: { leadId: id, kind: "PRICE" } });
    check("requests: rep saves price → own PRICE request DONE", codeOf(pr) === "OK" && codeOf(saved) === "OK" && priceReq.status === "DONE", `${priceReq.status} ${priceReq.resolutionNote}`);
    const before = await leadRev(id);
    const offers = await import("../../lib/commands/offers");
    const { businessDate: bd } = await import("../../lib/domain/businessTime");
    const sent = await offers.recordOfferSentAs(rep, {
        leadId: id,
        expectedRevision: before,
        idempotencyKey: key(),
        contents: ["PRICE"],
        sentOn: bd(new Date()),
        followUp: true,
    });
    const afterLead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { nextActionKind: true, nextActionAt: true, nextActionHasTime: true, revision: true, ownerId: true } });
    const { businessDate, addBusinessCalendarDays } = await import("../../lib/domain/businessTime");
    const expected = addBusinessCalendarDays(businessDate(new Date()), 7);
    check(
        "requests: price sent (OFFER_SENT) → CALL +7 business days (day-only), one revision bump",
        codeOf(sent) === "OK" && afterLead.nextActionKind === "CALL" && !afterLead.nextActionHasTime && afterLead.nextActionAt !== null &&
            businessDate(afterLead.nextActionAt) === expected && afterLead.revision === before + 1,
        JSON.stringify({ at: afterLead.nextActionAt && businessDate(afterLead.nextActionAt), expected, delta: afterLead.revision - before }),
    );

    // Manažér uloží cenu na obchodníkovom obchode → vlastník ostáva.
    await pipeline.saveQuoteAs(manager, id, { price: 990, priceNote: "zľava" });
    const owner = (await prisma.lead.findUniqueOrThrow({ where: { id }, select: { ownerId: true } })).ownerId;
    check("requests: manager price keeps owner", owner === rep.id, `owner=${owner === rep.id ? "rep" : owner}`);

    // Návrh odoslaný manažérom → DESIGN DONE.
    const { createDesignAs } = await import("../../lib/commands/tracking");
    await createDesignAs(manager, { leadId: id, label: "A" });
    const d = await prisma.design.findFirstOrThrow({ where: { leadId: id }, select: { id: true } });
    const ds = await offers.recordOfferSentAs(manager, {
        leadId: id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        contents: ["DESIGN"],
        designIds: [d.id],
        sentOn: bd(new Date()),
        followUp: true,
    });
    const designReq = await prisma.dealRequest.findFirstOrThrow({ where: { id: design[0].id } });
    check("requests: design marked sent → DESIGN DONE", codeOf(ds) === "OK" && designReq.status === "DONE", designReq.status);

    // OTHER → manuálne DONE povolené.
    await work.createDealRequestAs(rep, id, "OTHER", "zavolaj mu ty");
    const other = await prisma.dealRequest.findFirstOrThrow({ where: { leadId: id, kind: "OTHER", status: "OPEN" } });
    const otherDone = await pipeline.resolveDealRequestAs(manager, other.id, "DONE", null);
    check("requests: OTHER manual DONE allowed", codeOf(otherDone) === "OK", codeOf(otherDone));

    // ORDER → WON zatvorí obchod; žiadna OPEN požiadavka, closedAt nastavené.
    await work.logFollowUpAs(rep, { leadId: id, outcome: "WANTS_TO_ORDER", expectedRevision: await leadRev(id), idempotencyKey: key(), note: "idú do toho" });
    await work.createDealRequestAs(rep, id, "EMAIL", null);
    const won = await pipeline.changeStatusAs(manager, id, "WON");
    const openAfter = await prisma.dealRequest.count({ where: { leadId: id, status: "OPEN" } });
    const order = await prisma.dealRequest.findFirstOrThrow({ where: { leadId: id, kind: "ORDER" } });
    const closed = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { status: true, closedAt: true } });
    check("requests: WON → ORDER DONE, others cancelled, closedAt set", codeOf(won) === "OK" && openAfter === 0 && order.status === "DONE" && closed.closedAt !== null, JSON.stringify({ openAfter, order: order.status, closed }));

    // Uzavretý obchod: obchodník nemôže follow-up; môže REOPEN; REOPEN na otvorenom zakázaný; manažér reopen → DONE.
    const fu = await work.logFollowUpAs(rep, { leadId: id, outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const edit = await work.updateDealContactAs(rep, id, { note: "x" });
    const reopenReq = await work.createDealRequestAs(rep, id, "REOPEN", "chcú ešte e-shop");
    check("closed deal: rep follow-up/edit rejected, REOPEN request allowed", codeOf(fu) === "ERR:DEAL_CLOSED" && codeOf(edit) === "ERR:DEAL_CLOSED" && codeOf(reopenReq) === "OK", `${codeOf(fu)} ${codeOf(edit)} ${codeOf(reopenReq)}`);
    const reopened = await pipeline.reopenDealAs(manager, id);
    const reopenStatus = await prisma.dealRequest.findFirstOrThrow({ where: { leadId: id, kind: "REOPEN" } });
    const openDeal = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { status: true, closedAt: true, ownerId: true } });
    check("closed deal: manager reopens → REOPEN DONE, owner kept", codeOf(reopened) === "OK" && reopenStatus.status === "DONE" && openDeal.status === "ACTIVE" && openDeal.closedAt === null && openDeal.ownerId === rep.id, JSON.stringify(openDeal));
    const reopenOnOpen = await work.createDealRequestAs(rep, id, "REOPEN", null);
    check("closed deal: REOPEN on an open deal rejected", codeOf(reopenOnOpen) !== "OK", codeOf(reopenOnOpen));

    // Follow-up NOT_INTERESTED zatvorí obchod a zruší požiadavky.
    await work.createDealRequestAs(rep, id, "PRICE", null);
    const lost = await work.logFollowUpAs(rep, { leadId: id, outcome: "NOT_INTERESTED", expectedRevision: await leadRev(id), idempotencyKey: key(), lostReason: "drahé" });
    const lostLead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { status: true, closedAt: true, lostReason: true } });
    const openLost = await prisma.dealRequest.count({ where: { leadId: id, status: "OPEN" } });
    check("follow-up NOT_INTERESTED → LOST, closedAt, no open requests", codeOf(lost) === "OK" && lostLead.status === "LOST" && lostLead.closedAt !== null && openLost === 0, JSON.stringify({ lostLead, openLost }));

    // First-call štatistiky (CALL_QUEUE) sa follow-upmi nemenia.
    const queueCalls = await prisma.activity.count({ where: { leadId: id, type: "CALL", source: "CALL_QUEUE" } });
    check("stats: follow-ups use source CLIENTS, first-call count unchanged", queueCalls === 1, `CALL_QUEUE calls=${queueCalls}`);
};

// Rozsah obchodníka: cudzí obchod → NOT_FOUND; obchodník bez deals.manage nemôže manažérske príkazy.
tests.dealScope = async () => {
    const pipeline = await import("../../lib/commands/pipeline");
    const work = await import("../../lib/commands/dealWork");
    const repA = await makeUser("SALES_REP");
    const repB = await makeUser("SALES_REP");
    const id = await makeDeal(repA);
    const f = await work.logFollowUpAs(repB, { leadId: id, outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const q = await work.saveDealQuoteAs(repB, id, { price: 1, priceNote: null });
    const m = await pipeline.saveQuoteAs(repA, id, { price: 1, priceNote: null });
    const w = await pipeline.changeStatusAs(repA, id, "WON");
    check("deal scope: foreign rep → NOT_FOUND; rep cannot use manager commands", codeOf(f) === "ERR:NOT_FOUND" && codeOf(q) === "ERR:NOT_FOUND" && codeOf(m) === "ERR:FORBIDDEN" && codeOf(w) === "ERR:FORBIDDEN", `${codeOf(f)} ${codeOf(q)} ${codeOf(m)} ${codeOf(w)}`);

    const { requireDealView } = await import("../../lib/access/leads");
    let viewA = "OK";
    let viewB = "OK";
    await requireDealView(prisma, repA, id).catch((e) => (viewA = e.code));
    await requireDealView(prisma, repB, id).catch((e) => (viewB = e.code));
    const nonDeal = await makeAssignedLead(repA.id);
    let viewNonDeal = "OK";
    await requireDealView(prisma, repA, nonDeal).catch((e) => (viewNonDeal = e.code));
    check("deal scope: page view own OK, foreign/non-deal NOT_FOUND", viewA === "OK" && viewB === "NOT_FOUND" && viewNonDeal === "NOT_FOUND", `${viewA} ${viewB} ${viewNonDeal}`);
};

// Obchodník loguje follow-up, manažér súčasne presúva obchody → po commite presunu žiadna aktivita od obchodníka.
tests.transferRace = async () => {
    const pipeline = await import("../../lib/commands/pipeline");
    const work = await import("../../lib/commands/dealWork");
    const manager = await makeUser("MANAGER");
    const repA = await makeUser("SALES_REP");
    const repB = await makeUser("SALES_REP");
    const n = Math.min(ITER, 20);
    let bad = 0;
    for (let i = 0; i < n; i++) {
        const id = await makeDeal(repA);
        const rev = await leadRev(id);
        const [fu, tr] = await Promise.all([
            work.logFollowUpAs(repA, { leadId: id, outcome: "NO_ANSWER", expectedRevision: rev, idempotencyKey: key() }),
            pipeline.transferDealsAs(manager, { fromOwnerId: repA.id, toOwnerId: repB.id, statuses: ["ACTIVE", "SNOOZED"] }),
        ]);
        const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { ownerId: true } });
        const transferAt = await prisma.activity.findFirst({ where: { leadId: id, type: "OWNER_CHANGED", source: "PIPELINE" }, select: { createdAt: true } });
        const repAfter = transferAt
            ? await prisma.activity.count({ where: { leadId: id, userId: repA.id, source: "CLIENTS", createdAt: { gt: transferAt.createdAt } } })
            : 0;
        // Ak bol obchod pri presune preskočený (SKIP LOCKED), ostáva u A – vtedy follow-up je legitímny.
        const ok = repAfter === 0 && (lead.ownerId === repB.id || (lead.ownerId === repA.id && !transferAt));
        if (!ok) {
            bad++;
            console.log(`   iteration ${i}: fu=${codeOf(fu)} tr=${JSON.stringify(tr)} owner=${lead.ownerId === repB.id ? "B" : "A"} repAfter=${repAfter}`);
        }
        // presunuté obchody späť, aby ďalšia iterácia presúvala len nový
        await prisma.lead.updateMany({ where: { ownerId: repB.id }, data: { ownerId: null, status: "LOST", closedAt: new Date() } });
        await prisma.lead.updateMany({ where: { ownerId: repA.id }, data: { status: "LOST", closedAt: new Date() } });
    }
    check(`transfer race: follow-up vs bulk owner transfer (${n}×)`, bad === 0, `bad=${bad}`);
};

// Pravidlo revízie: každý príkaz zvýši revíziu presne o 1.
tests.revision = async () => {
    const pipeline = await import("../../lib/commands/pipeline");
    const work = await import("../../lib/commands/dealWork");
    const tracking = await import("../../lib/commands/tracking");
    const offers = await import("../../lib/commands/offers");
    const { businessDate } = await import("../../lib/domain/businessTime");
    const today = businessDate(new Date());
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep, "WANTS_DESIGN");
    const steps: [string, () => Promise<unknown>][] = [
        ["updateLead", () => pipeline.updateLeadAs(manager, id, { note: "n1", email: "a@b.c" })],
        ["saveQuote", () => pipeline.saveQuoteAs(manager, id, { price: 100, priceNote: null })],
        ["recordOffer ABOUT_US", async () => offers.recordOfferSentAs(manager, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), contents: ["ABOUT_US"], sentOn: today, followUp: false })],
        ["setProjectType", () => pipeline.setProjectTypeAs(manager, id, "ESHOP")],
        ["setNextAction", async () => pipeline.setNextActionAs(manager, id, { kind: "CALL", schedule: { kind: "daysFromToday", days: 2 } }, await leadRev(id))],
        ["recordOffer PRICELIST+PRICE", async () => offers.recordOfferSentAs(manager, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), contents: ["PRICELIST", "PRICE"], sentOn: today, followUp: true })],
        ["addBusinessNote", () => pipeline.addBusinessNoteAs(manager, id, "poznámka")],
        ["createDesign", () => tracking.createDesignAs(manager, { leadId: id, label: "B" })],
        ["recordOffer DESIGN", async () => offers.recordOfferSentAs(manager, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), contents: ["DESIGN"], designIds: [(await prisma.design.findFirstOrThrow({ where: { leadId: id } })).id], sentOn: today, followUp: false })],
        ["correctRecord", async () => offers.correctRecordAs(manager, (await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT", revertedAt: null } })).id, "test opravy")],
        ["createDealRequest", () => work.createDealRequestAs(rep, id, "OTHER", "x")],
        ["logFollowUp", async () => work.logFollowUpAs(rep, { leadId: id, outcome: "WANTS_DESIGN", expectedRevision: await leadRev(id), idempotencyKey: key() })],
        ["changeOwner", () => pipeline.changeOwnerAs(manager, id, manager.id)],
        ["changeStatus SNOOZED", () => pipeline.changeStatusAs(manager, id, "SNOOZED")],
        ["markLost", () => pipeline.markLostAs(manager, id, "test")],
        ["changeStatus closed→SNOOZED", () => pipeline.changeStatusAs(manager, id, "SNOOZED")],
    ];
    const wrong: string[] = [];
    for (const [name, fn] of steps) {
        const before = await leadRev(id);
        const r = await fn();
        const after = await leadRev(id);
        if (codeOf(r) !== "OK" || after - before !== 1) wrong.push(`${name}: ${codeOf(r)} Δ=${after - before}`);
    }
    check("revision: every deal command bumps exactly once", wrong.length === 0, wrong.join("; "));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// claimBatch súbežne s deaktiváciou → deaktivovaný používateľ nikdy nedrží NEW.
tests.claimVsDeactivate = async () => {
    const { deactivateUserAs } = await import("../../lib/commands/admin");
    const admin = await makeUser("ADMIN");
    await makePoolLeads(20);
    const n = ITER;
    let bad = 0;
    const tally2: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
        const u = await makeUser("TELESALES");
        const order = i % 2 === 0;
        const [claim, deact] = order
            ? await Promise.all([claimBatchAs(u), deactivateUserAs(admin, u.id)])
            : await Promise.all([deactivateUserAs(admin, u.id), claimBatchAs(u)]).then(([d, c]) => [c, d] as const);
        const k = `claim=${codeOf(claim)}${"claimed" in claim ? `(${claim.claimed})` : ""} deact=${deact.ok ? "OK" : deact.code}`;
        tally2[k] = (tally2[k] ?? 0) + 1;
        const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { deletedAt: true } });
        const held = await prisma.lead.count({ where: { assignedCallerId: u.id, status: "NEW", deletedAt: null } });
        if (user.deletedAt && held !== 0) {
            bad++;
            console.log(`   iteration ${i}: deactivated but holds ${held} NEW (${k})`);
        }
        if (!deact.ok && user.deletedAt) {
            bad++;
            console.log(`   iteration ${i}: deactivation failed but user deactivated (${k})`);
        }
        // uvoľni pre ďalšiu iteráciu
        if (!user.deletedAt) await deactivateUserAs(admin, u.id);
    }
    check(`deactivation vs claim (${n}×): never deactivated with NEW`, bad === 0, `bad=${bad} ${JSON.stringify(tally2)}`);
};

// Deaktivácia počas rozbehnutého logCall na NEW, ktorý sa potom ROLLBACKne → čaká, uvoľní, 0 NEW.
tests.deactivateInflight = async () => {
    const { deactivateUserAs } = await import("../../lib/commands/admin");
    const { requireCallLead } = await import("../../lib/access/leads");
    const { withLockTx } = await import("../../lib/access/locks");
    const admin = await makeUser("ADMIN");
    const n = ITER;
    let bad = 0;
    let waited = 0;
    for (let i = 0; i < n; i++) {
        const u = await makeUser("TELESALES");
        const leadId = await makeAssignedLead(u.id);
        let locked!: () => void;
        const lockedP = new Promise<void>((r) => (locked = r));
        const inflight = withLockTx(async (tx) => {
            await requireCallLead(tx, u, leadId);
            locked();
            await sleep(60 + (i % 5) * 20);
            throw new Error("injected failure after Lead lock");
        }).catch((e: Error) => e.message);
        await lockedP;
        const t0 = Date.now();
        const deact = await deactivateUserAs(admin, u.id);
        const tookMs = Date.now() - t0;
        if (tookMs >= 40) waited++;
        const failure = await inflight;
        const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { deletedAt: true } });
        const held = await prisma.lead.count({ where: { assignedCallerId: u.id, status: "NEW", deletedAt: null } });
        if (!deact.ok || !user.deletedAt || held !== 0 || !failure.includes("injected")) {
            bad++;
            console.log(`   iteration ${i}: deact=${deact.ok ? "OK" : deact.code} deactivated=${Boolean(user.deletedAt)} held=${held} inflight=${failure}`);
        }
    }
    check(`deactivation waits for in-flight call that rolls back (${n}×) → 0 NEW`, bad === 0, `bad=${bad}, deactivation waited in ${waited}/${n}`);
};

// Nesúvisiaci dlhý zámok na leade dlhšie než lock_timeout → deaktivácia sa celá vráti (RETRYABLE), user aktívny.
tests.deactivateTimeout = async () => {
    const { deactivateUserAs } = await import("../../lib/commands/admin");
    const admin = await makeUser("ADMIN");
    const u = await makeUser("TELESALES");
    const leadId = await makeAssignedLead(u.id);
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
        async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
            locked();
            await sleep(13_000);
        },
        { maxWait: 5_000, timeout: 30_000 },
    );
    await lockedP;
    const t0 = Date.now();
    const deact = await deactivateUserAs(admin, u.id);
    const took = Date.now() - t0;
    await holder;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { deletedAt: true } });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId }, select: { assignedCallerId: true } });
    check(
        "deactivation past lock_timeout → rolled back, RETRYABLE, user active, lead still assigned",
        !deact.ok && deact.code === "RETRYABLE" && user.deletedAt === null && lead.assignedCallerId === u.id,
        `deact=${deact.ok ? "OK" : deact.code} took=${took}ms active=${user.deletedAt === null}`,
    );
};

// Presun retry A → B, potom A vracia svoj starší hovor → odmietnuté, lead ostáva u B.
tests.transferThenRevert = async () => {
    const { transferCallWorkAs } = await import("../../lib/commands/assignments");
    const manager = await makeUser("MANAGER");
    const a = await makeUser("TELESALES");
    const b = await makeUser("TELESALES");
    const id = await makeAssignedLead(a.id);
    await logCallAs(a, { leadId: id, outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const act = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "CALL" }, select: { id: true } });
    const tr = await transferCallWorkAs(manager, { fromUserId: a.id, toUserId: b.id, kind: "RETRY" });
    const rv = await revertCallResultAs(a, act.id, await leadRev(id));
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { assignedCallerId: true, status: true } });
    const aEdit = await (await import("../../lib/commands/calls")).updateLeadContactAs(a, id, { phone: "111" });
    check(
        "transfer then revert by former caller → rejected, lead stays with B; former caller cannot edit",
        "moved" in tr && tr.moved === 1 && codeOf(rv) !== "OK" && lead.assignedCallerId === b.id && codeOf(aEdit) === "ERR:NOT_FOUND",
        `tr=${JSON.stringify(tr)} rv=${codeOf(rv)} owner=${lead.assignedCallerId === b.id ? "B" : "?"} edit=${codeOf(aEdit)}`,
    );
};

// Manažér presúva 1 000+ retry → v dávkach, audit len pre presunuté, nič nepreskočené; NEW rešpektuje kapacitu.
tests.bulkTransfer = async () => {
    const { transferCallWorkAs, releaseBatchAs } = await import("../../lib/commands/assignments");
    const manager = await makeUser("MANAGER");
    const a = await makeUser("TELESALES");
    const b = await makeUser("TELESALES");
    const total = 1050;
    const rows = Array.from({ length: total }, (_, i) => ({
        companyName: `CC-TEST ${RUN} bulk ${i}`,
        phone: `+000 ${RUN} b${i}`,
        status: "CALLING" as const,
        callbackKind: "RETRY" as const,
        assignedCallerId: a.id,
        assignedCallerAt: new Date(),
        createdAt: new Date(OLD.getTime() - (i + 1) * 1000),
    }));
    await prisma.lead.createMany({ data: rows });
    const ids = (await prisma.lead.findMany({ where: { companyName: { startsWith: `CC-TEST ${RUN} bulk` } }, select: { id: true } })).map((l) => l.id);
    createdLeads.push(...ids);

    const t0 = Date.now();
    const tr = await transferCallWorkAs(manager, { fromUserId: a.id, toUserId: b.id, kind: "RETRY" });
    const took = Date.now() - t0;
    const leftA = await prisma.lead.count({ where: { id: { in: ids }, assignedCallerId: a.id } });
    const atB = await prisma.lead.count({ where: { id: { in: ids }, assignedCallerId: b.id } });
    const audits = await prisma.activity.count({ where: { leadId: { in: ids }, type: "CALLER_ASSIGNED" } });
    check(
        `bulk transfer ${total} retries A → B`,
        "moved" in tr && tr.moved === total && leftA === 0 && atB === total && audits === total,
        `moved=${"moved" in tr ? tr.moved : tr.error} leftA=${leftA} atB=${atB} audits=${audits} took=${took}ms`,
    );

    // kapacita NEW: cieľ drží 8 → presunú sa len 2
    for (let i = 0; i < 8; i++) await makeAssignedLead(b.id);
    for (let i = 0; i < 6; i++) await makeAssignedLead(a.id);
    const cap = await transferCallWorkAs(manager, { fromUserId: a.id, toUserId: b.id, kind: "NEW" });
    const bNew = await prisma.lead.count({ where: { assignedCallerId: b.id, status: "NEW" } });
    const full = await transferCallWorkAs(manager, { fromUserId: a.id, toUserId: b.id, kind: "NEW" });
    check("NEW transfer respects target capacity (8 held → 2 moved, then refused)", "moved" in cap && cap.moved === 2 && bNew === 10 && codeOf(full) !== "OK", `cap=${JSON.stringify(cap)} bNew=${bNew} full=${codeOf(full)}`);
    const rel = await releaseBatchAs(manager, a.id);
    const aNew = await prisma.lead.count({ where: { assignedCallerId: a.id, status: "NEW" } });
    check("release batch → pool", "moved" in rel && rel.moved === 4 && aNew === 0, `rel=${JSON.stringify(rel)} aNew=${aNew}`);
};

// Handoff člena tímu súbežne so zmenou vedúceho → vlastník = vedúci platný pred tým, ako handoff zamkol Team.
tests.handoffVsLeader = async () => {
    const { setTeamLeaderAs } = await import("../../lib/commands/teams");
    const l1 = await makeUser("ADMIN");
    const rep = await makeUser("SALES_REP");
    const teamId = await makeTeam(l1.id);
    const caller = await makeUser("TELESALES", { teamId });
    const changes: { at: number; leaderId: string }[] = [
        { at: (await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { updatedAt: true } })).updatedAt.getTime(), leaderId: l1.id },
    ];
    const n = ITER;
    const outcomes: Record<string, number> = {};
    const deals: string[] = [];
    for (let i = 0; i < n; i++) {
        const leadId = await makeAssignedLead(caller.id);
        const next = i % 2 === 0 ? rep.id : l1.id;
        const [call, lead] = await Promise.all([
            logCallAs(caller, { leadId, outcome: "WANTS_QUOTE", expectedRevision: await leadRev(leadId), idempotencyKey: key() }),
            (async () => {
                await sleep(i % 3);
                return setTeamLeaderAs(teamId, next);
            })(),
        ]);
        const k = `call=${codeOf(call)} leader=${lead.ok ? "OK" : lead.code}`;
        outcomes[k] = (outcomes[k] ?? 0) + 1;
        if (lead.ok) {
            const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { updatedAt: true, leaderId: true } });
            changes.push({ at: t.updatedAt.getTime(), leaderId: t.leaderId! });
        }
        if (codeOf(call) === "OK") deals.push(leadId);
    }
    let bad = 0;
    for (const id of deals) {
        const d = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { ownerId: true, pipelineEnteredAt: true } });
        const at = d.pipelineEnteredAt!.getTime();
        const expected = [...changes].filter((c) => c.at < at).sort((x, y) => y.at - x.at)[0]?.leaderId;
        if (d.ownerId !== expected) bad++;
    }
    const unexpected = Object.keys(outcomes).filter((k) => /ERR:(?!RETRYABLE)/.test(k) || /leader=(?!OK|RETRYABLE)/.test(k));
    check(
        `handoff vs setTeamLeader (${n}×): owner = leader valid when the handoff locked the team`,
        bad === 0 && unexpected.length === 0,
        `bad=${bad} deals=${deals.length} outcomes=${JSON.stringify(outcomes)}`,
    );
};

// deleteTeam súbežne s handoffmi → len RETRYABLE chyby, po zmazaní obchody nepriradené.
tests.deleteTeamVsHandoffs = async () => {
    const { deleteTeamAs } = await import("../../lib/commands/teams");
    const l1 = await makeUser("ADMIN");
    const teamId = await makeTeam(l1.id);
    const caller = await makeUser("TELESALES", { teamId });
    const leads: string[] = [];
    for (let i = 0; i < 20; i++) leads.push(await makeAssignedLead(caller.id));
    let deleteStarted = 0;
    let deleteReturned = 0;
    const results = await Promise.all([
        ...leads.map(async (id, i) => {
            await sleep(i * 15);
            return logCallAs(caller, { leadId: id, outcome: "WANTS_EMAIL", expectedRevision: await leadRev(id), idempotencyKey: key() });
        }),
        (async () => {
            await sleep(140);
            deleteStarted = Date.now();
            const r = await deleteTeamAs(teamId);
            deleteReturned = Date.now();
            return r;
        })(),
    ]);
    const del = results.pop() as Awaited<ReturnType<typeof deleteTeamAs>>;
    createdTeams.splice(createdTeams.indexOf(teamId), 1);
    let bad = 0;
    for (const id of leads) {
        const d = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { ownerId: true, pipelineEnteredAt: true } });
        if (!d.pipelineEnteredAt) continue;
        const at = d.pipelineEnteredAt.getTime();
        if (d.ownerId === l1.id && at > deleteReturned) bad++;
        if (d.ownerId === null && at < deleteStarted) bad++;
        if (d.ownerId !== null && d.ownerId !== l1.id) bad++;
    }
    const errors = results.filter((r) => codeOf(r) !== "OK" && codeOf(r) !== "ERR:RETRYABLE");
    check(
        "deleteTeam vs handoffs: no non-retryable errors; unrouted after delete",
        del.ok && errors.length === 0 && bad === 0,
        `delete=${del.ok ? "OK" : del.code} ${JSON.stringify(tally(results))} bad=${bad}`,
    );
};

// ── Regresné testy k revízii (context/features/01-salesrep/revision.md) ─────────────────

// R-01: crafted payload s extra poľami (stav, vlastník, značka, zmazanie) sa odmietne na oboch vstupoch; nič sa nezmení.
tests.r01CraftedInput = async () => {
    const work = await import("../../lib/commands/dealWork");
    const pipeline = await import("../../lib/commands/pipeline");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const other = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const snapshot = async () => {
        const l = await prisma.lead.findUniqueOrThrow({
            where: { id },
            select: { status: true, ownerId: true, pipelineEnteredAt: true, deletedAt: true, revision: true, phone: true, closedAt: true, handedOffById: true },
        });
        const requests = await prisma.dealRequest.count({ where: { leadId: id } });
        return JSON.stringify({ ...l, requests });
    };
    const before = await snapshot();
    const evil = { phone: "0999 999 999", status: "WON", ownerId: other.id, pipelineEnteredAt: null, deletedAt: new Date(), closedAt: new Date() };
    const viaClient = await work.updateDealContactAs(rep, id, evil as never);
    const viaPipeline = await pipeline.updateLeadAs(manager, id, evil as never);
    const relation = await work.updateDealContactAs(rep, id, { note: "x", owner: { connect: { id: other.id } } } as never);
    const nextEvil = await work.setDealNextActionAs(rep, id, { kind: "CALL", status: "WON" } as never, (await prisma.lead.findUniqueOrThrow({ where: { id } })).revision);
    const after = await snapshot();
    check(
        "R-01: extra fields rejected on client + pipeline contact edit and next-action; deal unchanged",
        codeOf(viaClient) !== "OK" && codeOf(viaPipeline) !== "OK" && codeOf(relation) !== "OK" && codeOf(nextEvil) !== "OK" && before === after,
        `${codeOf(viaClient)} ${codeOf(viaPipeline)} ${codeOf(relation)} ${codeOf(nextEvil)} unchanged=${before === after}`,
    );
    const valid = await work.updateDealContactAs(rep, id, { phone: " 0911 000 111 ", email: "ok@test.invalid" });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { phone: true, email: true, status: true, ownerId: true } });
    check("R-01: valid contact edit still works", codeOf(valid) === "OK" && lead.phone === "0911 000 111" && lead.status === "ACTIVE" && lead.ownerId === rep.id, JSON.stringify(lead));
};

// R-02: poradie sa počíta pred LIMIT – urgentný obchod a najstaršia požiadavka sú na 1. strane aj pri > 50 obchodoch.
tests.r02PipelineOrder = async () => {
    const { getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const owner = await makeUser("MANAGER");
    const requester = await makeUser("SALES_REP");
    const scope = dealScope(owner);
    const mine = { userId: owner.id } as const;
    const base = { status: "ACTIVE" as const, pipelineEnteredAt: new Date(), ownerId: owner.id };
    const mk = async (label: string, data: Record<string, unknown>) => {
        leadSeq++;
        const l = await prisma.lead.create({
            data: { companyName: `CC-TEST ${RUN} ${label} ${leadSeq}`, phone: `+000 ${RUN} r2${leadSeq}`, ...base, ...data },
            select: { id: true },
        });
        createdLeads.push(l.id);
        return l.id;
    };
    const inProgress: string[] = [];
    for (let i = 0; i < 55; i++) {
        inProgress.push(await mk("inprogress", { nextActionKind: "SEND_DESIGN", nextActionMode: "IN_PROGRESS", nextActionAt: new Date(Date.UTC(2001, 0, 1 + i)) }));
    }
    const overdue = await mk("overdue", { nextActionKind: "CALL", nextActionMode: "SCHEDULED", nextActionAt: new Date("2020-01-01T00:00:00Z") });
    const page = await getDealList({ scope, owner: mine, status: "ACTIVE", take: 50 });
    check("R-02: overdue deal first on page 1 among 56 deals", page.rows[0]?.id === overdue && page.hasMore, `first=${page.rows[0]?.id === overdue ? "overdue" : "other"} rows=${page.rows.length} hasMore=${page.hasMore}`);

    for (const id of inProgress) {
        await prisma.dealRequest.create({ data: { leadId: id, kind: "OTHER", createdById: requester.id } });
    }
    const oldest = await mk("oldestrequest", { nextActionKind: null, nextActionAt: null });
    await prisma.dealRequest.create({ data: { leadId: oldest, kind: "PRICE", createdById: requester.id, createdAt: new Date("2000-01-01T00:00:00Z") } });
    const req = await getDealList({ scope, owner: mine, view: "requests", take: 50 });
    check("R-02: oldest request first in Požiadavky view with > 50 request deals", req.rows[0]?.id === oldest && req.hasMore, `first=${req.rows[0]?.id === oldest ? "oldest" : "other"} rows=${req.rows.length}`);
    const next = await getDealList({ scope, owner: mine, view: "requests", take: 100 });
    const ids = next.rows.map((r) => r.id);
    const { nextActionSort } = await import("../../lib/overdue");
    const everything = await getDealList({ scope, owner: "all", take: 5000 });
    const ranks = everything.rows.map((r) => nextActionSort(r.nextActionMode, r.nextActionKind, r.nextActionAt, r.nextActionHasTime));
    const inversions = ranks.filter((r, i) => i > 0 && (r.rank < ranks[i - 1].rank || (r.rank === ranks[i - 1].rank && r.rank !== 3 && r.rank !== 4 && r.tie < ranks[i - 1].tie))).length;
    check("R-02: SQL order matches nextActionSort over all deals", inversions === 0, `deals=${everything.rows.length} inversions=${inversions}`);
    check("R-02: deterministic, no duplicates across a larger page", new Set(ids).size === ids.length && ids.length === 56 && ids.slice(0, 50).join() === req.rows.map((r) => r.id).join(), `n=${ids.length}`);
};

// R-03: detail pre bývalého vlastníka po presune nevráti nič (rozsah je v samotnom dotaze).
tests.r03DetailScope = async () => {
    const { getDealDetail } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const pipeline = await import("../../lib/commands/pipeline");
    const manager = await makeUser("MANAGER");
    const repA = await makeUser("SALES_REP");
    const repB = await makeUser("SALES_REP");
    const id = await makeDeal(repA);
    const detail = (u: AccessUser) => getDealDetail(id, dealScope(u), dealCapabilities(u));
    const before = await detail(repA);
    const moved = await pipeline.changeOwnerAs(manager, id, repB.id);
    const formerOwner = await detail(repA);
    const newOwner = await detail(repB);
    const asManager = await detail(manager);
    check(
        "R-03: detail query scoped - former owner null after transfer, new owner and manager see it",
        before !== null && codeOf(moved) === "OK" && formerOwner === null && newOwner !== null && asManager !== null,
        `before=${Boolean(before)} former=${Boolean(formerOwner)} new=${Boolean(newOwner)} manager=${Boolean(asManager)}`,
    );
    check("R-05: rep detail has no design version field", before !== null && before.designs.every((d) => !("version" in d)), "");
    check(
        "W1: rep detail hides audit activities",
        before !== null && before.activities.every((a) => a.category === "BUSINESS"),
        "",
    );
};

// R-04: hľadanie je stránkované – 101 zhôd je dosiahnuteľných.
tests.r04SearchPaging = async () => {
    const { getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const rep = await makeUser("SALES_REP");
    const token = `srch${RUN}`;
    await prisma.lead.createMany({
        data: Array.from({ length: 101 }, (_, i) => ({
            companyName: `CC-TEST ${token} ${i}`,
            phone: `+000 ${RUN} s${i}`,
            status: "ACTIVE" as const,
            pipelineEnteredAt: new Date(),
            ownerId: rep.id,
        })),
    });
    createdLeads.push(...(await prisma.lead.findMany({ where: { companyName: { contains: token } }, select: { id: true } })).map((l) => l.id));
    const scope = dealScope(rep);
    const mine = { userId: rep.id } as const;
    const first = await getDealList({ scope, owner: mine, query: token, view: "all" });
    const all = await getDealList({ scope, owner: mine, query: token, view: "all", take: 150 });
    const firstIds = first.rows.map((r) => r.id);
    const allIds = all.rows.map((r) => r.id);
    check(
        "R-04: 101 matches - first page 50 + hasMore, larger page reaches all 101 in the same order",
        first.hasMore && firstIds.length === 50 && !all.hasMore && new Set(allIds).size === 101 && allIds.slice(0, 50).join() === firstIds.join(),
        `first=${firstIds.length} all=${allIds.length}`,
    );
};

// ── Zlúčenie obrazoviek (round 2, wave 1) ────────────────────────────────────

// W1-A: obchodník nevidí cudzí obchod bez ohľadu na ?owner= – rozsah je v dotaze, nie v URL.
tests.w1RepScope = async () => {
    const { getDealList, getDealDetail } = await import("../../lib/queries/pipeline");
    const { dealScope, resolveOwnerFilter } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const repA = await makeUser("SALES_REP");
    const repB = await makeUser("SALES_REP");
    const mineId = await makeDeal(repA);
    const foreignId = await makeDeal(repB);
    const scope = dealScope(repA);
    let leaked = 0;
    let missingOwn = 0;
    for (const raw of [undefined, "me", "all", "unassigned", repB.id, "../../etc", ""]) {
        const owner = resolveOwnerFilter(raw, repA, scope);
        const { rows } = await getDealList({ scope, owner, view: "all", take: 500 });
        if (rows.some((r) => r.id === foreignId)) leaked++;
        if (!rows.some((r) => r.id === mineId)) missingOwn++;
    }
    const foreignDetail = await getDealDetail(foreignId, scope, dealCapabilities(repA));
    check(
        "W1-A: rep list never returns another owner's deal for any ?owner= value",
        leaked === 0 && missingOwn === 0 && foreignDetail === null,
        `leaked=${leaked} missingOwn=${missingOwn} foreignDetail=${Boolean(foreignDetail)}`,
    );
};

// W1-B: manažérovo „owner=<obchodník>" vráti presne to, čo vidí obchodník sám, v rovnakom poradí.
tests.w1ManagerSeesRepBoard = async () => {
    const { getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope, resolveOwnerFilter } = await import("../../lib/domain/dealScope");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    for (let i = 0; i < 5; i++) await makeDeal(rep, i % 2 === 0 ? "WANTS_QUOTE" : "WANTS_DESIGN");
    const repScope = dealScope(rep);
    const repView = await getDealList({ scope: repScope, owner: resolveOwnerFilter("me", rep, repScope), view: "all", take: 500 });
    const mgrScope = dealScope(manager);
    const mgrView = await getDealList({ scope: mgrScope, owner: resolveOwnerFilter(rep.id, manager, mgrScope), view: "all", take: 500 });
    check(
        "W1-B: manager filtering by a rep sees exactly the rep's own board, same order",
        repView.rows.length > 0 && repView.rows.map((r) => r.id).join() === mgrView.rows.map((r) => r.id).join(),
        `rep=${repView.rows.length} manager=${mgrView.rows.length}`,
    );
};

// W1-C: pilulka „Na dnes" (SQL) sa zhoduje s clientSection() nad všetkými otvorenými obchodmi v databáze.
tests.w1TodayParity = async () => {
    const { getDealList, getDealCounts } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { clientSection } = await import("../../lib/domain/clientSections");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
    const mk = async (label: string, data: Record<string, unknown>) => {
        leadSeq++;
        const l = await prisma.lead.create({
            data: {
                companyName: `CC-TEST ${RUN} ${label} ${leadSeq}`,
                phone: `+000 ${RUN} t${leadSeq}`,
                status: "ACTIVE",
                pipelineEnteredAt: new Date(),
                ownerId: rep.id,
                ...data,
            },
            select: { id: true },
        });
        createdLeads.push(l.id);
        return l.id;
    };
    // Fixture pre každú vetvu pravidla: bez kroku, bez termínu, po termíne, dnes, budúce (deň aj čas),
    // rozpracované, čaká na klienta (s termínom aj bez), spiace (zobudené / bez dátumu / budúce), s požiadavkou.
    await mk("nostep", { nextActionKind: null, nextActionAt: null });
    await mk("nodate", { nextActionKind: "CALL", nextActionAt: null });
    await mk("overdue", { nextActionKind: "CALL", nextActionAt: day(-3) });
    await mk("todayday", { nextActionKind: "CALL", nextActionAt: new Date() });
    await mk("future", { nextActionKind: "CALL", nextActionAt: day(5) });
    await mk("futuretime", { nextActionKind: "CALL", nextActionAt: day(5), nextActionHasTime: true });
    await mk("inprogress", { nextActionKind: "SEND_DESIGN", nextActionMode: "IN_PROGRESS", nextActionAt: day(-10) });
    await mk("waitingdue", { nextActionKind: "WAITING_FOR_CLIENT", nextActionAt: day(-1) });
    await mk("waitingnodate", { nextActionKind: "WAITING_FOR_CLIENT", nextActionAt: null });
    await mk("snoozedwoken", { status: "SNOOZED", nextActionKind: "CALL", nextActionAt: day(-1) });
    await mk("snoozednodate", { status: "SNOOZED", nextActionKind: "CALL", nextActionAt: null });
    await mk("snoozedfuture", { status: "SNOOZED", nextActionKind: "CALL", nextActionAt: day(30) });
    const withRequest = await mk("withrequest", { nextActionKind: "CALL", nextActionAt: day(-2) });
    await prisma.dealRequest.create({ data: { leadId: withRequest, kind: "PRICE", createdById: rep.id } });

    const scope = dealScope(manager);
    const sqlToday = await getDealList({ scope, owner: "all", view: "today", take: 5000 });
    const counts = await getDealCounts({ scope, owner: "all" });
    const now = new Date();
    const open = await prisma.lead.findMany({
        where: { deletedAt: null, pipelineEnteredAt: { not: null }, status: { in: ["ACTIVE", "SNOOZED"] } },
        select: {
            id: true,
            status: true,
            nextActionKind: true,
            nextActionAt: true,
            nextActionHasTime: true,
            nextActionMode: true,
            closedAt: true,
            requests: { where: { status: "OPEN" }, select: { id: true } },
        },
    });
    const expected = new Set(
        open.filter((l) => clientSection({ ...l, openRequestCount: l.requests.length }, now).section === "TODAY").map((l) => l.id),
    );
    const got = new Set(sqlToday.rows.map((r) => r.id));
    const missing = [...expected].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !expected.has(id));
    check(
        "W1-C: Na dnes SQL matches clientSection() over every open deal",
        missing.length === 0 && extra.length === 0 && counts.today === expected.size,
        `open=${open.length} expected=${expected.size} got=${got.size} missing=${missing.length} extra=${extra.length} count=${counts.today}`,
    );
};

// R-06: titulok „Čaká na mňa" ukazuje presný počet aj pri > 50 otvorených požiadavkách.
tests.r06RequestCount = async () => {
    const { getManagerToday } = await import("../../lib/queries/today/manager");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const owner = await makeUser("SALES_REP");
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
        leadSeq++;
        const l = await prisma.lead.create({
            data: { companyName: `CC-TEST ${RUN} req ${i}`, phone: `+000 ${RUN} q${i}`, status: "ACTIVE", pipelineEnteredAt: new Date(), ownerId: owner.id },
            select: { id: true },
        });
        createdLeads.push(l.id);
        ids.push(l.id);
    }
    await prisma.dealRequest.createMany({ data: ids.map((leadId) => ({ leadId, kind: "OTHER" as const, createdById: rep.id })) });
    const expected = await prisma.dealRequest.count({ where: { status: "OPEN", lead: { deletedAt: null } } });
    const today = await getManagerToday(manager);
    check("R-06: request count exact beyond 50, preview bounded", expected > 50 && today.requestCount === expected && today.requests.length <= 10, `count=${today.requestCount} expected=${expected} preview=${today.requests.length}`);
};

// ── Model interakcií (round 2, wave 2) ───────────────────────────────────────

// W2-A: „nezdvihli" ostáva nezdvihli aj keď si používateľ zvolí iný ďalší krok než predvolený.
tests.w2NoAnswerKeepsOutcome = async () => {
    const work = await import("../../lib/commands/dealWork");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);

    // 1. predvolené správanie sa nemení: bez výberu = zavolať nasledujúci pracovný deň
    const first = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "NO_ANSWER",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
    });
    const afterDefault = await prisma.lead.findUniqueOrThrow({
        where: { id },
        select: { nextActionKind: true, nextActionAt: true, nextActionMode: true },
    });

    // 2. s vlastným krokom: výsledok ostáva NO_ANSWER, ale krok je ten zvolený
    const second = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "NO_ANSWER",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        nextKind: "WAITING_FOR_CLIENT",
        schedule: { kind: "daysFromToday", days: 5 },
        note: "nechám to na nich",
    });
    const afterOverride = await prisma.lead.findUniqueOrThrow({
        where: { id },
        select: { nextActionKind: true, nextActionAt: true },
    });
    const calls = await prisma.activity.findMany({
        where: { leadId: id, type: "CALL" },
        orderBy: { createdAt: "desc" },
        select: { outcome: true },
    });
    check(
        "W2-A: no-answer keeps its outcome with a custom next step",
        codeOf(first) === "OK" &&
            afterDefault.nextActionKind === "CALL" &&
            afterDefault.nextActionAt !== null &&
            codeOf(second) === "OK" &&
            afterOverride.nextActionKind === "WAITING_FOR_CLIENT" &&
            afterOverride.nextActionAt !== null &&
            // makeDeal() zakladá obchod pozitívnym prvým hovorom, takže tretí záznam je fixture
            calls.length === 3 &&
            calls.slice(0, 2).every((c) => c.outcome === "NO_ANSWER"),
        `default=${afterDefault.nextActionKind} override=${afterOverride.nextActionKind} calls=${calls.map((c) => c.outcome).join(",")}`,
    );
};

// W2-B: odpoveď klienta sa uloží ako kľúč v meta a ako čitateľný popisok v poznámke; neznámy kľúč sa odmietne.
tests.w2ReplyStored = async () => {
    const work = await import("../../lib/commands/dealWork");
    const { CLIENT_REPLIES } = await import("../../lib/domain/clientReplies");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const reply = CLIENT_REPLIES.find((r) => r.key === "NOT_LOOKED_YET")!;

    const ok = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "POSITIVE",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        nextKind: "CALL",
        schedule: { kind: "daysFromToday", days: 2 },
        note: "vraj v piatok",
        reply: reply.key,
    });
    const activity = await prisma.activity.findFirst({
        where: { leadId: id, type: "CALL" },
        orderBy: { createdAt: "desc" },
        select: { note: true, meta: true, outcome: true },
    });
    const bogus = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "POSITIVE",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        nextKind: "CALL",
        schedule: { kind: "daysFromToday", days: 2 },
        reply: "TOTALLY_MADE_UP",
    });
    const meta = (activity?.meta ?? {}) as { reply?: string };
    check(
        "W2-B: reply stored in meta + label in the note, unknown reply rejected",
        codeOf(ok) === "OK" &&
            meta.reply === reply.key &&
            activity?.note === `${reply.label} – vraj v piatok` &&
            codeOf(bogus) !== "OK",
        `meta=${meta.reply} note=${activity?.note} bogus=${codeOf(bogus)}`,
    );
};

// W2-C: „chcú objednať" čaká na manažéra, nie na klienta – krok ORDER + otvorená požiadavka.
tests.w2OrderStep = async () => {
    const work = await import("../../lib/commands/dealWork");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const r = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "WANTS_TO_ORDER",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        note: "stránka + admin systém",
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { nextActionKind: true, status: true } });
    const requests = await prisma.dealRequest.findMany({ where: { leadId: id, status: "OPEN" }, select: { kind: true, note: true } });
    check(
        "W2-C: wants-to-order sets the ORDER step and opens an ORDER request",
        codeOf(r) === "OK" &&
            lead.nextActionKind === "ORDER" &&
            lead.status === "ACTIVE" &&
            requests.length === 1 &&
            requests[0].kind === "ORDER",
        `kind=${lead.nextActionKind} requests=${requests.map((x) => x.kind).join(",")}`,
    );
};

// W2-D: počítadlo „N. pokus" (SQL v zozname aj v detaile) ráta po sebe idúce nezdvihnutia a po dovolaní sa vynuluje.
tests.w2NoAnswerStreak = async () => {
    const work = await import("../../lib/commands/dealWork");
    const { getDealList, getDealDetail } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const scope = dealScope(rep);
    const mine = { userId: rep.id } as const;
    const streakOf = async () => {
        const { rows } = await getDealList({ scope, owner: mine, view: "all", take: 500 });
        return rows.find((r) => r.id === id)?.noAnswerStreak ?? -1;
    };

    for (let i = 0; i < 3; i++) {
        await work.logFollowUpAs(rep, { leadId: id, outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    }
    const afterThree = await streakOf();
    const detail = await getDealDetail(id, scope, dealCapabilities(rep));
    await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "POSITIVE",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        nextKind: "WAITING_FOR_CLIENT",
    });
    const afterAnswered = await streakOf();
    check(
        "W2-D: no-answer streak counts consecutive misses and resets after a real contact",
        afterThree === 3 && detail?.noAnswerStreak === 3 && afterAnswered === 0,
        `list=${afterThree} detail=${detail?.noAnswerStreak} afterAnswered=${afterAnswered}`,
    );
};

// W2-E: ďalší krok sa riadi zdieľaným zoznamom – „Poslať návrh" je rozpracované a bez dátumu začína dnes,
// „Zavolať" bez dátumu neprejde.
tests.w2NextStepRules = async () => {
    const work = await import("../../lib/commands/dealWork");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const design = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "POSITIVE",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        nextKind: "SEND_DESIGN",
    });
    const afterDesign = await prisma.lead.findUniqueOrThrow({
        where: { id },
        select: { nextActionKind: true, nextActionMode: true, nextActionAt: true },
    });
    const callWithoutDate = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "POSITIVE",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        nextKind: "CALL",
    });
    check(
        "W2-E: shared step rules – design is in progress from today, call without a date is refused",
        codeOf(design) === "OK" &&
            afterDesign.nextActionKind === "SEND_DESIGN" &&
            afterDesign.nextActionMode === "IN_PROGRESS" &&
            afterDesign.nextActionAt !== null &&
            codeOf(callWithoutDate) !== "OK",
        `kind=${afterDesign.nextActionKind} mode=${afterDesign.nextActionMode} call=${codeOf(callWithoutDate)}`,
    );
};

// ── Round 2, wave 3a: čo klient dostal (§2c) ─────────────────────────────────────

async function w3a() {
    const offers = await import("../../lib/commands/offers");
    const work = await import("../../lib/commands/dealWork");
    const pipeline = await import("../../lib/commands/pipeline");
    const bt = await import("../../lib/domain/businessTime");
    const today = bt.businessDate(new Date());
    const daysAgo = (n: number) => bt.addBusinessCalendarDays(today, -n);
    const record = async (u: AccessUser, leadId: string, extra: Partial<Parameters<typeof offers.recordOfferSentAs>[1]>) =>
        offers.recordOfferSentAs(u, {
            leadId,
            expectedRevision: await leadRev(leadId),
            idempotencyKey: key(),
            contents: ["ABOUT_US"],
            sentOn: today,
            followUp: false,
            ...extra,
        });
    const lead = (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });
    return { offers, work, pipeline, bt, today, daysAgo, record, lead };
}

// W3a-A: záznam odoslania nastaví súhrn + krok o 7 dní, zvýši revíziu raz; ten istý kľúč (aj súbežne) = jeden záznam.
tests.w3aRecordIdempotent = async () => {
    const { offers, bt, today, lead } = await w3a();
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep, "WANTS_EMAIL");
    const before = await leadRev(id);
    const k = key();
    const input = { leadId: id, expectedRevision: before, idempotencyKey: k, contents: ["ABOUT_US", "PRICELIST"] as ("ABOUT_US" | "PRICELIST")[], sentOn: today, followUp: true };
    const [r1, r2] = await Promise.all([offers.recordOfferSentAs(rep, input), offers.recordOfferSentAs(rep, input)]);
    const r3 = await offers.recordOfferSentAs(rep, input);
    const l = await lead(id);
    const rows = await prisma.activity.count({ where: { leadId: id, type: "OFFER_SENT" } });
    const expected = bt.addBusinessCalendarDays(today, 7);
    check(
        "W3a-A: record sets summary + CALL +7, one bump; same key twice in parallel and again = one record",
        codeOf(r1) === "OK" && codeOf(r2) === "OK" && codeOf(r3) === "OK" && rows === 1 &&
            l.offerAboutUsAt !== null && l.offerPricelistAt !== null && l.offerPriceAt === null &&
            l.nextActionKind === "CALL" && l.nextActionAt !== null && bt.businessDate(l.nextActionAt) === expected &&
            l.revision === before + 1,
        `r=${codeOf(r1)},${codeOf(r2)},${codeOf(r3)} rows=${rows} rev+${l.revision - before} next=${l.nextActionKind}`,
    );
    const other = await offers.recordOfferSentAs(rep, { ...input, contents: ["PRICELIST"] });
    check("W3a-A: a reused key with different content is not a second write", codeOf(other) === "OK" && (await prisma.activity.count({ where: { leadId: id, type: "OFFER_SENT" } })) === 1, codeOf(other));

    // Dve rôzne kľúče s tou istou revíziou súčasne → presne jeden prejde, druhý STALE.
    const rev = await leadRev(id);
    const both = await Promise.all([0, 1].map(() => offers.recordOfferSentAs(rep, { ...input, idempotencyKey: key(), expectedRevision: rev })));
    const ok = both.filter((b) => codeOf(b) === "OK").length;
    check("W3a-A: two different submits on the same revision → exactly one wins", ok === 1 && both.some((b) => codeOf(b) === "ERR:STALE"), JSON.stringify(tally(both)));
};

// W3a-B: posielaná cena je snímka – neskoršia zmena ceny obchodu nezmení, čo klient dostal; bez ceny sa cena poslať nedá.
tests.w3aPriceSnapshot = async () => {
    const { record, pipeline, lead } = await w3a();
    const { getDealDetail } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const noPrice = await record(rep, id, { contents: ["PRICE"] });
    await pipeline.saveQuoteAs(manager, id, { price: 1000, priceNote: "Web 550 · admin 450" });
    const sent = await record(rep, id, { contents: ["PRICE"] });
    await pipeline.saveQuoteAs(manager, id, { price: 1200, priceNote: null });
    const detail = await getDealDetail(id, dealScope(rep), dealCapabilities(rep));
    const l = await lead(id);
    check(
        "W3a-B: price is snapshotted at send time; no price → refused",
        codeOf(noPrice) !== "OK" && codeOf(sent) === "OK" && detail?.offers.lastPrice?.amount === "1000" &&
            detail.offers.lastPrice.note === "Web 550 · admin 450" && l.offerPriceAt !== null && Number(l.price) === 1200,
        `noPrice=${codeOf(noPrice)} last=${JSON.stringify(detail?.offers.lastPrice)} price=${l.price}`,
    );
};

// W3a-C: oprava nezávisí od poradia; návrh = prvé platné odoslanie alebo starý údaj.
tests.w3aCorrectionOrder = async () => {
    const { offers, record, pipeline, bt, daysAgo, lead } = await w3a();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");

    const finals: string[] = [];
    for (const order of [
        [0, 1],
        [1, 0],
    ]) {
        const id = await makeDeal(rep);
        await pipeline.saveQuoteAs(manager, id, { price: 1000, priceNote: null });
        await record(rep, id, { contents: ["PRICE"], sentOn: daysAgo(3) });
        await pipeline.saveQuoteAs(manager, id, { price: 1100, priceNote: null });
        await record(rep, id, { contents: ["PRICE"] });
        const rows = await prisma.activity.findMany({ where: { leadId: id, type: "OFFER_SENT" }, orderBy: { createdAt: "asc" } });
        const afterFirst = await offers.correctRecordAs(rep, rows[order[0]].id, "omyl v teste");
        const mid = await lead(id);
        await offers.correctRecordAs(manager, rows[order[1]].id, "omyl v teste");
        const end = await lead(id);
        finals.push(`${codeOf(afterFirst)}|mid=${mid.offerPriceAt ? "set" : "null"}|end=${end.offerPriceAt ? "set" : "null"}|disclosed=${end.priceDisclosed}`);
    }
    check(
        "W3a-C: correcting two price sends in either order ends with no price known (legacy priceDisclosed untouched)",
        finals.every((f) => f === "OK|mid=set|end=null|disclosed=false"),
        finals.join(" ; "),
    );

    // Návrh poslaný 5 a 1 deň dozadu → oprava skoršieho = sentAt je ten neskorší.
    const id = await makeDeal(rep);
    const { createDesignAs } = await import("../../lib/commands/tracking");
    await createDesignAs(manager, { leadId: id, label: "smrek1" });
    const design = await prisma.design.findFirstOrThrow({ where: { leadId: id } });
    await record(rep, id, { contents: ["DESIGN"], designIds: [design.id], sentOn: daysAgo(5) });
    await record(rep, id, { contents: ["DESIGN"], designIds: [design.id], sentOn: daysAgo(1) });
    const first = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT" }, orderBy: { createdAt: "asc" } });
    const beforeFix = (await prisma.design.findUniqueOrThrow({ where: { id: design.id } })).sentAt;
    await offers.correctRecordAs(rep, first.id, "omyl v teste");
    const afterFix = (await prisma.design.findUniqueOrThrow({ where: { id: design.id } })).sentAt;
    check(
        "W3a-C: design sent date = first valid send; correcting the earlier one moves it to the later one",
        beforeFix !== null && bt.businessDate(beforeFix) === daysAgo(5) && afterFix !== null && bt.businessDate(afterFix) === daysAgo(1),
        `before=${beforeFix && bt.businessDate(beforeFix)} after=${afterFix && bt.businessDate(afterFix)}`,
    );

    // Starý návrh (legacySentAt) → nové odoslanie ho neposunie a oprava nového ho nezmaže.
    const id2 = await makeDeal(rep);
    await createDesignAs(manager, { leadId: id2, label: "stary" });
    const old = await prisma.design.findFirstOrThrow({ where: { leadId: id2 } });
    const legacyAt = bt.businessDayStart(daysAgo(20));
    await prisma.design.update({ where: { id: old.id }, data: { sentAt: legacyAt, legacySentAt: legacyAt } });
    await record(rep, id2, { contents: ["DESIGN"], designIds: [old.id] });
    const withNew = (await prisma.design.findUniqueOrThrow({ where: { id: old.id } })).sentAt;
    const newRow = await prisma.activity.findFirstOrThrow({ where: { leadId: id2, type: "OFFER_SENT" } });
    await offers.correctRecordAs(rep, newRow.id, "omyl v teste");
    const afterCorrect = (await prisma.design.findUniqueOrThrow({ where: { id: old.id } })).sentAt;
    check(
        "W3a-C: legacy design date survives a new send and its correction",
        withNew?.getTime() === legacyAt.getTime() && afterCorrect?.getTime() === legacyAt.getTime(),
        `withNew=${withNew?.toISOString()} after=${afterCorrect?.toISOString()}`,
    );
};

// W3a-D: starý obchod – staré príznaky znamenajú „?", spätný záznam bez vedľajších účinkov, potvrdenie len manažér.
tests.w3aLegacy = async () => {
    const { offers, record, daysAgo, lead } = await w3a();
    const { clientKnowledge } = await import("../../lib/domain/offers");
    const { getDealDetail, getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const work = await import("../../lib/commands/dealWork");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await prisma.lead.update({ where: { id }, data: { hadLegacySends: true, priceDisclosed: true, quoteSentAt: new Date() } });
    await work.createDealRequestAs(rep, id, "PRICE", "neviem cenu");
    const nextBefore = (await lead(id)).nextActionKind;

    const detail0 = await getDealDetail(id, dealScope(manager), dealCapabilities(manager));
    const k0 = clientKnowledge(detail0!.offers);
    const repHistorical = await record(rep, id, { historical: true, contents: ["PRICE"], price: { amount: 700, note: null }, sentOn: daysAgo(30) });
    const hist = await record(manager, id, { historical: true, contents: ["ABOUT_US", "PRICE"], price: { amount: 700, note: null }, sentOn: daysAgo(30) });
    const l = await lead(id);
    const openPrice = await prisma.dealRequest.count({ where: { leadId: id, kind: "PRICE", status: "OPEN" } });
    const { rows } = await getDealList({ scope: dealScope(manager), owner: { userId: rep.id }, view: "all", take: 500 });
    const row = rows.find((r) => r.id === id);
    const detail1 = await getDealDetail(id, dealScope(manager), dealCapabilities(manager));
    const k1 = clientKnowledge(detail1!.offers);
    check(
        "W3a-D: legacy flags mean '?', historical entry is manager-only and touches no step, ticket or 'Naposledy'",
        k0.PRICE.state === "unknown" && k0.PRICELIST.state === "unknown" && codeOf(repHistorical) !== "OK" && codeOf(hist) === "OK" &&
            l.offerPriceAt !== null && l.nextActionKind === nextBefore && openPrice === 1 && row?.lastActivity?.type !== "OFFER_SENT" &&
            detail1?.lastTouch?.type !== "OFFER_SENT" && k1.PRICE.state === "yes" && k1.PRICELIST.state === "unknown" && Number(l.price ?? 0) !== 700,
        `k0=${k0.PRICE.state}/${k0.PRICELIST.state} rep=${codeOf(repHistorical)} hist=${codeOf(hist)} step=${l.nextActionKind}/${nextBefore} open=${openPrice} last=${row?.lastActivity?.type} k1=${k1.PRICE.state}/${k1.PRICELIST.state}`,
    );

    const repConfirm = await offers.confirmLegacyReviewedAs(rep, id);
    const confirm = await offers.confirmLegacyReviewedAs(manager, id);
    const detail2 = await getDealDetail(id, dealScope(manager), dealCapabilities(manager));
    const k2 = clientKnowledge(detail2!.offers);
    const afterReview = await record(manager, id, { historical: true, contents: ["PRICELIST"], sentOn: daysAgo(10) });
    check(
        "W3a-D: only the manager confirms review; afterwards empty = 'no' and historical entries are closed",
        codeOf(repConfirm) !== "OK" && codeOf(confirm) === "OK" && k2.PRICELIST.state === "no" && k2.ABOUT_US.state === "yes" && codeOf(afterReview) !== "OK",
        `rep=${codeOf(repConfirm)} mgr=${codeOf(confirm)} k2=${k2.PRICELIST.state}/${k2.ABOUT_US.state} after=${codeOf(afterReview)}`,
    );
};

// W3a-E: typ kontaktu sa ukladá pravdivo – bez kontaktu nie je hovor, odpoveď nie je hovor a resetuje „N. pokus", SMS nič nemení.
tests.w3aContactTypes = async () => {
    const { work } = await w3a();
    const { getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const countType = (type: "CALL" | "CLIENT_REPLIED" | "SMS_SENT") => prisma.activity.count({ where: { leadId: id, type, source: "CLIENTS" } });
    const base = { leadId: id, outcome: "POSITIVE" as const, nextKind: "WAITING_FOR_CLIENT" as const };

    const k = key();
    const none = await work.logFollowUpAs(rep, { ...base, contact: "NONE", expectedRevision: await leadRev(id), idempotencyKey: k });
    const noneAgain = await work.logFollowUpAs(rep, { ...base, contact: "NONE", expectedRevision: (await leadRev(id)) - 1, idempotencyKey: k });
    const callsAfterNone = await countType("CALL");
    const planning = await prisma.activity.count({ where: { leadId: id, idempotencyKey: k } });

    for (let i = 0; i < 2; i++) {
        await work.logFollowUpAs(rep, { leadId: id, outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    }
    const streakOf = async () => (await getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id)?.noAnswerStreak;
    const streak2 = await streakOf();
    const replied = await work.logFollowUpAs(rep, { ...base, contact: "REPLIED", reply: "WILL_CONTACT_US", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const streak0 = await streakOf();
    const sms = await work.logFollowUpAs(rep, { ...base, contact: "SMS", note: "web + kontakt", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const smsRow = await prisma.activity.findFirst({ where: { leadId: id, type: "SMS_SENT" }, select: { note: true, outcome: true } });
    const smsLead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { nextActionNote: true } });
    const badSms = await work.logFollowUpAs(rep, { leadId: id, contact: "SMS", outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const badNone = await work.logFollowUpAs(rep, { leadId: id, contact: "NONE", outcome: "WANTS_QUOTE", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const badReply = await work.logFollowUpAs(rep, { leadId: id, contact: "REPLIED", outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    check(
        "W3a-E: 'bez kontaktu' writes no call (replay OK), a reply is CLIENT_REPLIED and resets the streak, SMS is SMS_SENT without outcome",
        codeOf(none) === "OK" && codeOf(noneAgain) === "OK" && callsAfterNone === 0 && planning === 1 &&
            streak2 === 2 && codeOf(replied) === "OK" && streak0 === 0 && (await countType("CLIENT_REPLIED")) === 1 &&
            codeOf(sms) === "OK" && smsRow?.note === "web + kontakt" && smsRow.outcome === null && smsLead.nextActionNote === null &&
            codeOf(badSms) !== "OK" && codeOf(badNone) !== "OK" && codeOf(badReply) !== "OK",
        `none=${codeOf(none)}/${codeOf(noneAgain)} calls=${callsAfterNone} plan=${planning} streak=${streak2}→${streak0} sms=${JSON.stringify(smsRow)} bad=${codeOf(badSms)},${codeOf(badNone)},${codeOf(badReply)}`,
    );
};

// W3a-F: cena povedaná v hovore = OFFER_SENT (telefón) v tej istej transakcii; „Naposledy" ostáva hovor.
tests.w3aPhonePrice = async () => {
    const { work, lead } = await w3a();
    const { getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const before = await leadRev(id);
    const r = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "POSITIVE",
        nextKind: "SEND_QUOTE",
        phonePrice: { amount: 900 },
        expectedRevision: before,
        idempotencyKey: key(),
    });
    const l = await lead(id);
    const offer = await prisma.activity.findFirst({ where: { leadId: id, type: "OFFER_SENT" }, select: { meta: true } });
    const call = await prisma.activity.findFirst({ where: { leadId: id, type: "CALL", source: "CLIENTS" }, select: { id: true } });
    const meta = offer?.meta as { channel?: string; callActivityId?: string; price?: { amount?: string } } | null;
    const row = (await getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((x) => x.id === id);
    const onNoAnswer = await work.logFollowUpAs(rep, { leadId: id, outcome: "NO_ANSWER", phonePrice: { amount: 1 }, expectedRevision: await leadRev(id), idempotencyKey: key() });
    check(
        "W3a-F: phone price saves the price + a PHONE record linked to the call, one bump; 'Naposledy' stays the call; refused on no-answer",
        codeOf(r) === "OK" && Number(l.price) === 900 && l.offerPriceAt !== null && l.revision === before + 1 &&
            meta?.channel === "PHONE" && meta.callActivityId === call?.id && meta.price?.amount === "900" &&
            row?.lastActivity?.type === "CALL" && codeOf(onNoAnswer) !== "OK",
        `r=${codeOf(r)} price=${l.price} rev+${l.revision - before} meta=${JSON.stringify(meta)} last=${row?.lastActivity?.type} na=${codeOf(onNoAnswer)}`,
    );
};

// W3a-G: kto smie opraviť a čo sa dá opraviť; prečiarknutý záznam zmizne z „Naposledy".
tests.w3aCorrectionRules = async () => {
    const { offers, work } = await w3a();
    const { getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const other = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await work.logFollowUpAs(rep, { leadId: id, contact: "SMS", outcome: "POSITIVE", nextKind: "WAITING_FOR_CLIENT", note: "sms", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const sms = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "SMS_SENT" } });
    const call = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "CALL" } });
    const lastBefore = (await getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id)?.lastActivity?.type;
    const foreign = await offers.correctRecordAs(other, sms.id, "nie môj obchod");
    const short = await offers.correctRecordAs(rep, sms.id, "x");
    const onCall = await offers.correctRecordAs(manager, call.id, "hovor sa neopravuje");
    const byManager = await offers.correctRecordAs(manager, sms.id, "omyl v teste");
    const twice = await offers.correctRecordAs(rep, sms.id, "omyl v teste");
    const lastAfter = (await getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id)?.lastActivity?.type;
    const stored = await prisma.activity.findUniqueOrThrow({ where: { id: sms.id }, select: { revertedAt: true, revertedById: true, meta: true } });
    check(
        "W3a-G: foreign rep NOT_FOUND, short reason / a CALL refused, manager corrects, twice = STALE, 'Naposledy' skips it",
        codeOf(foreign) === "ERR:NOT_FOUND" && codeOf(short) !== "OK" && codeOf(onCall) === "ERR:FORBIDDEN" && codeOf(byManager) === "OK" &&
            codeOf(twice) === "ERR:STALE" && lastBefore === "SMS_SENT" && lastAfter !== "SMS_SENT" &&
            stored.revertedById === manager.id && JSON.stringify(stored.meta).includes("omyl v teste"),
        `foreign=${codeOf(foreign)} short=${codeOf(short)} call=${codeOf(onCall)} mgr=${codeOf(byManager)} twice=${codeOf(twice)} last=${lastBefore}→${lastAfter}`,
    );
};

// W3a-H: poradie odoslaní – spätný záznam v ten istý deň je starší než bežný; posledná cena = kotva.
tests.w3aOrdering = async () => {
    const { summarizeOffers } = await import("../../lib/domain/offers");
    const mk = (id: string, sentOn: string, historical: boolean, createdAt: string, amount: string) => ({
        id,
        createdAt: new Date(createdAt),
        revertedAt: null,
        meta: { channel: "EMAIL" as const, contents: ["PRICE" as const], price: { amount, note: null }, sentOn, historical },
    });
    const normalFirst = summarizeOffers([
        mk("a", "2026-09-10", false, "2026-09-10T08:00:00Z", "1100"),
        mk("b", "2026-09-10", true, "2026-09-18T08:00:00Z", "900"),
    ]);
    const later = summarizeOffers([mk("a", "2026-09-10", false, "2026-09-10T08:00:00Z", "1100"), mk("c", "2026-09-12", false, "2026-09-12T08:00:00Z", "1300")]);
    check(
        "W3a-H: a backdated entry never overtakes a normal one on the same day; the latest price is the anchor",
        normalFirst.lastPrice?.amount === "1100" && later.lastPrice?.amount === "1300",
        `sameDay=${normalFirst.lastPrice?.amount} later=${later.lastPrice?.amount}`,
    );
};

async function main() {
    passwordHash = await bcrypt.hash(`cc-${RUN}-unused`, 4);
    console.log(`endpoint=${endpoint} run=${RUN}`);
    try {
        for (const [name, fn] of Object.entries(tests)) {
            if (only && !only.includes(name)) continue;
            console.log(`\n── ${name}`);
            try {
                await fn();
            } catch (error) {
                check(`${name}: threw`, false, error instanceof Error ? error.stack ?? error.message : String(error));
            }
        }
    } finally {
        await cleanup().catch((e) => console.error("cleanup failed:", e));
        await prisma.$disconnect();
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
}

main();
