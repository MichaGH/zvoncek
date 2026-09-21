// Funkčné + súbežné kontroly (plán §13 fáza 9). LEN dev/test branch – nikdy produkcia.
// Vytvára vlastné fixture (používatelia `cc_*`, kontakty „CC-TEST") a na konci ich zmaže.
//
//   npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint ep-xxxx [--only claims,stale] [--iterations 100]
import "dotenv/config";
import bcrypt from "bcrypt";
import type { RequestContent, Role } from "../../app/generated/prisma/enums";
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
        await prisma.leadRequest.deleteMany({ where: { leadId: { in: createdLeads } } });
        await prisma.activity.deleteMany({ where: { leadId: { in: createdLeads } } });
        await prisma.dealOwnership.deleteMany({ where: { leadId: { in: createdLeads } } });
        await prisma.dealTask.deleteMany({ where: { leadId: { in: createdLeads } } });
        await prisma.lead.deleteMany({ where: { id: { in: createdLeads } } });
    }
    if (createdTeams.length) {
        await prisma.user.updateMany({ where: { teamId: { in: createdTeams } }, data: { teamId: null } });
        await prisma.team.deleteMany({ where: { id: { in: createdTeams } } });
    }
    if (createdUsers.length) {
        await prisma.activity.deleteMany({ where: { userId: { in: createdUsers } } });
        await prisma.dealOwnership.deleteMany({
            where: { OR: [{ byUserId: { in: createdUsers } }, { fromUserId: { in: createdUsers } }, { toUserId: { in: createdUsers } }] },
        });
        await prisma.dealTask.deleteMany({
            where: { OR: [{ requestedById: { in: createdUsers } }, { assigneeId: { in: createdUsers } }, { closedById: { in: createdUsers } }] },
        });
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

// Handoff: TELESALES v tíme s vedúcim (deals.receive) → vedúci; bez tímu → nepriradené; SALES_REP → sám.
// Wave 3: „chcú návrh" nezakladá nič automaticky (D9); odovzdanie = jeden DealOwnership(HANDOFF).
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
    const tasks1 = await prisma.dealTask.count({ where: { leadId: l1 } });
    const own1 = await prisma.dealOwnership.findMany({ where: { leadId: l1 }, select: { reason: true, fromUserId: true, toUserId: true, byUserId: true } });
    check(
        "handoff: team member → team leader, marker = call createdAt, no automatic task, one HANDOFF ownership row",
        "recipient" in r1 && r1.recipient?.id === leader.id && d1.ownerId === leader.id && d1.handedOffById === inTeam.id &&
            d1.assignedCallerId === null && d1.status === "ACTIVE" && d1.pipelineEnteredAt?.getTime() === call1.createdAt.getTime() &&
            tasks1 === 0 && call1.leadRevision === d1.revision &&
            own1.length === 1 && own1[0].reason === "HANDOFF" && own1[0].fromUserId === null && own1[0].toUserId === leader.id && own1[0].byUserId === inTeam.id,
        JSON.stringify({ r1, ownerOk: d1.ownerId === leader.id, tasks1, own1, leadRevision: call1.leadRevision, revision: d1.revision }),
    );

    const l2 = await makeAssignedLead(alone.id);
    const r2 = await logCallAs(alone, { leadId: l2, outcome: "WANTS_QUOTE", expectedRevision: await leadRev(l2), idempotencyKey: key() });
    const d2 = await prisma.lead.findUniqueOrThrow({ where: { id: l2 }, select: { ownerId: true } });
    const own2 = await prisma.dealOwnership.count({ where: { leadId: l2 } });
    check("handoff: no team → unassigned (not blocked), no ownership row (owner did not change)", "recipient" in r2 && r2.recipient === null && d2.ownerId === null && own2 === 0, JSON.stringify({ r2, own2 }));

    const l3 = await makeAssignedLead(rep.id);
    const r3 = await logCallAs(rep, { leadId: l3, outcome: "WANTS_EMAIL", expectedRevision: await leadRev(l3), idempotencyKey: key() });
    const d3 = await prisma.lead.findUniqueOrThrow({ where: { id: l3 }, select: { ownerId: true } });
    check("handoff: SALES_REP → own deal", "recipient" in r3 && r3.recipient?.id === rep.id && d3.ownerId === rep.id, JSON.stringify(r3));

    // Vrátenie handoffu hneď po hovore → späť volajúcemu ako RETRY; história vlastníctva dostane REVERT.
    const act = await prisma.activity.findFirstOrThrow({ where: { leadId: l1, type: "CALL" }, select: { id: true } });
    const rv = await revertCallResultAs(inTeam, act.id, await leadRev(l1));
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l1 }, select: { status: true, pipelineEnteredAt: true, ownerId: true, assignedCallerId: true } });
    const revertRow = await prisma.dealOwnership.findFirst({ where: { leadId: l1, reason: "REVERT" }, select: { fromUserId: true, toUserId: true } });
    check(
        "handoff revert: back to caller as retry, REVERT ownership row",
        codeOf(rv) === "OK" && after.status === "CALLING" && after.pipelineEnteredAt === null && after.ownerId === null && after.assignedCallerId === inTeam.id &&
            revertRow?.fromUserId === leader.id && revertRow.toUserId === null,
        `${codeOf(rv)} ${JSON.stringify(after)} revert=${JSON.stringify(revertRow)}`,
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

// Životný cyklus obchodu bez automatických úloh (wave 3 nahradila požiadavky): „chcú návrh" nič nezakladá, cena
// odoslaná → hovor o 7 dní, WON zavrie, uzavretý obchod je pre obchodníka len na čítanie, manažér ho znovu otvorí.
tests.dealLifecycle = async () => {
    const pipeline = await import("../../lib/commands/pipeline");
    const work = await import("../../lib/commands/dealWork");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);

    const wd = await work.logFollowUpAs(rep, { leadId: id, outcome: "WANTS_DESIGN", expectedRevision: await leadRev(id), idempotencyKey: key(), note: "chcú modrú" });
    const tasks = await prisma.dealTask.count({ where: { leadId: id } });
    const afterWd = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { nextActionKind: true, nextActionMode: true } });
    check("lifecycle: WANTS_DESIGN sets 'Poslať návrh' and creates no task (D9)", codeOf(wd) === "OK" && tasks === 0 && afterWd.nextActionKind === "SEND_DESIGN", `${codeOf(wd)} tasks=${tasks} ${JSON.stringify(afterWd)}`);

    const saved = await work.saveDealQuoteAs(rep, id, { price: 790, priceNote: null });
    const before = await leadRev(id);
    const offers = await import("../../lib/commands/offers");
    const { businessDate, addBusinessCalendarDays } = await import("../../lib/domain/businessTime");
    const sent = await offers.recordOfferSentAs(rep, {
        leadId: id,
        expectedRevision: before,
        idempotencyKey: key(),
        contents: ["PRICE"],
        sentOn: businessDate(new Date()),
        followUp: true,
    });
    const afterLead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { nextActionKind: true, nextActionAt: true, nextActionHasTime: true, revision: true, ownerId: true } });
    const expected = addBusinessCalendarDays(businessDate(new Date()), 7);
    check(
        "lifecycle: price sent (OFFER_SENT) → CALL +7 business days (day-only), one revision bump",
        codeOf(saved) === "OK" && codeOf(sent) === "OK" && afterLead.nextActionKind === "CALL" && !afterLead.nextActionHasTime && afterLead.nextActionAt !== null &&
            businessDate(afterLead.nextActionAt) === expected && afterLead.revision === before + 1,
        JSON.stringify({ at: afterLead.nextActionAt && businessDate(afterLead.nextActionAt), expected, delta: afterLead.revision - before }),
    );

    await pipeline.saveQuoteAs(manager, id, { price: 990, priceNote: "zľava" });
    const owner = (await prisma.lead.findUniqueOrThrow({ where: { id }, select: { ownerId: true } })).ownerId;
    check("lifecycle: manager price keeps owner", owner === rep.id, `owner=${owner === rep.id ? "rep" : owner}`);

    const won = await pipeline.changeStatusAs(manager, id, { status: "WON", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const closed = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { status: true, closedAt: true, nextActionKind: true } });
    check("lifecycle: WON closes (closedAt set, step cleared)", codeOf(won) === "OK" && closed.status === "WON" && closed.closedAt !== null && closed.nextActionKind === null, JSON.stringify(closed));

    const fu = await work.logFollowUpAs(rep, { leadId: id, outcome: "NO_ANSWER", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const edit = await work.updateDealContactAs(rep, id, { note: "x" });
    const { askManagerAs } = await import("../../lib/commands/tasks");
    const ask = await askManagerAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), type: "HELP", contents: ["OTHER"], text: "otvor to", assigneeId: manager.id, step: { kind: "CALL" } });
    check(
        "closed deal: rep follow-up / edit / task all rejected (reopen is not a task – D13)",
        codeOf(fu) === "ERR:DEAL_CLOSED" && codeOf(edit) === "ERR:DEAL_CLOSED" && codeOf(ask) === "ERR:DEAL_CLOSED",
        `${codeOf(fu)} ${codeOf(edit)} ${codeOf(ask)}`,
    );
    const reopened = await pipeline.reopenDealAs(manager, id, { expectedRevision: await leadRev(id), idempotencyKey: key() });
    const openDeal = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { status: true, closedAt: true, ownerId: true, nextActionKind: true } });
    check("closed deal: manager reopens → ACTIVE, CALL today, owner kept", codeOf(reopened) === "OK" && openDeal.status === "ACTIVE" && openDeal.closedAt === null && openDeal.ownerId === rep.id && openDeal.nextActionKind === "CALL", JSON.stringify(openDeal));

    const lost = await work.logFollowUpAs(rep, { leadId: id, outcome: "NOT_INTERESTED", expectedRevision: await leadRev(id), idempotencyKey: key(), lostReason: "drahé" });
    const lostLead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { status: true, closedAt: true, lostReason: true } });
    check("follow-up NOT_INTERESTED → LOST, closedAt, reason", codeOf(lost) === "OK" && lostLead.status === "LOST" && lostLead.closedAt !== null && lostLead.lostReason === "drahé", JSON.stringify(lostLead));

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
    const w = await pipeline.changeStatusAs(repA, id, { status: "WON", expectedRevision: await leadRev(id), idempotencyKey: key() });
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
            pipeline.transferDealsAs(manager, { operationId: key(), fromOwnerId: repA.id, toOwnerId: repB.id, statuses: ["ACTIVE", "SNOOZED"] }),
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
    const tasks = await import("../../lib/commands/tasks");
    const manager = await makeUser("MANAGER");
    const manager2 = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep, "WANTS_DESIGN");
    const openTaskId = async () => (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id }, orderBy: { createdAt: "desc" } })).id;
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
        ["askManager", async () => tasks.askManagerAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), type: "HELP", contents: ["PRICE"], text: "koľko?", assigneeId: manager.id, step: { kind: "SEND_QUOTE" } })],
        ["taskMessage", async () => tasks.taskMessageAs(rep, { taskId: await openTaskId(), expectedRevision: await leadRev(id), idempotencyKey: key(), text: "chce modrú" })],
        ["reassignTask", async () => tasks.reassignTaskAs(manager, { taskId: await openTaskId(), expectedRevision: await leadRev(id), idempotencyKey: key(), assigneeId: manager2.id })],
        ["logFollowUp fact-only", async () => work.logFollowUpAs(manager, { leadId: id, outcome: "POSITIVE", keepLockedStep: true, expectedRevision: await leadRev(id), idempotencyKey: key() })],
        ["resolveTaskParts", async () => tasks.resolveTaskPartsAs(manager2, { taskId: await openTaskId(), expectedRevision: await leadRev(id), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285, note: null } }] })],
        ["dismissResults", async () => tasks.dismissResultsAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), taskId: await openTaskId(), items: [{ kind: "PRICE" }], reason: "klient už nechce" })],
        ["logFollowUp", async () => work.logFollowUpAs(rep, { leadId: id, outcome: "WANTS_DESIGN", expectedRevision: await leadRev(id), idempotencyKey: key() })],
        ["askManager HANDOVER", async () => tasks.askManagerAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), type: "HANDOVER", text: "chce detaily", assigneeId: manager.id })],
        ["declineHandover", async () => tasks.declineHandoverAs(manager, { taskId: await openTaskId(), expectedRevision: await leadRev(id), idempotencyKey: key(), reason: "pokračuj ty" })],
        ["takeover", async () => tasks.takeoverAs(manager, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), step: { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 } } })],
        ["changeOwner", async () => pipeline.changeOwnerAs(manager, id, { ownerId: rep.id, expectedRevision: await leadRev(id), idempotencyKey: key() })],
        ["changeStatus SNOOZED", async () => pipeline.changeStatusAs(manager, id, { status: "SNOOZED", expectedRevision: await leadRev(id), idempotencyKey: key() })],
        ["markLost", async () => pipeline.markLostAs(manager, id, { reason: "test", expectedRevision: await leadRev(id), idempotencyKey: key() })],
        ["changeStatus closed→SNOOZED", async () => pipeline.changeStatusAs(manager, id, { status: "SNOOZED", expectedRevision: await leadRev(id), idempotencyKey: key() })],
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
        const tasks = await prisma.dealTask.count({ where: { leadId: id } });
        return JSON.stringify({ ...l, tasks });
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

    // Wave 3: „Pre mňa" = úlohy pridelené mne, najstaršia prvá, aj pri > 50 (fixture úloh priamo, poradie je vec dopytu).
    for (const id of inProgress) {
        await prisma.lead.update({ where: { id }, data: { ownerId: requester.id } });
        await prisma.dealTask.create({
            data: { leadId: id, type: "HELP", text: "x", requestedById: requester.id, assigneeId: owner.id, parts: { create: [{ kind: "OTHER", addedById: requester.id }] } },
        });
    }
    const oldest = await mk("oldesttask", { nextActionKind: null, nextActionAt: null, ownerId: requester.id });
    await prisma.dealTask.create({
        data: {
            leadId: oldest,
            type: "HELP",
            text: "x",
            requestedById: requester.id,
            assigneeId: owner.id,
            createdAt: new Date("2000-01-01T00:00:00Z"),
            parts: { create: [{ kind: "PRICE", addedById: requester.id }] },
        },
    });
    const req = await getDealList({ scope, owner: mine, view: "inbox", viewerId: owner.id, take: 50 });
    check("R-02: oldest task first in 'Pre mňa' with > 50 tasks", req.rows[0]?.id === oldest && req.hasMore, `first=${req.rows[0]?.id === oldest ? "oldest" : "other"} rows=${req.rows.length}`);
    const next = await getDealList({ scope, owner: mine, view: "inbox", viewerId: owner.id, take: 100 });
    const ids = next.rows.map((r) => r.id);
    const { nextActionSort } = await import("../../lib/overdue");
    const everything = await getDealList({ scope, owner: "all", take: 5000 });
    const ranks = everything.rows.map((r) => nextActionSort(r.nextActionMode, r.nextActionKind, r.nextActionAt, r.nextActionHasTime, undefined, r.locked));
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
    const moved = await pipeline.changeOwnerAs(manager, id, { ownerId: repB.id, expectedRevision: await leadRev(id), idempotencyKey: key() });
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
    // rozpracované, čaká na klienta (s termínom aj bez), spiace (zobudené / bez dátumu / budúce), so zamknutým krokom.
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
    const locked = await mk("locked", { nextActionKind: "SEND_QUOTE", nextActionAt: null });
    await prisma.dealTask.create({
        data: { leadId: locked, type: "HELP", text: "x", requestedById: rep.id, assigneeId: manager.id, parts: { create: [{ kind: "PRICE", addedById: rep.id }] } },
    });
    const doneTask = await mk("donetask", { nextActionKind: "SEND_QUOTE", nextActionAt: day(-1) });
    await prisma.dealTask.create({
        data: {
            leadId: doneTask,
            type: "HELP",
            text: "x",
            status: "DONE",
            requestedById: rep.id,
            assigneeId: manager.id,
            parts: { create: [{ kind: "PRICE", status: "DELIVERED", addedById: rep.id }] },
        },
    });

    const scope = dealScope(manager);
    const sqlToday = await getDealList({ scope, owner: "all", view: "today", take: 5000 });
    const counts = await getDealCounts({ scope, owner: "all", viewerId: manager.id });
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
            tasks: { select: { status: true } },
        },
    });
    const { isStepLocked } = await import("../../lib/domain/tasks");
    const expected = new Set(
        open.filter((l) => clientSection({ ...l, stepLocked: isStepLocked(l.tasks) }, now).section === "TODAY").map((l) => l.id),
    );
    const got = new Set(sqlToday.rows.map((r) => r.id));
    const missing = [...expected].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !expected.has(id));
    check(
        "W1-C: Na dnes SQL matches clientSection() over every open deal (locked deal excluded, closed task not)",
        missing.length === 0 && extra.length === 0 && counts.today === expected.size && !got.has(locked) && got.has(doneTask),
        `open=${open.length} expected=${expected.size} got=${got.size} missing=${missing.length} extra=${extra.length} count=${counts.today}`,
    );
};

// R-06: titulok „Čaká na mňa" ukazuje presný počet aj pri > 50 otvorených úlohách (wave 3: úlohy pridelené MNE).
tests.r06TaskCount = async () => {
    const { getManagerToday } = await import("../../lib/queries/today/manager");
    const manager = await makeUser("MANAGER");
    const other = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
        leadSeq++;
        const l = await prisma.lead.create({
            data: { companyName: `CC-TEST ${RUN} task ${i}`, phone: `+000 ${RUN} q${i}`, status: "ACTIVE", pipelineEnteredAt: new Date(), ownerId: rep.id },
            select: { id: true },
        });
        createdLeads.push(l.id);
        ids.push(l.id);
    }
    // 51 pre manažéra, 1 pre iného manažéra (nesmie sa započítať)
    for (const [i, leadId] of ids.entries()) {
        await prisma.dealTask.create({
            data: {
                leadId,
                type: "HELP",
                text: "x",
                requestedById: rep.id,
                assigneeId: i === 51 ? other.id : manager.id,
                parts: { create: [{ kind: "OTHER", addedById: rep.id }] },
            },
        });
    }
    const today = await getManagerToday(manager);
    check("R-06: task count exact beyond 50 (only mine), preview bounded", today.taskCount === 51 && today.tasks.length <= 10, `count=${today.taskCount} preview=${today.tasks.length}`);
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

// W2-C (wave 3, D15): „chcú objednať" je obyčajná odpoveď – krok si vyberá obchodník, nič sa nezakladá, obchod ostáva.
tests.w2OrderReply = async () => {
    const work = await import("../../lib/commands/dealWork");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const noStep = await work.logFollowUpAs(rep, { leadId: id, outcome: "WANTS_TO_ORDER", expectedRevision: await leadRev(id), idempotencyKey: key(), note: "stránka + admin" });
    const r = await work.logFollowUpAs(rep, {
        leadId: id,
        outcome: "WANTS_TO_ORDER",
        reply: "WANTS_TO_ORDER",
        nextKind: "CALL",
        schedule: { kind: "daysFromToday", days: 1 },
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        note: "stránka + admin systém",
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { nextActionKind: true, status: true, ownerId: true } });
    const tasks = await prisma.dealTask.count({ where: { leadId: id } });
    const call = await prisma.activity.findFirst({ where: { leadId: id, type: "CALL", outcome: "WANTS_TO_ORDER" } });
    check(
        "W2-C: wants-to-order is an ordinary reply – needs a chosen step, records the call, creates no task",
        codeOf(noStep) !== "OK" && codeOf(r) === "OK" && lead.nextActionKind === "CALL" && lead.status === "ACTIVE" && lead.ownerId === rep.id && tasks === 0 && call !== null,
        `noStep=${codeOf(noStep)} r=${codeOf(r)} kind=${lead.nextActionKind} tasks=${tasks}`,
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
    check("W3a-A: a reused key with different content is a conflict, not a second write", codeOf(other) === "ERR:IDEMPOTENCY_CONFLICT" && (await prisma.activity.count({ where: { leadId: id, type: "OFFER_SENT" } })) === 1, codeOf(other));

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
        finals.push(`${codeOf(afterFirst)}|mid=${mid.offerPriceAt ? "set" : "null"}|end=${end.offerPriceAt ? "set" : "null"}`);
    }
    check(
        "W3a-C: correcting two price sends in either order ends with no price known",
        finals.every((f) => f === "OK|mid=set|end=null"),
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
};

// W3a-D: spätný záznam (odoslanie mimo aplikácie s pôvodným dátumom) – len manažér, bez zmeny kroku, úlohy a „Naposledy".
tests.w3aHistorical = async () => {
    const { record, daysAgo, lead } = await w3a();
    const { clientKnowledge } = await import("../../lib/domain/offers");
    const { getDealDetail, getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const { askManagerAs } = await import("../../lib/commands/tasks");
    await askManagerAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), type: "HELP", contents: ["PRICE"], text: "neviem cenu", assigneeId: manager.id, step: { kind: "SEND_QUOTE" } });
    const nextBefore = (await lead(id)).nextActionKind;

    const repHistorical = await record(rep, id, { historical: true, contents: ["PRICE"], price: { amount: 700, note: null }, sentOn: daysAgo(30) });
    const hist = await record(manager, id, { historical: true, contents: ["ABOUT_US", "PRICE"], price: { amount: 700, note: null }, sentOn: daysAgo(30) });
    const l = await lead(id);
    const openPrice = await prisma.dealTask.count({ where: { leadId: id, status: "OPEN" } });
    const { rows } = await getDealList({ scope: dealScope(manager), owner: { userId: rep.id }, view: "all", take: 500 });
    const row = rows.find((r) => r.id === id);
    const detail = await getDealDetail(id, dealScope(manager), dealCapabilities(manager));
    const k = clientKnowledge(detail!.offers);
    check(
        "W3a-D: historical entry is manager-only and touches no step, task or 'Naposledy'; empty content means 'no'",
        codeOf(repHistorical) !== "OK" && codeOf(hist) === "OK" && l.offerPriceAt !== null && l.nextActionKind === nextBefore &&
            openPrice === 1 && row?.lastActivity?.type !== "OFFER_SENT" && detail?.lastTouch?.type !== "OFFER_SENT" &&
            k.PRICE.state === "yes" && k.PRICELIST.state === "no" && Number(l.price ?? 0) !== 700,
        `rep=${codeOf(repHistorical)} hist=${codeOf(hist)} step=${l.nextActionKind}/${nextBefore} open=${openPrice} last=${row?.lastActivity?.type} k=${k.PRICE.state}/${k.PRICELIST.state}`,
    );
};

// V1 → V2 prevod: prevedené odoslanie (pôvodný čas, historical: false) sa správa ako každé iné – je „Klient dostal",
// „Odoslané" aj „Naposledy"; oprava zachová jeho neviditeľnú provenienciu.
tests.w3aMigratedSend = async () => {
    const offers = await import("../../lib/commands/offers");
    const { recomputeOffers } = await import("../../lib/domain/offerMutations");
    const { offerNote, parseOfferMeta } = await import("../../lib/domain/offers");
    const { getDealDetail, getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const bt = await import("../../lib/domain/businessTime");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const at = new Date(Date.now() - 20 * 86_400_000);
    const meta = {
        channel: "EMAIL" as const,
        contents: ["ABOUT_US" as const, "PRICE" as const],
        price: { amount: "499", note: null },
        sentOn: bt.businessDate(at),
        historical: false,
        migrated: true,
        migration: { key: `v2mig:offer:${id}:${bt.businessDate(at)}`, rule: "D-003r2", sources: ["gone1", "gone2"], originalAt: at.toISOString(), amountSource: "QUOTE_NOTE" as const, migratedAt: new Date().toISOString() },
    };
    const migrated = await prisma.activity.create({ data: { leadId: id, userId: manager.id, type: "OFFER_SENT", category: "BUSINESS", source: "PIPELINE", note: offerNote(meta), meta, createdAt: at } });
    await prisma.$transaction((tx) => recomputeOffers(tx, id));
    const detail = await getDealDetail(id, dealScope(manager), dealCapabilities(manager));
    const row = (await getDealList({ scope: dealScope(manager), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id);
    const shown = detail!.activities.find((a) => a.id === migrated.id);
    check(
        "MIG-1: a migrated send behaves like any other send – received, 'Odoslané', no 'doplnené spätne' badge",
        shown?.offer?.historical === false && detail!.offers.lastPrice?.amount === "499" && detail!.lastOffer !== null &&
            row?.lastOffer !== null && row?.gotPrice === true,
        `historical=${shown?.offer?.historical} price=${detail!.offers.lastPrice?.amount} lastOffer=${detail!.lastOffer?.text}/${row?.lastOffer?.text}`,
    );
    const fix = await offers.correctRecordAs(manager, migrated.id, "test opravy prevodu");
    const after = parseOfferMeta((await prisma.activity.findUniqueOrThrow({ where: { id: migrated.id } })).meta);
    const l = await prisma.lead.findUniqueOrThrow({ where: { id } });
    check(
        "MIG-2: correcting a migrated send keeps its provenance and clears the price summary",
        codeOf(fix) === "OK" && after?.migration?.sources.length === 2 && after?.migrated === true && l.offerPriceAt === null,
        `fix=${codeOf(fix)} sources=${after?.migration?.sources.length} priceAt=${l.offerPriceAt?.toISOString()}`,
    );
};

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

// ── Round 2, wave 3b: detail rework (§2d) ────────────────────────────────────────

// W3b-A: „Zmeniť krok" = bez kontaktu, len plán – stav obchodu sa nemení (spiaci ostane spiaci), žiadny hovor.
tests.w3bReplanKeepsStatus = async () => {
    const work = await import("../../lib/commands/dealWork");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await work.logFollowUpAs(rep, { leadId: id, outcome: "SNOOZE", schedule: { kind: "monthsFromToday", months: 2 }, expectedRevision: await leadRev(id), idempotencyKey: key() });
    const calls = await prisma.activity.count({ where: { leadId: id, type: "CALL" } });
    const r = await work.logFollowUpAs(rep, {
        leadId: id,
        contact: "NONE",
        outcome: "POSITIVE",
        nextKind: "CALL",
        schedule: { kind: "daysFromToday", days: 30 },
        stepNote: "presunuté",
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
    });
    const l = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { status: true, nextActionKind: true, nextActionNote: true } });
    const callsAfter = await prisma.activity.count({ where: { leadId: id, type: "CALL" } });
    check(
        "W3b-A: replanning a snoozed deal keeps it SNOOZED, writes no call, updates the step",
        codeOf(r) === "OK" && l.status === "SNOOZED" && l.nextActionKind === "CALL" && l.nextActionNote === "presunuté" && callsAfter === calls,
        `r=${codeOf(r)} status=${l.status} kind=${l.nextActionKind} calls ${calls}→${callsAfter}`,
    );
};

// W3b-B: vlastný deň follow-up hovoru v „Čo sme poslali"; minulý deň alebo deň bez follow-upu sa odmietne.
tests.w3bFollowUpDate = async () => {
    const offers = await import("../../lib/commands/offers");
    const bt = await import("../../lib/domain/businessTime");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep, "WANTS_EMAIL");
    const today = bt.businessDate(new Date());
    const day = bt.addBusinessCalendarDays(today, 3);
    const base = { leadId: id, contents: ["ABOUT_US"] as "ABOUT_US"[], sentOn: today };
    const past = await offers.recordOfferSentAs(rep, { ...base, expectedRevision: await leadRev(id), idempotencyKey: key(), followUp: true, followUpOn: bt.addBusinessCalendarDays(today, -1) });
    const noFollow = await offers.recordOfferSentAs(rep, { ...base, expectedRevision: await leadRev(id), idempotencyKey: key(), followUp: false, followUpOn: day });
    const ok = await offers.recordOfferSentAs(rep, { ...base, expectedRevision: await leadRev(id), idempotencyKey: key(), followUp: true, followUpOn: day });
    const l = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { nextActionKind: true, nextActionAt: true } });
    check(
        "W3b-B: chosen follow-up day is used; a past day or a day without follow-up is refused",
        codeOf(past) !== "OK" && codeOf(noFollow) !== "OK" && codeOf(ok) === "OK" && l.nextActionKind === "CALL" && l.nextActionAt !== null && bt.businessDate(l.nextActionAt) === day,
        `past=${codeOf(past)} noFollow=${codeOf(noFollow)} ok=${codeOf(ok)} at=${l.nextActionAt && bt.businessDate(l.nextActionAt)}`,
    );
};

// W3b-C: riadok zoznamu nesie údaje pre dialóg (cena, rozpis, návrhy so sledovaným odkazom) – bez presmerovania.
tests.w3bListDialogData = async () => {
    const pipeline = await import("../../lib/commands/pipeline");
    const { createDesignAs } = await import("../../lib/commands/tracking");
    const { getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await pipeline.saveQuoteAs(manager, id, { price: 990, priceNote: "Web 550 · SEO 440" });
    await createDesignAs(manager, { leadId: id, label: "smrek1", url: "smrek1.thegrandpoints.com" });
    const row = (await getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id);
    const d = row?.dialog;
    check(
        "W3b-C: list row carries price, breakdown and designs (with the copy link) for the in-place dialog",
        d?.price === 990 && d.priceNote === "Web 550 · SEO 440" && d.designs.length === 1 && (d.designs[0].trackedUrl ?? "").includes("?p=") &&
            d.owner?.id === rep.id && row?.hasDesignSent === false,
        JSON.stringify({ price: d?.price, note: d?.priceNote, designs: d?.designs.map((x) => ({ url: x.url, tracked: Boolean(x.trackedUrl) })), sent: row?.hasDesignSent }),
    );
};

// W3b-D: po ďalšom hovore zoznam aj detail stále ukazujú, čo sme poslali naposledy („čakáme, kým si pozrú návrh").
tests.w3bLastOfferStays = async () => {
    const offers = await import("../../lib/commands/offers");
    const work = await import("../../lib/commands/dealWork");
    const { createDesignAs } = await import("../../lib/commands/tracking");
    const { getDealList, getDealDetail } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const bt = await import("../../lib/domain/businessTime");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await createDesignAs(manager, { leadId: id, label: "smrek1", url: "smrek1.thegrandpoints.com" });
    const design = await prisma.design.findFirstOrThrow({ where: { leadId: id } });
    await offers.recordOfferSentAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), contents: ["DESIGN"], designIds: [design.id], sentOn: bt.businessDate(new Date()), followUp: true });
    await work.logFollowUpAs(rep, { leadId: id, outcome: "POSITIVE", reply: "NOT_LOOKED_YET", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 2 }, expectedRevision: await leadRev(id), idempotencyKey: key() });
    const row = (await getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id);
    const detail = await getDealDetail(id, dealScope(rep), dealCapabilities(rep));
    check(
        "W3b-D: after a later call, list and detail still show the last send (návrh smrek1)",
        row?.lastActivity?.type === "CALL" && row.lastOffer?.text === "návrh smrek1" && detail?.lastTouch?.type === "CALL" && detail.lastOffer?.text === "návrh smrek1",
        `row=${row?.lastActivity?.type}/${row?.lastOffer?.text} detail=${detail?.lastTouch?.type}/${detail?.lastOffer?.text}`,
    );
};

// ── Round 2, wave 3b follow-up: fixes from the external review ─────────────────────

// R3-4: starý obchod s Lead.designSentAt, ale bez jediného Design riadku, sa nezobrazí ako „návrh neposlaný".
tests.w3cLegacyNoDesignRow = async () => {
    const { getDealList, getDealDetail } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const at = new Date(Date.now() - 20 * 86_400_000);
    await prisma.lead.update({ where: { id }, data: { designSentAt: at } });
    const row = (await getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id);
    const detail = await getDealDetail(id, dealScope(rep), dealCapabilities(rep));
    check(
        "R3-4: legacy designSentAt without Design rows still shows as sent (list + detail)",
        row?.hasDesignSent === true && row.dialog.offers.designSentAt === at.toISOString() && detail?.offers.designSentAt === at.toISOString(),
        `row=${row?.hasDesignSent} detail=${detail?.offers.designSentAt}`,
    );
};

// R3-5: ten istý kľúč s iným obsahom je konflikt, nie falošné „uložené" (odoslanie aj SMS).
tests.w3cReplayPayload = async () => {
    const offers = await import("../../lib/commands/offers");
    const work = await import("../../lib/commands/dealWork");
    const bt = await import("../../lib/domain/businessTime");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep, "WANTS_EMAIL");
    const k = key();
    const base = { leadId: id, idempotencyKey: k, sentOn: bt.businessDate(new Date()), followUp: false };
    const rev = await leadRev(id);
    const first = await offers.recordOfferSentAs(rep, { ...base, expectedRevision: rev, contents: ["ABOUT_US"] });
    const same = await offers.recordOfferSentAs(rep, { ...base, expectedRevision: rev, contents: ["ABOUT_US"] });
    const changed = await offers.recordOfferSentAs(rep, { ...base, expectedRevision: rev, contents: ["ABOUT_US", "PRICELIST"] });
    const sk = key();
    const srev = await leadRev(id);
    const sms1 = await work.logFollowUpAs(rep, { leadId: id, contact: "SMS", outcome: "POSITIVE", nextKind: "WAITING_FOR_CLIENT", note: "web", expectedRevision: srev, idempotencyKey: sk });
    const sms2 = await work.logFollowUpAs(rep, { leadId: id, contact: "SMS", outcome: "POSITIVE", nextKind: "WAITING_FOR_CLIENT", note: "web", expectedRevision: srev, idempotencyKey: sk });
    const sms3 = await work.logFollowUpAs(rep, { leadId: id, contact: "SMS", outcome: "POSITIVE", nextKind: "WAITING_FOR_CLIENT", note: "iný text", expectedRevision: srev, idempotencyKey: sk });
    check(
        "R3-5: same key + same content = replay OK; same key + different content = IDEMPOTENCY_CONFLICT",
        codeOf(first) === "OK" && codeOf(same) === "OK" && codeOf(changed) === "ERR:IDEMPOTENCY_CONFLICT" &&
            codeOf(sms1) === "OK" && codeOf(sms2) === "OK" && codeOf(sms3) === "ERR:IDEMPOTENCY_CONFLICT",
        `offer=${codeOf(first)},${codeOf(same)},${codeOf(changed)} sms=${codeOf(sms1)},${codeOf(sms2)},${codeOf(sms3)}`,
    );
};

// R3-6: „Naposledy" je len skutočný kontakt – spätný záznam ani požiadavka ho nemenia; spätné odoslanie nie je „Odoslané".
tests.w3cLastTouchRules = async () => {
    const offers = await import("../../lib/commands/offers");
    const work = await import("../../lib/commands/dealWork");
    const { getDealDetail, getDealList } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const bt = await import("../../lib/domain/businessTime");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await work.logFollowUpAs(rep, { leadId: id, outcome: "POSITIVE", nextKind: "WAITING_FOR_CLIENT", expectedRevision: await leadRev(id), idempotencyKey: key() });
    await offers.recordOfferSentAs(manager, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), contents: ["ABOUT_US"], sentOn: bt.addBusinessCalendarDays(bt.businessDate(new Date()), -40), historical: true, followUp: false });
    const { askManagerAs } = await import("../../lib/commands/tasks");
    await askManagerAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), type: "HELP", contents: ["OTHER"], text: "otázka na manažéra", assigneeId: manager.id, step: { kind: "CALL" } });
    const detail = await getDealDetail(id, dealScope(rep), dealCapabilities(rep));
    const row = (await getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id);
    check(
        "R3-6: a task and a historical entry change neither 'Naposledy' nor the 'Odoslané' line",
        detail?.lastTouch?.type === "CALL" && row?.lastActivity?.type === "CALL" && detail.lastOffer === null && row.lastOffer === null,
        `detail=${detail?.lastTouch?.type}/${detail?.lastOffer?.text ?? "null"} row=${row?.lastActivity?.type}/${row?.lastOffer?.text ?? "null"}`,
    );
};

// R3-7: zmazanie jediného poslaného návrhu prepočíta súhrn obchodu (a zvýši revíziu raz).
tests.w3cDeleteDesign = async () => {
    const offers = await import("../../lib/commands/offers");
    const tracking = await import("../../lib/commands/tracking");
    const bt = await import("../../lib/domain/businessTime");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await tracking.createDesignAs(manager, { leadId: id, label: "omyl" });
    const d = await prisma.design.findFirstOrThrow({ where: { leadId: id } });
    await offers.recordOfferSentAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), contents: ["DESIGN"], designIds: [d.id], sentOn: bt.businessDate(new Date()), followUp: false });
    const sentBefore = (await prisma.lead.findUniqueOrThrow({ where: { id } })).designSentAt;
    const before = await leadRev(id);
    const r = await tracking.removeDesignAs(manager, d.id);
    const l = await prisma.lead.findUniqueOrThrow({ where: { id } });
    check(
        "R3-7: deleting the only sent design clears Lead.designSentAt, one revision bump",
        codeOf(r) === "OK" && sentBefore !== null && l.designSentAt === null && l.revision === before + 1,
        `before=${sentBefore?.toISOString()} after=${l.designSentAt} rev+${l.revision - before}`,
    );
};

// R3-8: cena povedaná telefonicky – iná suma nezdedí starý rozpis; tá istá suma ho ponechá; rozpis sa dá zadať.
tests.w3cPhoneBreakdown = async () => {
    const work = await import("../../lib/commands/dealWork");
    const pipeline = await import("../../lib/commands/pipeline");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const snapshotNote = async (id: string) => {
        const a = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT" }, orderBy: { createdAt: "desc" } });
        return (a.meta as { price?: { note?: string | null } } | null)?.price?.note ?? null;
    };
    const call = (id: string, rev: number, phonePrice: { amount: number; note?: string | null }) =>
        work.logFollowUpAs(rep, { leadId: id, outcome: "POSITIVE", nextKind: "SEND_QUOTE", phonePrice, expectedRevision: rev, idempotencyKey: key() });

    const a = await makeDeal(rep);
    await pipeline.saveQuoteAs(manager, a, { price: 1000, priceNote: "Web 600 · SEO 400" });
    await call(a, await leadRev(a), { amount: 900 });
    const diff = { snap: await snapshotNote(a), lead: (await prisma.lead.findUniqueOrThrow({ where: { id: a } })).priceNote };

    const b = await makeDeal(rep);
    await pipeline.saveQuoteAs(manager, b, { price: 1000, priceNote: "Web 600 · SEO 400" });
    await call(b, await leadRev(b), { amount: 1000 });
    const same = await snapshotNote(b);

    const c = await makeDeal(rep);
    await call(c, await leadRev(c), { amount: 800, note: "Web 500 · admin 300" });
    const given = await snapshotNote(c);
    check(
        "R3-8: phone price — new amount drops the old breakdown, same amount keeps it, a given breakdown is stored",
        diff.snap === null && diff.lead === null && same === "Web 600 · SEO 400" && given === "Web 500 · admin 300",
        JSON.stringify({ diff, same, given }),
    );
};

// ── Wave 3: úlohy pre manažéra, zámok kroku, odovzdanie, História, počty (wave-3-task-proposal-final.md §9) ─────

async function w3() {
    const tasks = await import("../../lib/commands/tasks");
    const work = await import("../../lib/commands/dealWork");
    const pipeline = await import("../../lib/commands/pipeline");
    const offers = await import("../../lib/commands/offers");
    const queries = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const bt = await import("../../lib/domain/businessTime");
    const today = bt.businessDate(new Date());
    const lead = (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });
    const openTask = (id: string) => prisma.dealTask.findFirst({ where: { leadId: id, status: "OPEN" } });
    const lastTask = (id: string) => prisma.dealTask.findFirstOrThrow({ where: { leadId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const ask = async (
        rep: AccessUser,
        leadId: string,
        assigneeId: string,
        extra: Partial<Parameters<typeof tasks.askManagerAs>[1]> = {},
    ) =>
        tasks.askManagerAs(rep, {
            leadId,
            expectedRevision: await leadRev(leadId),
            idempotencyKey: key(),
            type: "HELP",
            contents: ["PRICE"],
            text: "e-shop, 200 produktov",
            assigneeId,
            step: { kind: "SEND_QUOTE", note: null },
            ...extra,
        });
    // Wave 4: manažér odovzdáva ČASTI. Pomocník drží staré testy čitateľné – cena, ak sa nepovie inak.
    const finish = async (m: AccessUser, leadId: string, extra: { price?: { amount: number; note: string | null }; designs?: { id: string; version: number }[]; answer?: string } = {}) =>
        tasks.resolveTaskPartsAs(m, {
            taskId: (await openTask(leadId))!.id,
            expectedRevision: await leadRev(leadId),
            idempotencyKey: key(),
            parts: [
                ...(extra.designs ? [{ kind: "DESIGN" as const, op: "DELIVER" as const, designs: extra.designs }] : []),
                ...(extra.answer !== undefined ? [{ kind: "OTHER" as const, op: "DELIVER" as const, answer: extra.answer }] : []),
                ...(extra.designs || extra.answer !== undefined
                    ? extra.price
                        ? [{ kind: "PRICE" as const, op: "DELIVER" as const, price: extra.price }]
                        : []
                    : [{ kind: "PRICE" as const, op: "DELIVER" as const, price: extra.price ?? { amount: 1285, note: null } }]),
            ],
        });
    const follow = async (u: AccessUser, leadId: string, extra: Partial<Parameters<typeof work.logFollowUpAs>[1]>) =>
        work.logFollowUpAs(u, { leadId, outcome: "POSITIVE", expectedRevision: await leadRev(leadId), idempotencyKey: key(), ...extra });
    const send = async (u: AccessUser, leadId: string, extra: Partial<Parameters<typeof offers.recordOfferSentAs>[1]>) =>
        offers.recordOfferSentAs(u, {
            leadId,
            expectedRevision: await leadRev(leadId),
            idempotencyKey: key(),
            contents: ["PRICE"],
            sentOn: today,
            followUp: false,
            ...extra,
        });
    const detail = (id: string, u: AccessUser) => queries.getDealDetail(id, dealScope(u), dealCapabilities(u));
    const pending = async (id: string) => (await (await import("../../lib/domain/taskMutations")).loadPending(prisma, id));
    const design = async (m: AccessUser, leadId: string, label: string, url: string | null = `${label}.test.invalid`) => {
        const { createDesignAs } = await import("../../lib/commands/tracking");
        await createDesignAs(m, { leadId, label, url });
        return prisma.design.findFirstOrThrow({ where: { leadId, label }, select: { id: true, currentVersion: true } });
    };
    return { tasks, work, pipeline, offers, queries, dealScope, dealCapabilities, bt, today, lead, openTask, lastTask, ask, finish, follow, send, detail, pending, design };
}

// W3-1 vznik úlohy: len vlastník-obchodník, nie telesales / manažér / cudzí; uzavretý nie; druhá OPEN nie; spiaci sa zobudí;
// zamknutý krok bez dátumu; jedna revízia; opakovanie s tým istým kľúčom; zmena obsahu = konflikt; D3 krok.
tests.w3Create = async () => {
    const { tasks, lead, ask, pipeline, work } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const other = await makeUser("SALES_REP");
    const tele = await makeUser("TELESALES");
    const id = await makeDeal(rep);
    await work.logFollowUpAs(rep, { leadId: id, outcome: "SNOOZE", schedule: { kind: "monthsFromToday", months: 2 }, expectedRevision: await leadRev(id), idempotencyKey: key() });

    const foreign = await ask(other, id, manager.id);
    const byTele = await ask(tele, id, manager.id);
    const byManager = await ask(manager, id, manager.id);
    const toRep = await ask(rep, id, other.id);
    const wrongStep = await ask(rep, id, manager.id, { step: { kind: "CALL" } });
    const noText = await ask(rep, id, manager.id, { text: "   " });
    check(
        "W3-1: foreign rep NOT_FOUND, telesales / manager FORBIDDEN, assignee must be a resolver, price task needs the send step (D3), text required",
        codeOf(foreign) === "ERR:NOT_FOUND" && codeOf(byTele) === "ERR:FORBIDDEN" && codeOf(byManager) === "ERR:FORBIDDEN" &&
            codeOf(toRep) === "ERR:FORBIDDEN" && codeOf(wrongStep) !== "OK" && codeOf(noText) !== "OK",
        `${codeOf(foreign)} ${codeOf(byTele)} ${codeOf(byManager)} ${codeOf(toRep)} ${codeOf(wrongStep)} ${codeOf(noText)}`,
    );

    const before = await leadRev(id);
    const k = key();
    const input = { leadId: id, expectedRevision: before, idempotencyKey: k, type: "HELP" as const, contents: ["PRICE" as const], text: "e-shop", assigneeId: manager.id, step: { kind: "SEND_QUOTE" as const, note: "cena od Michala" } };
    const [a, b] = await Promise.all([tasks.askManagerAs(rep, input), tasks.askManagerAs(rep, input)]);
    const again = await tasks.askManagerAs(rep, input);
    const changed = await Promise.all([
        tasks.askManagerAs(rep, { ...input, text: "iný text" }),
        tasks.askManagerAs(rep, { ...input, contents: ["PRICE", "OTHER"] }),
        tasks.askManagerAs(rep, { ...input, step: { kind: "SEND_DESIGN", note: "cena od Michala" } }),
    ]);
    const l = await lead(id);
    const count = await prisma.dealTask.count({ where: { leadId: id } });
    const created = await prisma.activity.count({ where: { leadId: id, type: "TASK_CREATED" } });
    check(
        "W3-1: snoozed deal wakes, step locked without a date, one bump; same key (parallel + again) = one task; changed payload = conflict",
        codeOf(a) === "OK" && codeOf(b) === "OK" && codeOf(again) === "OK" && count === 1 && created === 1 &&
            l.status === "ACTIVE" && l.nextActionKind === "SEND_QUOTE" && l.nextActionAt === null && l.nextActionNote === "cena od Michala" &&
            l.revision === before + 1 && changed.every((c) => codeOf(c) === "ERR:IDEMPOTENCY_CONFLICT"),
        `r=${codeOf(a)},${codeOf(b)},${codeOf(again)} tasks=${count} status=${l.status} at=${l.nextActionAt} rev+${l.revision - before} changed=${changed.map(codeOf).join(",")}`,
    );

    const second = await ask(rep, id, manager.id, { contents: ["OTHER"], step: { kind: "CALL" } });
    check("W3-1: a second open task on the same deal is refused (I1)", codeOf(second) === "ERR:STALE" && (await prisma.dealTask.count({ where: { leadId: id, status: "OPEN" } })) === 1, codeOf(second));

    const closedId = await makeDeal(rep);
    await pipeline.changeStatusAs(manager, closedId, { status: "LOST", expectedRevision: await leadRev(closedId), idempotencyKey: key() });
    const onClosed = await ask(rep, closedId, manager.id);
    const ownId = await makeDeal(manager);
    const ownDeal = await ask(manager, ownId, manager.id);
    check("W3-1: closed deal → DEAL_CLOSED; a manager never asks on his own deal (D7)", codeOf(onClosed) === "ERR:DEAL_CLOSED" && codeOf(ownDeal) === "ERR:FORBIDDEN", `${codeOf(onClosed)} ${codeOf(ownDeal)}`);
};

// W3-1b krok po vybavení sa nevyberá (spätná väzba 2026-09-19): cena → „Poslať cenu", návrh → „Poslať návrh", iné →
// ostáva aktuálny krok aj s poznámkou (zmeniť sa dá len pri „Iné"); čakajúci návrh (I10) zúži cenu na „Poslať návrh".
// Predvolený manažér = vedúci tímu, inak naposledy oslovený.
tests.w3AutoStep = async () => {
    const { tasks, lead, ask, follow, finish, design, lastTask } = await w3();
    const { stepAfterTask } = await import("../../lib/domain/tasks");
    const { defaultStepNote } = await import("../../lib/domain/nextStepOptions");
    const { getResolverOptions } = await import("../../lib/queries/pipeline");
    const manager = await makeUser("MANAGER");
    const manager2 = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const noStep = { step: undefined };

    // Čistá funkcia: matica obsah × aktuálny krok × čakajúce.
    const none = { kind: null, note: null };
    const call = { kind: "CALL" as const, note: "dohodnúť stretnutie" };
    const quote = { kind: "SEND_QUOTE" as const, note: "cena na e-shop" };
    const pureOk = [
        [stepAfterTask(["PRICE"], quote, [], defaultStepNote), "SEND_QUOTE", "cena na e-shop", true],
        [stepAfterTask(["PRICE"], call, [], defaultStepNote), "SEND_QUOTE", defaultStepNote("SEND_QUOTE"), true],
        [stepAfterTask(["DESIGN"], quote, [], defaultStepNote), "SEND_DESIGN", defaultStepNote("SEND_DESIGN"), true],
        [stepAfterTask(["OTHER"], call, [], defaultStepNote), "CALL", "dohodnúť stretnutie", false],
        [stepAfterTask(["OTHER"], none, [], defaultStepNote), "CALL", defaultStepNote("CALL"), false],
        [stepAfterTask(["PRICE"], call, [{ kind: "DESIGN" }], defaultStepNote), "SEND_DESIGN", defaultStepNote("SEND_DESIGN"), true],
        [stepAfterTask(["PRICE", "DESIGN"], call, [], defaultStepNote), "SEND_DESIGN", defaultStepNote("SEND_DESIGN"), true],
        [stepAfterTask(["OTHER"], quote, [{ kind: "PRICE" }], defaultStepNote), "SEND_QUOTE", "cena na e-shop", false],
    ].every(([r, kind, note, fixed]) => {
        const s = r as ReturnType<typeof stepAfterTask>;
        return s.kind === kind && s.note === note && s.fixed === fixed;
    });
    check("W3-1b: stepAfterTask matrix (price/design fixed, other keeps step + note, I10 narrows, design wins)", pureOk);

    // Cena bez kroku v požiadavke: „Poslať cenu" s pôvodnou poznámkou ostáva; z hovoru → „Poslať cenu" s predvolenou.
    const idQ = await makeDeal(rep);
    const q0 = await lead(idQ);
    const rQ = await ask(rep, idQ, manager.id, noStep);
    const q1 = await lead(idQ);
    const idC = await makeDeal(rep);
    await follow(rep, idC, { nextKind: "CALL", schedule: { kind: "daysFromToday", days: 2 }, stepNote: "zavolať ohľadom webu" });
    const rC = await ask(rep, idC, manager.id, noStep);
    const c1 = await lead(idC);
    check(
        "W3-1b: price task without a step keeps 'Poslať cenu' + its note; from 'Zavolať' it becomes 'Poslať cenu' (locked, no date)",
        codeOf(rQ) === "OK" && q0.nextActionKind === "SEND_QUOTE" && q1.nextActionKind === "SEND_QUOTE" && q1.nextActionNote === q0.nextActionNote &&
            q1.nextActionAt === null && codeOf(rC) === "OK" && c1.nextActionKind === "SEND_QUOTE" &&
            c1.nextActionNote === defaultStepNote("SEND_QUOTE") && c1.nextActionAt === null,
        `${codeOf(rQ)} ${q0.nextActionKind}→${q1.nextActionKind} "${q0.nextActionNote}"→"${q1.nextActionNote}" | ${codeOf(rC)} ${c1.nextActionKind} "${c1.nextActionNote}"`,
    );

    const idD = await makeDeal(rep);
    const rD = await ask(rep, idD, manager.id, { contents: ["DESIGN"], step: undefined });
    const idO = await makeDeal(rep);
    await follow(rep, idO, { nextKind: "CALL", schedule: { kind: "daysFromToday", days: 2 }, stepNote: "dohodnúť stretnutie" });
    const rO = await ask(rep, idO, manager.id, { contents: ["OTHER"], step: undefined });
    const idO2 = await makeDeal(rep);
    const rO2 = await ask(rep, idO2, manager.id, { contents: ["OTHER"], step: { kind: "SEND_EMAIL", note: "poslať referencie" } });
    const idW = await makeDeal(rep);
    const rW = await ask(rep, idW, manager.id, { contents: ["PRICE"], step: { kind: "SEND_DESIGN", note: null } });
    const [d1, o1, o2, w1] = await Promise.all([lead(idD), lead(idO), lead(idO2), lead(idW)]);
    check(
        "W3-1b: design → 'Poslať návrh'; other keeps 'Zavolať' + note; other with a chosen step honours it; price with a different step is refused",
        codeOf(rD) === "OK" && d1.nextActionKind === "SEND_DESIGN" &&
            codeOf(rO) === "OK" && o1.nextActionKind === "CALL" && o1.nextActionNote === "dohodnúť stretnutie" && o1.nextActionAt === null &&
            codeOf(rO2) === "OK" && o2.nextActionKind === "SEND_EMAIL" && o2.nextActionNote === "poslať referencie" &&
            codeOf(rW) !== "OK" && w1.nextActionKind === "SEND_QUOTE" && w1.nextActionAt !== null &&
            (await prisma.dealTask.count({ where: { leadId: idW } })) === 0,
        `${codeOf(rD)} ${d1.nextActionKind} | ${codeOf(rO)} ${o1.nextActionKind} "${o1.nextActionNote}" | ${codeOf(rO2)} ${o2.nextActionKind} | ${codeOf(rW)} ${w1.nextActionKind}`,
    );

    // I10: vrátený a neposlaný návrh → nová cenová úloha dostane „Poslať návrh"; „Iné" so „Zavolať" neprejde.
    const idP = await makeDeal(rep);
    const dz = await design(manager, idP, "Variant A");
    await ask(rep, idP, manager.id, { contents: ["DESIGN"], step: undefined });
    const done = await finish(manager, idP, { designs: [{ id: dz.id, version: dz.currentVersion }] });
    const otherCall = await ask(rep, idP, manager.id, { contents: ["OTHER"], step: { kind: "CALL" } });
    const priceTask = await ask(rep, idP, manager.id, noStep);
    const p1 = await lead(idP);
    const t = await lastTask(idP);
    check(
        "W3-1b: pending design narrows a new price task to 'Poslať návrh'; other with 'Zavolať' → RESULT_PENDING",
        codeOf(done) === "OK" && codeOf(otherCall) === "ERR:RESULT_PENDING" && codeOf(priceTask) === "OK" &&
            p1.nextActionKind === "SEND_DESIGN" && t.status === "OPEN" && (await partRows(t.id)).map((p) => p.kind).join() === "PRICE",
        `${codeOf(done)} ${codeOf(otherCall)} ${codeOf(priceTask)} ${p1.nextActionKind} ${t.status} ${(await partRows(t.id)).map((p) => p.kind).join()}`,
    );

    // Predvolený manažér: vedúci tímu; bez tímu naposledy oslovený; bez oboch nikto.
    const teamId = await makeTeam(manager2.id);
    const inTeam = await makeUser("SALES_REP", { teamId });
    const fresh = await makeUser("SALES_REP");
    const mineOf = async (u: AccessUser) => (await getResolverOptions(u.id)).filter((r) => r.mine).map((r) => r.id);
    const [mTeam, mLast, mFresh] = await Promise.all([mineOf(inTeam), mineOf(rep), mineOf(fresh)]);
    check(
        "W3-1b: default manager = team leader, else the last asked manager, else none",
        mTeam.join() === manager2.id && mLast.join() === manager.id && mFresh.length === 0,
        JSON.stringify({ team: mTeam.length, last: mLast.length, fresh: mFresh.length }),
    );
    void tasks;
};

// Review R01 (2026-09-19): (1) o vrátených výsledkoch rozhoduje vlastník aj vo vložených cestách (odoslanie, kontakt);
// (2) „Poslal som to sám" vždy končí hovorom (okrem čakajúceho staršieho výsledku); (3) znovuotvorenie s vlastníkom,
// ktorý už nemôže viesť obchody, prejde na otvárajúceho manažéra; (5) prekryv „ostáva" nesmie rušiť úlohu.
tests.w3R01 = async () => {
    const { tasks, work, pipeline, offers, lead, ask, finish, follow, send, design, pending, openTask, today } = await w3();
    const { deactivateUserAs, updateUserProfileAs } = await import("../../lib/commands/admin");
    const { reopenOwnerTarget } = await import("../../lib/domain/dealMutations");
    const admin = await makeUser("ADMIN");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");

    // (1) Vrátená odpoveď na obchode obchodníka; manažér ju nesmie vziať na vedomie cez kontakt ani cez odoslanie.
    const id = await makeDeal(rep);
    await ask(rep, id, manager.id, { contents: ["OTHER"], step: undefined });
    await finish(manager, id, { answer: "hosting áno, 10 €/mes." });
    const answer = (await pending(id)).find((i) => i.kind === "OTHER")!;
    const ack = { items: [{ taskId: answer.taskId, kind: "OTHER" as const }], reason: null };
    const byMgrCall = await follow(manager, id, { nextKind: "CALL", schedule: { kind: "daysFromToday", days: 1 }, dismiss: ack });
    const byMgrSend = await send(manager, id, { contents: ["ABOUT_US"], dismiss: ack });
    const stillPending = (await pending(id)).some((i) => i.kind === "OTHER");
    const mgrCallPlain = await follow(manager, id, { nextKind: "CALL", schedule: { kind: "daysFromToday", days: 1 } });
    const mgrSendPlain = await send(manager, id, { contents: ["ABOUT_US"] });
    const byOwner = await follow(rep, id, { nextKind: "CALL", schedule: { kind: "daysFromToday", days: 2 }, dismiss: ack });
    check(
        "R01-1: a manager on a rep's deal cannot dismiss returned items through a call or a send (FORBIDDEN, item stays); the same call / send without dismiss works; the owner can",
        codeOf(byMgrCall) === "ERR:FORBIDDEN" && codeOf(byMgrSend) === "ERR:FORBIDDEN" && stillPending &&
            codeOf(mgrCallPlain) === "OK" && codeOf(mgrSendPlain) === "OK" && codeOf(byOwner) === "OK" &&
            !(await pending(id)).some((i) => i.kind === "OTHER"),
        `${codeOf(byMgrCall)} ${codeOf(byMgrSend)} pending=${stillPending} ${codeOf(mgrCallPlain)} ${codeOf(mgrSendPlain)} ${codeOf(byOwner)}`,
    );

    // (2) „Poslal som to sám": followUp:false sa odmietne; bez neho krok = hovor; s čakajúcim starším návrhom krok ostáva.
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id);
    const t2 = (await openTask(id2))!;
    const base2 = { taskId: t2.id, idempotencyKey: key(), parts: [{ kind: "PRICE" as const, op: "DELIVER" as const, price: { amount: 700, note: null } }], sentOn: today };
    const optOut = await tasks.finishAndSendAs(manager, { ...base2, expectedRevision: await leadRev(id2), followUp: false as unknown as true });
    const fs = await tasks.finishAndSendAs(manager, { ...base2, idempotencyKey: key(), expectedRevision: await leadRev(id2) });
    const l2 = await lead(id2);
    const id3 = await makeDeal(rep);
    const dz = await design(manager, id3, "Variant B");
    await ask(rep, id3, manager.id, { contents: ["DESIGN"], step: undefined });
    await finish(manager, id3, { designs: [{ id: dz.id, version: dz.currentVersion }] });
    await ask(rep, id3, manager.id, { step: undefined });
    const t3 = (await openTask(id3))!;
    const fs3 = await tasks.finishAndSendAs(manager, { taskId: t3.id, expectedRevision: await leadRev(id3), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 800, note: null } }], sentOn: today });
    const l3 = await lead(id3);
    check(
        "R01-2: finish-and-send never leaves 'Poslať…' for what was sent: opt-out refused, default = 'Zavolať'; an older unsent návrh keeps 'Poslať návrh'",
        codeOf(optOut) !== "OK" && codeOf(fs) === "OK" && l2.nextActionKind === "CALL" &&
            codeOf(fs3) === "OK" && l3.nextActionKind === "SEND_DESIGN" && (await pending(id3)).some((i) => i.kind === "DESIGN"),
        `${codeOf(optOut)} ${codeOf(fs)} ${l2.nextActionKind} | ${codeOf(fs3)} ${l3.nextActionKind}`,
    );

    // (3) Znovuotvorenie: deaktivovaný / preradený vlastník → obchod prevezme otvárajúci manažér (OWNER_CHANGED + DealOwnership).
    const gone = await makeUser("SALES_REP");
    const demoted = await makeUser("SALES_REP");
    const idA = await makeDeal(gone);
    const idB = await makeDeal(demoted);
    const idC = await makeDeal(rep);
    for (const x of [idA, idB, idC]) await pipeline.markLostAs(manager, x, { reason: "test", expectedRevision: await leadRev(x), idempotencyKey: key() });
    const deact = await deactivateUserAs(admin, gone.id);
    const demote = await updateUserProfileAs(admin, demoted.id, { firstName: demoted.firstName, lastName: "x", username: demoted.username, email: null, phone: null, role: "TELESALES", note: null });
    const revA = await leadRev(idA);
    const rA = await pipeline.reopenDealAs(manager, idA, { expectedRevision: revA, idempotencyKey: key() });
    const rB = await pipeline.changeStatusAs(manager, idB, { status: "ACTIVE", expectedRevision: await leadRev(idB), idempotencyKey: key() });
    const rC = await pipeline.reopenDealAs(manager, idC, { expectedRevision: await leadRev(idC), idempotencyKey: key() });
    const [a, b, c] = await Promise.all([lead(idA), lead(idB), lead(idC)]);
    const ownRows = await prisma.dealOwnership.findMany({ where: { leadId: { in: [idA, idB, idC] }, reason: "CHANGE" } });
    const ownerLogs = await prisma.activity.count({ where: { leadId: idA, type: "OWNER_CHANGED" } });
    const pureNobody = reopenOwnerTarget({
        owner: { id: "x", role: "SALES_REP", deletedAt: new Date(), teamId: null, firstName: "x", lastName: "x" },
        me: { id: "y", role: "TELESALES", deletedAt: null, teamId: null, firstName: "y", lastName: "y" },
    });
    check(
        "R01-3: reopen with a deactivated / demoted owner → the reopening manager owns it (one revision, OWNER_CHANGED + DealOwnership CHANGE); a valid owner stays; nobody eligible → unassigned",
        "ok" in deact && deact.ok && !("error" in demote) && codeOf(rA) === "OK" && codeOf(rB) === "OK" && codeOf(rC) === "OK" &&
            a.status === "ACTIVE" && a.ownerId === manager.id && a.revision === revA + 1 && b.status === "ACTIVE" && b.ownerId === manager.id &&
            c.ownerId === rep.id && ownRows.length === 2 && ownRows.every((o) => o.toUserId === manager.id) && ownerLogs >= 1 &&
            pureNobody.change && pureNobody.target === null,
        `${JSON.stringify(deact).slice(0, 40)} ${codeOf(rA)} ${codeOf(rB)} ${codeOf(rC)} A=${a.ownerId === manager.id} B=${b.ownerId === manager.id} C=${c.ownerId === rep.id} rows=${ownRows.length} rev+${a.revision - revA}`,
    );

    // (5) Prekryv pri odoslaní: „ostáva otvorená" + cancelTask a „zrušiť" bez dôvodu sa odmietnu; úloha ostáva otvorená.
    const id5 = await makeDeal(rep);
    await ask(rep, id5, manager.id);
    const t5 = (await openTask(id5))!;
    const keepButCancel = await send(rep, id5, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "KEEP_OPEN", withdrawParts: { taskId: t5.id, kinds: ["PRICE"], reason: "x" } });
    const cancelNoReason = await send(rep, id5, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "WITHDRAW_PARTS", withdrawParts: { taskId: t5.id, kinds: ["PRICE"], reason: " " } });
    const cancelNoOverlap = await send(rep, id5, { contents: ["ABOUT_US"], withdrawParts: { taskId: t5.id, kinds: ["PRICE"], reason: "netreba" } });
    check(
        "R01-5: send with KEEP_OPEN + withdrawParts, WITHDRAW_PARTS without a reason, or withdrawParts without the choice are refused; the task stays OPEN",
        codeOf(keepButCancel) !== "OK" && codeOf(cancelNoReason) !== "OK" && codeOf(cancelNoOverlap) !== "OK" && (await openTask(id5))?.id === t5.id,
        `${codeOf(keepButCancel)} ${codeOf(cancelNoReason)} ${codeOf(cancelNoOverlap)}`,
    );
    void work;
    void offers;
};

// Review R02 (2026-09-19): (1) uloženie profilu kontroluje držanú prácu podľa NOVEJ roly pod zámkom User riadku –
// aj keď sa rola „nemení" (zastaralý formulár po súbežnom povýšení a pridelení obchodu); (3) zoznam a detail počítajú
// „N. pokus" rovnako aj pri zhodnom createdAt (poradie createdAt, id).
tests.w3R02 = async () => {
    const { queries, dealScope, dealCapabilities, detail } = await w3();
    const { updateUserProfileAs } = await import("../../lib/commands/admin");
    const admin = await makeUser("ADMIN");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");

    // Stav po prehratom súbehu: SCOUT drží otvorený obchod. Uloženie profilu s tou istou rolou ho musí odmietnuť.
    const scout = await makeUser("SCOUT");
    const stranded = await makeDeal(rep);
    await prisma.lead.update({ where: { id: stranded }, data: { ownerId: scout.id } });
    const sameRole = await updateUserProfileAs(admin, scout.id, { firstName: scout.firstName, lastName: "x", username: scout.username, email: null, phone: null, role: "SCOUT", note: null });
    const repEdit = await updateUserProfileAs(admin, rep.id, { firstName: rep.firstName, lastName: "y", username: rep.username, email: null, phone: null, role: "SALES_REP", note: null });
    await prisma.lead.update({ where: { id: stranded }, data: { ownerId: rep.id } });
    check(
        "R02-1: a profile save is checked against the NEW role under the User lock – a SCOUT holding an open deal is refused even with an unchanged role; a rep's ordinary edit still works",
        "ok" in sameRole && !sameRole.ok && /Najprv presuň/.test(sameRole.error) && "ok" in repEdit && repEdit.ok,
        `${JSON.stringify(sameRole).slice(0, 80)} ${JSON.stringify(repEdit).slice(0, 40)}`,
    );

    // Zhodný createdAt: úspešný hovor s vyšším id je „posledný" – zoznam aj detail ukážu 0 pokusov.
    const id = await makeDeal(rep);
    const at = new Date();
    const first = await prisma.activity.create({ data: { leadId: id, userId: rep.id, type: "CALL", category: "BUSINESS", source: "CLIENTS", outcome: "NO_ANSWER", createdAt: at } });
    const second = await prisma.activity.create({ data: { leadId: id, userId: rep.id, type: "CALL", category: "BUSINESS", source: "CLIENTS", outcome: "POSITIVE", createdAt: at } });
    const [lo, hi] = first.id < second.id ? [first, second] : [second, first];
    const list = await queries.getDealList({ scope: dealScope(manager), owner: { userId: rep.id }, status: "ACTIVE", take: 50 });
    const row = list.rows.find((r) => r.id === id);
    const d = await detail(id, manager);
    check(
        "R02-3: with an equal createdAt the list's attempt counter and the detail agree (ordered by createdAt, id)",
        row !== undefined && d !== null && row.noAnswerStreak === d.noAnswerStreak && d.noAnswerStreak === (hi.outcome === "NO_ANSWER" ? 1 : 0),
        `list=${row?.noAnswerStreak} detail=${d?.noAnswerStreak} last=${hi.outcome} (${lo.outcome} first)`,
    );
    void dealCapabilities;
};

// Review R03-1 (2026-09-19): posledná čakajúca vrátená položka dokončí krok „Poslať…" v oboch poradiach – návrh skôr,
// cena posledná (krok „Poslať návrh", posiela sa len cena) aj cena skôr, návrh posledný. Kým niečo čaká, krok ostáva.
tests.w3R03 = async () => {
    const { lead, ask, finish, send, pending, design } = await w3();
    // Wave 5: sendCompletesStep počíta s nevybavenými OBSAHMI (požiadavky klienta + práca manažéra), nie len
    // s vrátenými položkami úloh – preto býva v lib/domain/clientRequests.ts.
    const { sendCompletesStep } = await import("../../lib/domain/clientRequests");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const P = ["PRICE"] as const;
    const D = ["DESIGN"] as const;
    const pureOk =
        sendCompletesStep("SEND_DESIGN", ["PRICE"], P, []) && // návrh už išiel, posledná cena
        sendCompletesStep("SEND_DESIGN", ["DESIGN"], D, []) &&
        sendCompletesStep("SEND_QUOTE", ["PRICE"], [], []) &&
        sendCompletesStep(null, ["ABOUT_US"], [], []) &&
        !sendCompletesStep("SEND_DESIGN", ["PRICE"], [...P, ...D], D) && // návrh ešte čaká
        !sendCompletesStep("SEND_DESIGN", ["PRICE"], [], []) && // bez vrátených položiek cena návrh nedokončí
        !sendCompletesStep("CALL", ["PRICE"], P, []); // naplánovaný hovor sa predvolene ponecháva
    check("R03-1: sendCompletesStep – the last pending returned item completes 'Poslať…', anything still pending keeps it", pureOk);

    // Obe poradia na DB: cena + návrh vrátené, krok „Poslať návrh".
    const both = async () => {
        const id = await makeDeal(rep);
        const d = await design(manager, id, `r03-${key().slice(0, 6)}`);
        await ask(rep, id, manager.id);
        await finish(manager, id, { price: { amount: 900, note: null } });
        const tPrice = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id } })).id;
        await ask(rep, id, manager.id, { contents: ["DESIGN"], step: { kind: "SEND_DESIGN" } });
        await finish(manager, id, { designs: [{ id: d.id, version: 1 }] });
        const tDesign = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id, id: { not: tPrice } } })).id;
        return { id, d, tPrice, tDesign };
    };
    const a = await both();
    const aDesign = await send(rep, a.id, { contents: ["DESIGN"], designIds: [a.d.id], fulfils: [{ taskId: a.tDesign, kind: "DESIGN", designId: a.d.id }] });
    const aMid = await lead(a.id);
    const aPrice = await send(rep, a.id, { contents: ["PRICE"], fulfils: [{ taskId: a.tPrice, kind: "PRICE" }], followUp: true });
    const aEnd = await lead(a.id);
    const b = await both();
    await send(rep, b.id, { contents: ["PRICE"], fulfils: [{ taskId: b.tPrice, kind: "PRICE" }] });
    const bMid = await lead(b.id);
    const bDesign = await send(rep, b.id, { contents: ["DESIGN"], designIds: [b.d.id], fulfils: [{ taskId: b.tDesign, kind: "DESIGN", designId: b.d.id }], followUp: true });
    const bEnd = await lead(b.id);
    // Wave 5 (§3.7, §6.8): po čiastočnom odoslaní krok padne na to, čo NEVYBAVENÉ ostalo – po odoslanom návrhu
    // teda „Poslať cenu". Predtým tu ostávalo „Poslať návrh", hoci už nebolo čo posielať.
    check(
        "R03-1 + W5: návrh first → step follows the rest ('Poslať cenu'), last price + call → CALL; price first → 'Poslať návrh', last návrh + call → CALL",
        codeOf(aDesign) === "OK" && aMid.nextActionKind === "SEND_QUOTE" && codeOf(aPrice) === "OK" && aEnd.nextActionKind === "CALL" &&
            bMid.nextActionKind === "SEND_DESIGN" && codeOf(bDesign) === "OK" && bEnd.nextActionKind === "CALL" &&
            (await pending(a.id)).length === 0 && (await pending(b.id)).length === 0,
        `a: ${codeOf(aDesign)} ${aMid.nextActionKind} → ${codeOf(aPrice)} ${aEnd.nextActionKind}; b: ${bMid.nextActionKind} → ${codeOf(bDesign)} ${bEnd.nextActionKind}`,
    );
};

// W3-2 zámok: každý zapisovač kroku/stavu vráti STEP_LOCKED; fakt (každý druh kontaktu) prejde, posunie „Naposledy",
// krok nezmení – aj keď kontakt zapíše manažér; zrušiť + zmeniť je jedna transakcia s jednou revíziou.
tests.w3Lock = async () => {
    const { work, pipeline, lead, ask, follow, queries, dealScope, send } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await ask(rep, id, manager.id, { contents: ["DESIGN"], step: { kind: "SEND_DESIGN" } });
    const locked = await lead(id);

    const writers = await Promise.all([
        follow(rep, id, { nextKind: "CALL", schedule: { kind: "daysFromToday", days: 2 } }),
        follow(rep, id, { contact: "NONE", nextKind: "WAITING_FOR_CLIENT" }),
        work.logFollowUpAs(rep, { leadId: id, outcome: "SNOOZE", schedule: { kind: "monthsFromToday", months: 2 }, expectedRevision: locked.revision, idempotencyKey: key() }),
        work.logFollowUpAs(rep, { leadId: id, outcome: "NOT_INTERESTED", expectedRevision: locked.revision, idempotencyKey: key() }),
        work.setDealNextActionAs(rep, id, { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 } }, locked.revision),
        pipeline.setNextActionAs(manager, id, { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 } }, locked.revision),
        pipeline.changeStatusAs(manager, id, { status: "SNOOZED", expectedRevision: locked.revision, idempotencyKey: key() }),
        pipeline.changeStatusAs(manager, id, { status: "WON", expectedRevision: locked.revision, idempotencyKey: key() }),
        pipeline.markLostAs(manager, id, { reason: "x", expectedRevision: locked.revision, idempotencyKey: key() }),
    ]);
    const unchanged = await lead(id);
    check(
        "W3-2: every step/status writer returns STEP_LOCKED while a task is open; nothing changes",
        writers.every((w) => codeOf(w) === "ERR:STEP_LOCKED") && unchanged.revision === locked.revision && unchanged.nextActionKind === "SEND_DESIGN",
        writers.map(codeOf).join(","),
    );

    const facts: [string, () => Promise<unknown>][] = [
        ["answered + reply", () => follow(rep, id, { keepLockedStep: true, reply: "DECIDING", note: "porada v piatok" })],
        ["no answer", () => follow(rep, id, { outcome: "NO_ANSWER", keepLockedStep: true })],
        ["replied", () => follow(rep, id, { contact: "REPLIED", keepLockedStep: true, reply: "WANTS_CHANGES", note: "chce modrú" })],
        ["sms", () => follow(rep, id, { contact: "SMS", keepLockedStep: true, note: "posielam info" })],
        ["phone price (no price task)", () => follow(rep, id, { keepLockedStep: true, phonePrice: { amount: 700 } })],
        ["manager's own call on the rep's deal", () => follow(manager, id, { keepLockedStep: true, note: "volal som, chce modrú" })],
        ["send while locked (followUp forced off)", () => send(rep, id, { contents: ["ABOUT_US"], followUp: true })],
    ];
    const wrong: string[] = [];
    for (const [name, fn] of facts) {
        const before = await lead(id);
        const r = await fn();
        const after = await lead(id);
        const same = after.nextActionKind === before.nextActionKind && after.nextActionAt === null && after.nextActionNote === before.nextActionNote && after.status === before.status;
        if (codeOf(r) !== "OK" || !same || after.revision !== before.revision + 1) wrong.push(`${name}: ${codeOf(r)} same=${same} Δ=${after.revision - before.revision}`);
    }
    const row = (await queries.getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id);
    check(
        "W3-2: fact-only contact of every kind (and the manager's call) saves, moves 'Naposledy', leaves the locked step, one bump each",
        wrong.length === 0 && row?.lastActivity?.type === "OFFER_SENT" && (await prisma.dealTask.count({ where: { leadId: id, status: "OPEN" } })) === 1,
        `${wrong.join("; ")} last=${row?.lastActivity?.type}`,
    );

    const bad = await Promise.all([
        follow(rep, id, { keepLockedStep: true, stepNote: "x" }),
        follow(rep, id, { keepLockedStep: true, nextKind: "CALL" }),
        follow(rep, id, { keepLockedStep: true, contact: "NONE" }),
        work.logFollowUpAs(rep, { leadId: id, outcome: "SNOOZE", keepLockedStep: true, schedule: { kind: "monthsFromToday", months: 2 }, expectedRevision: await leadRev(id), idempotencyKey: key() }),
    ]);
    check("W3-2: fact-only mode rejects any step / status input", bad.every((b) => codeOf(b) !== "OK"), bad.map(codeOf).join(","));

    // Zrušiť + zmeniť: uspanie s dôvodom; zlé id úlohy = STALE; bez dôvodu = odmietnuté.
    const task = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id, status: "OPEN" } })).id;
    const noReason = await work.logFollowUpAs(rep, { leadId: id, outcome: "SNOOZE", schedule: { kind: "monthsFromToday", months: 2 }, cancelTask: { taskId: task }, expectedRevision: await leadRev(id), idempotencyKey: key() });
    const wrongId = await work.logFollowUpAs(rep, { leadId: id, outcome: "SNOOZE", schedule: { kind: "monthsFromToday", months: 2 }, cancelTask: { taskId: "nope", reason: "x" }, expectedRevision: await leadRev(id), idempotencyKey: key() });
    const managerReplan = await follow(manager, id, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 1 }, cancelTask: { taskId: task, reason: "ja" } });
    const beforeSnooze = await leadRev(id);
    const snooze = await work.logFollowUpAs(rep, { leadId: id, outcome: "SNOOZE", schedule: { kind: "monthsFromToday", months: 2 }, cancelTask: { taskId: task, reason: "klient až na jar" }, expectedRevision: beforeSnooze, idempotencyKey: key() });
    const t = await prisma.dealTask.findUniqueOrThrow({ where: { id: task } });
    const s = await lead(id);
    const cancelRow = await prisma.activity.findFirst({ where: { taskId: task, type: "TASK_CANCELLED" }, select: { idempotencyKey: true } });
    check(
        "W3-2: cancel + snooze = one transaction (task CANCELLED with reason, status SNOOZED, one bump); wrong id STALE; no reason refused; a manager cannot cancel by replanning",
        codeOf(noReason) !== "OK" && codeOf(wrongId) === "ERR:STALE" && codeOf(managerReplan) === "ERR:FORBIDDEN" && codeOf(snooze) === "OK" &&
            t.status === "CANCELLED" && t.closeReason === "klient až na jar" && s.status === "SNOOZED" && s.nextActionAt !== null &&
            s.revision === beforeSnooze + 1 && cancelRow !== null && cancelRow.idempotencyKey === null,
        `${codeOf(noReason)} ${codeOf(wrongId)} ${codeOf(managerReplan)} ${codeOf(snooze)} task=${t.status} status=${s.status} rev+${s.revision - beforeSnooze}`,
    );

    // Manažérov stavový výber a „Stratené" rušia úlohu tým istým parametrom; zlé číslo (obchodník) tiež.
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id);
    const t2 = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id2, status: "OPEN" } })).id;
    const won = await pipeline.changeStatusAs(manager, id2, { status: "WON", expectedRevision: await leadRev(id2), idempotencyKey: key(), cancelTask: { taskId: t2 } });
    const id3 = await makeDeal(rep);
    await ask(rep, id3, manager.id);
    const t3 = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id3, status: "OPEN" } })).id;
    const bad3 = await work.logFollowUpAs(rep, { leadId: id3, outcome: "BAD_NUMBER", cancelTask: { taskId: t3 }, expectedRevision: await leadRev(id3), idempotencyKey: key() });
    const [c2, c3] = await Promise.all([prisma.dealTask.findUniqueOrThrow({ where: { id: t2 } }), prisma.dealTask.findUniqueOrThrow({ where: { id: t3 } })]);
    const [l2, l3] = await Promise.all([lead(id2), lead(id3)]);
    check(
        "W3-2: manager status select (WON) and rep 'zlé číslo' cancel the task with 'obchod uzavretý' in the same save (I7)",
        codeOf(won) === "OK" && codeOf(bad3) === "OK" && c2.status === "CANCELLED" && c3.status === "CANCELLED" &&
            (c2.closeReason ?? "").startsWith("obchod uzavretý") && l2.status === "WON" && l3.status === "UNREACHABLE",
        `${codeOf(won)} ${codeOf(bad3)} ${c2.status}/${c2.closeReason} ${c3.status} ${l2.status} ${l3.status}`,
    );
};

// W3-3 prekryv: odoslanie toho, na čom manažér robí, bez voľby neprejde; „ostáva otvorená" = fakt; „netreba" = zrušiť +
// poslať + follow-up; nesúvisiaci obsah voľbu nepotrebuje; manažér „netreba" nemôže.
tests.w3Overlap = async () => {
    const { lead, ask, send, follow, openTask, pipeline, design } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await pipeline.saveQuoteAs(manager, id, { price: 1000, priceNote: null });
    await ask(rep, id, manager.id);
    const noChoice = await send(rep, id, { contents: ["PRICE"] });
    const phoneNoChoice = await follow(rep, id, { keepLockedStep: true, phonePrice: { amount: 1000 } });
    const unrelated = await send(rep, id, { contents: ["ABOUT_US"], followUp: true });
    const keep = await send(rep, id, { contents: ["PRICE"], overlap: "KEEP_OPEN", followUp: true });
    const phoneKeep = await follow(rep, id, { keepLockedStep: true, phonePrice: { amount: 1000 }, overlap: "KEEP_OPEN" });
    const afterKeep = await lead(id);
    const stillOpen = await openTask(id);
    const managerCancel = await send(manager, id, { contents: ["PRICE"], overlap: "WITHDRAW_PARTS", withdrawParts: { taskId: stillOpen!.id, kinds: ["PRICE"], reason: "netreba" } });
    const before = await leadRev(id);
    const cancel = await send(rep, id, { contents: ["PRICE"], overlap: "WITHDRAW_PARTS", withdrawParts: { taskId: stillOpen!.id, kinds: ["PRICE"], reason: "cenu som zistil sám" }, followUp: true });
    const afterCancel = await lead(id);
    const t = await prisma.dealTask.findUniqueOrThrow({ where: { id: stillOpen!.id } });
    check(
        "W3-3: price send / phone price on a price task need a choice; 'keep open' is fact-only; unrelated contents need none",
        codeOf(noChoice) === "ERR:TASK_OVERLAP" && codeOf(phoneNoChoice) === "ERR:TASK_OVERLAP" && codeOf(unrelated) === "OK" &&
            codeOf(keep) === "OK" && codeOf(phoneKeep) === "OK" && afterKeep.nextActionKind === "SEND_QUOTE" && afterKeep.nextActionAt === null && stillOpen !== null,
        `${codeOf(noChoice)} ${codeOf(phoneNoChoice)} ${codeOf(unrelated)} ${codeOf(keep)} ${codeOf(phoneKeep)} step=${afterKeep.nextActionKind}/${afterKeep.nextActionAt}`,
    );
    check(
        "W3-3: 'už to netreba' = cancel + send + follow-up atomically (one bump); a manager cannot cancel the rep's task this way",
        codeOf(managerCancel) === "ERR:FORBIDDEN" && codeOf(cancel) === "OK" && t.status === "CANCELLED" && afterCancel.nextActionKind === "CALL" &&
            afterCancel.nextActionAt !== null && afterCancel.revision === before + 1,
        `${codeOf(managerCancel)} ${codeOf(cancel)} task=${t.status} step=${afterCancel.nextActionKind} rev+${afterCancel.revision - before}`,
    );

    const id2 = await makeDeal(rep);
    const d = await design(manager, id2, "smrek");
    await ask(rep, id2, manager.id, { contents: ["PRICE", "DESIGN"], step: { kind: "SEND_DESIGN" } });
    const designNoChoice = await send(rep, id2, { contents: ["DESIGN"], designIds: [d.id] });
    const combinedPrice = await send(rep, id2, { contents: ["ABOUT_US", "PRICE"], price: { amount: 500, note: null } });
    check("W3-3: a návrh send on a DESIGN task and a price send on a combined task are refused without a choice", codeOf(designNoChoice) === "ERR:TASK_OVERLAP" && codeOf(combinedPrice) === "ERR:TASK_OVERLAP", `${codeOf(designNoChoice)} ${codeOf(combinedPrice)}`);
};

// W3-4 vybavenie: cena bez sumy / návrh bez URL = chyba; DONE uloží cenu aj výsledok, krok dnes; opakovanie; zmena = konflikt;
// „Vybavil som to sám" = jedno OFFER_SENT s fulfils + DONE + follow-up naraz; zamietnutie drží krok a odomkne.
tests.w3Finish = async () => {
    const { tasks, lead, ask, finish, detail, design, pending, openTask, bt, today } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN"], step: { kind: "SEND_DESIGN" } });
    const noUrl = await design(manager, id, "bezurl", null);
    const good = await design(manager, id, "smrek");
    // Wave 4: odovzdať sa dá aj SAMOTNÝ návrh – cena ostáva otvorená a úloha beží ďalej (§2.1 bod 5).
    const withNoUrl = await finish(manager, id, { price: { amount: 1285, note: null }, designs: [{ id: noUrl.id, version: 1 }] });
    const byRep = await finish(rep, id, { price: { amount: 1285, note: null }, designs: [{ id: good.id, version: 1 }] });
    const task = (await openTask(id))!;
    const k = key();
    const rev = await leadRev(id);
    const input = {
        taskId: task.id,
        expectedRevision: rev,
        idempotencyKey: k,
        parts: [
            { kind: "PRICE" as const, op: "DELIVER" as const, price: { amount: 1285, note: "Web 900 · eshop 385" } },
            { kind: "DESIGN" as const, op: "DELIVER" as const, designs: [{ id: good.id, version: good.currentVersion }] },
        ],
    };
    const done = await tasks.resolveTaskPartsAs(manager, input);
    const replay = await tasks.resolveTaskPartsAs(manager, input);
    const conflict = await tasks.resolveTaskPartsAs(manager, {
        ...input,
        parts: [{ ...input.parts[0], price: { amount: 1300, note: null } }, input.parts[1]],
    });
    const l = await lead(id);
    const t = await prisma.dealTask.findUniqueOrThrow({ where: { id: task.id } });
    const d = await detail(id, rep);
    const p = await pending(id);
    check(
        "W3-4 / wave 4: a návrh without a URL is refused, the rep cannot deliver; delivering both parts saves the price + result, closes the task, step due today, one bump",
        codeOf(withNoUrl) !== "OK" && codeOf(byRep) === "ERR:FORBIDDEN" && codeOf(done) === "OK" &&
            Number(l.price) === 1285 && l.priceNote === "Web 900 · eshop 385" && t.status === "DONE" && t.closedById === manager.id &&
            l.nextActionKind === "SEND_DESIGN" && l.nextActionAt !== null && bt.businessDate(l.nextActionAt) === today && l.revision === rev + 1 &&
            d?.section === "TODAY" && p.length === 2,
        `${codeOf(withNoUrl)} ${codeOf(byRep)} ${codeOf(done)} price=${l.price} status=${t.status} section=${d?.section} pending=${p.length}`,
    );
    check("W3-4: finish retry with the same key = OK, with a changed amount = conflict", codeOf(replay) === "OK" && codeOf(conflict) === "ERR:IDEMPOTENCY_CONFLICT", `${codeOf(replay)} ${codeOf(conflict)}`);

    // „Vybavil som to sám"
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id);
    const t2 = (await openTask(id2))!;
    const k2 = key();
    const rev2 = await leadRev(id2);
    const fsInput = {
        taskId: t2.id,
        expectedRevision: rev2,
        idempotencyKey: k2,
        parts: [{ kind: "PRICE" as const, op: "DELIVER" as const, price: { amount: 990, note: null } }],
        extraContents: ["ABOUT_US" as const],
        sentOn: today,
        followUp: true as const,
    };
    const fs = await tasks.finishAndSendAs(manager, fsInput);
    const fsReplay = await tasks.finishAndSendAs(manager, fsInput);
    const fsConflict = await tasks.finishAndSendAs(manager, { ...fsInput, followUpOn: bt.addBusinessCalendarDays(today, 3) });
    const offersRows = await prisma.activity.findMany({ where: { leadId: id2, type: "OFFER_SENT" }, select: { meta: true, userId: true, idempotencyKey: true } });
    const l2 = await lead(id2);
    const t2after = await prisma.dealTask.findUniqueOrThrow({ where: { id: t2.id } });
    const fulfils = (offersRows[0]?.meta as { fulfils?: { taskId: string; kind: string }[] } | null)?.fulfils;
    check(
        "W3-4: 'Vybavil som to sám' = one OFFER_SENT (manager's, fulfils this task) + DONE + follow-up call, one bump; retry OK; changed date = conflict",
        codeOf(fs) === "OK" && codeOf(fsReplay) === "OK" && codeOf(fsConflict) === "ERR:IDEMPOTENCY_CONFLICT" && offersRows.length === 1 &&
            offersRows[0].userId === manager.id && fulfils?.length === 1 && fulfils[0].taskId === t2.id && t2after.status === "DONE" &&
            l2.nextActionKind === "CALL" && l2.revision === rev2 + 1 && (await pending(id2)).length === 0,
        `${codeOf(fs)} ${codeOf(fsReplay)} ${codeOf(fsConflict)} offers=${offersRows.length} fulfils=${JSON.stringify(fulfils)} step=${l2.nextActionKind} rev+${l2.revision - rev2}`,
    );

    // Zamietnutie: dôvod povinný, krok ostáva (odomknutý, dnes), dôvod je vrátená položka.
    const id3 = await makeDeal(rep);
    await ask(rep, id3, manager.id);
    const t3 = (await openTask(id3))!;
    const noReason = await tasks.resolveTaskPartsAs(manager, { taskId: t3.id, expectedRevision: await leadRev(id3), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DECLINE", reason: " " }] });
    const dec = await tasks.resolveTaskPartsAs(manager, { taskId: t3.id, expectedRevision: await leadRev(id3), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DECLINE", reason: "zavolaj im a zisti, čo chcú" }] });
    const l3 = await lead(id3);
    const p3 = await pending(id3);
    check(
        "W3-4: decline needs a reason and unlocks the step due today – a system 'Poslať cenu' is not restored (R02-1), the neutral CALL is – and the reason waits as 'zamietnuté'",
        codeOf(noReason) !== "OK" && codeOf(dec) === "OK" && l3.nextActionKind === "CALL" && l3.nextActionAt !== null &&
            bt.businessDate(l3.nextActionAt) === today && p3.length === 1 && p3[0].kind === "DECLINED" && p3[0].text === "zavolaj im a zisti, čo chcú",
        `${codeOf(noReason)} ${codeOf(dec)} step=${l3.nextActionKind} pending=${JSON.stringify(p3.map((i) => i.kind))}`,
    );
};

// W3-5 vrátené výsledky: položky, fulfils, „Neposielam", nahradená cena, uzavretie, prečiarknutie, I10.
tests.w3Results = async () => {
    const { tasks, work, offers, lead, ask, finish, send, follow, pending, design, pipeline } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const rep2 = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const dA = await design(manager, id, "variantA");
    const dB = await design(manager, id, "variantB");
    await ask(rep, id, manager.id);
    await finish(manager, id, { price: { amount: 1285, note: null } });
    const t1 = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id } })).id;
    await ask(rep, id, manager.id, { contents: ["DESIGN"], step: { kind: "SEND_DESIGN" } });
    await finish(manager, id, { designs: [{ id: dA.id, version: 1 }, { id: dB.id, version: 1 }] });
    const t2 = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id, id: { not: t1 } } })).id;
    const p0 = await pending(id);
    check("W3-5: price done, then návrh done, neither sent → all three items pending together", p0.length === 3 && p0.filter((i) => i.kind === "DESIGN").length === 2, JSON.stringify(p0.map((i) => i.kind)));

    const generic = await send(rep, id, { contents: ["ABOUT_US"] });
    const historical = await send(manager, id, { historical: true, contents: ["PRICE"], price: { amount: 1285, note: null }, sentOn: "2020-01-01", fulfils: [{ taskId: t1, kind: "PRICE" }] });
    const foreignTaskId = await makeDeal(rep2);
    await ask(rep2, foreignTaskId, manager.id);
    const foreign = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: foreignTaskId } })).id;
    const wrongLead = await send(rep, id, { contents: ["PRICE"], fulfils: [{ taskId: foreign, kind: "PRICE" }] });
    const notInSend = await send(rep, id, { contents: ["ABOUT_US"], fulfils: [{ taskId: t1, kind: "PRICE" }] });
    const notInResult = await send(rep, id, { contents: ["PRICE"], fulfils: [{ taskId: t2, kind: "PRICE" }] });
    check(
        "W3-5: a generic send consumes nothing; historical / another lead's task / content not in the send / not in the result → rejected",
        codeOf(generic) === "OK" && (await pending(id)).length === 3 && codeOf(historical) !== "OK" && codeOf(wrongLead) !== "OK" &&
            codeOf(notInSend) !== "OK" && codeOf(notInResult) !== "OK",
        `${codeOf(generic)} ${codeOf(historical)} ${codeOf(wrongLead)} ${codeOf(notInSend)} ${codeOf(notInResult)}`,
    );

    // Pošle cenu (fulfils) + chce „Zavolať, či prišlo" → RESULT_PENDING (návrhy ostávajú); bez follow-upu OK, krok ostáva.
    const priceWithCall = await send(rep, id, { contents: ["PRICE"], fulfils: [{ taskId: t1, kind: "PRICE" }], followUp: true });
    const priceOnly = await send(rep, id, { contents: ["PRICE"], fulfils: [{ taskId: t1, kind: "PRICE" }] });
    const afterPrice = await lead(id);
    const p1 = await pending(id);
    check(
        "W3-5: sending the price consumes only the price; with návrhy still pending the follow-up call is refused (I10), the step stays 'Poslať návrh'",
        codeOf(priceWithCall) === "ERR:RESULT_PENDING" && codeOf(priceOnly) === "OK" && p1.length === 2 && p1.every((i) => i.kind === "DESIGN") &&
            afterPrice.nextActionKind === "SEND_DESIGN",
        `${codeOf(priceWithCall)} ${codeOf(priceOnly)} pending=${p1.map((i) => i.kind).join(",")} step=${afterPrice.nextActionKind}`,
    );

    const toCall = await follow(rep, id, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 2 } });
    const noReason = await tasks.dismissResultsAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), taskId: t2, items: [{ kind: "DESIGN", designId: dB.id }] });
    const k = key();
    const dismissInput = { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: k, taskId: t2, items: [{ kind: "DESIGN" as const, designId: dB.id }], reason: "klient chce len A" };
    const before = await leadRev(id);
    const [d1, d2] = await Promise.all([tasks.dismissResultsAs(rep, dismissInput), tasks.dismissResultsAs(rep, dismissInput)]);
    const p2 = await pending(id);
    const dismissRows = await prisma.activity.count({ where: { leadId: id, type: "TASK_RESULT_DISMISSED" } });
    check(
        "W3-5: a step change to a call is refused while a návrh waits; 'Neposielam' needs a reason, is one row + one bump, retry-safe; návrh A stays",
        codeOf(toCall) === "ERR:RESULT_PENDING" && codeOf(noReason) !== "OK" && codeOf(d1) === "OK" && codeOf(d2) === "OK" && dismissRows === 1 &&
            (await leadRev(id)) === before + 1 && p2.length === 1 && p2[0].designId === dA.id,
        `${codeOf(toCall)} ${codeOf(noReason)} ${codeOf(d1)} ${codeOf(d2)} rows=${dismissRows} pending=${JSON.stringify(p2.map((i) => i.designId === dA.id))}`,
    );

    // Prečiarknutie odoslania, ktoré použilo cenu → cena je znova nevybavená.
    const priceSend = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT", meta: { path: ["fulfils"], array_contains: [{ taskId: t1 }] } } });
    const corr = await offers.correctRecordAs(rep, priceSend.id, "omyl v teste");
    const p3 = await pending(id);
    check("W3-5: crossing out the consuming send brings the price back", codeOf(corr) === "OK" && p3.some((i) => i.kind === "PRICE" && i.taskId === t1), JSON.stringify(p3.map((i) => i.kind)));

    // Zmena kroku s odmietnutím zvyšku v tom istom uložení → OK.
    const dropAll = await follow(rep, id, {
        contact: "NONE",
        nextKind: "CALL",
        schedule: { kind: "daysFromToday", days: 2 },
        dismiss: { items: [{ taskId: t1, kind: "PRICE" }, { taskId: t2, kind: "DESIGN", designId: dA.id }], reason: "klient sa rozmyslel" },
    });
    check("W3-5: a step change with the remaining items dismissed in the same save is allowed", codeOf(dropAll) === "OK" && (await pending(id)).length === 0 && (await lead(id)).nextActionKind === "CALL", codeOf(dropAll));

    // Dve vrátené ceny: jedno odoslanie nesmie použiť obe; jednu použije a staršiu odmietne ako nahradenú.
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id);
    await finish(manager, id2, { price: { amount: 1000, note: null } });
    await ask(rep, id2, manager.id);
    await finish(manager, id2, { price: { amount: 1100, note: null } });
    const [old, fresh] = await prisma.dealTask.findMany({ where: { leadId: id2 }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const both = await send(rep, id2, { contents: ["PRICE"], fulfils: [{ taskId: old.id, kind: "PRICE" }, { taskId: fresh.id, kind: "PRICE" }] });
    const one = await send(rep, id2, {
        contents: ["PRICE"],
        fulfils: [{ taskId: fresh.id, kind: "PRICE" }],
        dismiss: { items: [{ taskId: old.id, kind: "PRICE" }], reason: "nahradená novšou" },
        followUp: true,
    });
    check("W3-5: two pending prices – one send cannot fulfil both; one fulfilled + the older dismissed as superseded → follow-up allowed", codeOf(both) !== "OK" && codeOf(one) === "OK" && (await pending(id2)).length === 0 && (await lead(id2)).nextActionKind === "CALL", `${codeOf(both)} ${codeOf(one)}`);

    // Telefonická cena môže vybaviť vrátenú cenu.
    const id3 = await makeDeal(rep);
    await ask(rep, id3, manager.id);
    await finish(manager, id3, { price: { amount: 800, note: null } });
    const t3 = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id3 } })).id;
    const phone = await follow(rep, id3, { phonePrice: { amount: 800 }, fulfils: [{ taskId: t3, kind: "PRICE" }], nextKind: "SEND_QUOTE" });
    check("W3-5: a phone price can fulfil a returned price", codeOf(phone) === "OK" && (await pending(id3)).length === 0, codeOf(phone));

    // Uzavretie odmietne všetko s „obchod uzavretý"; znovuotvorenie nič neoživí; manažér rozhoduje na obchode bez vlastníka.
    const id4 = await makeDeal(rep);
    await ask(rep, id4, manager.id);
    await finish(manager, id4, { price: { amount: 700, note: null } });
    const lost = await work.logFollowUpAs(rep, { leadId: id4, outcome: "NOT_INTERESTED", expectedRevision: await leadRev(id4), idempotencyKey: key() });
    const closedDismiss = await prisma.activity.findFirst({ where: { leadId: id4, type: "TASK_RESULT_DISMISSED" }, select: { meta: true } });
    await pipeline.reopenDealAs(manager, id4, { expectedRevision: await leadRev(id4), idempotencyKey: key() });
    check(
        "W3-5: closing dismisses pending items with 'obchod uzavretý'; reopening does not revive them",
        codeOf(lost) === "OK" && (closedDismiss?.meta as { reason?: string } | null)?.reason === "obchod uzavretý" && (await pending(id4)).length === 0,
        `${codeOf(lost)} ${JSON.stringify(closedDismiss?.meta)}`,
    );
    const id5 = await makeDeal(rep);
    await ask(rep, id5, manager.id);
    await finish(manager, id5, { price: { amount: 600, note: null } });
    const t5 = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id5 } })).id;
    const onRepDeal = await tasks.dismissResultsAs(manager, { leadId: id5, expectedRevision: await leadRev(id5), idempotencyKey: key(), taskId: t5, items: [{ kind: "PRICE" }], reason: "x" });
    await pipeline.changeOwnerAs(manager, id5, { ownerId: null, expectedRevision: await leadRev(id5), idempotencyKey: key() });
    const kept = (await pending(id5)).length;
    const onUnassigned = await tasks.dismissResultsAs(manager, { leadId: id5, expectedRevision: await leadRev(id5), idempotencyKey: key(), taskId: t5, items: [{ kind: "PRICE" }], reason: "bez vlastníka" });
    check(
        "W3-5: a manager cannot decide on the rep's result; the deal moved to nobody keeps it; then the manager may dismiss it",
        codeOf(onRepDeal) === "ERR:FORBIDDEN" && kept === 1 && codeOf(onUnassigned) === "OK" && (await pending(id5)).length === 0,
        `${codeOf(onRepDeal)} kept=${kept} ${codeOf(onUnassigned)}`,
    );

    // Odpoveď „Iné" a zamietnutie ostávajú, kým ich obchodník nevezme na vedomie (aj pre-ticked riadkom v ďalšom kontakte).
    const id6 = await makeDeal(rep);
    await ask(rep, id6, manager.id, { contents: ["OTHER"], step: { kind: "CALL" } });
    await finish(manager, id6, { answer: "áno, EN verzia je v cene" });
    const t6 = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id6 } })).id;
    const plainCall = await follow(rep, id6, { outcome: "NO_ANSWER" });
    const stays = (await pending(id6)).length;
    const acked = await follow(rep, id6, { outcome: "NO_ANSWER", dismiss: { items: [{ taskId: t6, kind: "OTHER" }] } });
    check("W3-5: an 'Iné' answer stays after an unrelated call and goes with the pre-ticked 'Beriem na vedomie' in the next contact", codeOf(plainCall) === "OK" && stays === 1 && codeOf(acked) === "OK" && (await pending(id6)).length === 0, `${codeOf(plainCall)} stays=${stays} ${codeOf(acked)}`);
};

// W3-6 odovzdanie: prijatie cez kartu úlohy aj cez výber vlastníka = DONE + HANDOVER; odmietnutie odomkne.
tests.w3Handover = async () => {
    const { tasks, pipeline, lead, ask, detail, queries } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const h = await ask(rep, id, manager.id, { type: "HANDOVER", contents: [], step: undefined, text: "chce riešiť technické detaily" });
    const before = await lead(id);
    const accept = await tasks.takeoverAs(manager, { leadId: id, expectedRevision: before.revision, idempotencyKey: key(), note: "preberám", step: { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 }, note: "zistiť detaily" } });
    const after = await lead(id);
    const t = await prisma.dealTask.findFirstOrThrow({ where: { leadId: id } });
    const own = await prisma.dealOwnership.findFirst({ where: { leadId: id, reason: "HANDOVER" } });
    const repView = await detail(id, rep);
    const hist = await queries.getHandedOverHistory(rep.id);
    check(
        "W3-6: handover accepted via the task card → owner = manager, task DONE, DealOwnership(HANDOVER), his step, rep loses access and sees it in História",
        codeOf(h) === "OK" && before.nextActionAt === null && codeOf(accept) === "OK" && after.ownerId === manager.id && t.status === "DONE" &&
            own?.fromUserId === rep.id && after.nextActionKind === "CALL" && after.nextActionNote === "zistiť detaily" && after.revision === before.revision + 1 &&
            repView === null && hist.some((r) => r.leadId === id && r.reason === "HANDOVER"),
        `${codeOf(h)} ${codeOf(accept)} owner=${after.ownerId === manager.id} task=${t.status} own=${Boolean(own)} repView=${Boolean(repView)} rev+${after.revision - before.revision}`,
    );

    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id, { type: "HANDOVER", contents: [], step: undefined, text: "idú do toho" });
    const viaSelect = await pipeline.changeOwnerAs(manager, id2, { ownerId: manager.id, expectedRevision: await leadRev(id2), idempotencyKey: key() });
    const t2 = await prisma.dealTask.findFirstOrThrow({ where: { leadId: id2 } });
    const own2 = await prisma.dealOwnership.findFirst({ where: { leadId: id2, reason: "HANDOVER" } });
    const l2 = await lead(id2);
    check(
        "W3-6: handover accepted via the owner select → the same outcome (DONE + HANDOVER), step due today",
        codeOf(viaSelect) === "OK" && t2.status === "DONE" && own2 !== null && l2.ownerId === manager.id && l2.nextActionAt !== null,
        `${codeOf(viaSelect)} ${t2.status} own=${Boolean(own2)}`,
    );

    const id3 = await makeDeal(rep);
    await ask(rep, id3, manager.id, { type: "HANDOVER", contents: [], step: undefined, text: "detaily" });
    const t3 = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id3 } })).id;
    const dec = await tasks.declineHandoverAs(manager, { taskId: t3, expectedRevision: await leadRev(id3), idempotencyKey: key(), reason: "pokračuj ty" });
    const l3 = await lead(id3);
    check("W3-6: 'Nie, pokračuj ty' → DECLINED, rep keeps the deal, step unlocked and due", codeOf(dec) === "OK" && l3.ownerId === rep.id && l3.nextActionAt !== null && (await prisma.dealTask.findUniqueOrThrow({ where: { id: t3 } })).status === "DECLINED", codeOf(dec));

    const onOwn = await tasks.takeoverAs(manager, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), step: { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 } } });
    const byRep = await tasks.takeoverAs(rep, { leadId: id3, expectedRevision: await leadRev(id3), idempotencyKey: key(), step: { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 } } });
    check("W3-6: takeover of an own deal / by a rep is refused", codeOf(onOwn) === "ERR:FORBIDDEN" && codeOf(byRep) === "ERR:FORBIDDEN", `${codeOf(onOwn)} ${codeOf(byRep)}`);
};

// W3-7 prechod vlastníka: obchodník / manažér / nikto × HELP / HANDOVER; jednotlivo aj hromadne; DealOwnership na každú zmenu.
tests.w3OwnerTransition = async () => {
    const { pipeline, lead, ask, openTask } = await w3();
    const manager = await makeUser("MANAGER");
    const manager2 = await makeUser("MANAGER");
    const repA = await makeUser("SALES_REP");
    const repB = await makeUser("SALES_REP");
    const change = async (id: string, ownerId: string | null, taskAssigneeId?: string) =>
        pipeline.changeOwnerAs(manager, id, { ownerId, expectedRevision: await leadRev(id), idempotencyKey: key(), ...(taskAssigneeId ? { taskAssigneeId } : {}) });

    const toRep = await makeDeal(repA);
    await ask(repA, toRep, manager.id);
    const r1 = await change(toRep, repB.id, manager2.id);
    const t1 = await openTask(toRep);
    const l1 = await lead(toRep);
    const toMgr = await makeDeal(repA);
    await ask(repA, toMgr, manager.id);
    const r2 = await change(toMgr, manager2.id);
    const t2 = await prisma.dealTask.findFirstOrThrow({ where: { leadId: toMgr } });
    const l2 = await lead(toMgr);
    const toNobody = await makeDeal(repA);
    await ask(repA, toNobody, manager.id, { type: "HANDOVER", contents: [], step: undefined, text: "detaily" });
    const r3 = await change(toNobody, null);
    const t3 = await prisma.dealTask.findFirstOrThrow({ where: { leadId: toNobody } });
    const handToRep = await makeDeal(repA);
    await ask(repA, handToRep, manager.id, { type: "HANDOVER", contents: [], step: undefined, text: "detaily" });
    const r4 = await change(handToRep, repB.id);
    const t4 = await openTask(handToRep);
    const rows = await prisma.dealOwnership.findMany({ where: { leadId: { in: [toRep, toMgr, toNobody, handToRep] }, reason: { in: ["CHANGE", "HANDOVER"] } } });
    check(
        "W3-7: → rep keeps the task (reassigned as chosen, still locked); → manager cancels HELP (step due today); → nobody cancels; HANDOVER → rep stays open",
        [r1, r2, r3, r4].every((r) => codeOf(r) === "OK") && t1?.assigneeId === manager2.id && l1.ownerId === repB.id && l1.nextActionAt === null &&
            t2.status === "CANCELLED" && (t2.closeReason ?? "").startsWith("klienta prevzal") && l2.nextActionAt !== null &&
            t3.status === "CANCELLED" && t3.closeReason === "obchod bez vlastníka" && t4 !== null && rows.length === 4,
        `${[r1, r2, r3, r4].map(codeOf).join(",")} t1=${t1?.assigneeId === manager2.id} t2=${t2.status} t3=${t3.status}/${t3.closeReason} t4=${Boolean(t4)} rows=${rows.length}`,
    );
    const toAssignee = await change(toRep, repA.id, repA.id);
    check("W3-7: the task can never go to a non-resolver (assignee choice refused)", codeOf(toAssignee) === "ERR:FORBIDDEN", codeOf(toAssignee));

    // Hromadne: 3 obchody A → B (úlohy ostávajú), potom B → manažér (HELP zrušená, HANDOVER prijaté); opakovanie s tým istým id.
    const bulkIds: string[] = [];
    for (let i = 0; i < 3; i++) bulkIds.push(await makeDeal(repA));
    await ask(repA, bulkIds[0], manager.id);
    await ask(repA, bulkIds[1], manager.id, { type: "HANDOVER", contents: [], step: undefined, text: "detaily" });
    const opId = key();
    const bulkInput = { operationId: opId, fromOwnerId: repA.id, toOwnerId: repB.id, taskAssigneeId: manager2.id };
    const b1 = await pipeline.transferDealsAs(manager, bulkInput);
    const b1again = await pipeline.transferDealsAs(manager, bulkInput);
    const bConflict = await pipeline.transferDealsAs(manager, { ...bulkInput, toOwnerId: manager.id });
    const afterBulk = await prisma.lead.findMany({ where: { id: { in: bulkIds } }, select: { ownerId: true } });
    const bulkTasks = await prisma.dealTask.findMany({ where: { leadId: { in: bulkIds } }, select: { status: true, assigneeId: true } });
    const bulkRows = await prisma.dealOwnership.count({ where: { leadId: { in: bulkIds }, reason: "BULK" } });
    check(
        "W3-7: bulk to a rep keeps tasks (assignee as chosen), one BULK row per deal; retry same id = same total, nothing twice; other target same id = conflict",
        "moved" in b1 && b1.moved >= 3 && "moved" in b1again && b1again.moved === b1.moved && codeOf(bConflict) === "ERR:IDEMPOTENCY_CONFLICT" &&
            afterBulk.every((l) => l.ownerId === repB.id) && bulkTasks.every((t) => t.status === "OPEN" && t.assigneeId === manager2.id) && bulkRows === 3,
        `b1=${JSON.stringify(b1)} again=${JSON.stringify(b1again)} conflict=${codeOf(bConflict)} tasks=${JSON.stringify(bulkTasks)} rows=${bulkRows}`,
    );
    const b2 = await pipeline.transferDealsAs(manager, { operationId: key(), fromOwnerId: repB.id, toOwnerId: manager.id });
    const tasksAfter = await prisma.dealTask.findMany({ where: { leadId: { in: bulkIds } }, select: { type: true, status: true } });
    const reasons = await prisma.dealOwnership.findMany({ where: { leadId: { in: bulkIds }, toUserId: manager.id }, select: { reason: true } });
    check(
        "W3-7: bulk to a manager ends tasks – HELP cancelled, HANDOVER accepted (reason HANDOVER)",
        "moved" in b2 && tasksAfter.find((t) => t.type === "HELP")?.status === "CANCELLED" && tasksAfter.find((t) => t.type === "HANDOVER")?.status === "DONE" &&
            reasons.filter((r) => r.reason === "HANDOVER").length === 1 && reasons.filter((r) => r.reason === "BULK").length >= 2,
        `b2=${JSON.stringify(b2)} tasks=${JSON.stringify(tasksAfter)} reasons=${reasons.map((r) => r.reason).join(",")}`,
    );
};

// W3-8 D14 + zámky: deaktivácia / zmena roly odmietnutá s obchodmi alebo úlohami; súbežne s vytvorením úlohy nikdy
// nevznikne deaktivovaný manažér s otvorenou úlohou.
tests.w3Deactivation = async () => {
    const { deactivateUserAs, updateUserProfileAs } = await import("../../lib/commands/admin");
    const { ask, pipeline, openTask, tasks } = await w3();
    const admin = await makeUser("ADMIN");
    const manager = await makeUser("MANAGER");
    const manager2 = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const withDeal = await deactivateUserAs(admin, rep.id);
    const demote = await updateUserProfileAs(admin, rep.id, { firstName: rep.firstName, lastName: "x", username: rep.username, email: null, phone: null, role: "TELESALES", note: null });
    await ask(rep, id, manager.id);
    const withTask = await deactivateUserAs(admin, manager.id);
    const demoteMgr = await updateUserProfileAs(admin, manager.id, { firstName: manager.firstName, lastName: "x", username: manager.username, email: null, phone: null, role: "SALES_REP", note: null });
    const t = await openTask(id);
    await tasks.reassignTaskAs(manager, { taskId: t!.id, expectedRevision: await leadRev(id), idempotencyKey: key(), assigneeId: manager2.id });
    const afterMove = await deactivateUserAs(admin, manager.id);
    await pipeline.changeOwnerAs(admin, id, { ownerId: manager2.id, expectedRevision: await leadRev(id), idempotencyKey: key() });
    const repAfter = await deactivateUserAs(admin, rep.id);
    check(
        "W3-8 (D14): deactivation / demotion refused with owned open deals or assigned open tasks; allowed after moving them",
        !withDeal.ok && withDeal.error.includes("obchod") && !demote.ok && !withTask.ok && withTask.error.includes("úloh") && !demoteMgr.ok &&
            afterMove.ok && repAfter.ok,
        `${withDeal.ok ? "OK" : withDeal.error} | ${demote.ok ? "OK" : demote.error} | ${withTask.ok ? "OK" : withTask.error} | ${demoteMgr.ok} | ${afterMove.ok} | ${repAfter.ok}`,
    );

    // Súbežne: vytvorenie úlohy pre manažéra vs jeho deaktivácia → nikdy deaktivovaný s otvorenou úlohou.
    const n = Math.min(ITER, 15);
    let bad = 0;
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
        const m = await makeUser("MANAGER");
        const r = await makeUser("SALES_REP");
        const deal = await makeDeal(r);
        const rev = await leadRev(deal);
        const input = { leadId: deal, expectedRevision: rev, idempotencyKey: key(), type: "HELP" as const, contents: ["PRICE" as const], text: "x", assigneeId: m.id, step: { kind: "SEND_QUOTE" as const } };
        // Striedavo: deaktivácia hneď, alebo o chvíľu neskôr – aby vyhrali obe poradia (úloha skôr → deaktivácia odmietnutá).
        const [a, d] = await Promise.all([
            tasks.askManagerAs(r, input),
            (async () => {
                await sleep(i % 2 === 0 ? 0 : 150 + (i % 3) * 50);
                return deactivateUserAs(admin, m.id);
            })(),
        ]);
        const k = `ask=${codeOf(a)} deact=${d.ok ? "OK" : d.code ?? "refused"}`;
        outcomes[k] = (outcomes[k] ?? 0) + 1;
        const u = await prisma.user.findUniqueOrThrow({ where: { id: m.id }, select: { deletedAt: true } });
        const held = await prisma.dealTask.count({ where: { assigneeId: m.id, status: "OPEN" } });
        if (u.deletedAt && held > 0) bad++;
        await prisma.lead.update({ where: { id: deal }, data: { status: "LOST", closedAt: new Date() } });
        await prisma.dealTask.updateMany({ where: { leadId: deal, status: "OPEN" }, data: { status: "CANCELLED" } });
    }
    check(`W3-8: ask vs deactivation of the assignee (${n}×) – never a deactivated manager with an open task`, bad === 0, `bad=${bad} ${JSON.stringify(outcomes)}`);

    // Vybavenie vs presun tej istej úlohy súbežne → presne jedno prejde, druhé STALE.
    const rep2 = await makeUser("SALES_REP");
    const race = await makeDeal(rep2);
    await ask(rep2, race, manager2.id);
    const task = (await openTask(race))!;
    const rev = await leadRev(race);
    const [f, r] = await Promise.all([
        tasks.resolveTaskPartsAs(manager2, { taskId: task.id, expectedRevision: rev, idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1, note: null } }] }),
        tasks.reassignTaskAs(admin, { taskId: task.id, expectedRevision: rev, idempotencyKey: key(), assigneeId: admin.id }),
    ]);
    check("W3-8: finish vs reassign on the same revision → exactly one wins", [f, r].filter((x) => codeOf(x) === "OK").length === 1, `${codeOf(f)} ${codeOf(r)}`);
};

// W3-9 čerstvosť a dvojklik: stará revízia = STALE; paralelný dvojklik = jeden efekt, obe OK.
tests.w3Freshness = async () => {
    const { tasks, pipeline, ask, finish } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const repB = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const old = (await leadRev(id)) - 1;
    const stale = await Promise.all([
        tasks.takeoverAs(manager, { leadId: id, expectedRevision: old, idempotencyKey: key(), step: { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 } } }),
        pipeline.changeOwnerAs(manager, id, { ownerId: repB.id, expectedRevision: old, idempotencyKey: key() }),
        pipeline.changeStatusAs(manager, id, { status: "SNOOZED", expectedRevision: old, idempotencyKey: key() }),
        pipeline.markLostAs(manager, id, { reason: null, expectedRevision: old, idempotencyKey: key() }),
        tasks.askManagerAs(rep, { leadId: id, expectedRevision: old, idempotencyKey: key(), type: "HELP", contents: ["PRICE"], text: "x", assigneeId: manager.id, step: { kind: "SEND_QUOTE" } }),
    ]);
    check("W3-9: takeover / owner / status / lost / ask with an old revision → STALE", stale.every((s) => codeOf(s) === "ERR:STALE"), stale.map(codeOf).join(","));

    const twice = async (label: string, run: (k: string, rev: number) => Promise<unknown>, count: () => Promise<number>) => {
        const k = key();
        const rev = await leadRev(id);
        const rs = await Promise.all([run(k, rev), run(k, rev)]);
        const n = await count();
        return { label, ok: rs.every((r) => codeOf(r) === "OK") && n === 1, detail: `${label}: ${rs.map(codeOf).join(",")} rows=${n}` };
    };
    const results = [
        await twice("changeOwner", (k, rev) => pipeline.changeOwnerAs(manager, id, { ownerId: repB.id, expectedRevision: rev, idempotencyKey: k }), () => prisma.dealOwnership.count({ where: { leadId: id, toUserId: repB.id } })),
        await twice("changeStatus", (k, rev) => pipeline.changeStatusAs(manager, id, { status: "SNOOZED", expectedRevision: rev, idempotencyKey: k }), () => prisma.activity.count({ where: { leadId: id, type: "STATUS_CHANGED" } })),
        await twice("markLost", (k, rev) => pipeline.markLostAs(manager, id, { reason: "x", expectedRevision: rev, idempotencyKey: k }), async () => (await prisma.activity.count({ where: { leadId: id, type: "STATUS_CHANGED" } })) - 1),
        await twice("reopen", (k, rev) => pipeline.reopenDealAs(manager, id, { expectedRevision: rev, idempotencyKey: k }), () => prisma.activity.count({ where: { leadId: id, type: "DEAL_REOPENED" } })),
        await twice("takeover", (k, rev) => tasks.takeoverAs(manager, { leadId: id, expectedRevision: rev, idempotencyKey: k, step: { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 } } }), () => prisma.dealOwnership.count({ where: { leadId: id, reason: "TAKEOVER" } })),
    ];
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id);
    await finish(manager, id2, { price: { amount: 100, note: null } });
    const t = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id2 } })).id;
    const k = key();
    const rev2 = await leadRev(id2);
    const dis = await Promise.all([0, 1].map(() => tasks.dismissResultsAs(rep, { leadId: id2, expectedRevision: rev2, idempotencyKey: k, taskId: t, items: [{ kind: "PRICE" }], reason: "nie" })));
    const disRows = await prisma.activity.count({ where: { leadId: id2, type: "TASK_RESULT_DISMISSED" } });
    results.push({ label: "dismiss", ok: dis.every((r) => codeOf(r) === "OK") && disRows === 1, detail: `dismiss: ${dis.map(codeOf).join(",")} rows=${disRows}` });
    check("W3-9: double click on owner / status / lost / reopen / takeover / dismiss → both OK, one effect", results.every((r) => r.ok), results.map((r) => r.detail).join(" | "));
};

// W3-10 zámok TS ↔ SQL, žiadny akčný pohľad nemá zamknutý obchod, počty pilulek = celé zoznamy pri všetkých filtroch.
tests.w3LockParity = async () => {
    const { queries, dealScope } = await w3();
    const { isStepLocked } = await import("../../lib/domain/tasks");
    const { STEP_LOCKED_SQL } = await import("../../lib/queries/pipeline");
    const { Prisma } = await import("../../app/generated/prisma/client");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const taskStates = [null, "OPEN-HELP", "OPEN-HANDOVER", "DONE", "DECLINED", "CANCELLED"] as const;
    const statuses = ["ACTIVE", "SNOOZED", "LOST"] as const;
    const ids: string[] = [];
    for (const ts of taskStates) {
        for (const status of statuses) {
            leadSeq++;
            const l = await prisma.lead.create({
                data: {
                    companyName: `CC-TEST ${RUN} lock ${leadSeq}`,
                    phone: `+000 ${RUN} l${leadSeq}`,
                    status,
                    pipelineEnteredAt: new Date(),
                    ownerId: rep.id,
                    closedAt: status === "LOST" ? new Date() : null,
                    nextActionKind: "CALL",
                    nextActionAt: ts?.startsWith("OPEN") ? null : new Date(Date.now() - 86_400_000),
                },
                select: { id: true },
            });
            createdLeads.push(l.id);
            ids.push(l.id);
            if (ts) {
                await prisma.dealTask.create({
                    data: {
                        leadId: l.id,
                        type: ts === "OPEN-HANDOVER" ? "HANDOVER" : "HELP",
                        status: ts === "OPEN-HELP" || ts === "OPEN-HANDOVER" ? "OPEN" : ts,
                        text: "x",
                        requestedById: rep.id,
                        assigneeId: manager.id,
                        ...(ts === "OPEN-HANDOVER"
                            ? {}
                            : {
                                  parts: {
                                      create: [
                                          {
                                              kind: "PRICE" as const,
                                              status: ts === "OPEN-HELP" ? ("REQUESTED" as const) : ts === "DONE" ? ("DELIVERED" as const) : ts === "DECLINED" ? ("DECLINED" as const) : ("WITHDRAWN" as const),
                                              addedById: rep.id,
                                          },
                                      ],
                                  },
                              }),
                    },
                });
            }
        }
    }
    const tsLocked = await prisma.lead.findMany({ where: { id: { in: ids } }, select: { id: true, tasks: { select: { status: true } } } });
    const sqlLocked = await prisma.$queryRaw<{ id: string; locked: boolean }[]>(Prisma.sql`SELECT l.id, ${STEP_LOCKED_SQL} AS locked FROM "Lead" l WHERE l.id = ANY(${ids})`);
    const mismatch = tsLocked.filter((l) => isStepLocked(l.tasks) !== sqlLocked.find((s) => s.id === l.id)?.locked);
    check(`W3-10: isStepLocked ↔ STEP_LOCKED_SQL agree over ${ids.length} task × status combinations`, mismatch.length === 0 && ids.length === 18, `mismatch=${mismatch.length}`);

    // Zamknutý obchod nie je nikde na riešenie: Na dnes, pilulky druhu kroku, dashboard (dnes + kalendár), manažérove „po termíne".
    const { getDealsToday } = await import("../../lib/queries/today");
    const { getManagerToday } = await import("../../lib/queries/today/manager");
    const lockedIds = new Set(tsLocked.filter((l) => isStepLocked(l.tasks)).map((l) => l.id));
    const scope = dealScope(rep);
    const owner = { userId: rep.id } as const;
    const views = ["today", "call", "quote", "email", "design", "waiting"];
    const leaks: string[] = [];
    for (const view of views) {
        const { rows } = await queries.getDealList({ scope, owner, view, take: 5000, viewerId: rep.id });
        if (rows.some((r) => lockedIds.has(r.id))) leaks.push(view);
    }
    const dash = await getDealsToday(rep);
    if (dash?.urgent.some((u) => lockedIds.has(u.id))) leaks.push("dashboard");
    const waiting = await queries.getDealList({ scope, owner, view: "waiting_manager", take: 5000 });
    const mgr = await getManagerToday(manager);
    const repRow = mgr.reps.find((r) => r.id === rep.id);
    check(
        "W3-10: a locked deal appears in no actionable view (Na dnes, step pills, dashboard) – only in 'Čakám na manažéra'",
        leaks.length === 0 && [...lockedIds].filter((id) => waiting.rows.some((r) => r.id === id)).length === 4 && repRow !== undefined,
        `leaks=${leaks.join(",")} waiting=${waiting.rows.filter((r) => lockedIds.has(r.id)).length} (locked open deals: 4)`,
    );

    // Počty = celé zoznamy pri každom filtri (stav, vlastník, hľadanie) – aj „Pre mňa" a „Čakám na manažéra".
    const mgrScope = dealScope(manager);
    const combos: { owner: "all" | { userId: string }; status?: "ACTIVE" | "SNOOZED" | "LOST"; query?: string }[] = [
        { owner: "all" },
        { owner: "all", status: "ACTIVE" },
        { owner: "all", status: "SNOOZED" },
        { owner: "all", status: "LOST" },
        { owner: { userId: rep.id } },
        { owner: "all", query: `CC-TEST ${RUN} lock` },
        { owner: { userId: rep.id }, status: "ACTIVE", query: "lock" },
    ];
    const wrongCounts: string[] = [];
    for (const c of combos) {
        const params = { scope: mgrScope, owner: c.owner, status: c.status, query: c.query, viewerId: manager.id };
        const counts = await queries.getDealCounts(params);
        for (const v of queries.COUNTED_VIEWS) {
            const { rows } = await queries.getDealList({ ...params, view: v === "all" ? undefined : v, take: 100_000 });
            if (rows.length !== counts[v]) wrongCounts.push(`${JSON.stringify(c)} ${v}: count=${counts[v]} list=${rows.length}`);
        }
    }
    check("W3-10: every pill count equals its full list under status / owner / search filters", wrongCounts.length === 0, wrongCounts.slice(0, 5).join(" | "));

    // Obchodník nikdy nevidí cudziu úlohu: „Pre mňa" s jeho id je prázdne, cudzí detail null.
    const rep2 = await makeUser("SALES_REP");
    const inbox = await queries.getDealList({ scope: dealScope(rep2), owner: { userId: rep2.id }, view: "inbox", viewerId: rep2.id, take: 5000 });
    const foreign = await queries.getDealDetail(ids[3], dealScope(rep2), (await import("../../lib/domain/dealCapabilities")).dealCapabilities(rep2));
    check("W3-10: a rep never sees a foreign task (inbox empty, foreign detail null)", inbox.rows.length === 0 && foreign === null, `inbox=${inbox.rows.length} detail=${Boolean(foreign)}`);
};

// W3-11 História: vrátený prvý hovor, vrátenie a nový obchod iného, obchod späť u mňa, zmazaný kontakt – nič z toho;
// jeden riadok na obchod.
tests.w3History = async () => {
    const { queries, pipeline, tasks } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const repB = await makeUser("SALES_REP");
    const hist = () => queries.getHandedOverHistory(rep.id);

    // 1. prvý hovor → hneď vrátený → iný obchodník z neho spraví obchod
    const l1 = await makeAssignedLead(rep.id);
    await logCallAs(rep, { leadId: l1, outcome: "WANTS_QUOTE", expectedRevision: await leadRev(l1), idempotencyKey: key() });
    const call1 = await prisma.activity.findFirstOrThrow({ where: { leadId: l1, type: "CALL" } });
    await revertCallResultAs(rep, call1.id, await leadRev(l1));
    await prisma.lead.update({ where: { id: l1 }, data: { assignedCallerId: repB.id } });
    await logCallAs(repB, { leadId: l1, outcome: "WANTS_QUOTE", expectedRevision: await leadRev(l1), idempotencyKey: key() });
    // 2. obchod odíde a vráti sa späť ku mne
    const l2 = await makeDeal(rep);
    await pipeline.changeOwnerAs(manager, l2, { ownerId: repB.id, expectedRevision: await leadRev(l2), idempotencyKey: key() });
    await pipeline.changeOwnerAs(manager, l2, { ownerId: rep.id, expectedRevision: await leadRev(l2), idempotencyKey: key() });
    // 3. obchod odíde dvakrát (B, potom manažér prevezme) → jeden riadok, posledný odchod
    const l3 = await makeDeal(rep);
    await pipeline.changeOwnerAs(manager, l3, { ownerId: repB.id, expectedRevision: await leadRev(l3), idempotencyKey: key() });
    await pipeline.changeOwnerAs(manager, l3, { ownerId: rep.id, expectedRevision: await leadRev(l3), idempotencyKey: key() });
    await tasks.takeoverAs(manager, { leadId: l3, expectedRevision: await leadRev(l3), idempotencyKey: key(), step: { kind: "CALL", schedule: { kind: "daysFromToday", days: 1 } } });
    // 4. odovzdaný a potom zmazaný kontakt
    const l4 = await makeDeal(rep);
    await pipeline.changeOwnerAs(manager, l4, { ownerId: repB.id, expectedRevision: await leadRev(l4), idempotencyKey: key() });
    await prisma.lead.update({ where: { id: l4 }, data: { deletedAt: new Date() } });

    const rows = await hist();
    const l3rows = rows.filter((r) => r.leadId === l3);
    check(
        "W3-11: História hides a reverted first call (even after re-entry for another rep), a deal back with me, a deleted contact; one row per deal (latest move)",
        !rows.some((r) => r.leadId === l1) && !rows.some((r) => r.leadId === l2) && !rows.some((r) => r.leadId === l4) &&
            l3rows.length === 1 && l3rows[0].reason === "TAKEOVER",
        JSON.stringify(rows.map((r) => ({ l: [l1, l2, l3, l4].indexOf(r.leadId), reason: r.reason }))),
    );
};

// W3-12 odtlačky: ten istý kľúč so zmenenou povedanou cenou / prekryvom / zrušením / poznámkou ku kroku / odmietnutím,
// alebo so zmenenou cenou / dňom hovoru pri odoslaní = konflikt.
tests.w3Fingerprints = async () => {
    const { work, offers, today, bt, pipeline } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await pipeline.saveQuoteAs(manager, id, { price: 1000, priceNote: null });
    const k = key();
    const rev = await leadRev(id);
    const base = { leadId: id, outcome: "POSITIVE" as const, nextKind: "SEND_QUOTE" as const, expectedRevision: rev, idempotencyKey: k, phonePrice: { amount: 900 }, stepNote: "potvrdiť emailom" };
    const first = await work.logFollowUpAs(rep, base);
    const same = await work.logFollowUpAs(rep, base);
    const variants = await Promise.all([
        work.logFollowUpAs(rep, { ...base, phonePrice: { amount: 950 } }),
        work.logFollowUpAs(rep, { ...base, stepNote: "iná" }),
        work.logFollowUpAs(rep, { ...base, overlap: "KEEP_OPEN", keepLockedStep: true, nextKind: undefined, stepNote: undefined }),
        work.logFollowUpAs(rep, { ...base, cancelTask: { taskId: "x", reason: "y" } }),
        work.logFollowUpAs(rep, { ...base, dismiss: { items: [{ taskId: "x", kind: "OTHER" }] } }),
        work.logFollowUpAs(rep, { ...base, schedule: { kind: "daysFromToday", days: 1 } }),
    ]);
    check(
        "W3-12: follow-up – same key + same payload replays; changed phone price / step note / overlap / cancel / dismiss / date = conflict",
        codeOf(first) === "OK" && codeOf(same) === "OK" && variants.every((v) => codeOf(v) === "ERR:IDEMPOTENCY_CONFLICT"),
        `${codeOf(first)} ${codeOf(same)} ${variants.map(codeOf).join(",")}`,
    );
    const ok2 = key();
    const rev2 = await leadRev(id);
    const sendBase = { leadId: id, expectedRevision: rev2, idempotencyKey: ok2, contents: ["PRICE" as const], sentOn: today, followUp: true, price: { amount: 1100, note: null } };
    const s1 = await offers.recordOfferSentAs(rep, sendBase);
    const s2 = await offers.recordOfferSentAs(rep, sendBase);
    const sv = await Promise.all([
        offers.recordOfferSentAs(rep, { ...sendBase, price: { amount: 1200, note: null } }),
        offers.recordOfferSentAs(rep, { ...sendBase, price: { amount: 1100, note: "rozpis" } }),
        offers.recordOfferSentAs(rep, { ...sendBase, followUpOn: bt.addBusinessCalendarDays(today, 2) }),
        offers.recordOfferSentAs(rep, { ...sendBase, followUp: false }),
    ]);
    check("W3-12: send – changed price / breakdown / follow-up day / follow-up choice under the same key = conflict", codeOf(s1) === "OK" && codeOf(s2) === "OK" && sv.every((v) => codeOf(v) === "ERR:IDEMPOTENCY_CONFLICT"), `${codeOf(s1)} ${codeOf(s2)} ${sv.map(codeOf).join(",")}`);
};

// W3-13 odkaz „Pre mňa" z akéhokoľvek stavu filtrov nemá vlastníka / stav / „Od:" / stránkovanie.
tests.w3InboxHref = async () => {
    const { inboxHref, parseDealParams } = await import("../../lib/domain/dealFilters");
    const states = [
        parseDealParams({}),
        parseDealParams({ filter: "lost", view: "quote", owner: "all", q: "pek", from: "u1", limit: "150" }),
        parseDealParams({ filter: "all", owner: "unassigned", from: "abc" }),
    ];
    const urls = states.map(inboxHref);
    const bad = urls.filter((u) => {
        const p = new URL(u, "http://x").searchParams;
        return p.get("view") !== "inbox" || p.has("owner") || p.has("filter") || p.has("from") || p.has("limit");
    });
    check("W3-13: the 'Pre mňa' link clears owner, status, 'Od:' and paging (keeps search)", bad.length === 0 && urls[1].includes("q=pek"), urls.join(" "));
};

// W3-14 udalosti úlohy nikdy nemenia „Naposledy".
tests.w3TaskRowsNotLastTouch = async () => {
    const { ask, finish, tasks, queries, dealScope, detail } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await ask(rep, id, manager.id, { contents: ["OTHER"], step: { kind: "CALL" } });
    const t = (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id } })).id;
    await tasks.taskMessageAs(manager, { taskId: t, expectedRevision: await leadRev(id), idempotencyKey: key(), text: "koľko jazykov?" });
    await finish(manager, id, { answer: "dva" });
    await tasks.dismissResultsAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), taskId: t, items: [{ kind: "OTHER" }] });
    const row = (await queries.getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((r) => r.id === id);
    const d = await detail(id, rep);
    check("W3-14: TASK_* rows never change 'Naposledy' (list and detail keep the first call)", row?.lastActivity?.type === "CALL" && d?.lastTouch?.type === "CALL", `${row?.lastActivity?.type} ${d?.lastTouch?.type}`);
};

// W3-15 dve poznámky (F1): „Čo povedali" len do kontaktu, „Poznámka ku kroku" len do kroku; prázdna = predvolený text;
// pole bez miesta sa odmietne.
tests.w3SheetNotes = async () => {
    const { follow, lead, work } = await w3();
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const r = await follow(rep, id, { reply: "DECIDING", note: "porada v piatok", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 3 }, stepNote: "zavolať po porade" });
    const call = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "CALL", source: "CLIENTS" }, orderBy: { createdAt: "desc" } });
    const l = await lead(id);
    const empty = await follow(rep, id, { reply: "WANTS_INFO", note: "chcú cenník", nextKind: "SEND_EMAIL" });
    const l2 = await lead(id);
    const quote = await follow(rep, id, { outcome: "WANTS_QUOTE", note: "chcú cenu", stepNote: "" });
    const l3 = await lead(id);
    const noneWithNote = await follow(rep, id, { contact: "NONE", note: "povedali", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 1 } });
    const lostWithStep = await work.logFollowUpAs(rep, { leadId: id, outcome: "NOT_INTERESTED", stepNote: "x", expectedRevision: await leadRev(id), idempotencyKey: key() });
    check(
        "W3-15 (F1): 'Čo povedali' only in the contact row, 'Poznámka ku kroku' only in the step; empty = default text; misplaced fields refused",
        codeOf(r) === "OK" && call.note === "Majú poradu / rozhodujú sa – porada v piatok" && l.nextActionNote === "zavolať po porade" &&
            codeOf(empty) === "OK" && l2.nextActionNote === "Poslať info / cenník" &&
            codeOf(quote) === "OK" && l3.nextActionNote === "Poslať cenu" &&
            codeOf(noneWithNote) !== "OK" && codeOf(lostWithStep) !== "OK",
        `${codeOf(r)} call="${call.note}" step="${l.nextActionNote}" empty="${l2.nextActionNote}" quote="${l3.nextActionNote}" ${codeOf(noneWithNote)} ${codeOf(lostWithStep)}`,
    );
};

// ── Wave 5: čo klient pýtal vs. čo dostal (wave-5-proposal.md §10) ──────────

async function w5() {
    const base = await w3();
    const calls = await import("../../lib/commands/calls");
    const requests = await import("../../lib/commands/requests");
    const rq = await import("../../lib/domain/requestMutations");
    const cr = await import("../../lib/domain/clientRequests");
    const stats = await import("../../lib/queries/stats");
    // Prvý hovor „majú záujem" so zaškrtnutými obsahmi – nový vstup fronty volaní (§3.1).
    const interested = async (rep: AccessUser, asked: RequestContent[], extra: { idempotencyKey?: string } = {}) => {
        const id = await makeAssignedLead(rep.id);
        const r = await calls.logCallAs(rep, {
            leadId: id,
            outcome: "INTERESTED",
            asked,
            expectedRevision: await leadRev(id),
            idempotencyKey: extra.idempotencyKey ?? key(),
        });
        if ("error" in r) throw new Error(`INTERESTED failed: ${r.error}`);
        return id;
    };
    const rows = (leadId: string) =>
        prisma.leadRequest.findMany({ where: { leadId }, orderBy: [{ requestedAt: "asc" }, { id: "asc" }] });
    const state = (leadId: string) => rq.requestStateOf(prisma, leadId);
    const outstanding = (leadId: string) => rq.outstandingOf(prisma, leadId);
    const asks = async (
        u: AccessUser,
        leadId: string,
        input: { add?: RequestContent[]; withdraw?: string[]; reason?: string | null; expectedRevision?: number; idempotencyKey?: string },
    ) =>
        requests.setClientAsksAs(u, {
            leadId,
            expectedRevision: input.expectedRevision ?? (await leadRev(leadId)),
            idempotencyKey: input.idempotencyKey ?? key(),
            add: input.add ?? [],
            withdraw: input.withdraw ?? [],
            reason: input.reason ?? null,
        });
    const openIdsOf = async (leadId: string, content: RequestContent) =>
        (await rows(leadId)).filter((r) => r.content === content && r.state === "OPEN").map((r) => r.id);
    return { ...base, calls, requests, rq, cr, stats, interested, rows, state, outstanding, asks, openIdsOf };
}

// W5-1 prvý hovor (§10.1): jeden aj viac obsahov naraz, krok podľa dominantného obsahu, kanonický odtlačok
// (preusporiadané pole = to isté, zmenený výber pod tým istým kľúčom = konflikt), súbežné odoslanie = jeden zápis.
tests.w5FirstCall = async () => {
    const { interested, rows, lead, calls } = await w5();
    const rep = await makeUser("SALES_REP");

    const single: [RequestContent, string][] = [
        ["INFO", "SEND_EMAIL"],
        ["PRICELIST", "SEND_EMAIL"],
        ["PRICE", "SEND_QUOTE"],
        ["DESIGN", "SEND_DESIGN"],
        ["REVIEW", "SEND_EMAIL"],
    ];
    const singleOk: string[] = [];
    for (const [content, kind] of single) {
        const id = await interested(rep, [content]);
        const l = await lead(id);
        const r = await rows(id);
        singleOk.push(`${content}:${l.nextActionKind}:${r.length}:${r[0]?.state}`);
        if (l.nextActionKind !== kind || r.length !== 1 || r[0].state !== "OPEN") singleOk.push("FAIL");
    }

    const multi = await interested(rep, ["PRICELIST", "DESIGN", "PRICE"]);
    const mLead = await lead(multi);
    const mRows = await rows(multi);
    const call = await prisma.activity.findFirstOrThrow({ where: { leadId: multi, type: "CALL" } });
    const meta = call.meta as { asked?: string[] } | null;

    // Ten istý kľúč a ten istý výber v inom poradí = to isté uloženie; iný výber = konflikt (R01-4).
    const sameKey = key();
    const id2 = await makeAssignedLead(rep.id);
    const first = await calls.logCallAs(rep, {
        leadId: id2, outcome: "INTERESTED", asked: ["PRICE", "DESIGN"], expectedRevision: 0, idempotencyKey: sameKey,
    });
    const reordered = await calls.logCallAs(rep, {
        leadId: id2, outcome: "INTERESTED", asked: ["DESIGN", "PRICE"], expectedRevision: 0, idempotencyKey: sameKey,
    });
    const changed = await calls.logCallAs(rep, {
        leadId: id2, outcome: "INTERESTED", asked: ["DESIGN"], expectedRevision: 0, idempotencyKey: sameKey,
    });

    // Súbežné odoslanie toho istého výsledku: jeden hovor, jedna sada riadkov.
    const id3 = await makeAssignedLead(rep.id);
    const k3 = key();
    const parallel = await Promise.all(
        Array.from({ length: 5 }, () =>
            calls.logCallAs(rep, { leadId: id3, outcome: "INTERESTED", asked: ["PRICE", "INFO"], expectedRevision: 0, idempotencyKey: k3 }),
        ),
    );
    const empty = await calls.logCallAs(rep, {
        leadId: (await makeAssignedLead(rep.id)), outcome: "INTERESTED", asked: [], expectedRevision: 0, idempotencyKey: key(),
    });

    check(
        "W5-1: first call records every ticked content, the step follows the dominant one, reordered = same payload, changed = conflict, parallel = one write",
        !singleOk.includes("FAIL") &&
            mLead.nextActionKind === "SEND_DESIGN" && mLead.nextActionMode === "IN_PROGRESS" && mRows.length === 3 &&
            (meta?.asked ?? []).join() === "PRICELIST,PRICE,DESIGN" &&
            codeOf(first) === "OK" && codeOf(reordered) === "OK" && codeOf(changed) === "ERR:IDEMPOTENCY_CONFLICT" &&
            (await rows(id2)).length === 2 &&
            Object.keys(tally(parallel)).join() === "OK" &&
            (await prisma.activity.count({ where: { leadId: id3, type: "CALL" } })) === 1 &&
            (await rows(id3)).length === 2 &&
            codeOf(empty) !== "OK",
        `${singleOk.join(" ")} | multi=${mLead.nextActionKind}/${mRows.length} meta=${(meta?.asked ?? []).join("+")} | ${codeOf(first)} ${codeOf(reordered)} ${codeOf(changed)} | ${JSON.stringify(tally(parallel))} | empty=${codeOf(empty)}`,
    );
};

// W5-2 telefonická cena (§10.2, §10.12): povedaná cena splní otvorenú požiadavku odkazom z toho istého hovoru;
// ručne zvolený krok (potvrdiť emailom / dohodnutý hovor) prepočet NEPREPÍŠE.
tests.w5PhonePrice = async () => {
    const { interested, rows, lead, follow, asks, outstanding } = await w5();
    const rep = await makeUser("SALES_REP");

    const id = await interested(rep, ["PRICE"]);
    const r = await follow(rep, id, { nextKind: "SEND_QUOTE", phonePrice: { amount: 1285, note: null } });
    const after = await rows(id);
    const offer = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT" } });
    const l1 = await lead(id);

    // Ručne zvolený „Zavolať" prežije aj ďalšiu požiadavku – projekcia dáva len predvoľbu (R02-2).
    const manual = await follow(rep, id, { nextKind: "CALL", schedule: { kind: "daysFromToday", days: 3 } });
    const add = await asks(rep, id, { add: ["DESIGN"] });
    const l2 = await lead(id);

    check(
        "W5-2: a price told on the call satisfies that call's PRICE request by link; a deliberately chosen step survives later reconciliation",
        codeOf(r) === "OK" && after.length === 1 && after[0].state === "SENT" && after[0].resolvedActivityId === offer.id &&
            l1.nextActionKind === "SEND_QUOTE" &&
            codeOf(manual) === "OK" && codeOf(add) === "OK" && l2.nextActionKind === "CALL" &&
            (await outstanding(id)).join() === "DESIGN",
        `${codeOf(r)} ${after[0]?.state} step=${l1.nextActionKind} → ${codeOf(add)} ${l2.nextActionKind} outstanding=${(await outstanding(id)).join("+")}`,
    );
};

// W5-3 požiadali znova (§10.3, §10.14): stará cena novú požiadavku nespĺňa; dve otvorené požiadavky na ten istý
// obsah sú JEDEN riadok práce a jedno odoslanie zavrie obe; pre štatistiky ostávajú dve udalosti.
tests.w5AskAgain = async () => {
    const { interested, rows, lead, send, asks, state, outstanding, today, bt } = await w5();
    const rep = await makeUser("SALES_REP");

    const id = await interested(rep, ["PRICE"]);
    await send(rep, id, { contents: ["PRICE"], price: { amount: 900, note: null } });
    const afterSend = await rows(id);
    const again = await asks(rep, id, { add: ["PRICE"] });
    const afterAsk = await rows(id);
    const l1 = await lead(id);

    // Druhá otvorená požiadavka na ten istý obsah → stále jeden riadok práce.
    await asks(rep, id, { add: ["PRICE"] });
    const grouped = await state(id);
    const closing = await send(rep, id, { contents: ["PRICE"], price: { amount: 1100, note: null } });
    const closed = await rows(id);

    // Spätne datované odoslanie nesplní požiadavku, ktorá vznikla neskôr (§5).
    const id2 = await interested(rep, ["INFO"]);
    const back = await send(rep, id2, { contents: ["ABOUT_US"], sentOn: bt.addBusinessCalendarDays(today, -3) });
    const backRows = await rows(id2);

    check(
        "W5-3: an older receipt never satisfies a later request; two open requests of one content are one work row and one send closes both; a backdated send does not satisfy a later request",
        afterSend.length === 1 && afterSend[0].state === "SENT" &&
            codeOf(again) === "OK" && afterAsk.length === 2 && afterAsk[1].state === "OPEN" && l1.nextActionKind === "SEND_QUOTE" &&
            grouped.outstanding.length === 1 && grouped.outstanding[0].openIds.length === 2 && grouped.history.length === 3 &&
            codeOf(closing) === "OK" && closed.filter((x) => x.state === "OPEN").length === 0 &&
            (await outstanding(id)).length === 0 &&
            codeOf(back) === "OK" && backRows[0].state === "OPEN",
        `sent=${afterSend[0]?.state} again=${codeOf(again)} rows=${afterAsk.length} work=${grouped.outstanding.length}/${grouped.outstanding[0]?.openIds.length} closed=${closed.filter((x) => x.state === "OPEN").length} backdated=${backRows[0]?.state}`,
    );
};

// W5-4 čiastočné odoslanie a pokrytie kroku (§10.4, §10.19): po odoslaní časti krok padne na to, čo ostalo;
// zámerne užší krok si ponechá vlastný popisok a to, čo nepokrýva, varuje – rovnako v detaile aj v zozname.
tests.w5PartialSend = async () => {
    const { interested, rows, lead, send, detail, queries, dealScope, cr, outstanding } = await w5();
    const rep = await makeUser("SALES_REP");

    const id = await interested(rep, ["PRICELIST", "PRICE", "DESIGN"]);
    const l0 = await lead(id);
    const part = await send(rep, id, { contents: ["PRICELIST"] });
    const l1 = await lead(id);
    const afterPart = await rows(id);

    // Zámerne užší krok: „Poslať cenu", hoci je nevybavený aj návrh.
    const view = cr.stepView("SEND_QUOTE", ["DESIGN", "PRICE"]);
    const combined = cr.stepView("SEND_DESIGN", ["DESIGN", "PRICE", "PRICELIST"]);
    const covered = cr.coveredContents("SEND_DESIGN", ["DESIGN", "PRICE", "PRICELIST"]);

    const d = await detail(id, rep);
    const row = (await queries.getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 })).rows.find((x) => x.id === id);

    // Obsah navyše, ktorý nikto nepýtal, nerobí žiadny riadok – len sa zapíše ako odoslané.
    const extra = await send(rep, id, { contents: ["REVIEW"] });
    const afterExtra = await rows(id);

    check(
        "W5-4: a partial send drops what went out and the step follows the rest; a deliberately narrower step keeps its own label and warns about what it does not cover; list and detail agree",
        l0.nextActionKind === "SEND_DESIGN" && codeOf(part) === "OK" &&
            afterPart.filter((x) => x.state === "SENT").map((x) => x.content).join() === "PRICELIST" &&
            l1.nextActionKind === "SEND_DESIGN" &&
            view.headline === null && view.warn.join() === "DESIGN" &&
            combined.headline === "Poslať návrh + cenu + cenník" && combined.warn.length === 0 &&
            covered.join() === "DESIGN,PRICE" &&
            d?.stepHeadline === row?.stepHeadline && d?.askWarning === row?.askWarning &&
            d?.outstanding.join() === row?.outstanding.join() && d?.stepHeadline === "Poslať návrh + cenu" &&
            codeOf(extra) === "OK" && afterExtra.length === 3 &&
            (await outstanding(id)).join() === "DESIGN,PRICE",
        `${l0.nextActionKind} → ${codeOf(part)} ${l1.nextActionKind} | narrow=${JSON.stringify(view)} combined="${combined.headline}" | detail="${d?.stepHeadline}" list="${row?.stepHeadline}" warn="${row?.askWarning}"`,
    );
};

// W5-5 opravy a poradie (§10.5, §10.11): prečiarknuté odoslanie otvorí požiadavku len vtedy, keď ju nespĺňa žiadne
// iné platné odoslanie; po dvoch odoslaniach a oprave prvého ostáva vybavená (vyriešenie sa presunie na druhé).
tests.w5Correction = async () => {
    const { interested, rows, send, offers, cr } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");

    const id = await interested(rep, ["INFO"]);
    await send(rep, id, { contents: ["ABOUT_US"] });
    const sent = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT" } });
    const undo = await offers.correctRecordAs(manager, sent.id, "poslalo sa na zlú adresu");
    const reopened = await rows(id);

    const id2 = await interested(rep, ["INFO"]);
    await send(rep, id2, { contents: ["ABOUT_US"] });
    await send(rep, id2, { contents: ["ABOUT_US"] });
    const two = await prisma.activity.findMany({ where: { leadId: id2, type: "OFFER_SENT" }, orderBy: { createdAt: "asc" } });
    const fix = await offers.correctRecordAs(manager, two[0].id, "duplicitný záznam");
    const still = await rows(id2);

    // Čisté pravidlo: prvé oprávnené odoslanie vyhráva, stiahnutú požiadavku neoživí žiadne odoslanie.
    const t = (ms: number) => new Date(2026, 0, 1, 0, 0, 0, ms);
    const pure = cr.resolveRequests(
        [
            { id: "a", content: "PRICE", state: "OPEN", requestedAt: t(10), resolvedAt: null, resolvedById: null, resolvedActivityId: null },
            { id: "b", content: "PRICE", state: "WITHDRAWN", requestedAt: t(10), resolvedAt: t(11), resolvedById: "u", resolvedActivityId: null },
            { id: "c", content: "PRICE", state: "OPEN", requestedAt: t(30), resolvedAt: null, resolvedById: null, resolvedActivityId: null },
        ],
        [
            { id: "r2", userId: "u", instant: t(20), contents: ["PRICE"] },
            { id: "r1", userId: "u", instant: t(15), contents: ["PRICE"] },
        ],
    );

    check(
        "W5-5: crossing out a send reopens a row only when no other valid receipt satisfies it; the earliest eligible receipt wins; a withdrawn row is never revived",
        codeOf(undo) === "OK" && reopened[0].state === "OPEN" && reopened[0].resolvedActivityId === null &&
            codeOf(fix) === "OK" && still[0].state === "SENT" && still[0].resolvedActivityId === two[1].id &&
            pure.get("a")?.resolvedActivityId === "r1" && pure.get("b")?.state === "WITHDRAWN" && pure.get("c")?.state === "OPEN",
        `${codeOf(undo)} ${reopened[0]?.state} | ${codeOf(fix)} ${still[0]?.state} moved=${still[0]?.resolvedActivityId === two[1].id} | pure a=${pure.get("a")?.resolvedActivityId} b=${pure.get("b")?.state} c=${pure.get("c")?.state}`,
    );
};

// W5-6 vrátenie prvého hovoru (§10.6): riadky toho hovoru sa zmažú; ak klient už niečo z nich dostal, vrátenie sa
// odmietne – odoslanie ostáva pravdou a požiadavka, ktorú splnilo, sa nesmie stratiť.
tests.w5Revert = async () => {
    const { interested, rows, rq, send } = await w5();
    const rep = await makeUser("SALES_REP");

    const id = await interested(rep, ["PRICE", "INFO"]);
    const call = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "CALL" } });
    const before = (await rows(id)).length;
    const undo = await revertCallResultAs(rep, call.id, await leadRev(id));
    const after = (await rows(id)).length;

    const id2 = await interested(rep, ["PRICE"]);
    const call2 = await prisma.activity.findFirstOrThrow({ where: { leadId: id2, type: "CALL" } });
    await send(rep, id2, { contents: ["PRICE"], price: { amount: 700, note: null } });
    let refused = "none";
    try {
        await prisma.$transaction(async (tx) => {
            await rq.deleteRequestsOfActivity(tx as never, id2, call2.id);
        });
    } catch (error) {
        refused = (error as { code?: string }).code ?? "threw";
    }

    check(
        "W5-6: the first-call revert deletes that call's request rows; a row the client already received refuses the revert",
        codeOf(undo) === "OK" && before === 2 && after === 0 && refused === "STALE",
        `${codeOf(undo)} ${before}→${after} refused=${refused}`,
    );
};

// W5-7 úlohy pre manažéra (§10.7, §10.18): pri nevybavenom návrhu ostáva uložený druh „Poslať návrh" aj pri cenovej
// úlohe; a manažérska práca BEZ požiadavky klienta ostáva nevybavená, drží krok a odoslanie ju spotrebuje (R03-1).
tests.w5ManagerWork = async () => {
    const { interested, lead, ask, finish, send, state, outstanding, offers } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");

    const id = await interested(rep, ["DESIGN"]);
    // Krok sa pri žiadosti nevyberá: klient čaká na návrh, takže zamknutý krok je „Poslať návrh" aj pri cenovej
    // úlohe – a formulár, ktorý pošle iný krok, dostane STALE.
    const priceTask = await ask(rep, id, manager.id, { contents: ["PRICE"], step: undefined });
    const wrongStep = await ask(rep, id, manager.id, { contents: ["PRICE"] });
    const locked = await lead(id);

    // Bez jedinej požiadavky klienta: obchodník si vypýta cenu sám.
    const id2 = await makeDeal(rep, "WANTS_QUOTE");
    const none = (await state(id2)).history.length;
    await ask(rep, id2, manager.id, { contents: ["PRICE"] });
    const making = await outstanding(id2);
    await finish(manager, id2, { price: { amount: 1500, note: null } });
    const prepared = await outstanding(id2);
    const l2 = await lead(id2);
    const sendIt = await send(rep, id2, { contents: ["PRICE"], fulfils: [{ taskId: (await prisma.dealTask.findFirstOrThrow({ where: { leadId: id2 } })).id, kind: "PRICE" }], followUp: true });
    const afterSend = await outstanding(id2);
    const l3 = await lead(id2);
    const offer = await prisma.activity.findFirstOrThrow({ where: { leadId: id2, type: "OFFER_SENT" } });
    await offers.correctRecordAs(manager, offer.id, "poslalo sa omylom");
    const back = await outstanding(id2);

    check(
        "W5-7: an open DESIGN request keeps the stored kind 'Poslať návrh' even for a price task; manager work without any client request stays outstanding, holds the step, is consumed by the send and comes back when that send is crossed out",
        codeOf(priceTask) === "OK" && codeOf(wrongStep) === "ERR:STALE" && locked.nextActionKind === "SEND_DESIGN" && locked.nextActionAt === null &&
            none === 0 && making.join() === "PRICE" && prepared.join() === "PRICE" && l2.nextActionKind === "SEND_QUOTE" &&
            codeOf(sendIt) === "OK" && afterSend.length === 0 && l3.nextActionKind === "CALL" && back.join() === "PRICE",
        `task=${codeOf(priceTask)}/${codeOf(wrongStep)} locked=${locked.nextActionKind} | making=${making.join("+")} prepared=${prepared.join("+")} step=${l2.nextActionKind} → ${codeOf(sendIt)} after=${afterSend.join("+")} step=${l3.nextActionKind} back=${back.join("+")}`,
    );
};

// W5-8 ceruzka (§10.8, §10.9): pridať / stiahnuť, dôvod len pri stiahnutí, vybavený riadok sa stiahnuť nedá,
// cudzí obchod NOT_FOUND, dve karty = jedno uloženie, presne jedno zvýšenie revízie.
tests.w5Pencil = async () => {
    const { interested, rows, lead, asks, send, openIdsOf, ask } = await w5();
    const rep = await makeUser("SALES_REP");
    const other = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");

    const id = await interested(rep, ["PRICE"]);
    const rev0 = await leadRev(id);
    const added = await asks(rep, id, { add: ["DESIGN", "PRICELIST"] });
    const rev1 = await leadRev(id);
    const l1 = await lead(id);

    const noReason = await asks(rep, id, { withdraw: await openIdsOf(id, "DESIGN") });
    const withdrawn = await asks(rep, id, { withdraw: await openIdsOf(id, "DESIGN"), reason: "rozmysleli si to" });
    const l2 = await lead(id);
    const afterWithdraw = await rows(id);

    await send(rep, id, { contents: ["PRICE"], price: { amount: 800, note: null } });
    const sentRow = (await rows(id)).find((r) => r.content === "PRICE" && r.state === "SENT")!;
    const withdrawSent = await asks(rep, id, { withdraw: [sentRow.id], reason: "omyl" });

    const foreign = await asks(other, id, { add: ["INFO"] });
    const byManager = await asks(manager, id, { add: ["INFO"] });

    // Dve karty, ten istý kľúč a obsah → jedno uloženie; iný obsah pod tým istým kľúčom → konflikt.
    const k = key();
    const revNow = await leadRev(id);
    const twice = await Promise.all([
        asks(rep, id, { add: ["REVIEW"], idempotencyKey: k, expectedRevision: revNow }),
        asks(rep, id, { add: ["REVIEW"], idempotencyKey: k, expectedRevision: revNow }),
    ]);
    const conflict = await asks(rep, id, { add: ["INFO"], idempotencyKey: k, expectedRevision: await leadRev(id) });

    // Otvorená úloha sa ceruzkou nikdy neruší.
    const id3 = await interested(rep, ["PRICE"]);
    await ask(rep, id3, manager.id, { contents: ["PRICE"] });
    const withTask = await asks(rep, id3, { withdraw: await openIdsOf(id3, "PRICE"), reason: "už nechcú" });
    const taskStillOpen = (await prisma.dealTask.count({ where: { leadId: id3, status: "OPEN" } })) === 1;

    check(
        "W5-8: the pencil adds and withdraws open rows only, a reason is required for a withdrawal, a satisfied row cannot be withdrawn, another rep gets NOT_FOUND, the same key saves once, and an open task is never cancelled by it",
        codeOf(added) === "OK" && rev1 === rev0 + 1 && l1.nextActionKind === "SEND_DESIGN" &&
            codeOf(noReason) !== "OK" && codeOf(withdrawn) === "OK" && l2.nextActionKind === "SEND_QUOTE" &&
            afterWithdraw.filter((r) => r.state === "WITHDRAWN").length === 1 &&
            codeOf(withdrawSent) === "ERR:STALE" &&
            codeOf(foreign) === "ERR:NOT_FOUND" && codeOf(byManager) === "OK" &&
            JSON.stringify(tally(twice)) === JSON.stringify({ OK: 2 }) &&
            (await rows(id)).filter((r) => r.content === "REVIEW").length === 1 &&
            codeOf(conflict) === "ERR:IDEMPOTENCY_CONFLICT" &&
            codeOf(withTask) === "OK" && taskStillOpen,
        `add=${codeOf(added)} rev=${rev0}→${rev1} step=${l1.nextActionKind} | noReason=${codeOf(noReason)} withdraw=${codeOf(withdrawn)} step=${l2.nextActionKind} | sent=${codeOf(withdrawSent)} foreign=${codeOf(foreign)} manager=${codeOf(byManager)} | ${JSON.stringify(tally(twice))} conflict=${codeOf(conflict)} | task=${codeOf(withTask)}/${taskStillOpen}`,
    );
};

// W5-9 uzavretie a znovuotvorenie (§10.17): uzavretie riadky nechá tak a nič nestiahne; znovuotvorenie s nevybavenou
// prácou otvorí obchod na ten odosielací krok, bez nevybavenej práce na pevné „Zavolať".
tests.w5CloseReopen = async () => {
    const { interested, rows, lead, pipeline, send } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");
    const { REOPEN_STEP_NOTE } = await import("../../lib/domain/dealMutations");

    const id = await interested(rep, ["DESIGN"]);
    const won = await pipeline.changeStatusAs(manager, id, { status: "WON", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const closedRows = await rows(id);
    const reopen = await pipeline.reopenDealAs(manager, id, { expectedRevision: await leadRev(id), idempotencyKey: key() });
    const l1 = await lead(id);

    const id2 = await interested(rep, ["INFO"]);
    await send(rep, id2, { contents: ["ABOUT_US"] });
    await pipeline.changeStatusAs(manager, id2, { status: "LOST", expectedRevision: await leadRev(id2), idempotencyKey: key() });
    await pipeline.reopenDealAs(manager, id2, { expectedRevision: await leadRev(id2), idempotencyKey: key() });
    const l2 = await lead(id2);

    check(
        "W5-9: WON (the deliberate exception) leaves the request rows untouched; reopening with outstanding work gives that send step today, and 'Zavolať' only when nothing is outstanding",
        codeOf(won) === "OK" && closedRows.length === 1 && closedRows[0].state === "OPEN" &&
            codeOf(reopen) === "OK" && l1.nextActionKind === "SEND_DESIGN" && l1.nextActionAt !== null &&
            l2.nextActionKind === "CALL" && l2.nextActionNote === REOPEN_STEP_NOTE,
        `${codeOf(won)} rows=${closedRows[0]?.state} → ${codeOf(reopen)} ${l1.nextActionKind} | nothing outstanding → ${l2.nextActionKind} "${l2.nextActionNote}"`,
    );
};

// W5-10 odkazy a rozsah (§10.16): aktivita z iného obchodu, prečiarknutý záznam a nesprávny typ sa pod zámkom
// odmietnu – cudzí kľúč to dokázať nevie.
tests.w5Links = async () => {
    const { interested, rq, send, offers } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");

    const a = await interested(rep, ["PRICE"]);
    const b = await interested(rep, ["PRICE"]);
    const callOfB = await prisma.activity.findFirstOrThrow({ where: { leadId: b, type: "CALL" } });
    await send(rep, a, { contents: ["PRICE"], price: { amount: 500, note: null } });
    const offerOfA = await prisma.activity.findFirstOrThrow({ where: { leadId: a, type: "OFFER_SENT" } });
    await offers.correctRecordAs(manager, offerOfA.id, "test");

    const attempt = async (activityId: string, types: ("CALL" | "OFFER_SENT")[]) => {
        try {
            await prisma.$transaction(async (tx) => {
                await rq.addRequests(tx as never, {
                    leadId: a,
                    contents: ["INFO"],
                    requestedAt: new Date(),
                    requestedById: rep.id,
                    sourceActivityId: activityId,
                    sourceTypes: types,
                });
                throw new Error("ROLLBACK_OK");
            });
            return "none";
        } catch (error) {
            const code = (error as { code?: string }).code;
            return code ?? ((error as Error).message === "ROLLBACK_OK" ? "accepted" : "threw");
        }
    };

    const crossLead = await attempt(callOfB.id, ["CALL"]);
    const crossedOut = await attempt(offerOfA.id, ["OFFER_SENT"]);
    const wrongType = await attempt(offerOfA.id, ["CALL"]);

    check(
        "W5-10: a source activity from another lead, a crossed-out record and a wrong type are refused under the lock",
        crossLead === "NOT_FOUND" && crossedOut === "STALE" && wrongType === "FORBIDDEN",
        `crossLead=${crossLead} crossedOut=${crossedOut} wrongType=${wrongType}`,
    );
};

// W5-11 migrácia (§10.15): deterministický `migrationKey` je jediná ochrana proti duplikátu pri opakovanom aj
// prerušenom behu; migrované riadky sa do štatistík dopytu nerátajú a nemajú pripísaného aktéra.
tests.w5Migration = async () => {
    const { interested, stats, rows } = await w5();
    const rep = await makeUser("SALES_REP");
    const id = await interested(rep, ["PRICE"]);

    const insert = async () =>
        prisma.$executeRawUnsafe(
            `INSERT INTO "LeadRequest" (id, "leadId", content, state, origin, "requestedAt", "requestedById",
                                        "migrationKey", provenance, "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, 'INFO', 'SENT', 'MIGRATED_RECEIPT', now(), NULL,
                     'w5:receipt:' || $1 || ':INFO',
                     jsonb_build_object('source', 'OFFER_SENT', 'confidence', 'high'), now(), now())
             ON CONFLICT ("migrationKey") DO NOTHING`,
            id,
        );
    const first = await insert();
    const second = await insert(); // opakovaný / prerušený beh
    const all = await rows(id);
    const migrated = all.find((r) => r.origin === "MIGRATED_RECEIPT")!;

    const demand = await stats.getDemandStats({ range: { key: "all", label: "all", from: null, to: null }, userId: rep.id });

    check(
        "W5-11: the deterministic migrationKey makes a rerun a no-op; a migrated row carries no actor and is excluded from demand statistics",
        first === 1 && second === 0 && all.length === 2 && migrated.requestedById === null &&
            demand.byContent.PRICE === 1 && demand.byContent.INFO === 0,
        `insert=${first}/${second} rows=${all.length} actor=${migrated.requestedById} demand=${JSON.stringify(demand.byContent)}`,
    );
};

// W5-12 parita (§10.10, §10.13): riadok zoznamu a detail popisujú tú istú prácu, a obchod, ktorého krok dala
// projekcia, sedí so sekciou „Na dnes" aj s jej SQL dvojčaťom.
tests.w5Parity = async () => {
    const { interested, queries, dealScope, detail, lead, cr } = await w5();
    const rep = await makeUser("SALES_REP");

    const ids = [
        await interested(rep, ["DESIGN", "PRICE"]),
        await interested(rep, ["PRICE"]),
        await interested(rep, ["PRICELIST", "REVIEW"]),
    ];
    const list = await queries.getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "all", take: 500 });
    const todayIds = (await queries.getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "today", take: 500 })).rows.map((r) => r.id);

    let same = true;
    let expected = true;
    for (const id of ids) {
        const row = list.rows.find((r) => r.id === id);
        const d = await detail(id, rep);
        const l = await lead(id);
        if (!row || !d) { same = false; continue; }
        if (row.stepHeadline !== d.stepHeadline || row.askWarning !== d.askWarning || row.outstanding.join() !== d.outstanding.join()) same = false;
        // §6.8: uložený krok je predvoľba projekcie a nadpis vymenuje všetko nevybavené.
        if (l.nextActionKind !== cr.stepKindForOutstanding(row.outstanding)) expected = false;
        if (row.stepHeadline !== cr.stepView(l.nextActionKind, row.outstanding).headline) expected = false;
        // §6.8: návrh je „rozpracované" (patrí do Rozpracované, nie do Na dnes), ostatné sú splatné dnes.
        const inProgress = l.nextActionMode === "IN_PROGRESS";
        if (todayIds.includes(id) === inProgress) expected = false;
        if (inProgress !== (row.section === "IN_PROGRESS")) expected = false;
    }

    check(
        "W5-12: the list row and the detail describe the same work, the stored step is the projection's default and every such deal lands in 'Na dnes' (TS + SQL)",
        same && expected,
        `same=${same} expected=${expected} today=${todayIds.length}/${ids.length}`,
    );
};

// W5-13 súbeh a uzavretý obchod (§10.4, §10.9): dve karty posielajúce prekrývajúce sa podmnožiny skončia s tým, čo
// klient naozaj dostal (nikdy dve otvorené požiadavky na to isté), a ceruzka na uzavretom obchode neprejde.
tests.w5Race = async () => {
    const { interested, rows, asks, offers, pipeline } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");

    const id = await interested(rep, ["INFO", "PRICELIST", "PRICE"]);
    const rev = await leadRev(id);
    // Dve karty: prvá posiela „info + cenník", druhá „cenník + cena". Jedna vyhrá revíziu, druhá dostane STALE.
    const both = await Promise.all([
        offers.recordOfferSentAs(rep, {
            leadId: id, expectedRevision: rev, idempotencyKey: key(),
            contents: ["ABOUT_US", "PRICELIST"], sentOn: (await import("../../lib/domain/businessTime")).businessDate(new Date()), followUp: false,
        }),
        offers.recordOfferSentAs(rep, {
            leadId: id, expectedRevision: rev, idempotencyKey: key(),
            contents: ["PRICELIST", "PRICE"], sentOn: (await import("../../lib/domain/businessTime")).businessDate(new Date()),
            price: { amount: 990, note: null }, followUp: false,
        }),
    ]);
    const after = await rows(id);
    const sent = after.filter((r) => r.state === "SENT").map((r) => r.content).sort().join(",");
    const open = after.filter((r) => r.state === "OPEN").map((r) => r.content).sort().join(",");
    const offerCount = await prisma.activity.count({ where: { leadId: id, type: "OFFER_SENT" } });

    await pipeline.changeStatusAs(manager, id, { status: "WON", expectedRevision: await leadRev(id), idempotencyKey: key() });
    const closed = await asks(rep, id, { add: ["DESIGN"] });

    check(
        "W5-13: two tabs sending overlapping subsets leave exactly what the client received (one send lands, the other is STALE); the pencil is refused on a closed deal",
        Object.keys(tally(both)).sort().join() === "ERR:STALE,OK" && offerCount === 1 &&
            (sent === "INFO,PRICELIST" || sent === "PRICE,PRICELIST") &&
            (open === "PRICE" || open === "INFO") &&
            codeOf(closed) === "ERR:DEAL_CLOSED",
        `${JSON.stringify(tally(both))} offers=${offerCount} sent=${sent} open=${open} closed=${codeOf(closed)}`,
    );
};

// ── Wave 5 implementation review R01 (.ai/reviews/01-sales-rep/W5/implementation/R01-response.md) ──────────────

// R01-1: cenník sa do migrácie nedostane ako otvorená práca. Spúšťa PRESNÉ SQL migračného skriptu (wave5-requests-sql.ts)
// dvakrát v transakcii, ktorá sa vráti späť – test nič netrvalo nezapíše do ostatných obchodov testovacej DB.
tests.w5MigrationPricelist = async () => {
    const { interested, send, rows } = await w5();
    const sql = await import("./wave5-requests-sql");
    const rep = await makeUser("SALES_REP");
    const id = await interested(rep, ["INFO"]);
    await send(rep, id, { contents: ["PRICELIST"] }); // prevod starých odoslaní by pridal PRICELIST do tohto kanonického odoslania
    const offer = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT" } });
    const src = sql.RECEIPT_SOURCES.find((s) => s.content === "PRICELIST")!;
    const before = (await rows(id)).filter((r) => r.content === "PRICELIST").length;

    class Rollback extends Error {}
    type Seen = { first: number; second: number; mine: Awaited<ReturnType<typeof rows>>; openPricelist: number };
    const box: { seen?: Seen } = {};
    try {
        await prisma.$transaction(
            async (tx) => {
                const first = Number(await tx.$executeRawUnsafe(sql.insertReceipts(src.content, src.sent)));
                const second = Number(await tx.$executeRawUnsafe(sql.insertReceipts(src.content, src.sent)));
                const mine = await tx.leadRequest.findMany({ where: { leadId: id, content: "PRICELIST" } });
                const openPricelist = await tx.leadRequest.count({ where: { content: "PRICELIST", origin: "MIGRATED_RECEIPT", state: "OPEN" } });
                box.seen = { first, second, mine, openPricelist };
                throw new Rollback();
            },
            { timeout: 60_000, maxWait: 30_000 },
        );
    } catch (error) {
        if (!(error instanceof Rollback)) throw error;
    }
    const s = box.seen as Seen;
    const row = s?.mine[0];
    check(
        "R01-1: a PRICELIST receipt migrates to ONE linked SENT row (never an OPEN one); a second run adds nothing; no migrated PRICELIST row is left open",
        Boolean(s) && before === 0 && s.first >= 1 && s.second === 0 && s.mine.length === 1 &&
            row.state === "SENT" && row.origin === "MIGRATED_RECEIPT" && row.resolvedActivityId === offer.id &&
            row.resolvedAt !== null && row.requestedById === null && row.migrationKey === `w5:receipt:${id}:PRICELIST` &&
            s.openPricelist === 0,
        `first=${s?.first} second=${s?.second} rows=${s?.mine.length} state=${row?.state} linked=${row?.resolvedActivityId === offer.id} openPricelist=${s?.openPricelist}`,
    );
};

// R01-2: „Chcú niečo poslať" krok nevyberá – server ho odvodí z toho, čo ostane nevybavené po zápise požiadaviek a povedanej cene.
tests.w5StepFromRequests = async () => {
    const { interested, rows, lead, follow, send } = await w5();
    const rep = await makeUser("SALES_REP");
    const price = { amount: 1200, note: null };

    // Cena z telefónu spĺňa PRICE; zostáva INFO → „Poslať info", nie „Poslať cenu".
    const a = await interested(rep, ["INFO"]);
    const ka = key();
    const revA = await leadRev(a);
    const ra = await follow(rep, a, { asked: ["PRICE"], phonePrice: price, stepFromRequests: true, idempotencyKey: ka });
    const la = await lead(a);
    const rowsA = await rows(a);
    const retry = await follow(rep, a, { asked: ["PRICE"], phonePrice: price, stepFromRequests: true, idempotencyKey: ka, expectedRevision: revA });
    const changed = await follow(rep, a, { asked: ["PRICE", "INFO"], phonePrice: price, stepFromRequests: true, idempotencyKey: ka, expectedRevision: revA });

    // PRICE + DESIGN s cenou z telefónu → zostáva návrh (rozpracované).
    const b = await interested(rep, ["INFO"]);
    const rb = await follow(rep, b, { asked: ["PRICE", "DESIGN"], phonePrice: price, stepFromRequests: true });
    const lb = await lead(b);

    // Cena z telefónu pokryla všetko → nič na poslanie: server odmietne (klient by mal ísť cez výber kroku), nič sa nezapíše.
    const c = await interested(rep, ["INFO"]);
    await send(rep, c, { contents: ["ABOUT_US"] });
    const before = (await rows(c)).length;
    const rc = await follow(rep, c, { asked: ["PRICE"], phonePrice: price, stepFromRequests: true });
    const after = (await rows(c)).length;

    // Neplatné kombinácie.
    const d = await interested(rep, ["INFO"]);
    const withKind = await follow(rep, d, { asked: ["PRICE"], stepFromRequests: true, nextKind: "CALL" });
    const noAsk = await follow(rep, d, { stepFromRequests: true });
    const wrongOutcome = await follow(rep, d, { asked: ["PRICE"], stepFromRequests: true, outcome: "SNOOZE", schedule: { kind: "monthsFromToday", months: 2 } });

    check(
        "R01-2: with the phone price the derived step is what is STILL outstanding (INFO → send info; DESIGN → návrh), a retry replays, a changed payload conflicts",
        codeOf(ra) === "OK" && la.nextActionKind === "SEND_EMAIL" &&
            rowsA.find((r) => r.content === "PRICE")?.state === "SENT" && rowsA.find((r) => r.content === "INFO")?.state === "OPEN" &&
            codeOf(retry) === "OK" && (await rows(a)).length === rowsA.length &&
            codeOf(changed) === "ERR:IDEMPOTENCY_CONFLICT" &&
            codeOf(rb) === "OK" && lb.nextActionKind === "SEND_DESIGN" && lb.nextActionMode === "IN_PROGRESS",
        `${codeOf(ra)} step=${la.nextActionKind} rows=${rowsA.map((r) => `${r.content}:${r.state}`).join(",")} retry=${codeOf(retry)} changed=${codeOf(changed)} | ${codeOf(rb)} ${lb.nextActionKind}/${lb.nextActionMode}`,
    );
    check(
        "R01-2: nothing left outstanding → refused and nothing written; the flag with an explicit step, without asks or on another outcome is invalid",
        codeOf(rc) === "ERR:STALE" && before === after && codeOf(withKind) !== "OK" && codeOf(noAsk) !== "OK" && codeOf(wrongOutcome) !== "OK",
        `${codeOf(rc)} rows ${before}→${after} | ${codeOf(withKind)} ${codeOf(noAsk)} ${codeOf(wrongOutcome)}`,
    );
};

// R01-3: odloženie / uzavretie obchodu s nevybavenými požiadavkami klienta – menovanie presných id + dôvod, stiahnutie pod
// tým istým zámkom, jedna revízia, opakovanie, obnovenie po zmene v inej karte, znovuotvorenie bez oživenia.
tests.w5CloseWithdraw = async () => {
    const { interested, rows, lead, follow, asks, pipeline } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");
    const { REOPEN_STEP_NOTE } = await import("../../lib/domain/dealMutations");
    const snooze = { outcome: "SNOOZE" as const, schedule: { kind: "monthsFromToday" as const, months: 2 } };
    const idsOf = async (id: string) => (await rows(id)).filter((r) => r.state === "OPEN").map((r) => r.id);

    // Snooze: bez id / bez dôvodu / so zlým zoznamom sa neuloží, nič sa nezmení.
    const a = await interested(rep, ["DESIGN", "PRICE"]);
    const ids = await idsOf(a);
    const rev0 = await leadRev(a);
    const none = await follow(rep, a, { ...snooze });
    const noReason = await follow(rep, a, { ...snooze, withdraw: { ids, reason: "  " } });
    const partial = await follow(rep, a, { ...snooze, withdraw: { ids: [ids[0]], reason: "už nechcú" } });
    const foreignId = await follow(rep, a, { ...snooze, withdraw: { ids: [...ids, "cl_not_mine_000000000"], reason: "už nechcú" } });
    const untouched = (await rows(a)).every((r) => r.state === "OPEN") && (await leadRev(a)) === rev0;

    const k = key();
    const ok = await follow(rep, a, { ...snooze, withdraw: { ids, reason: "už nechcú" }, idempotencyKey: k });
    const la = await lead(a);
    const withdrawn = await rows(a);
    const audit = await prisma.activity.count({ where: { leadId: a, type: "CLIENT_ASK_CHANGED" } });
    const replay = await follow(rep, a, { ...snooze, withdraw: { ids, reason: "už nechcú" }, idempotencyKey: k, expectedRevision: rev0 });
    const conflict = await follow(rep, a, { ...snooze, withdraw: { ids, reason: "iný dôvod" }, idempotencyKey: k, expectedRevision: rev0 });
    const auditAfter = await prisma.activity.count({ where: { leadId: a, type: "CLIENT_ASK_CHANGED" } });

    check(
        "R01-3: snoozing with open asks needs their exact ids and a reason (missing / blank / partial / foreign id refused, nothing written); one save withdraws them all under one revision bump",
        codeOf(none) !== "OK" && codeOf(noReason) !== "OK" && codeOf(partial) === "ERR:STALE" && codeOf(foreignId) === "ERR:STALE" && untouched &&
            codeOf(ok) === "OK" && la.status === "SNOOZED" && la.revision === rev0 + 1 &&
            withdrawn.every((r) => r.state === "WITHDRAWN" && r.reason === "už nechcú" && r.resolvedById === rep.id && r.resolvedActivityId === null) &&
            audit === 1 && codeOf(replay) === "OK" && auditAfter === 1 && codeOf(conflict) === "ERR:IDEMPOTENCY_CONFLICT",
        `none=${codeOf(none)} blank=${codeOf(noReason)} partial=${codeOf(partial)} foreign=${codeOf(foreignId)} → ${codeOf(ok)} ${la.status} rev+${la.revision - rev0} audit=${audit}/${auditAfter} replay=${codeOf(replay)} conflict=${codeOf(conflict)}`,
    );

    // Iná karta pridala požiadavku po tom, čo táto videla zoznam → STALE, nič sa nestiahne.
    const b = await interested(rep, ["INFO"]);
    const seen = await idsOf(b);
    await asks(rep, b, { add: ["PRICE"] });
    const stale = await follow(rep, b, { outcome: "NOT_INTERESTED", lostReason: "nie", withdraw: { ids: seen, reason: "nie" } });
    const bStillOpen = (await idsOf(b)).length === 2 && (await lead(b)).status === "ACTIVE";

    // Uzavretie (LOST) a zlé číslo (UNREACHABLE) stiahnu; bez withdraw sa neuloží; „withdraw" mimo odloženia / uzavretia je neplatné.
    const c = await interested(rep, ["PRICELIST", "REVIEW"]);
    const cIds = await idsOf(c);
    const closeNoWithdraw = await follow(rep, c, { outcome: "NOT_INTERESTED", lostReason: "nie" });
    const wrongOutcome = await follow(rep, c, { withdraw: { ids: cIds, reason: "x" } });
    const lost = await follow(rep, c, { outcome: "NOT_INTERESTED", lostReason: "majú dodávateľa", withdraw: { ids: cIds, reason: "majú dodávateľa" } });
    const lc = await lead(c);

    const d = await interested(rep, ["INFO"]);
    const bad = await follow(rep, d, { outcome: "BAD_NUMBER", withdraw: { ids: await idsOf(d), reason: "zlé číslo" } });
    const ld = await lead(d);

    // Znovuotvorenie: stiahnutá požiadavka sa neoživí – bez nevybavenej práce ide pevné „Zavolať".
    const reopen = await pipeline.reopenDealAs(manager, c, { expectedRevision: await leadRev(c), idempotencyKey: key() });
    const lc2 = await lead(c);

    // Obchod bez otvorených požiadaviek sa odkladá ako predtým, bez withdraw.
    const e2 = await interested(rep, ["INFO"]);
    await asks(rep, e2, { withdraw: await idsOf(e2), reason: "už nechcú" });
    const plain = await follow(rep, e2, { ...snooze });

    check(
        "R01-3: a request changed in another tab → STALE and nothing is withdrawn; LOST / UNREACHABLE withdraw; closing without them or a withdraw on another outcome is refused; reopening does not revive them; a deal with nothing open snoozes as before",
        codeOf(stale) === "ERR:STALE" && bStillOpen &&
            codeOf(closeNoWithdraw) !== "OK" && codeOf(wrongOutcome) !== "OK" &&
            codeOf(lost) === "OK" && lc.status === "LOST" && (await rows(c)).every((r) => r.state === "WITHDRAWN") &&
            codeOf(bad) === "OK" && ld.status === "UNREACHABLE" &&
            codeOf(reopen) === "OK" && lc2.nextActionKind === "CALL" && lc2.nextActionNote === REOPEN_STEP_NOTE && (await idsOf(c)).length === 0 &&
            codeOf(plain) === "OK",
        `stale=${codeOf(stale)} kept=${bStillOpen} | noWithdraw=${codeOf(closeNoWithdraw)} wrongOutcome=${codeOf(wrongOutcome)} | lost=${codeOf(lost)} ${lc.status} bad=${codeOf(bad)} ${ld.status} | reopen=${codeOf(reopen)} ${lc2.nextActionKind} | plain=${codeOf(plain)}`,
    );
};

// R01-4: čo sa predzaškrtne v „Čo sme poslali" – len to, čo klient pýtal (čistá funkcia, ktorú používa dialóg).
tests.w5DialogDefaults = async () => {
    const cr = await import("../../lib/domain/clientRequests");
    const designOnly = cr.offerDefaults(["DESIGN"]);
    const nothing = cr.offerDefaults([]);
    const some = cr.offerDefaults(["INFO", "REVIEW"]);
    check(
        "R01-4: a návrh-only request (or nothing asked) preticks no e-mail content; only what was asked is ticked",
        !designOnly.aboutUs && !designOnly.pricelist && !designOnly.review &&
            !nothing.aboutUs && !nothing.pricelist && !nothing.review &&
            some.aboutUs && !some.pricelist && some.review,
        `design=${JSON.stringify(designOnly)} none=${JSON.stringify(nothing)} info+review=${JSON.stringify(some)}`,
    );
};

// R01-5: návrh poslaný mimo systému (deal bez Design riadku) – platný záznam, ktorý splní požiadavku, sa dá prečiarknuť
// a vráti ju; s Design riadkom sa obísť nedá; meta ani súhrn nepoužijú žiadne Design.sentAt.
tests.w5UntrackedDesign = async () => {
    const { interested, rows, lead, send, offers, design } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");

    const id = await interested(rep, ["DESIGN"]);
    const noIds = await send(rep, id, { contents: ["DESIGN"] });
    const both = await send(rep, id, { contents: ["DESIGN"], untrackedDesign: true, designIds: ["x"] });
    const wrongContent = await send(rep, id, { contents: ["ABOUT_US"], untrackedDesign: true });
    const k = key();
    const ok = await send(rep, id, { contents: ["DESIGN"], untrackedDesign: true, idempotencyKey: k, expectedRevision: await leadRev(id) });
    const l1 = await lead(id);
    const req = (await rows(id))[0];
    const offer = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT" } });
    const meta = offer.meta as { untrackedDesign?: boolean; designs?: unknown; contents?: string[] } | null;
    const retry = await send(rep, id, { contents: ["DESIGN"], untrackedDesign: true, idempotencyKey: k, expectedRevision: 0 });
    const offersAfterRetry = await prisma.activity.count({ where: { leadId: id, type: "OFFER_SENT" } });
    const designRows = await prisma.design.count({ where: { leadId: id } });

    // Prečiarknutie vráti požiadavku aj stĺpec návrhu.
    const fix = await offers.correctRecordAs(manager, offer.id, "poslané omylom");
    const l2 = await lead(id);
    const req2 = (await rows(id))[0];

    // Deal s Design riadkom: „návrh bez záznamu" sa odmietne.
    const withDesign = await interested(rep, ["DESIGN"]);
    await design(manager, withDesign, "smrek1");
    const bypass = await send(rep, withDesign, { contents: ["DESIGN"], untrackedDesign: true, expectedRevision: await leadRev(withDesign) });

    // Starý údaj obchodu bez návrhov ostane, kým sa preň nezapíše odoslanie bez záznamu.
    const legacy = await interested(rep, ["INFO"]);
    const legacyAt = new Date("2026-01-05T10:00:00.000Z");
    await prisma.lead.update({ where: { id: legacy }, data: { designSentAt: legacyAt } });
    await send(rep, legacy, { contents: ["ABOUT_US"] });
    const l3 = await lead(legacy);

    check(
        "R01-5: DESIGN without ids and without the untracked flag is refused; the flag with ids / on other contents is refused; the flag records DESIGN with no Design row, satisfies the request, sets designSentAt and creates no Design",
        codeOf(noIds) !== "OK" && codeOf(both) !== "OK" && codeOf(wrongContent) !== "OK" &&
            codeOf(ok) === "OK" && meta?.untrackedDesign === true && meta?.designs === undefined && meta?.contents?.join() === "DESIGN" &&
            req.state === "SENT" && req.resolvedActivityId === offer.id && l1.designSentAt !== null && designRows === 0 &&
            codeOf(retry) === "OK" && offersAfterRetry === 1,
        `noIds=${codeOf(noIds)} both=${codeOf(both)} wrong=${codeOf(wrongContent)} ok=${codeOf(ok)} untracked=${meta?.untrackedDesign} req=${req.state} designSentAt=${l1.designSentAt?.toISOString()} designRows=${designRows} retry=${codeOf(retry)}/${offersAfterRetry}`,
    );
    check(
        "R01-5: crossing out the untracked send reopens the request and clears designSentAt; a deal that HAS a Design cannot use the flag; an old designSentAt survives unrelated sends",
        codeOf(fix) === "OK" && req2.state === "OPEN" && l2.designSentAt === null &&
            codeOf(bypass) !== "OK" &&
            l3.designSentAt?.getTime() === legacyAt.getTime(),
        `fix=${codeOf(fix)} req=${req2.state} designSentAt=${l2.designSentAt} | bypass=${codeOf(bypass)} | legacy=${l3.designSentAt?.toISOString()}`,
    );
};

// Q2: manažér uzavrie obchod v detaile – LOST / UNREACHABLE stiahnu otvorené požiadavky (id + dôvod), WON ich nechá.
tests.w5ManagerClose = async () => {
    const { interested, rows, pipeline } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");
    const openIds = async (id: string) => (await rows(id)).filter((r) => r.state === "OPEN").map((r) => r.id);

    const a = await interested(rep, ["DESIGN", "PRICE"]);
    const ids = await openIds(a);
    const noWithdraw = await pipeline.changeStatusAs(manager, a, { status: "LOST", expectedRevision: await leadRev(a), idempotencyKey: key() });
    const blank = await pipeline.changeStatusAs(manager, a, { status: "LOST", expectedRevision: await leadRev(a), idempotencyKey: key(), withdraw: { ids, reason: " " } });
    const partial = await pipeline.changeStatusAs(manager, a, { status: "UNREACHABLE", expectedRevision: await leadRev(a), idempotencyKey: key(), withdraw: { ids: [ids[0]], reason: "x" } });
    const still = (await openIds(a)).length === 2;
    const ok = await pipeline.changeStatusAs(manager, a, { status: "UNREACHABLE", expectedRevision: await leadRev(a), idempotencyKey: key(), withdraw: { ids, reason: "zlé číslo" } });

    const b = await interested(rep, ["INFO"]);
    const lostNo = await pipeline.markLostAs(manager, b, { reason: "nie", expectedRevision: await leadRev(b), idempotencyKey: key() });
    const lostOk = await pipeline.markLostAs(manager, b, { reason: "nie", expectedRevision: await leadRev(b), idempotencyKey: key(), withdraw: { ids: await openIds(b), reason: "nie" } });

    const c = await interested(rep, ["PRICE"]);
    const wonWith = await pipeline.changeStatusAs(manager, c, { status: "WON", expectedRevision: await leadRev(c), idempotencyKey: key(), withdraw: { ids: await openIds(c), reason: "x" } });
    const won = await pipeline.changeStatusAs(manager, c, { status: "WON", expectedRevision: await leadRev(c), idempotencyKey: key() });

    check(
        "Q2: manager LOST / UNREACHABLE with open asks needs exact ids + a reason and withdraws them; WON leaves them and refuses a withdraw",
        codeOf(noWithdraw) !== "OK" && codeOf(blank) !== "OK" && codeOf(partial) === "ERR:STALE" && still && codeOf(ok) === "OK" &&
            (await rows(a)).every((r) => r.state === "WITHDRAWN" && r.reason === "zlé číslo") &&
            codeOf(lostNo) !== "OK" && codeOf(lostOk) === "OK" && (await openIds(b)).length === 0 &&
            codeOf(wonWith) !== "OK" && codeOf(won) === "OK" && (await openIds(c)).length === 1,
        `no=${codeOf(noWithdraw)} blank=${codeOf(blank)} partial=${codeOf(partial)} ok=${codeOf(ok)} | lost=${codeOf(lostNo)}/${codeOf(lostOk)} | won+w=${codeOf(wonWith)} won=${codeOf(won)}`,
    );
};

// Cena uvedená v našej SMS je fakt o tom, čo klient vie (kanál PHONE + via SMS, viazaný na SMS_SENT); iné kontakty ju nesmú niesť.
tests.w5SmsPrice = async () => {
    const { interested, rows, follow, lead } = await w5();
    const rep = await makeUser("SALES_REP");
    const id = await interested(rep, ["PRICE"]);
    const sms = await follow(rep, id, {
        contact: "SMS", note: "Cena webu je 990 €", phonePrice: { amount: 990, note: null },
        nextKind: "CALL", schedule: { kind: "daysFromToday", days: 3 },
    });
    const smsRow = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "SMS_SENT" } });
    const offer = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT" } });
    const meta = offer.meta as { channel?: string; via?: string; callActivityId?: string; price?: { amount?: string } } | null;
    const reqs = await rows(id);
    const l = await lead(id);
    const none = await follow(rep, id, { contact: "NONE", phonePrice: { amount: 1, note: null }, nextKind: "CALL", schedule: { kind: "daysFromToday", days: 3 } });
    const other = await interested(rep, ["INFO"]);
    const noSms = await follow(rep, other, {
        contact: "SMS", note: "Ahoj", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 3 },
    });
    check(
        "SMS with a price: one SMS_SENT + one OFFER_SENT (PHONE via SMS, linked to the SMS), the open PRICE request is satisfied, the price is the deal's; NONE cannot carry a price; a plain SMS writes no offer",
        codeOf(sms) === "OK" && meta?.channel === "PHONE" && meta.via === "SMS" && meta.callActivityId === smsRow.id && meta.price?.amount === "990" &&
            reqs.find((r) => r.content === "PRICE")?.state === "SENT" && Number(l.price) === 990 &&
            codeOf(none) !== "OK" && codeOf(noSms) === "OK" &&
            (await prisma.activity.count({ where: { leadId: other, type: "OFFER_SENT" } })) === 0,
        `${codeOf(sms)} ${meta?.channel}/${meta?.via} linked=${meta?.callActivityId === smsRow.id} req=${reqs[0]?.state} price=${l.price} none=${codeOf(none)} plain=${codeOf(noSms)}`,
    );
};

// „Poslali sme SMS" + ponechať krok: zapíše sa len SMS (a cena z nej), krok, dátum a stav ostávajú; jedna revízia.
tests.w5SmsKeepStep = async () => {
    const { interested, follow, lead } = await w5();
    const rep = await makeUser("SALES_REP");
    const id = await interested(rep, ["DESIGN"]);
    const before = await lead(id);
    const rev0 = await leadRev(id);
    const planningCount = () => prisma.activity.count({ where: { leadId: id, type: { in: ["NEXT_ACTION_CHANGED", "NEXT_ACTION_SET", "NEXT_ACTION_CLEARED"] } } });
    const planningBefore = await planningCount();
    const kept = await follow(rep, id, { contact: "SMS", note: "Návrh pošleme zajtra", keepStep: true });
    const after = await lead(id);
    const sms = await prisma.activity.count({ where: { leadId: id, type: "SMS_SENT" } });
    const planning = (await planningCount()) - planningBefore;
    // R02-4: cena v SMS dokončuje systémový krok – ponechať sa nedá; zámerne naplánovaný hovor sa ponechať dá.
    const priceOnSystem = await follow(rep, id, { contact: "SMS", note: "Cena 500 €", keepStep: true, phonePrice: { amount: 500, note: null } });
    const call = await follow(rep, id, { contact: "CALL", keepStep: true });
    const withStep = await follow(rep, id, { contact: "SMS", note: "x", keepStep: true, nextKind: "CALL", schedule: { kind: "daysFromToday", days: 2 } });
    await follow(rep, id, { nextKind: "CALL", schedule: { kind: "daysFromToday", days: 5 } });
    const callStep = await lead(id);
    const priceOnPlan = await follow(rep, id, { contact: "SMS", note: "Cena 500 €", keepStep: true, phonePrice: { amount: 500, note: null } });
    const planAfter = await lead(id);
    check(
        "SMS + keepStep: only the SMS is recorded, step / date / status stay, one bump; a price in the SMS may keep a deliberate CALL but NOT a system send step; keepStep on a call or with an explicit step is refused",
        codeOf(kept) === "OK" && sms === 1 && after.nextActionKind === before.nextActionKind &&
            after.nextActionAt?.getTime() === before.nextActionAt?.getTime() && after.status === before.status && after.revision === rev0 + 1 &&
            planning === 0 && codeOf(priceOnSystem) === "ERR:FORBIDDEN" && codeOf(call) !== "OK" && codeOf(withStep) !== "OK" &&
            codeOf(priceOnPlan) === "OK" && planAfter.nextActionKind === "CALL" && planAfter.nextActionAt?.getTime() === callStep.nextActionAt?.getTime(),
        `${codeOf(kept)} step ${before.nextActionKind}→${after.nextActionKind} rev+${after.revision - rev0} planningRows=${planning} priceOnSystem=${codeOf(priceOnSystem)} call=${codeOf(call)} withStep=${codeOf(withStep)} priceOnPlan=${codeOf(priceOnPlan)} ${planAfter.nextActionKind}`,
    );
};

// R02-3: prečiarknutá SMS potiahne so sebou cenu, ktorá v nej zaznela – jedna revízia, prepočet aj požiadavky; opačne nie.
tests.w5SmsCorrection = async () => {
    const { interested, follow, lead, rows, offers } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");
    const id = await interested(rep, ["PRICE"]);
    await follow(rep, id, { contact: "SMS", note: "Cena 990 €", phonePrice: { amount: 990, note: null }, nextKind: "CALL", schedule: { kind: "daysFromToday", days: 3 } });
    const sms = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "SMS_SENT" } });
    const priced = await lead(id);
    const req1 = (await rows(id))[0].state;
    const rev = await leadRev(id);
    const [a, b] = await Promise.all([offers.correctRecordAs(manager, sms.id, "neodoslané"), offers.correctRecordAs(rep, sms.id, "neodoslané")]);
    const offer = await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT" } });
    const l = await lead(id);
    const req2 = (await rows(id))[0].state;

    // Opačný smer: prečiarknutá cena nechá SMS platnú.
    const id2 = await interested(rep, ["PRICE"]);
    await follow(rep, id2, { contact: "SMS", note: "Cena 700 €", phonePrice: { amount: 700, note: null }, nextKind: "CALL", schedule: { kind: "daysFromToday", days: 3 } });
    const offer2 = await prisma.activity.findFirstOrThrow({ where: { leadId: id2, type: "OFFER_SENT" } });
    await offers.correctRecordAs(manager, offer2.id, "zlá suma");
    const sms2 = await prisma.activity.findFirstOrThrow({ where: { leadId: id2, type: "SMS_SENT" } });

    check(
        "R02-3: crossing out an SMS crosses out the price it carried in the same transaction (one bump, the PRICE request reopens, the deal's price knowledge clears); two concurrent corrections → one wins; crossing out only the price leaves the SMS",
        priced.offerPriceAt !== null && req1 === "SENT" &&
            [a, b].filter((r) => codeOf(r) === "OK").length === 1 && offer.revertedAt !== null &&
            l.offerPriceAt === null && req2 === "OPEN" && l.revision === rev + 1 &&
            sms2.revertedAt === null,
        `priced=${Boolean(priced.offerPriceAt)} req ${req1}→${req2} results=${codeOf(a)},${codeOf(b)} offerReverted=${offer.revertedAt !== null} offerPriceAt=${l.offerPriceAt} rev+${l.revision - rev} | smsKept=${sms2.revertedAt === null}`,
    );
};

// R02-1: manažér odkladá obchod v detaile – rovnaké pravidlo ako v akčnom okne (id + dôvod, stiahnutie, jedna revízia).
tests.w5ManagerSnooze = async () => {
    const { interested, rows, pipeline, ask, openTask, bt } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");
    const st = async (id: string, extra: Record<string, unknown>, status: "SNOOZED" | "ACTIVE" = "SNOOZED") =>
        pipeline.changeStatusAs(manager, id, { status, expectedRevision: await leadRev(id), idempotencyKey: (extra.idempotencyKey as string) ?? key(), ...extra } as never);
    const openIds = async (id: string) => (await rows(id)).filter((r) => r.state === "OPEN").map((r) => r.id);

    const a = await interested(rep, ["DESIGN", "PRICE"]);
    const ids = await openIds(a);
    const none = await st(a, {});
    const blank = await st(a, { withdraw: { ids, reason: " " } });
    const partial = await st(a, { withdraw: { ids: [ids[0]], reason: "x" } });
    const untouched = (await openIds(a)).length === 2 && (await prisma.lead.findUniqueOrThrow({ where: { id: a } })).status === "ACTIVE";
    const rev0 = await leadRev(a);
    const k = key();
    const ok = await st(a, { withdraw: { ids, reason: "ozvať sa neskôr" }, idempotencyKey: k });
    const la = await prisma.lead.findUniqueOrThrow({ where: { id: a } });
    const audit = await prisma.activity.count({ where: { leadId: a, type: "CLIENT_ASK_CHANGED" } });
    const replay = await pipeline.changeStatusAs(manager, a, { status: "SNOOZED", expectedRevision: rev0, idempotencyKey: k, withdraw: { ids, reason: "ozvať sa neskôr" } });
    const auditAfter = await prisma.activity.count({ where: { leadId: a, type: "CLIENT_ASK_CHANGED" } });
    // withdraw pri stave, ktorý ho nespotrebúva
    const wake = await st(a, { withdraw: { ids, reason: "x" } }, "ACTIVE");

    // Otvorená úloha + otvorené požiadavky naraz.
    const b = await interested(rep, ["PRICE"]);
    const t = await ask(rep, b, manager.id, { contents: ["PRICE"] });
    const bIds = await openIds(b);
    const taskOnly = await st(b, { cancelTask: { taskId: (await openTask(b))!.id, reason: "x" } });
    const wakeOn = bt.addBusinessCalendarDays(bt.businessDate(new Date()), 3);
    const both = await st(b, { cancelTask: { taskId: (await openTask(b))!.id, reason: "x" }, withdraw: { ids: bIds, reason: "nechcú" }, snoozeUntil: wakeOn });

    check(
        "R02-1: a manager's SNOOZED needs the exact open ask ids + a reason (none / blank / partial refused, nothing written), withdraws them once under one bump, replays by key, and a withdraw on ACTIVE is refused",
        codeOf(none) === "ERR:FORBIDDEN" && codeOf(blank) !== "OK" && codeOf(partial) === "ERR:STALE" && untouched &&
            codeOf(ok) === "OK" && la.status === "SNOOZED" && la.revision === rev0 + 1 && audit === 1 &&
            (await rows(a)).every((r) => r.state === "WITHDRAWN") && codeOf(replay) === "OK" && auditAfter === 1 &&
            codeOf(wake) !== "OK",
        `none=${codeOf(none)} blank=${codeOf(blank)} partial=${codeOf(partial)} ok=${codeOf(ok)} ${la.status} rev+${la.revision - rev0} audit=${audit}/${auditAfter} replay=${codeOf(replay)} wake=${codeOf(wake)}`,
    );
    check(
        "R02-1: with an open task AND open asks the snooze needs both the task cancellation and the withdrawal",
        codeOf(t) === "OK" && codeOf(taskOnly) !== "OK" && codeOf(both) === "OK" && (await rows(b)).every((r) => r.state === "WITHDRAWN") && (await openTask(b)) === null,
        `task=${codeOf(t)} taskOnly=${codeOf(taskOnly)} both=${codeOf(both)}`,
    );
};

// R02-2: Lead.designSentAt = najnovší platný dátum zo sledovaných návrhov aj z odoslaní bez Design riadku.
tests.w5UntrackedLifecycle = async () => {
    const { interested, send, offers, design, lead, queries, dealScope } = await w5();
    const rep = await makeUser("SALES_REP");
    const manager = await makeUser("MANAGER");
    const tracking = await import("../../lib/commands/tracking");

    // (a) len zmazaný Design pred odoslaním bez záznamu
    const a = await interested(rep, ["DESIGN"]);
    const d0 = await design(manager, a, "stary");
    await tracking.removeDesignAs(manager, d0.id);
    const sentA = await send(rep, a, { contents: ["DESIGN"], untrackedDesign: true });
    const la = await lead(a);

    // (b) Design vytvorený PO odoslaní, potom nesúvisiace odoslanie, (c) potom sa Design zmaže
    const b = await interested(rep, ["DESIGN"]);
    await send(rep, b, { contents: ["DESIGN"], untrackedDesign: true });
    const at = (await lead(b)).designSentAt;
    const d1 = await design(manager, b, "novy");
    await send(rep, b, { contents: ["ABOUT_US"] });
    const lb = await lead(b);
    await tracking.removeDesignAs(manager, d1.id);
    const lc = await lead(b);

    // (d) korekcia odoslania bez záznamu, kým existuje iný neposlaný Design
    const c = await interested(rep, ["DESIGN"]);
    await send(rep, c, { contents: ["DESIGN"], untrackedDesign: true });
    const offer = await prisma.activity.findFirstOrThrow({ where: { leadId: c, type: "OFFER_SENT" } });
    await design(manager, c, "neposlany");
    const fix = await offers.correctRecordAs(manager, offer.id, "omyl");
    const ld = await lead(c);

    const list = await queries.getDealList({ scope: dealScope(rep), owner: { userId: rep.id }, view: "got_design", take: 500 });
    const inFilter = list.rows.some((r) => r.id === b);

    check(
        "R02-2: designSentAt is the latest valid date across tracked designs AND untracked sends — a deleted Design does not suppress it, a later Design (and its deletion) does not clear it, crossing the send out with another unsent Design present clears it; the 'Dostali návrh' filter agrees",
        codeOf(sentA) === "OK" && la.designSentAt !== null &&
            at !== null && lb.designSentAt?.getTime() === at.getTime() && lc.designSentAt?.getTime() === at.getTime() &&
            codeOf(fix) === "OK" && ld.designSentAt === null && inFilter,
        `a=${la.designSentAt?.toISOString()} b=${lb.designSentAt?.toISOString()}=${at?.toISOString()} afterDelete=${lc.designSentAt?.toISOString()} d=${ld.designSentAt} filter=${inFilter}`,
    );
};

// R02-6: okamih odoslania v migračnom SQL je PRESNE offerInstant() z TypeScriptu – inak by sa migrovaná požiadavka po
// prvom prepočte považovala za novšiu než jej odoslanie a znova by sa otvorila (polnoc UTC vs. polnoc Bratislavy).
tests.w5InstantParity = async () => {
    const { interested, send, bt, today } = await w5();
    const sql = await import("./wave5-requests-sql");
    const { offerInstant, parseOfferMeta } = await import("../../lib/domain/offers");
    const rep = await makeUser("SALES_REP");
    const id = await interested(rep, ["INFO"]);
    await send(rep, id, { contents: ["ABOUT_US"] }); // dnešný záznam: čas zápisu
    await send(rep, id, { contents: ["PRICELIST"], sentOn: bt.addBusinessCalendarDays(today, -3) }); // spätne datované
    const created = new Date();
    for (const [sentOn, historical] of [["2026-03-15", true], ["2026-01-05", false], ["2026-07-01", true]] as const) {
        await prisma.activity.create({
            data: {
                leadId: id, userId: rep.id, type: "OFFER_SENT", category: "BUSINESS", source: "PIPELINE",
                note: "parita", meta: { channel: "EMAIL", contents: ["DESIGN"], price: null, sentOn, historical, migrated: true, correction: null },
                createdAt: created,
            },
        });
    }
    const rows = await prisma.activity.findMany({ where: { leadId: id, type: "OFFER_SENT" }, select: { id: true, createdAt: true, meta: true } });
    const viaSql = await prisma.$queryRawUnsafe<{ id: string; instant: Date }[]>(
        `SELECT a.id, ${sql.instantSql} AS instant FROM "Activity" a WHERE a."leadId" = $1 AND a.type = 'OFFER_SENT'`,
        id,
    );
    const sqlById = new Map(viaSql.map((r) => [r.id, new Date(r.instant).getTime()]));
    const diffs = rows.flatMap((r) => {
        const meta = parseOfferMeta(r.meta);
        if (!meta) return [`${r.id}: unparsable`];
        const want = offerInstant(meta, r.createdAt).getTime();
        return sqlById.get(r.id) === want ? [] : [`${meta.sentOn}: sql=${new Date(sqlById.get(r.id) ?? 0).toISOString()} ts=${new Date(want).toISOString()}`];
    });
    // Koniec-koncov: migrovaný riadok po prvom prepočte NEZMENÍ stav (v transakcii, ktorá sa vráti späť).
    const rq = await import("../../lib/domain/requestMutations");
    class Rollback extends Error {}
    const box: { state?: string; linked?: boolean } = {};
    try {
        await prisma.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(sql.insertReceipts("DESIGN", "DESIGN"));
                await rq.reconcileRequests(tx as never, id);
                const row = await tx.leadRequest.findFirstOrThrow({ where: { leadId: id, content: "DESIGN" } });
                box.state = row.state;
                box.linked = row.resolvedActivityId !== null;
                throw new Rollback();
            },
            { timeout: 60_000, maxWait: 30_000 },
        );
    } catch (error) {
        if (!(error instanceof Rollback)) throw error;
    }
    check(
        "R02-6: the migration SQL's send instant equals offerInstant() for today's, backdated and historical rows (Bratislava midnight, not UTC), and a migrated historical receipt stays SENT after the first reconcile",
        rows.length === 5 && diffs.length === 0 && box.state === "SENT" && box.linked === true,
        `rows=${rows.length} diffs=${diffs.join(" | ") || "none"} afterReconcile=${box.state}/${box.linked}`,
    );
};

// ── Wave 4: jedna úloha, viac častí (wave-4-proposal.md §2.13) ───────────────

// W4-0 čisté pravidlá (§2.13): stav úlohy je funkcia častí a NEZÁVISÍ od poradia; adresa zamietnutej časti;
// a vlastnosť P6 – zamknutý krok je vždy bez dátumu, SCHEDULED a spĺňa I10.
tests.w4Pure = async () => {
    const t = await import("../../lib/domain/tasks");
    const cr = await import("../../lib/domain/clientRequests");
    const statuses = ["REQUESTED", "DELIVERED", "DECLINED", "WITHDRAWN"] as const;

    // Každá kombinácia troch častí × každé poradie → vždy ten istý stav úlohy.
    const wrong: string[] = [];
    for (const a of statuses) {
        for (const b of statuses) {
            for (const c of statuses) {
                const parts = [{ status: a }, { status: b }, { status: c }];
                const want = a === "REQUESTED" || b === "REQUESTED" || c === "REQUESTED"
                    ? "OPEN"
                    : [a, b, c].includes("DELIVERED")
                      ? "DONE"
                      : [a, b, c].includes("DECLINED")
                        ? "DECLINED"
                        : "CANCELLED";
                const got = t.taskStatusOfParts(parts);
                const shuffled = t.taskStatusOfParts([parts[2], parts[0], parts[1]]);
                if (got !== want || shuffled !== want) wrong.push(`${a}/${b}/${c}: ${got}/${shuffled} want ${want}`);
            }
        }
    }
    check(
        "W4-0 (§2.4): the task status is a pure, order-independent function of its parts over all 64 combinations",
        wrong.length === 0,
        wrong.slice(0, 3).join(" | ") || "all 64 combinations agree",
    );

    // Adresa položky: zamietnutie nesie ČASŤ, návrh svoje id, ostatné nič. Staré riadky (bez part) si kľúč nezmenia.
    const keys = [
        t.itemKey({ taskId: "T", kind: "PRICE" }),
        t.itemKey({ taskId: "T", kind: "DESIGN", designId: "d1" }),
        t.itemKey({ taskId: "T", kind: "DECLINED", part: "PRICE" }),
        t.itemKey({ taskId: "T", kind: "DECLINED", part: "OTHER" }),
        t.itemKey({ taskId: "T", kind: "DECLINED" }),
    ];
    check(
        "W4-0 (§2.4): two declined parts of one task are two distinct item addresses; an old whole-task decline keeps its key",
        new Set(keys).size === 5 && keys[2] === "T:DECLINED:PRICE" && keys[4] === "T:DECLINED:",
        keys.join(" · "),
    );

    // Značka časti nikdy nepovie „poslané", kým niečo naozaj neodišlo, a nikdy „pripravené", keď sa to vedome neposiela.
    const marks = (sent: number, dismissed: number, waiting: number) => {
        const items = [
            ...Array.from({ length: sent }, () => ({ disposition: { state: "SENT" as const, at: "x", activityId: "a" } })),
            ...Array.from({ length: dismissed }, () => ({ disposition: { state: "DISMISSED" as const, at: "x", by: null, reason: null, activityId: "a" } })),
            ...Array.from({ length: waiting }, () => ({ disposition: { state: "WAITING" as const } })),
        ];
        const mark = t.partMarkOf("DELIVERED", { total: items.length, sentCount: sent, dismissedCount: dismissed, waitingCount: waiting });
        return t.partMarkLabel({ mark, items: items as never, sentCount: sent, dismissedCount: dismissed, waitingCount: waiting, reason: null });
    };
    check(
        "W4-0 (§2.3, R02-2): the compact mark never claims a client receipt for a deliberately unsent item, and never says 'pripravené' when nothing is left to send",
        marks(0, 0, 2) === "pripravené" && marks(1, 0, 1).startsWith("1 z 2") && marks(0, 1, 0).startsWith("neposiela sa") &&
            marks(1, 1, 0).includes("neposlané") && marks(2, 0, 0) === "poslané klientovi (2)",
        [marks(0, 0, 2), marks(1, 0, 1), marks(0, 1, 0), marks(1, 1, 0), marks(2, 0, 0)].join(" · "),
    );

    // P6: zamknutý krok je pre KAŽDÚ nevybavenú množinu bez dátumu, SCHEDULED, a jeho druh spĺňa I10.
    const contents = cr.REQUEST_CONTENTS;
    const subsets: (typeof contents)[number][][] = [];
    for (let mask = 0; mask < 1 << contents.length; mask++) {
        subsets.push(contents.filter((_, i) => mask & (1 << i)));
    }
    const bad: string[] = [];
    for (const set of subsets) {
        for (const current of [null, "CALL", "SEND_QUOTE", "SEND_DESIGN", "SEND_EMAIL", "WAITING_FOR_CLIENT"] as const) {
            const step = cr.defaultStep(set, {
                nextActionKind: current,
                nextActionAt: new Date(),
                nextActionHasTime: true,
                nextActionMode: "IN_PROGRESS",
                nextActionNote: null,
            }, { locked: true });
            if (!step) {
                if (set.length > 0) bad.push(`${set.join("+")}/${current}: null for a non-empty set`);
                continue;
            }
            if (step.nextActionAt !== null || step.nextActionHasTime || step.nextActionMode !== "SCHEDULED") {
                bad.push(`${set.join("+")}/${current}: ${step.nextActionAt}/${step.nextActionMode}`);
            }
            const required = t.requiredStepKinds(set.includes("DESIGN") ? [{ kind: "DESIGN" }] : set.includes("PRICE") ? [{ kind: "PRICE" }] : []);
            if (required && !required.includes(step.nextActionKind!)) bad.push(`${set.join("+")}: ${step.nextActionKind} violates I10`);
        }
    }
    check(
        "W4-0 (P0 / P6): for every outstanding set and every current step, the LOCKED step has no date and mode SCHEDULED, and its kind satisfies I10",
        bad.length === 0,
        bad.slice(0, 3).join(" | ") || `${subsets.length} sets × 6 current steps`,
    );
};


// Pomocníci nad časťami – testy sa pýtajú na to isté, čo číta appka.
const partRows = (taskId: string) => prisma.dealTaskPart.findMany({ where: { taskId }, orderBy: { kind: "asc" } });
const partStatus = async (taskId: string) => Object.fromEntries((await partRows(taskId)).map((p) => [p.kind, p.status]));
const taskRow = (taskId: string) => prisma.dealTask.findUniqueOrThrow({ where: { id: taskId } });
const rowsOf = (leadId: string, types: string[]) =>
    prisma.activity.findMany({
        where: { leadId, type: { in: types as never } },
        select: { type: true, idempotencyKey: true, note: true, meta: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

// W4-1 vznik: 1–3 druhy naraz = jedna úloha s jednou časťou na druh; duplicita neprejde; krok sa odvodí z celku;
// a krok PRED zamknutím sa uloží ako záložný (P6 / R02-3).
tests.w4Ask = async () => {
    const { tasks, lead, ask, openTask, follow } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");

    const id = await makeDeal(rep);
    const dup = await ask(rep, id, manager.id, { contents: ["PRICE", "PRICE"], step: undefined });
    const three = await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN", "OTHER"], step: undefined });
    const t = (await openTask(id))!;
    const l = await lead(id);
    const parts = await partRows(t.id);
    check(
        "W4-1: one task carries 1–3 parts (one per kind), duplicates are refused, the step follows the whole set (návrh wins) and the step has no date",
        codeOf(dup) !== "OK" && codeOf(three) === "OK" && parts.length === 3 && parts.every((p) => p.status === "REQUESTED") &&
            parts.length === 3 && l.nextActionKind === "SEND_DESIGN" && l.nextActionAt === null && l.nextActionMode === "SCHEDULED",
        `${codeOf(dup)} ${codeOf(three)} parts=${parts.map((p) => p.kind).join("+")} step=${l.nextActionKind}/${l.nextActionAt}`,
    );

    // Záložný krok: to, čo obchod mal PRED zamknutím – sem sa vráti, keď nebude čo poslať.
    const id2 = await makeDeal(rep);
    await follow(rep, id2, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 3 } });
    const before = await lead(id2);
    await ask(rep, id2, manager.id, { contents: ["OTHER"], step: undefined });
    const t2 = (await openTask(id2))!;
    const l2 = await lead(id2);
    check(
        "W4-1 (R02-3): the deal's step before the lock is stored as the task's fallback; an 'Iné'-only task keeps that step, without a date",
        t2.fallbackKind === "CALL" && t2.fallbackKind === before.nextActionKind && l2.nextActionKind === "CALL" && l2.nextActionAt === null,
        `fallback=${t2.fallbackKind} step=${l2.nextActionKind}/${l2.nextActionAt}`,
    );
    void tasks;
};

// W4-2 Michalov postup (§2.1): cena späť → úloha OTVORENÁ, krok zamknutý a stále „Poslať návrh"; rep pošle cenu
// samu; návrh späť → úloha DONE a krok odomknutý. Oba poradia aj naraz.
tests.w4Partial = async () => {
    const { tasks, lead, ask, openTask, send, design, pending, detail, bt, today } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const d = await design(manager, id, "variantA");
    await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
    const t = (await openTask(id))!;

    const onlyPrice = await tasks.resolveTaskPartsAs(manager, {
        taskId: t.id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285, note: null } }],
    });
    const afterPrice = await lead(id);
    const statusAfterPrice = await taskRow(t.id);
    const p1 = await pending(id);
    check(
        "W4-2: delivering the price leaves the task OPEN, the step locked and still 'Poslať návrh'; the price waits as prepared",
        codeOf(onlyPrice) === "OK" && statusAfterPrice.status === "OPEN" && afterPrice.nextActionKind === "SEND_DESIGN" &&
            afterPrice.nextActionAt === null && p1.length === 1 && p1[0].kind === "PRICE" && Number(afterPrice.price) === 1285,
        `${codeOf(onlyPrice)} task=${statusAfterPrice.status} step=${afterPrice.nextActionKind}/${afterPrice.nextActionAt} pending=${p1.map((i) => i.kind).join(",")}`,
    );

    // Klient povedal „cenu pošli teraz, na návrhu rob ďalej" – rep prejde zamknutým krokom a cenu pošle (§2.1 bod 5).
    const sentPrice = await send(rep, id, { contents: ["PRICE"], fulfils: [{ taskId: t.id, kind: "PRICE" }] });
    const afterSend = await lead(id);
    const stillOpen = await taskRow(t.id);
    check(
        "W4-2: the ready price can be sent while the task runs – no overlap question, the task stays OPEN, the step stays locked on 'Poslať návrh'",
        codeOf(sentPrice) === "OK" && stillOpen.status === "OPEN" && afterSend.nextActionKind === "SEND_DESIGN" && afterSend.nextActionAt === null &&
            (await pending(id)).length === 0,
        `${codeOf(sentPrice)} task=${stillOpen.status} step=${afterSend.nextActionKind}/${afterSend.nextActionAt}`,
    );

    const designBack = await tasks.resolveTaskPartsAs(manager, {
        taskId: t.id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        parts: [{ kind: "DESIGN", op: "DELIVER", designs: [{ id: d.id, version: d.currentVersion }] }],
    });
    const closed = await taskRow(t.id);
    const afterDesign = await lead(id);
    const view = await detail(id, rep);
    check(
        "W4-2: the last part closes the task (DONE), the step unlocks to today, the návrh waits to be sent, and the card shows both parts",
        codeOf(designBack) === "OK" && closed.status === "DONE" && afterDesign.nextActionKind === "SEND_DESIGN" &&
            afterDesign.nextActionAt !== null && bt.businessDate(afterDesign.nextActionAt) === today &&
            (await pending(id)).filter((i) => i.kind === "DESIGN").length === 1 &&
            view?.tasks[0].parts.length === 2 && view.tasks[0].parts.find((p) => p.kind === "PRICE")?.mark === "SENT" &&
            view.tasks[0].parts.find((p) => p.kind === "DESIGN")?.mark === "PREPARED",
        `${codeOf(designBack)} task=${closed.status} step=${afterDesign.nextActionKind} marks=${view?.tasks[0].parts.map((p) => `${p.kind}:${p.mark}`).join(",")}`,
    );

    // Opačné poradie a všetko naraz.
    const id2 = await makeDeal(rep);
    const d2 = await design(manager, id2, "variantB");
    await ask(rep, id2, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
    const t2 = (await openTask(id2))!;
    await tasks.resolveTaskPartsAs(manager, {
        taskId: t2.id,
        expectedRevision: await leadRev(id2),
        idempotencyKey: key(),
        parts: [{ kind: "DESIGN", op: "DELIVER", designs: [{ id: d2.id, version: d2.currentVersion }] }],
    });
    const midway = await taskRow(t2.id);
    await tasks.resolveTaskPartsAs(manager, {
        taskId: t2.id,
        expectedRevision: await leadRev(id2),
        idempotencyKey: key(),
        parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 999, note: null } }],
    });
    const end2 = await taskRow(t2.id);

    const id3 = await makeDeal(rep);
    const d3 = await design(manager, id3, "variantC");
    await ask(rep, id3, manager.id, { contents: ["PRICE", "DESIGN", "OTHER"], step: undefined });
    const t3 = (await openTask(id3))!;
    const allAtOnce = await tasks.resolveTaskPartsAs(manager, {
        taskId: t3.id,
        expectedRevision: await leadRev(id3),
        idempotencyKey: key(),
        parts: [
            { kind: "PRICE", op: "DELIVER", price: { amount: 500, note: null } },
            { kind: "DESIGN", op: "DELIVER", designs: [{ id: d3.id, version: d3.currentVersion }] },
            { kind: "OTHER", op: "DELIVER", answer: "hosting je v cene" },
        ],
    });
    const end3 = await taskRow(t3.id);
    const p3 = await pending(id3);
    check(
        "W4-2: both orders reach the same end, and all three parts in one save close the task with all three items waiting",
        midway.status === "OPEN" && end2.status === "DONE" && codeOf(allAtOnce) === "OK" && end3.status === "DONE" && p3.length === 3,
        `reverse=${midway.status}→${end2.status} atOnce=${codeOf(allAtOnce)}/${end3.status} items=${p3.map((i) => i.kind).join(",")}`,
    );
};

// W4-3 (R02-4): vyplnené pole nie je rozhodnutie – odovzdá sa LEN to, čo manažér menoval; hodnoty pre nemenovaný
// druh sú neplatné.
tests.w4Selection = async () => {
    const { tasks, ask, openTask, design, pipeline } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    // Obchod má starú cenu – tú dialóg predvyplní, ale odovzdať sa nesmie bez výslovného zaškrtnutia.
    await pipeline.saveQuoteAs(manager, id, { price: 700, priceNote: "stará" });
    const d = await design(manager, id, "variantA");
    await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
    const t = (await openTask(id))!;

    const onlyDesign = await tasks.resolveTaskPartsAs(manager, {
        taskId: t.id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        parts: [{ kind: "DESIGN", op: "DELIVER", designs: [{ id: d.id, version: d.currentVersion }] }],
    });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { price: true, priceNote: true } });
    const status = await partStatus(t.id);
    const pricePart = (await partRows(t.id)).find((p) => p.kind === "PRICE");

    const crossValues = await tasks.resolveTaskPartsAs(manager, {
        taskId: t.id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 10, note: null }, answer: "navyše" }],
    });
    check(
        "W4-3 (R02-4): delivering only the návrh leaves PRICE requested, writes no price result and does not touch the deal's price; values for a kind that was not named are refused",
        codeOf(onlyDesign) === "OK" && status.PRICE === "REQUESTED" && status.DESIGN === "DELIVERED" && pricePart?.result === null &&
            Number(after.price) === 700 && after.priceNote === "stará" && codeOf(crossValues) === "ERR:FORBIDDEN",
        `${codeOf(onlyDesign)} ${JSON.stringify(status)} price=${after.price} cross=${codeOf(crossValues)}`,
    );
};

// W4-4 (§2.6, P6): zamknutý krok presne nasleduje nevybavenú prácu – pri každej udalosti bez dátumu a v režime
// SCHEDULED. B1: obchod BEZ úlohy sa nesmie dotknúť. B3: uzavretie úlohy nemení režim.
tests.w4StepLocked = async () => {
    const { tasks, lead, ask, openTask, send, follow, design, offers } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const d = await design(manager, id, "variantA");
    await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
    const t = (await openTask(id))!;
    const locked: string[] = [];
    const snap = async (label: string) => {
        const l = await lead(id);
        locked.push(`${label}=${l.nextActionKind}/${l.nextActionAt === null ? "null" : "date"}/${l.nextActionMode}`);
        return l;
    };
    await snap("ask");
    await tasks.resolveTaskPartsAs(manager, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285, note: null } }] });
    await snap("priceDelivered");
    const sent = await send(rep, id, { contents: ["PRICE"], fulfils: [{ taskId: t.id, kind: "PRICE" }] });
    await snap("priceSent");
    // R02-5: kým je úloha otvorená, oprava odoslania krok ZNOVA odvodí – rep ho opraviť nemôže, tak to musí appka.
    const offerId = (await prisma.activity.findFirstOrThrow({ where: { leadId: id, type: "OFFER_SENT", revertedAt: null } })).id;
    const corrected = await offers.correctRecordAs(rep, offerId, "zlá suma v maili");
    const afterCorrection = await snap("correction");
    await tasks.resolveTaskPartsAs(manager, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), parts: [{ kind: "DESIGN", op: "DELIVER", designs: [{ id: d.id, version: d.currentVersion }] }] });
    const closed = await snap("closed");
    const allLocked = locked.slice(0, 4).every((s) => s.includes("/null/SCHEDULED"));
    check(
        "W4-4 (P6 / R02-5): the locked step follows outstanding through deliver / send / correction – always without a date and SCHEDULED; a correction while locked re-derives it; closing keeps the mode",
        codeOf(sent) === "OK" && codeOf(corrected) === "OK" && allLocked && afterCorrection.nextActionKind === "SEND_DESIGN" &&
            closed.nextActionMode === "SCHEDULED" && closed.nextActionAt !== null,
        locked.join(" · "),
    );

    // B1: SMS s cenou na obchode BEZ úlohy („keepStep") sa kroku nesmie dotknúť – ani druhu, ani dátumu, ani režimu.
    const id2 = await makeDeal(rep);
    await follow(rep, id2, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 4 } });
    const beforeSms = await lead(id2);
    const sms = await follow(rep, id2, { contact: "SMS", keepStep: true, phonePrice: { amount: 500 }, note: "cena 500" });
    const afterSms = await lead(id2);
    check(
        "W4-4 (B1): an SMS with a price on a deal with NO task keeps the step, its date and its mode untouched",
        codeOf(sms) === "OK" && afterSms.nextActionKind === beforeSms.nextActionKind &&
            afterSms.nextActionAt?.getTime() === beforeSms.nextActionAt?.getTime() && afterSms.nextActionMode === beforeSms.nextActionMode,
        `${codeOf(sms)} ${beforeSms.nextActionKind}/${beforeSms.nextActionAt?.toISOString()} → ${afterSms.nextActionKind}/${afterSms.nextActionAt?.toISOString()}`,
    );
};

// W4-5 (R02-3): keď už niet čo poslať, zamknutý krok padá na ZÁLOŽNÝ – a vlastná voľba používateľa sa vráti.
tests.w4Fallback = async () => {
    const { tasks, lead, ask, openTask, follow, send, bt, today } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await follow(rep, id, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 5 } });
    await ask(rep, id, manager.id, { contents: ["OTHER"], step: undefined });
    const t = (await openTask(id))!;
    const onlyOther = await lead(id);

    // „Iné" nie je systémový krok a CALL tiež nie – P6 ho napriek tomu smie dočasne vytlačiť (§2.6).
    const added = await tasks.addTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["PRICE"], message: "klient volal, chce aj cenu" });
    const withPrice = await lead(id);
    const back = await tasks.withdrawTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["PRICE"], reason: "cenu si zistím sám" });
    const restored = await lead(id);
    check(
        "W4-5 (R02-3): an 'Iné'-only task keeps the deliberate call; adding PRICE moves the locked step to 'Poslať cenu' although CALL is not a system step; withdrawing it restores the call",
        onlyOther.nextActionKind === "CALL" && codeOf(added) === "OK" && withPrice.nextActionKind === "SEND_QUOTE" && withPrice.nextActionAt === null &&
            codeOf(back) === "OK" && restored.nextActionKind === "CALL" && restored.nextActionAt === null,
        `${onlyOther.nextActionKind} → ${codeOf(added)}/${withPrice.nextActionKind} → ${codeOf(back)}/${restored.nextActionKind}`,
    );

    // PRICE + OTHER: cena odíde, ostane len „Iné" → krok sa už nesmie tváriť, že treba niečo poslať.
    const id2 = await makeDeal(rep);
    await follow(rep, id2, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 5 } });
    await ask(rep, id2, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t2 = (await openTask(id2))!;
    await tasks.resolveTaskPartsAs(manager, { taskId: t2.id, expectedRevision: await leadRev(id2), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 300, note: null } }] });
    await send(rep, id2, { contents: ["PRICE"], fulfils: [{ taskId: t2.id, kind: "PRICE" }] });
    const afterSend = await lead(id2);
    const answered = await tasks.resolveTaskPartsAs(manager, { taskId: t2.id, expectedRevision: await leadRev(id2), idempotencyKey: key(), parts: [{ kind: "OTHER", op: "DELIVER", answer: "áno, ide to" }] });
    const afterClose = await lead(id2);
    check(
        "W4-5 (R02-3): once the sendable part is gone the locked step becomes the fallback instead of lying about 'Poslať cenu'; closing the task makes it due today",
        afterSend.nextActionKind === "CALL" && afterSend.nextActionAt === null && codeOf(answered) === "OK" &&
            afterClose.nextActionKind === "CALL" && afterClose.nextActionAt !== null && bt.businessDate(afterClose.nextActionAt) === today,
        `afterSend=${afterSend.nextActionKind}/${afterSend.nextActionAt} afterClose=${afterClose.nextActionKind}/${afterClose.nextActionAt}`,
    );
};

// W4-6 (R02-1): každý koniec úlohy. Stav aj riadok na úrovni úlohy určuje VÝSLEDNÝ stav, nie názov akcie –
// zamietnutie po dodávke je „Vybavené", nie „Zamietnuté".
tests.w4Terminal = async () => {
    const { tasks, ask, openTask, pipeline } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const start = async (contents: ("PRICE" | "DESIGN" | "OTHER")[]) => {
        const id = await makeDeal(rep);
        await ask(rep, id, manager.id, { contents, step: undefined });
        return { id, t: (await openTask(id))! };
    };
    const deliverPrice = (amount = 100) => ({ kind: "PRICE" as const, op: "DELIVER" as const, price: { amount, note: null } });
    const resolve = async (id: string, taskId: string, parts: Parameters<typeof tasks.resolveTaskPartsAs>[1]["parts"]) =>
        tasks.resolveTaskPartsAs(manager, { taskId, expectedRevision: await leadRev(id), idempotencyKey: key(), parts });

    // 1. dodať všetko  2. dodať a zvyšok zamietnuť v jednom príkaze
    const a = await start(["PRICE"]);
    await resolve(a.id, a.t.id, [deliverPrice()]);
    const b = await start(["PRICE", "OTHER"]);
    await resolve(b.id, b.t.id, [deliverPrice(), { kind: "OTHER", op: "DECLINE", reason: "to nevie nikto" }]);
    // 3. zamietnuť všetko, nič sa nedodalo  4. zamietnuť zvyšok PO dodávke (kľúčový riadok tabuľky)
    const c = await start(["PRICE", "OTHER"]);
    await resolve(c.id, c.t.id, [
        { kind: "PRICE", op: "DECLINE", reason: "nemám podklady" },
        { kind: "OTHER", op: "DECLINE", reason: "to nevie nikto" },
    ]);
    const d = await start(["PRICE", "OTHER"]);
    await resolve(d.id, d.t.id, [deliverPrice()]);
    await resolve(d.id, d.t.id, [{ kind: "OTHER", op: "DECLINE", reason: "to nevie nikto" }]);
    // 5. stiahnuť poslednú časť bez dodávky  6. stiahnuť poslednú PO dodávke
    const e = await start(["PRICE"]);
    await tasks.withdrawTaskPartsAs(rep, { taskId: e.t.id, expectedRevision: await leadRev(e.id), idempotencyKey: key(), kinds: ["PRICE"], reason: "netreba" });
    const f = await start(["PRICE", "OTHER"]);
    await resolve(f.id, f.t.id, [deliverPrice()]);
    await tasks.withdrawTaskPartsAs(rep, { taskId: f.t.id, expectedRevision: await leadRev(f.id), idempotencyKey: key(), kinds: ["OTHER"], reason: "netreba" });
    // 7. uzavretie obchodu bez dodávky  8. uzavretie obchodu PO dodávke
    const g = await start(["PRICE"]);
    await pipeline.markLostAs(manager, g.id, { reason: "test", expectedRevision: await leadRev(g.id), idempotencyKey: key(), cancelTask: { taskId: g.t.id, reason: null } });
    const h = await start(["PRICE", "OTHER"]);
    await resolve(h.id, h.t.id, [deliverPrice()]);
    await pipeline.markLostAs(manager, h.id, { reason: "test", expectedRevision: await leadRev(h.id), idempotencyKey: key(), cancelTask: { taskId: h.t.id, reason: null } });

    const states = await Promise.all([a, b, c, d, e, f, g, h].map((x) => taskRow(x.t.id)));
    const wantStatus = ["DONE", "DONE", "DECLINED", "DONE", "CANCELLED", "DONE", "CANCELLED", "DONE"];
    const taskRows = await Promise.all(
        [a, b, c, d, e, f, g, h].map(async (x) => (await rowsOf(x.id, ["TASK_DONE", "TASK_DECLINED", "TASK_CANCELLED"])).map((r) => r.type).join("+")),
    );
    const wantRows = ["TASK_DONE", "TASK_DONE", "TASK_DECLINED", "TASK_DONE", "TASK_CANCELLED", "TASK_DONE", "TASK_CANCELLED", "TASK_DONE"];
    // Hlavný keyed riadok príkazu, ktorý zvyšok zamietol PO dodávke, je TASK_PART_DECLINED – ale úloha je DONE.
    const dPartRows = (await rowsOf(d.id, ["TASK_PART_DONE", "TASK_PART_DECLINED"])).map((r) => `${r.type}:${r.idempotencyKey ? "keyed" : "plain"}`);
    check(
        "W4-6 (R02-1): every ending follows the RESULTING status – decline / withdraw / deal close after a delivery all end as DONE with a TASK_DONE row, never TASK_CANCELLED",
        states.map((s) => s.status).join(",") === wantStatus.join(",") && taskRows.join(",") === wantRows.join(",") &&
            dPartRows.join(",") === "TASK_PART_DONE:keyed,TASK_PART_DECLINED:keyed",
        `status=${states.map((s) => s.status).join(",")} rows=${taskRows.join(",")} d=${dPartRows.join(",")}`,
    );

    // Dodaná položka prežije každý koniec (§2.10) – aj uzavretie obchodu ju len „neposiela", nikdy nezmaže.
    const deliveredStates = await Promise.all([d, f, h].map(async (x) => (await partStatus(x.t.id)).PRICE));
    check(
        "W4-6: a delivered part survives a declined rest, a withdrawn rest and a closed deal",
        deliveredStates.every((s) => s === "DELIVERED"),
        deliveredStates.join(","),
    );
};

// W4-7 (R02-2): osud každej VRÁTENEJ POLOŽKY je vlastný. Vedome neposlaný návrh sa nikdy nesmie tváriť ako
// „klient ho dostal".
tests.w4Items = async () => {
    const { tasks, ask, openTask, send, design, detail } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const dA = await design(manager, id, "variantA");
    const dB = await design(manager, id, "variantB");
    await ask(rep, id, manager.id, { contents: ["DESIGN"], step: undefined });
    const t = (await openTask(id))!;
    await tasks.resolveTaskPartsAs(manager, {
        taskId: t.id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        parts: [{ kind: "DESIGN", op: "DELIVER", designs: [{ id: dA.id, version: dA.currentVersion }, { id: dB.id, version: dB.currentVersion }] }],
    });
    const bothWaiting = (await detail(id, rep))!.tasks[0].parts[0];

    await send(rep, id, { contents: ["DESIGN"], designIds: [dA.id], fulfils: [{ taskId: t.id, kind: "DESIGN", designId: dA.id }] });
    const oneSent = (await detail(id, rep))!.tasks[0].parts[0];

    await tasks.dismissResultsAs(rep, {
        leadId: id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        taskId: t.id,
        items: [{ kind: "DESIGN", designId: dB.id }],
        reason: "klient chce len A",
    });
    const oneDismissed = (await detail(id, rep))!.tasks[0].parts[0];
    const dispositions = oneDismissed.items.map((i) => i.disposition.state).sort().join(",");
    const dismissed = oneDismissed.items.find((i) => i.disposition.state === "DISMISSED")?.disposition;
    check(
        "W4-7 (R02-2): a DESIGN part returning two návrhy tracks each item on its own – waiting, sent (with its date) and deliberately not sent (with who and why); the part never reads as fully received",
        bothWaiting.mark === "PREPARED" && bothWaiting.items.length === 2 &&
            oneSent.mark === "PARTLY_SENT" && oneSent.sentCount === 1 && oneSent.waitingCount === 1 &&
            oneDismissed.mark === "PARTLY_SENT" && oneDismissed.dismissedCount === 1 && oneDismissed.waitingCount === 0 &&
            dispositions === "DISMISSED,SENT" && dismissed?.state === "DISMISSED" && dismissed.reason === "klient chce len A" &&
            oneSent.items.some((i) => i.disposition.state === "SENT" && typeof i.disposition.at === "string"),
        `both=${bothWaiting.mark} sent=${oneSent.mark}/${oneSent.sentCount} end=${oneDismissed.mark}/${oneDismissed.dismissedCount} ${dispositions}`,
    );

    // Zamietnutá ČASŤ vracia vlastné potvrdenie – dve zamietnuté časti sú dve potvrdenia, nie jedno (§2.4).
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t2 = (await openTask(id2))!;
    await tasks.resolveTaskPartsAs(manager, {
        taskId: t2.id,
        expectedRevision: await leadRev(id2),
        idempotencyKey: key(),
        parts: [
            { kind: "PRICE", op: "DECLINE", reason: "nemám podklady" },
            { kind: "OTHER", op: "DECLINE", reason: "to nevie nikto" },
        ],
    });
    const { loadPending } = await import("../../lib/domain/taskMutations");
    const declined = await loadPending(prisma, id2);
    const one = await tasks.dismissResultsAs(rep, {
        leadId: id2,
        expectedRevision: await leadRev(id2),
        idempotencyKey: key(),
        taskId: t2.id,
        items: [{ kind: "DECLINED", part: "PRICE" }],
        reason: null,
    });
    const left = await loadPending(prisma, id2);
    check(
        "W4-7: two declined parts are two separate acknowledgements; dismissing one leaves the other",
        declined.length === 2 && declined.every((i) => i.kind === "DECLINED") && new Set(declined.map((i) => i.part)).size === 2 &&
            codeOf(one) === "OK" && left.length === 1 && left[0].part === "OTHER",
        `declined=${declined.map((i) => i.part).join(",")} ${codeOf(one)} left=${left.map((i) => i.part).join(",")}`,
    );
};

// W4-8: stiahnutie a pridanie častí – kto smie, čo sa smie a čo sa už nikdy nepýta znova.
tests.w4WithdrawAdd = async () => {
    const { tasks, lead, ask, openTask, design, bt, today } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const rep2 = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const d = await design(manager, id, "variantA");
    await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
    const t = (await openTask(id))!;

    const byManager = await tasks.withdrawTaskPartsAs(manager, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["PRICE"], reason: "x" });
    const byStranger = await tasks.withdrawTaskPartsAs(rep2, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["PRICE"], reason: "x" });
    const noReason = await tasks.withdrawTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["PRICE"], reason: " " });
    const stepTooEarly = await tasks.withdrawTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["PRICE"], reason: "netreba", step: { kind: "CALL", note: null } });
    const ok = await tasks.withdrawTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["PRICE"], reason: "cenu si zistím sám" });
    const afterWithdraw = await taskRow(t.id);
    const statuses = await partStatus(t.id);
    check(
        "W4-8: only the owner withdraws a part, a reason is required, a new step is refused while the task stays open; the rest of the task runs on",
        codeOf(byManager) === "ERR:FORBIDDEN" && codeOf(byStranger) !== "OK" && codeOf(noReason) !== "OK" && codeOf(stepTooEarly) === "ERR:FORBIDDEN" &&
            codeOf(ok) === "OK" && afterWithdraw.status === "OPEN" && statuses.PRICE === "WITHDRAWN" && statuses.DESIGN === "REQUESTED",
        `${codeOf(byManager)} ${codeOf(byStranger)} ${codeOf(noReason)} ${codeOf(stepTooEarly)} ${codeOf(ok)} ${JSON.stringify(statuses)}`,
    );

    // Stiahnutý druh sa smie vyžiadať znova; dodaný ani zamietnutý nikdy (§2.4).
    const readd = await tasks.addTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["PRICE"], message: "predsa len ju treba" });
    const afterReadd = await partRows(t.id);
    const priceAgain = afterReadd.find((p) => p.kind === "PRICE");
    const duplicate = await tasks.addTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["DESIGN"], message: "znova" });
    const noMessage = await tasks.addTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["OTHER"], message: " " });
    const byManagerAdd = await tasks.addTaskPartsAs(manager, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["OTHER"], message: "pridávam" });
    check(
        "W4-8: a withdrawn kind returns to REQUESTED with a clean record; a kind already in play, an empty message and a non-owner are refused",
        codeOf(readd) === "OK" && priceAgain?.status === "REQUESTED" && priceAgain.resolvedAt === null && priceAgain.reason === null &&
            codeOf(duplicate) === "ERR:STALE" && codeOf(noMessage) !== "OK" && codeOf(byManagerAdd) === "ERR:FORBIDDEN",
        `${codeOf(readd)} price=${priceAgain?.status}/${priceAgain?.reason} ${codeOf(duplicate)} ${codeOf(noMessage)} ${codeOf(byManagerAdd)}`,
    );

    // Dodaná časť sa nestiahne – na to je „Neposielam" (§2.10).
    await tasks.resolveTaskPartsAs(manager, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), parts: [{ kind: "DESIGN", op: "DELIVER", designs: [{ id: d.id, version: d.currentVersion }] }] });
    const deliveredWithdraw = await tasks.withdrawTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["DESIGN"], reason: "netreba" });
    const addDelivered = await tasks.addTaskPartsAs(rep, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), kinds: ["DESIGN"], message: "ešte raz" });
    // Zvolený krok pri zatváraní sa prijme LEN vtedy, keď klientovi nič nedlhujeme – tu čaká dodaný návrh.
    const planWhileOwed = await tasks.withdrawTaskPartsAs(rep, {
        taskId: t.id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        kinds: ["PRICE"],
        reason: "netreba",
        step: { kind: "CALL", note: "ozvem sa" },
    });
    check(
        "W4-8: a delivered part can be neither withdrawn nor re-added, and a chosen step is refused while a delivered návrh is still waiting to be sent (I10)",
        codeOf(deliveredWithdraw) === "ERR:STALE" && codeOf(addDelivered) === "ERR:STALE" && codeOf(planWhileOwed) === "ERR:STALE" &&
            (await taskRow(t.id)).status === "OPEN",
        `${codeOf(deliveredWithdraw)} ${codeOf(addDelivered)} ${codeOf(planWhileOwed)}`,
    );

    // „Zrušiť + zmeniť" na čistom obchode: posledná časť sa stiahne a rep si v tom istom uložení zvolí krok.
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id, { contents: ["PRICE"], step: undefined });
    const t2 = (await openTask(id2))!;
    const closeAndPlan = await tasks.withdrawTaskPartsAs(rep, {
        taskId: t2.id,
        expectedRevision: await leadRev(id2),
        idempotencyKey: key(),
        kinds: ["PRICE"],
        reason: "netreba",
        step: { kind: "CALL", note: "ozvem sa" },
    });
    const afterPlan = await lead(id2);
    check(
        "W4-8: withdrawing the LAST open part with a chosen step closes the task (CANCELLED) and plans that step today",
        codeOf(closeAndPlan) === "OK" && (await taskRow(t2.id)).status === "CANCELLED" && afterPlan.nextActionKind === "CALL" &&
            afterPlan.nextActionNote === "ozvem sa" && afterPlan.nextActionAt !== null && bt.businessDate(afterPlan.nextActionAt) === today,
        `${codeOf(closeAndPlan)} step=${afterPlan.nextActionKind}/${afterPlan.nextActionNote}`,
    );
};

// W4-9 (§2.8): odoslanie počas otvorenej úlohy. Otázka padne LEN na to, čo sa ešte robí – a „už to netreba"
// stiahne presne tie časti, nie celú úlohu.
tests.w4SendWhileOpen = async () => {
    const { tasks, lead, ask, openTask, send, design } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const d = await design(manager, id, "variantA");
    await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
    const t = (await openTask(id))!;

    const noChoice = await send(rep, id, { contents: ["PRICE"], price: { amount: 1, note: null } });
    const unrelated = await send(rep, id, { contents: ["ABOUT_US"] });
    const keepOpen = await send(rep, id, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "KEEP_OPEN" });
    const afterKeep = await taskRow(t.id);
    check(
        "W4-9: sending a content whose part is still being made needs a choice; unrelated contents need none; KEEP_OPEN records the send and keeps every part",
        codeOf(noChoice) === "ERR:TASK_OVERLAP" && codeOf(unrelated) === "OK" && codeOf(keepOpen) === "OK" && afterKeep.status === "OPEN" &&
            Object.values(await partStatus(t.id)).every((s) => s === "REQUESTED"),
        `${codeOf(noChoice)} ${codeOf(unrelated)} ${codeOf(keepOpen)} ${JSON.stringify(await partStatus(t.id))}`,
    );

    // „Už to netreba" pri prekryve stiahne LEN cenu – návrh sa robí ďalej a krok ostáva zamknutý.
    const withdrawPrice = await send(rep, id, {
        contents: ["PRICE"],
        price: { amount: 2, note: null },
        overlap: "WITHDRAW_PARTS",
        withdrawParts: { taskId: t.id, kinds: ["PRICE"], reason: "cenu som zistil sám" },
    });
    const afterWithdraw = await taskRow(t.id);
    const l = await lead(id);
    check(
        "W4-9: WITHDRAW_PARTS takes back exactly the overlapping part; the task stays OPEN for the rest and the step stays locked on 'Poslať návrh'",
        codeOf(withdrawPrice) === "OK" && afterWithdraw.status === "OPEN" && (await partStatus(t.id)).PRICE === "WITHDRAWN" &&
            l.nextActionKind === "SEND_DESIGN" && l.nextActionAt === null,
        `${codeOf(withdrawPrice)} task=${afterWithdraw.status} ${JSON.stringify(await partStatus(t.id))} step=${l.nextActionKind}/${l.nextActionAt}`,
    );

    // Posledná robiaca sa časť stiahnutá odoslaním → úloha sa zavrie a krok sa odomkne.
    const closing = await send(rep, id, {
        contents: ["DESIGN"],
        designIds: [d.id],
        overlap: "WITHDRAW_PARTS",
        withdrawParts: { taskId: t.id, kinds: ["DESIGN"], reason: "návrh netreba" },
        followUp: true,
    });
    const closed = await taskRow(t.id);
    const after = await lead(id);
    check(
        "W4-9: withdrawing the last part in a send closes the task and unlocks the step (the follow-up call is planned)",
        codeOf(closing) === "OK" && closed.status === "CANCELLED" && after.nextActionKind === "CALL" && after.nextActionAt !== null,
        `${codeOf(closing)} task=${closed.status} step=${after.nextActionKind}`,
    );

    // Počas otvorenej úlohy sa hovor „či prišlo" nikdy neplánuje (krok je zamknutý).
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t2 = (await openTask(id2))!;
    await tasks.resolveTaskPartsAs(manager, { taskId: t2.id, expectedRevision: await leadRev(id2), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 5, note: null } }] });
    const sendWithCall = await send(rep, id2, { contents: ["PRICE"], fulfils: [{ taskId: t2.id, kind: "PRICE" }], followUp: true });
    const l2 = await lead(id2);
    check(
        "W4-9: no follow-up call is planned while the task is open – the step stays locked (the neutral CALL fallback, never 'Zavolať, či cena prišla')",
        codeOf(sendWithCall) === "OK" && l2.nextActionNote !== "Zavolať, či cena prišla" && l2.nextActionAt === null && (await taskRow(t2.id)).status === "OPEN",
        `${codeOf(sendWithCall)} step=${l2.nextActionKind}/${l2.nextActionAt}`,
    );
};

// W4-10 (R02-6 / §7 P1): „Zavolať, či prišlo" sa smie naplánovať LEN vtedy, keď klientovi po odoslaní už nič
// nedlhujeme – nie vtedy, keď len nezostala žiadna položka úlohy.
tests.w4FollowUpGate = async () => {
    const { tasks, lead, ask, openTask, send, offers } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const { logCallAs } = await import("../../lib/commands/calls");

    const withAsks = async () => {
        const id = await makeAssignedLead(rep.id);
        const r = await logCallAs(rep, {
            leadId: id,
            outcome: "INTERESTED",
            asked: ["INFO", "PRICELIST", "PRICE"],
            expectedRevision: await leadRev(id),
            idempotencyKey: key(),
        });
        if ("error" in r) throw new Error(`call failed: ${r.error}`);
        return id;
    };

    const id = await withAsks();
    await ask(rep, id, manager.id, { contents: ["PRICE"], step: undefined });
    const t = (await openTask(id))!;
    const sentBySelf = await tasks.finishAndSendAs(manager, {
        taskId: t.id,
        expectedRevision: await leadRev(id),
        idempotencyKey: key(),
        parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285, note: null } }],
        sentOn: (await w3()).today,
    });
    const afterOwed = await lead(id);
    const calls = await prisma.activity.count({ where: { leadId: id, type: "NEXT_ACTION_CHANGED", note: { contains: "Zavolať" } } });
    check(
        "W4-10 (P1): 'Poslal som to sám' closes the task but plans NO 'Zavolať, či prišlo' while the client is still owed info + cenník – the step becomes the remaining send",
        codeOf(sentBySelf) === "OK" && (await taskRow(t.id)).status === "DONE" && afterOwed.nextActionKind === "SEND_EMAIL" && calls === 0,
        `${codeOf(sentBySelf)} step=${afterOwed.nextActionKind} callRows=${calls}`,
    );

    // To isté odoslanie vrátane info + cenníka hovor NAPLÁNUJE.
    const id2 = await withAsks();
    await ask(rep, id2, manager.id, { contents: ["PRICE"], step: undefined });
    const t2 = (await openTask(id2))!;
    const all = await tasks.finishAndSendAs(manager, {
        taskId: t2.id,
        expectedRevision: await leadRev(id2),
        idempotencyKey: key(),
        parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285, note: null } }],
        extraContents: ["ABOUT_US", "PRICELIST"],
        sentOn: (await w3()).today,
    });
    const afterAll = await lead(id2);

    // Ručne poskladané followUp: true s nevybavenou prácou server odmietne (dialóg ho v takom stave neponúka).
    const id3 = await withAsks();
    const crafted = await send(rep, id3, { contents: ["PRICE"], price: { amount: 10, note: null }, followUp: true });
    const l3 = await lead(id3);
    check(
        "W4-10 (P1): the same send including info + cenník DOES plan the call; a hand-crafted followUp with outstanding work is refused server-side and nothing is written",
        codeOf(all) === "OK" && afterAll.nextActionKind === "CALL" && codeOf(crafted) === "ERR:FORBIDDEN" &&
            (await prisma.activity.count({ where: { leadId: id3, type: "OFFER_SENT" } })) === 0 && l3.nextActionKind !== "CALL",
        `${codeOf(all)} step=${afterAll.nextActionKind} | ${codeOf(crafted)} step3=${l3.nextActionKind}`,
    );
    void offers;
};

// W4-11: dodaná časť prežije každý osud obchodu – zamietnutie zvyšku, prevzatie, zmenu vlastníka, odobratie
// vlastníka aj hromadný presun (§2.10).
tests.w4Survives = async () => {
    const { tasks, ask, openTask, pending, pipeline } = await w3();
    const manager = await makeUser("MANAGER");
    const manager2 = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const rep2 = await makeUser("SALES_REP");
    const start = async () => {
        const id = await makeDeal(rep);
        await ask(rep, id, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
        const t = (await openTask(id))!;
        await tasks.resolveTaskPartsAs(manager, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 777, note: null } }] });
        return { id, t };
    };

    const a = await start();
    await tasks.resolveTaskPartsAs(manager, { taskId: a.t.id, expectedRevision: await leadRev(a.id), idempotencyKey: key(), parts: [{ kind: "OTHER", op: "DECLINE", reason: "netuším" }] });
    const b = await start();
    await tasks.takeoverAs(manager2, { leadId: b.id, expectedRevision: await leadRev(b.id), idempotencyKey: key(), step: { kind: "SEND_QUOTE", schedule: { kind: "daysFromToday", days: 1 } } });
    const c = await start();
    await pipeline.changeOwnerAs(manager, c.id, { ownerId: rep2.id, expectedRevision: await leadRev(c.id), idempotencyKey: key() });
    const d = await start();
    await pipeline.changeOwnerAs(manager, d.id, { ownerId: null, expectedRevision: await leadRev(d.id), idempotencyKey: key() });

    const kept = await Promise.all([a, b, c, d].map(async (x) => (await pending(x.id)).filter((i) => i.kind === "PRICE").length));
    const closed = await Promise.all([a, b, c, d].map(async (x) => (await taskRow(x.t.id)).status));
    check(
        "W4-11: a delivered price keeps waiting through a declined rest, a takeover, an owner change and a deal moved to nobody; every ending that does close the task is DONE, never CANCELLED",
        // Nový vlastník obchodník úlohu NERUŠÍ (wave 3 §6.10) – tá beží ďalej u toho istého manažéra.
        kept.every((n) => n === 1) && closed.join(",") === "DONE,DONE,OPEN,DONE",
        `kept=${kept.join(",")} status=${closed.join(",")}`,
    );
};

// W4A-R01 (review partA-R01 k wave 4 časti A, 2026-09-21): každý test tu musí PADNÚŤ na kóde pred opravou – preto sa vždy
// vyberie prechod, pri ktorom sa DRUH kroku viditeľne zmení (nie ten istý pred aj po).
tests.w4ReviewR01 = async () => {
    const { tasks, lead, ask, openTask, send, follow, offers, pipeline, detail, work, bt, today } = await w3();
    const w = await w5();
    const manager = await makeUser("MANAGER");
    const manager2 = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const st = (l: { nextActionKind: string | null; nextActionAt: Date | null; nextActionMode: string }) =>
        `${l.nextActionKind}/${l.nextActionAt === null ? "null" : "date"}/${l.nextActionMode}`;
    const callStep = { contact: "NONE" as const, nextKind: "CALL" as const, schedule: { kind: "daysFromToday" as const, days: 4 } };
    const deliverPrice = async (taskId: string, leadId: string) =>
        tasks.resolveTaskPartsAs(manager, { taskId, expectedRevision: await leadRev(leadId), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285, note: null } }] });

    // 1. Oprava odoslania pri otvorenej úlohe: PRICE + OTHER, záložný krok CALL → odoslaná cena vráti CALL → oprava SEND_QUOTE.
    const id1 = await makeDeal(rep);
    await follow(rep, id1, callStep);
    await ask(rep, id1, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t1 = (await openTask(id1))!;
    await deliverPrice(t1.id, id1);
    const sent1 = await send(rep, id1, { contents: ["PRICE"], fulfils: [{ taskId: t1.id, kind: "PRICE" }] });
    const afterSend1 = await lead(id1);
    const offerId = (await prisma.activity.findFirstOrThrow({ where: { leadId: id1, type: "OFFER_SENT", revertedAt: null } })).id;
    const rev1 = await leadRev(id1);
    const planRowsBefore = await prisma.activity.count({ where: { leadId: id1, type: { in: ["NEXT_ACTION_CHANGED", "NEXT_ACTION_SET"] }, note: { contains: "čaká na úlohu" } } });
    const corrected =await offers.correctRecordAs(rep, offerId, "zlá suma v maili");
    const afterCorr1 = await lead(id1);
    const planRows = (await prisma.activity.count({ where: { leadId: id1, type: { in: ["NEXT_ACTION_CHANGED", "NEXT_ACTION_SET"] }, note: { contains: "čaká na úlohu" } } })) - planRowsBefore;
    // Rovnaká oprava na ODOMKNUTOM obchode krok používateľa nepreplánuje.
    const id1b = await makeDeal(rep);
    await follow(rep, id1b, callStep);
    await send(rep, id1b, { contents: ["PRICE"], price: { amount: 500, note: null } });
    const beforeFree = await lead(id1b);
    const offerB = (await prisma.activity.findFirstOrThrow({ where: { leadId: id1b, type: "OFFER_SENT", revertedAt: null } })).id;
    const correctedFree = await offers.correctRecordAs(rep, offerB, "zlá suma v maili");
    const afterFree = await lead(id1b);
    check(
        "W4A-R01-1: crossing out a send while the task is open flips the locked step CALL → SEND_QUOTE (no date, SCHEDULED, one revision, one planning row); on an unlocked deal the same correction leaves the user's step alone",
        codeOf(sent1) === "OK" && st(afterSend1) === "CALL/null/SCHEDULED" && codeOf(corrected) === "OK" && st(afterCorr1) === "SEND_QUOTE/null/SCHEDULED" &&
            (await leadRev(id1)) === rev1 + 1 && planRows === 1 &&
            codeOf(correctedFree) === "OK" && st(afterFree) === st(beforeFree) && afterFree.nextActionKind === beforeFree.nextActionKind,
        `send=${st(afterSend1)} corr=${st(afterCorr1)} rows=${planRows} free=${st(beforeFree)}→${st(afterFree)}`,
    );

    // 2. Ceruzka „Chceli": OTHER-only úloha s krokom CALL → pridať PRICE → SEND_QUOTE → stiahnuť PRICE → späť CALL.
    const id2 = await makeDeal(rep);
    await follow(rep, id2, callStep);
    await ask(rep, id2, manager.id, { contents: ["OTHER"], step: { kind: "CALL", note: null } });
    const lockedCall = await lead(id2);
    const rev2 = await leadRev(id2);
    const addPrice = await w.asks(rep, id2, { add: ["PRICE"] });
    const withPrice = await lead(id2);
    const rev2b = await leadRev(id2);
    const dropPrice = await w.asks(rep, id2, { withdraw: await w.openIdsOf(id2, "PRICE"), reason: "cenu už nechcú" });
    const withoutPrice = await lead(id2);
    check(
        "W4A-R01-2: the 'Chceli' pencil on an open task uses the same P6 formula – CALL → add PRICE → SEND_QUOTE → withdraw PRICE → CALL, always without a date and SCHEDULED, one revision each, task stays open",
        st(lockedCall) === "CALL/null/SCHEDULED" && codeOf(addPrice) === "OK" && st(withPrice) === "SEND_QUOTE/null/SCHEDULED" && rev2b === rev2 + 1 &&
            codeOf(dropPrice) === "OK" && st(withoutPrice) === "CALL/null/SCHEDULED" && (await leadRev(id2)) === rev2b + 1 && (await openTask(id2)) !== null,
        `${st(lockedCall)} → ${codeOf(addPrice)} ${st(withPrice)} → ${codeOf(dropPrice)} ${st(withoutPrice)}`,
    );
    // Stale karta: rovnaká revízia dvakrát = druhé uloženie sa nepovolí.
    const staleRev = await leadRev(id2);
    const [tabA, tabB] = await Promise.all([
        w.asks(rep, id2, { add: ["INFO"], expectedRevision: staleRev }),
        w.asks(rep, id2, { add: ["REVIEW"], expectedRevision: staleRev }),
    ]);
    check("W4A-R01-2: two tabs on the same revision – exactly one pencil save wins", tally([tabA, tabB]).OK === 1, `${codeOf(tabA)} ${codeOf(tabB)}`);

    // 3. Telefón a SMS: „Už ju netreba – stiahnuť cenu" pri PRICE + DESIGN ostáva úloha otvorená a zamknutá na SEND_DESIGN.
    const phoneCase = async (contact: "CALL" | "SMS") => {
        const id = await makeDeal(rep);
        await follow(rep, id, callStep);
        await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
        const t = (await openTask(id))!;
        const withdrawParts = { taskId: t.id, kinds: ["PRICE" as const], reason: "cenu som zistil sám" };
        const noLock = await follow(rep, id, { contact, phonePrice: { amount: 500 }, overlap: "WITHDRAW_PARTS", withdrawParts });
        const forgedAll = await follow(rep, id, { contact, phonePrice: { amount: 500 }, keepLockedStep: true, overlap: "WITHDRAW_PARTS", withdrawParts: { ...withdrawParts, kinds: ["PRICE", "DESIGN"] } });
        const forgedOther = await follow(rep, id, { contact, phonePrice: { amount: 500 }, keepLockedStep: true, overlap: "WITHDRAW_PARTS", withdrawParts: { ...withdrawParts, kinds: ["DESIGN"] } });
        const byManager = await follow(manager, id, { contact, phonePrice: { amount: 500 }, keepLockedStep: true, overlap: "WITHDRAW_PARTS", withdrawParts });
        const untouched = JSON.stringify(await partStatus(t.id)) === JSON.stringify({ PRICE: "REQUESTED", DESIGN: "REQUESTED" });
        const k = key();
        const rev = await leadRev(id);
        const input = { contact, phonePrice: { amount: 500 }, keepLockedStep: true, overlap: "WITHDRAW_PARTS" as const, withdrawParts, idempotencyKey: k, expectedRevision: rev };
        const [a, b] = await Promise.all([follow(rep, id, input), follow(rep, id, input)]);
        const again = await follow(rep, id, input);
        const conflict = await follow(rep, id, { ...input, phonePrice: { amount: 501 } });
        const l = await lead(id);
        const parts = await partStatus(t.id);
        const contacts = await prisma.activity.count({ where: { leadId: id, type: contact === "SMS" ? "SMS_SENT" : "CALL", idempotencyKey: k } });
        return { noLock, forgedAll, forgedOther, byManager, untouched, a, b, again, conflict, l, parts, contacts, task: await taskRow(t.id) };
    };
    for (const contact of ["CALL", "SMS"] as const) {
        const r = await phoneCase(contact);
        check(
            `W4A-R01-3 (${contact}): withdrawing PRICE on a PRICE + DESIGN task saves the contact + price, keeps the task OPEN and the step locked on SEND_DESIGN; without keepLockedStep it is STEP_LOCKED, forged / foreign kinds and a non-owner are refused with nothing written; replay is one save, a changed body is a conflict`,
            codeOf(r.noLock) === "ERR:STEP_LOCKED" && codeOf(r.forgedAll) === "ERR:FORBIDDEN" && codeOf(r.forgedOther) === "ERR:FORBIDDEN" &&
                codeOf(r.byManager) === "ERR:FORBIDDEN" && r.untouched &&
                JSON.stringify(tally([r.a, r.b])) === '{"OK":2}' && codeOf(r.again) === "OK" && codeOf(r.conflict) === "ERR:IDEMPOTENCY_CONFLICT" &&
                r.parts.PRICE === "WITHDRAWN" && r.parts.DESIGN === "REQUESTED" && r.task.status === "OPEN" && st(r.l) === "SEND_DESIGN/null/SCHEDULED" && r.contacts === 1,
            `${codeOf(r.noLock)} ${codeOf(r.forgedAll)} ${codeOf(r.forgedOther)} ${codeOf(r.byManager)} untouched=${r.untouched} | ${codeOf(r.a)} ${codeOf(r.b)} ${codeOf(r.again)} ${codeOf(r.conflict)} | ${JSON.stringify(r.parts)} ${r.task.status} ${st(r.l)} contacts=${r.contacts}`,
        );
    }
    // PRICE je jediná robiaca sa časť: hovor stiahne cenu a úloha sa zavrie – vlastníkov krok vyhráva; zastaraný klient
    // (keepLockedStep na úlohe, ktorá sa medzitým zúžila) dostane odvodený krok odomknutý na dnes, nie zaseknutý bez dátumu.
    const id3 = await makeDeal(rep);
    await follow(rep, id3, callStep);
    await ask(rep, id3, manager.id, { contents: ["PRICE"], step: undefined });
    const t3 = (await openTask(id3))!;
    const closeWithStep = await follow(rep, id3, {
        contact: "CALL",
        phonePrice: { amount: 500 },
        overlap: "WITHDRAW_PARTS",
        withdrawParts: { taskId: t3.id, kinds: ["PRICE"], reason: "cenu som zistil sám" },
        nextKind: "CALL",
        schedule: { kind: "daysFromToday", days: 3 },
    });
    const l3 = await lead(id3);
    const id3b = await makeDeal(rep);
    await follow(rep, id3b, callStep);
    await ask(rep, id3b, manager.id, { contents: ["PRICE"], step: undefined });
    const t3b = (await openTask(id3b))!;
    const closeStale = await follow(rep, id3b, {
        contact: "CALL",
        phonePrice: { amount: 500 },
        keepLockedStep: true,
        overlap: "WITHDRAW_PARTS",
        withdrawParts: { taskId: t3b.id, kinds: ["PRICE"], reason: "cenu som zistil sám" },
    });
    const l3b = await lead(id3b);
    check(
        "W4A-R01-3: withdrawing the LAST open part by phone closes the task – the chosen step wins; a stale keepLockedStep client still gets the task closed and the step unlocked (kind CALL from the fallback, due today), never a locked null date",
        codeOf(closeWithStep) === "OK" && (await taskRow(t3.id)).status === "CANCELLED" && l3.nextActionKind === "CALL" && l3.nextActionAt !== null &&
            codeOf(closeStale) === "OK" && (await taskRow(t3b.id)).status === "CANCELLED" && l3b.nextActionKind === "CALL" && l3b.nextActionAt !== null,
        `${codeOf(closeWithStep)} ${st(l3)} | ${codeOf(closeStale)} ${st(l3b)}`,
    );

    // 4. E-mail: stiahnuť smie presne to, čo odoslanie prekrýva.
    const id4 = await makeDeal(rep);
    await ask(rep, id4, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
    const t4 = (await openTask(id4))!;
    const extra = await send(rep, id4, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "WITHDRAW_PARTS", withdrawParts: { taskId: t4.id, kinds: ["PRICE", "DESIGN"], reason: "x" } });
    const unrelated = await send(rep, id4, { contents: ["ABOUT_US"], overlap: "WITHDRAW_PARTS", withdrawParts: { taskId: t4.id, kinds: ["PRICE"], reason: "x" } });
    const wrongTask = await send(rep, id4, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "WITHDRAW_PARTS", withdrawParts: { taskId: "nie-je-moja", kinds: ["PRICE"], reason: "x" } });
    const wrongKind = await send(rep, id4, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "WITHDRAW_PARTS", withdrawParts: { taskId: t4.id, kinds: ["DESIGN"], reason: "x" } });
    const nothingWritten = (await prisma.activity.count({ where: { leadId: id4, type: "OFFER_SENT" } })) === 0 &&
        JSON.stringify(await partStatus(t4.id)) === JSON.stringify({ PRICE: "REQUESTED", DESIGN: "REQUESTED" });
    const valid = await send(rep, id4, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "WITHDRAW_PARTS", withdrawParts: { taskId: t4.id, kinds: ["PRICE"], reason: "x" } });
    check(
        "W4A-R01-4: forged withdrawParts (extra kind, kind the send does not cover, wrong task, wrong kind) are refused before anything is written; the exact overlap still works",
        codeOf(extra) === "ERR:FORBIDDEN" && codeOf(unrelated) === "ERR:FORBIDDEN" && codeOf(wrongTask) === "ERR:STALE" && codeOf(wrongKind) === "ERR:FORBIDDEN" &&
            nothingWritten && codeOf(valid) === "OK" && (await partStatus(t4.id)).PRICE === "WITHDRAWN" && (await partStatus(t4.id)).DESIGN === "REQUESTED",
        `${codeOf(extra)} ${codeOf(unrelated)} ${codeOf(wrongTask)} ${codeOf(wrongKind)} clean=${nothingWritten} valid=${codeOf(valid)}`,
    );

    // 5. Koniec úlohy zmenou vlastníka a uspaním: krok sa odvodí, nie odomkne staré uložené SEND_DESIGN.
    const endTask = async () => {
        const id = await makeDeal(rep);
        await follow(rep, id, callStep);
        await ask(rep, id, manager.id, { contents: ["PRICE", "DESIGN"], step: undefined });
        const t = (await openTask(id))!;
        await deliverPrice(t.id, id);
        await send(rep, id, { contents: ["PRICE"], fulfils: [{ taskId: t.id, kind: "PRICE" }] });
        return { id, t, before: await lead(id) };
    };
    const own = await endTask();
    const toNobody = await pipeline.changeOwnerAs(manager, own.id, { ownerId: null, expectedRevision: await leadRev(own.id), idempotencyKey: key() });
    const lNobody = await lead(own.id);
    const own2 = await endTask();
    const toManager = await pipeline.changeOwnerAs(manager, own2.id, { ownerId: manager2.id, expectedRevision: await leadRev(own2.id), idempotencyKey: key() });
    const lManager = await lead(own2.id);
    const snooze = await endTask();
    const wake = bt.addBusinessCalendarDays(today, 5);
    const noDate = await pipeline.changeStatusAs(manager, snooze.id, { status: "SNOOZED", cancelTask: { taskId: snooze.t.id, reason: "uspávam" }, expectedRevision: await leadRev(snooze.id), idempotencyKey: key() });
    const stillOpen = (await openTask(snooze.id)) !== null;
    const pastDate = await pipeline.changeStatusAs(manager, snooze.id, { status: "SNOOZED", snoozeUntil: today, cancelTask: { taskId: snooze.t.id, reason: "uspávam" }, expectedRevision: await leadRev(snooze.id), idempotencyKey: key() });
    const snoozed = await pipeline.changeStatusAs(manager, snooze.id, { status: "SNOOZED", snoozeUntil: wake, cancelTask: { taskId: snooze.t.id, reason: "uspávam" }, expectedRevision: await leadRev(snooze.id), idempotencyKey: key() });
    const lSnooze = await lead(snooze.id);
    check(
        "W4A-R01-5: an owner change (to nobody, to a manager) and a snooze that end the task derive the final step – the deal that was locked on SEND_DESIGN comes out on the CALL fallback, due today (a snooze: on the chosen wake date, and refused without one), not on the design that was just withdrawn",
        st(own.before) === "SEND_DESIGN/null/SCHEDULED" &&
            codeOf(toNobody) === "OK" && lNobody.nextActionKind === "CALL" && lNobody.nextActionAt !== null &&
            codeOf(toManager) === "OK" && lManager.nextActionKind === "CALL" && lManager.nextActionAt !== null &&
            codeOf(noDate) === "ERR:FORBIDDEN" && stillOpen && codeOf(pastDate) !== "OK" &&
            codeOf(snoozed) === "OK" && lSnooze.status === "SNOOZED" && lSnooze.nextActionKind === "CALL" && lSnooze.nextActionAt !== null &&
            bt.businessDate(lSnooze.nextActionAt) === wake,
        `before=${st(own.before)} nobody=${codeOf(toNobody)} ${st(lNobody)} manager=${codeOf(toManager)} ${st(lManager)} snooze=${codeOf(noDate)}/${codeOf(pastDate)}/${codeOf(snoozed)} ${lSnooze.status}/${st(lSnooze)}`,
    );

    // 6. Vedome neposlaná vrátená časť má vlastnú značku – nie „pripravené".
    const id6 = await makeDeal(rep);
    await ask(rep, id6, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t6 = (await openTask(id6))!;
    await deliverPrice(t6.id, id6);
    const dropped = await tasks.dismissResultsAs(rep, { leadId: id6, expectedRevision: await leadRev(id6), idempotencyKey: key(), taskId: t6.id, items: [{ kind: "PRICE" }], reason: "klient už cenu vie" });
    const priceView = (await detail(id6, rep))!.tasks[0].parts.find((p) => p.kind === "PRICE")!;
    check(
        "W4A-R01-6: a delivered part whose every item was deliberately not sent is marked DISMISSED (⊘ 'neposiela sa'), not PREPARED",
        codeOf(dropped) === "OK" && priceView.mark === "DISMISSED" && priceView.waitingCount === 0 && priceView.dismissedCount === 1,
        `${codeOf(dropped)} mark=${priceView.mark} waiting=${priceView.waitingCount} dismissed=${priceView.dismissedCount}`,
    );
    void work;
};

// W4A-F: filtre pipeline majú tri skladateľné úrovne (rad práce → druh kroku → stav). Rad × krok = prienik, počty čipov
// sedia so zoznamom, stará adresa ?view=call je „Všetko + krok", „auto" sa rozhodne podľa počtu „Na spracovanie".
tests.w4aFilterLevels = async () => {
    const { queries, dealScope, follow, ask, send, openTask } = await w3();
    const { parseDealParams, dealsHref, resolveView, DEAL_STEPS } = await import("../../lib/domain/dealFilters");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const w = await w5();
    // Obchody: volať dnes, volať o týždeň, poslať cenu (klient pýta cenu), a jeden zamknutý úlohou.
    const callToday = await makeDeal(rep);
    await follow(rep, callToday, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 0 } });
    const callLater = await makeDeal(rep);
    await follow(rep, callLater, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 7 } });
    const needsPrice = await w.interested(rep, ["PRICE"]);
    const locked = await makeDeal(rep);
    await follow(rep, locked, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 0 } });
    await ask(rep, locked, manager.id, { contents: ["PRICE"], step: undefined });
    void send; void openTask;

    const scope = dealScope(rep);
    const base = { scope, owner: { userId: rep.id }, viewerId: rep.id } as const;
    const ids = async (view: string | undefined, step?: string) =>
        new Set((await queries.getDealList({ ...base, view, step, take: 5000 })).rows.map((r) => r.id));
    const inter = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)));
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

    const allCall = await ids(undefined, "call");
    const todayAll = await ids("today");
    const todayCall = await ids("today", "call");
    const legacyCall = await ids("call");
    check(
        "W4A-F-1: 'Na dnes' × 'Volať' is the intersection; 'Všetko' × 'Volať' lists every unlocked CALL deal; the old view=call equals it; a locked deal is in neither",
        same(todayCall, inter(todayAll, allCall)) && todayCall.has(callToday) && !todayCall.has(callLater) &&
            allCall.has(callToday) && allCall.has(callLater) && same(legacyCall, allCall) && !allCall.has(locked) && !todayCall.has(locked),
        `todayCall=${todayCall.size} allCall=${allCall.size} legacy=${legacyCall.size}`,
    );

    const bad: string[] = [];
    for (const view of ["work", "today", undefined]) {
        const counts = await queries.getDealStepCounts({ ...base }, view);
        const whole = await ids(view);
        if (counts.all !== whole.size) bad.push(`${view}: all=${counts.all} list=${whole.size}`);
        for (const s of DEAL_STEPS) {
            const list = await ids(view, s.key);
            if (list.size !== counts[s.key]) bad.push(`${view}/${s.key}: count=${counts[s.key]} list=${list.size}`);
        }
    }
    const lockedStep = await queries.getDealStepCounts({ ...base }, "waiting_manager");
    const lockedList = await ids("waiting_manager", "call");
    check(
        "W4A-F-2: every step chip count equals its list in every queue; 'Čakám na manažéra' ignores the step",
        bad.length === 0 && lockedList.has(locked) && lockedStep.all === (await ids("waiting_manager")).size,
        bad.slice(0, 4).join(" | "),
    );

    const p1 = parseDealParams({ view: "quote" });
    const p2 = parseDealParams({ view: "waiting_manager", step: "call" });
    const p3 = parseDealParams({ view: "today", step: "nonsense" });
    const p4 = parseDealParams({});
    check(
        "W4A-F-3: parse – legacy ?view=quote → all + quote, a step is dropped where it makes no sense or is unknown, no view = auto; links keep the step across queues but not into 'Čakám na manažéra'",
        p1.view === "all" && p1.step === "quote" && p2.step === undefined && p3.step === undefined && p4.view === "auto" &&
            resolveView("auto", { work: 3 }) === "work" && resolveView("auto", { work: 0 }) === "today" && resolveView("today", { work: 3 }) === "today" &&
            dealsHref({ ...p4, view: "today", step: "call" }, { view: "all" }).includes("step=call") &&
            !dealsHref({ ...p4, view: "today", step: "call" }, { view: "waiting_manager" }).includes("step="),
        `${JSON.stringify(p1)} ${JSON.stringify(p2)}`,
    );
    void needsPrice;

    // Stav je hore a rady s krokmi existujú len pri „Aktívne" (Michal, 2026-09-21).
    const won = parseDealParams({ filter: "won", view: "today", step: "call" });
    const cur = { ...p4, view: "work", step: "call" };
    const toLost = dealsHref(cur, { filter: "lost" });
    const back = dealsHref({ ...cur, filter: "lost", view: "all", step: undefined }, { filter: "active" });
    check(
        "W4A-F-4: any status other than Aktívne is a plain list (no queue, no step, even from a hand-made URL); switching to it drops queue and step, switching back to Aktívne picks the queue by work again",
        won.view === "all" && won.step === undefined &&
            !toLost.includes("step=") && !toLost.includes("view=") && toLost.includes("filter=lost") &&
            !back.includes("view=") && !back.includes("filter="),
        `${JSON.stringify(won)} ${toLost} ${back}`,
    );

    // partA-R03 #3: pohľady „Klient už dostal" nemajú riadok s krokmi, takže nesmú niesť skrytý krok.
    const extras = ["got_pricelist", "got_price", "got_design"];
    const leaks: string[] = [];
    for (const from of ["work", "today", "all"]) {
        for (const x of extras) {
            const href = dealsHref({ ...p4, view: from, step: "call" }, { view: x });
            if (href.includes("step=")) leaks.push(`${from}→${x}: ${href}`);
            const parsed = parseDealParams({ view: x, step: "call" });
            if (parsed.step !== undefined) leaks.push(`parse ${x}`);
        }
    }
    // Zoznam pod „Dostali cenu" je celý – s hand-made ?step=call rovnaký ako bez neho, teda zhodný s počtom.
    const withHiddenStep = await ids("got_price", parseDealParams({ view: "got_price", step: "call" }).step);
    const plain = await ids("got_price");
    const counts = await queries.getDealCounts({ ...base });
    check(
        "W4A-F-5: entering 'Dostali …' from a step clears the step (link and hand-made URL); the list equals the displayed count",
        leaks.length === 0 && same(withHiddenStep, plain) && counts.got_price === plain.size,
        leaks.slice(0, 3).join(" | ") + ` count=${counts.got_price} list=${plain.size}`,
    );
};

// W4A-R02 (review partA-R02, 2026-09-21): začína vždy od SKUTOČNÉHO kroku wave 5 (klient pýta → appka nastaví
// „Poslať …"), nie od ručne zvoleného CALL – práve tam sa stará záloha vracala ako už hotová práca.
tests.w4ReviewR02 = async () => {
    const { tasks, lead, ask, openTask, send, follow, detail, design, bt, today } = await w3();
    const w = await w5();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const st = (l: { nextActionKind: string | null; nextActionAt: Date | null; nextActionMode: string }) =>
        `${l.nextActionKind}/${l.nextActionAt === null ? "null" : "date"}/${l.nextActionMode}`;
    const NOTE = "Pokračovať s klientom po odpovedi manažéra";
    const resolve = async (taskId: string, leadId: string, parts: Parameters<typeof tasks.resolveTaskPartsAs>[1]["parts"]) =>
        tasks.resolveTaskPartsAs(manager, { taskId, expectedRevision: await leadRev(leadId), idempotencyKey: key(), parts });
    const headlineOf = async (id: string) => (await detail(id, rep))!.stepHeadline;

    // 1a. SEND_QUOTE → PRICE + OTHER → cena odíde → zamknuté „čaká na manažéra", nikdy SEND_QUOTE → OTHER → CALL dnes.
    const id1 = await w.interested(rep, ["PRICE"]);
    const start1 = await lead(id1);
    await ask(rep, id1, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t1 = (await openTask(id1))!;
    await resolve(t1.id, id1, [{ kind: "PRICE", op: "DELIVER", price: { amount: 900, note: null } }]);
    const sent1 = await send(rep, id1, { contents: ["PRICE"], fulfils: [{ taskId: t1.id, kind: "PRICE" }] });
    const locked1 = await lead(id1);
    const head1 = await headlineOf(id1);
    await resolve(t1.id, id1, [{ kind: "OTHER", op: "DELIVER", answer: "hosting je v cene" }]);
    const done1 = await lead(id1);
    check(
        "W4A-R02-1 (PRICE): from a real Wave 5 SEND_QUOTE, after the price is sent only OTHER is left – the locked step is never SEND_QUOTE and reads 'Čaká na … – otázka / konzultácia'; closing OTHER unlocks CALL due today with the neutral note",
        start1.nextActionKind === "SEND_QUOTE" && codeOf(sent1) === "OK" && st(locked1) === "CALL/null/SCHEDULED" &&
            head1 === `Čaká na ${manager.firstName} – otázka / konzultácia` &&
            (await taskRow(t1.id)).status === "DONE" && done1.nextActionKind === "CALL" && done1.nextActionAt !== null &&
            bt.businessDate(done1.nextActionAt) === today && done1.nextActionNote === NOTE,
        `start=${start1.nextActionKind} locked=${st(locked1)} headline="${head1}" done=${st(done1)} note="${done1.nextActionNote}"`,
    );

    // 1b. To isté s návrhom.
    const id2 = await w.interested(rep, ["DESIGN"]);
    const start2 = await lead(id2);
    const d = await design(manager, id2, "variantA");
    await ask(rep, id2, manager.id, { contents: ["DESIGN", "OTHER"], step: undefined });
    const t2 = (await openTask(id2))!;
    await resolve(t2.id, id2, [{ kind: "DESIGN", op: "DELIVER", designs: [{ id: d.id, version: d.currentVersion }] }]);
    const sent2 = await send(rep, id2, { contents: ["DESIGN"], designIds: [d.id], fulfils: [{ taskId: t2.id, kind: "DESIGN", designId: d.id }] });
    const locked2 = await lead(id2);
    const head2 = await headlineOf(id2);
    await resolve(t2.id, id2, [{ kind: "OTHER", op: "DELIVER", answer: "doména je voľná" }]);
    const done2 = await lead(id2);
    check(
        "W4A-R02-1 (DESIGN): the same from SEND_DESIGN – locked 'čaká na manažéra', never SEND_DESIGN, then CALL today",
        start2.nextActionKind === "SEND_DESIGN" && codeOf(sent2) === "OK" && st(locked2) === "CALL/null/SCHEDULED" &&
            head2 === `Čaká na ${manager.firstName} – otázka / konzultácia` &&
            done2.nextActionKind === "CALL" && done2.nextActionAt !== null && done2.nextActionNote === NOTE,
        `start=${start2.nextActionKind} locked=${st(locked2)} headline="${head2}" done=${st(done2)}`,
    );

    // 1c. Klient chce aj info – to ostáva na odoslanie, takže sa nič „nečaká na otázku".
    const id3 = await w.interested(rep, ["PRICE", "INFO"]);
    await ask(rep, id3, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t3 = (await openTask(id3))!;
    await resolve(t3.id, id3, [{ kind: "PRICE", op: "DELIVER", price: { amount: 700, note: null } }]);
    await send(rep, id3, { contents: ["PRICE"], fulfils: [{ taskId: t3.id, kind: "PRICE" }] });
    const locked3 = await lead(id3);
    const head3 = await headlineOf(id3);
    check(
        "W4A-R02-1 (INFO): a still-outstanding INFO keeps the locked step on the send ('Poslať …'), not on 'čaká na manažéra'",
        locked3.nextActionKind === "SEND_EMAIL" && locked3.nextActionAt === null && !String(head3).startsWith("Čaká na"),
        `${st(locked3)} headline="${head3}"`,
    );

    // 1d. Ručne zvolený krok sa vracia nezmenený (podrobnejšie: W4A-R01-1 a w4Fallback).
    const id4 = await makeDeal(rep);
    await follow(rep, id4, { contact: "NONE", nextKind: "WAITING_FOR_CLIENT", schedule: { kind: "daysFromToday", days: 3 } });
    await ask(rep, id4, manager.id, { contents: ["OTHER"], step: { kind: "WAITING_FOR_CLIENT", note: null } });
    const t4 = (await openTask(id4))!;
    await resolve(t4.id, id4, [{ kind: "OTHER", op: "DELIVER", answer: "ok" }]);
    const back4 = await lead(id4);
    check(
        "W4A-R02-1 (manual): a deliberately chosen step (Čakáme na klienta) still comes back after the task",
        back4.nextActionKind === "WAITING_FOR_CLIENT" && back4.nextActionAt !== null,
        st(back4),
    );

    // 2. E-mail: stiahnutie POSLEDNEJ časti + odoslanie – krok sa odvodí po odoslaní, nie „Poslať cenu" po odoslaní ceny.
    const closeByEmail = async (opts: { followUp: boolean; manual: boolean }) => {
        const id = opts.manual ? await makeDeal(rep) : await w.interested(rep, ["PRICE"]);
        if (opts.manual) await follow(rep, id, { contact: "NONE", nextKind: "CALL", schedule: { kind: "daysFromToday", days: 4 } });
        await ask(rep, id, manager.id, { contents: ["PRICE"], step: undefined });
        const t = (await openTask(id))!;
        const rev = await leadRev(id);
        const k = key();
        const input = {
            contents: ["PRICE" as const],
            price: { amount: 1100, note: null },
            overlap: "WITHDRAW_PARTS" as const,
            withdrawParts: { taskId: t.id, kinds: ["PRICE" as const], reason: "cenu mám sám" },
            followUp: opts.followUp,
            idempotencyKey: k,
            expectedRevision: rev,
        };
        const [a, b] = await Promise.all([send(rep, id, input), send(rep, id, input)]);
        const again = await send(rep, id, input);
        const conflict = await send(rep, id, { ...input, price: { amount: 1101, note: null } });
        const l = await lead(id);
        const priceRows = (await w.rows(id)).filter((r) => r.content === "PRICE");
        const keyed = await prisma.activity.count({ where: { leadId: id, idempotencyKey: k } });
        return { a, b, again, conflict, l, task: await taskRow(t.id), priceRows, revAfter: await leadRev(id), rev, keyed };
    };
    for (const [label, opts] of [
        ["system fallback, no follow-up", { followUp: false, manual: false }],
        ["manual CALL fallback, no follow-up", { followUp: false, manual: true }],
        ["system fallback, with follow-up", { followUp: true, manual: false }],
    ] as const) {
        const r = await closeByEmail(opts);
        const stepOk = opts.followUp
            ? r.l.nextActionKind === "CALL" && r.l.nextActionAt !== null && bt.businessDate(r.l.nextActionAt) > today
            : r.l.nextActionKind === "CALL" && r.l.nextActionAt !== null && bt.businessDate(r.l.nextActionAt) === today;
        check(
            `W4A-R02-2 (${label}): withdrawing the last part in an e-mail closes the task, records the receipt and leaves NO stale 'Poslať cenu'; one keyed event, one revision, replay = one save, changed body = conflict`,
            r.task.status === "CANCELLED" && r.priceRows.every((row) => row.state === "SENT") && stepOk &&
                r.l.nextActionKind !== "SEND_QUOTE" && r.revAfter === r.rev + 1 && r.keyed === 1 &&
                JSON.stringify(tally([r.a, r.b])) === '{"OK":2}' && codeOf(r.again) === "OK" && codeOf(r.conflict) === "ERR:IDEMPOTENCY_CONFLICT",
            `task=${r.task.status} step=${st(r.l)} due=${r.l.nextActionAt ? bt.businessDate(r.l.nextActionAt) : null} rows=${r.priceRows.map((x) => x.state).join(",")} rev=${r.rev}→${r.revAfter} keyed=${r.keyed} | ${codeOf(r.a)} ${codeOf(r.b)} ${codeOf(r.again)} ${codeOf(r.conflict)}`,
        );
    }
    void today;
};

// W4-12: súbeh. Stiahnutie vs dodanie tej istej časti, dve časti naraz, replay a konflikt každého nového príkazu.
tests.w4Race = async () => {
    const { tasks, ask, openTask } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");

    const id = await makeDeal(rep);
    await ask(rep, id, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t = (await openTask(id))!;
    const rev = await leadRev(id);
    const [deliver, withdraw] = await Promise.all([
        tasks.resolveTaskPartsAs(manager, { taskId: t.id, expectedRevision: rev, idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1, note: null } }] }),
        tasks.withdrawTaskPartsAs(rep, { taskId: t.id, expectedRevision: rev, idempotencyKey: key(), kinds: ["PRICE"], reason: "netreba" }),
    ]);
    const price = (await partStatus(t.id)).PRICE;
    check(
        "W4-12: deliver vs withdraw of the SAME part on the same revision → exactly one wins and the part has exactly one outcome",
        [deliver, withdraw].filter((r) => codeOf(r) === "OK").length === 1 && (price === "DELIVERED" || price === "WITHDRAWN"),
        `${codeOf(deliver)} ${codeOf(withdraw)} price=${price}`,
    );

    // Replay a konflikt: ten istý kľúč + ten istý obsah = jeden zápis; iný obsah = konflikt. runKeyed hľadá OBA typy.
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t2 = (await openTask(id2))!;
    const k = key();
    const input = { taskId: t2.id, expectedRevision: await leadRev(id2), idempotencyKey: k, parts: [{ kind: "PRICE" as const, op: "DECLINE" as const, reason: "nemám podklady" }] };
    const first = await tasks.resolveTaskPartsAs(manager, input);
    const replay = await tasks.resolveTaskPartsAs(manager, input);
    const conflict = await tasks.resolveTaskPartsAs(manager, { ...input, parts: [{ kind: "PRICE", op: "DECLINE", reason: "iný dôvod" }] });
    const declinedRows = await prisma.activity.count({ where: { leadId: id2, type: "TASK_PART_DECLINED" } });
    // Peniaze v odtlačku ako reťazec (B7): 1285 a 1285.00 musia dať ten istý odtlačok.
    const id3 = await makeDeal(rep);
    await ask(rep, id3, manager.id, { contents: ["PRICE"], step: undefined });
    const t3 = (await openTask(id3))!;
    const k3 = key();
    const rev3 = await leadRev(id3);
    const m1 = await tasks.resolveTaskPartsAs(manager, { taskId: t3.id, expectedRevision: rev3, idempotencyKey: k3, parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285, note: null } }] });
    const m2 = await tasks.resolveTaskPartsAs(manager, { taskId: t3.id, expectedRevision: rev3, idempotencyKey: k3, parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285.0, note: null } }] });
    check(
        "W4-12: the same key replays once (both row types are looked up), a changed payload conflicts, and 1285 vs 1285.00 is the same fingerprint (B7)",
        codeOf(first) === "OK" && codeOf(replay) === "OK" && codeOf(conflict) === "ERR:IDEMPOTENCY_CONFLICT" && declinedRows === 1 &&
            codeOf(m1) === "OK" && codeOf(m2) === "OK",
        `${codeOf(first)} ${codeOf(replay)} ${codeOf(conflict)} rows=${declinedRows} money=${codeOf(m1)}/${codeOf(m2)}`,
    );
};

// W4-13 (D5, §5.1): zmenu ceny vidí aj obchodník – vrátane zmeny samotného rozpisu; nie je to kontakt s klientom
// a nedá sa prečiarknuť.
tests.w4PriceHistory = async () => {
    const { tasks, ask, openTask, offers, detail, pipeline } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const priceRows = () =>
        prisma.activity.findMany({ where: { leadId: id, type: "PRICE_CHANGED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, meta: true, category: true, note: true } });
    const viaOf = (rows: Awaited<ReturnType<typeof priceRows>>) => rows.map((r) => (r.meta as { via?: string } | null)?.via ?? "?").join(",");

    await pipeline.saveQuoteAs(manager, id, { price: 1000, priceNote: null });
    await pipeline.saveQuoteAs(manager, id, { price: 1000, priceNote: null }); // nič sa nezmenilo
    await pipeline.saveQuoteAs(manager, id, { price: 1000, priceNote: "Web 700 · admin 300" }); // len rozpis
    await ask(rep, id, manager.id, { contents: ["PRICE"], step: undefined });
    const t = (await openTask(id))!;
    await tasks.resolveTaskPartsAs(manager, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 1285, note: null } }] });
    const rows = await priceRows();
    const asRep = await detail(id, rep);
    const correction = await offers.correctRecordAs(manager, rows[0].id, "omyl v cene");
    check(
        "W4-13 (D5): every price change is one BUSINESS row the rep can see – including a breakdown-only edit; an unchanged save writes none; via names what caused it; the row is not correctable",
        rows.length === 3 && viaOf(rows) === "EDIT,EDIT,TASK" && rows.every((r) => r.category === "BUSINESS") &&
            Boolean(rows[1].note?.includes("rozpis")) && Boolean(asRep?.activities.some((a) => a.type === "PRICE_CHANGED")) &&
            codeOf(correction) === "ERR:FORBIDDEN",
        `rows=${rows.length} via=${viaOf(rows)} repSees=${asRep?.activities.some((a) => a.type === "PRICE_CHANGED")} correct=${codeOf(correction)}`,
    );

    // „Naposledy" sa cenou nehýbe – nie je to kontakt s klientom.
    const { LAST_TOUCH_TYPES } = await import("../../lib/domain/offers");
    const { CORRECTABLE_TYPES } = await import("../../lib/domain/offerMutations");
    check(
        "W4-13 (D5): PRICE_CHANGED is in neither whitelist – it never moves 'Naposledy' and cannot be crossed out",
        !(LAST_TOUCH_TYPES as readonly string[]).includes("PRICE_CHANGED") && !(CORRECTABLE_TYPES as readonly string[]).includes("PRICE_CHANGED") &&
            asRep?.lastTouch?.type !== "PRICE_CHANGED",
        `lastTouch=${asRep?.lastTouch?.type}`,
    );
};

// W4-14 (§6.3): po prepnutí kódu sú ČASTI zdrojom pravdy. Dotaz, ktorý to dokazuje, musí čiastočne vybavenú
// otvorenú úlohu naozaj nájsť – inak by sa dal prevod spustiť znova a zmazal by skutočnú prácu.
tests.w4Conversion = async () => {
    const { tasks, ask, openTask } = await w3();
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await ask(rep, id, manager.id, { contents: ["PRICE", "OTHER"], step: undefined });
    const t = (await openTask(id))!;
    const beforeDelivery = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT q.id FROM (${(await import("./wave4-parts-sql")).POST_CUTOVER_SQL}) q WHERE q.id = $1`, t.id);
    await tasks.resolveTaskPartsAs(manager, { taskId: t.id, expectedRevision: await leadRev(id), idempotencyKey: key(), parts: [{ kind: "PRICE", op: "DELIVER", price: { amount: 42, note: null } }] });
    const { POST_CUTOVER_SQL } = await import("./wave4-parts-sql");
    const afterDelivery = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT q.id FROM (${POST_CUTOVER_SQL}) q WHERE q.id = $1`, t.id);
    check(
        "W4-14 (§6.3): a partially delivered OPEN task is real part state a pure re-derivation could not produce – the conversion refuses to run again and cannot destroy it",
        beforeDelivery.length === 0 && afterDelivery.length === 1,
        `beforeDelivery=${beforeDelivery.length} afterDelivery=${afterDelivery.length}`,
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
