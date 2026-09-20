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
        ["finishTask", async () => tasks.finishTaskAs(manager2, { taskId: await openTaskId(), expectedRevision: await leadRev(id), idempotencyKey: key(), price: { amount: 1285, note: null } })],
        ["dismissResults", async () => tasks.dismissResultsAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), taskId: await openTaskId(), items: [{ kind: "PRICE" }], reason: "klient už nechce" })],
        ["logFollowUp", async () => work.logFollowUpAs(rep, { leadId: id, outcome: "WANTS_DESIGN", expectedRevision: await leadRev(id), idempotencyKey: key() })],
        ["askManager HANDOVER", async () => tasks.askManagerAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), type: "HANDOVER", text: "chce detaily", assigneeId: manager.id })],
        ["declineTask", async () => tasks.declineTaskAs(manager, { taskId: await openTaskId(), expectedRevision: await leadRev(id), idempotencyKey: key(), reason: "pokračuj ty" })],
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
        await prisma.dealTask.create({ data: { leadId: id, type: "HELP", contents: ["OTHER"], text: "x", requestedById: requester.id, assigneeId: owner.id } });
    }
    const oldest = await mk("oldesttask", { nextActionKind: null, nextActionAt: null, ownerId: requester.id });
    await prisma.dealTask.create({
        data: { leadId: oldest, type: "HELP", contents: ["PRICE"], text: "x", requestedById: requester.id, assigneeId: owner.id, createdAt: new Date("2000-01-01T00:00:00Z") },
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
    await prisma.dealTask.create({ data: { leadId: locked, type: "HELP", contents: ["PRICE"], text: "x", requestedById: rep.id, assigneeId: manager.id } });
    const doneTask = await mk("donetask", { nextActionKind: "SEND_QUOTE", nextActionAt: day(-1) });
    await prisma.dealTask.create({ data: { leadId: doneTask, type: "HELP", contents: ["PRICE"], text: "x", status: "DONE", requestedById: rep.id, assigneeId: manager.id } });

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
    await prisma.dealTask.createMany({
        data: ids.map((leadId, i) => ({ leadId, type: "HELP" as const, contents: ["OTHER" as const], text: "x", requestedById: rep.id, assigneeId: i === 51 ? other.id : manager.id })),
    });
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
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await prisma.lead.update({ where: { id }, data: { hadLegacySends: true, priceDisclosed: true, quoteSentAt: new Date() } });
    const { askManagerAs } = await import("../../lib/commands/tasks");
    await askManagerAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), type: "HELP", contents: ["PRICE"], text: "neviem cenu", assigneeId: manager.id, step: { kind: "SEND_QUOTE" } });
    const nextBefore = (await lead(id)).nextActionKind;

    const detail0 = await getDealDetail(id, dealScope(manager), dealCapabilities(manager));
    const k0 = clientKnowledge(detail0!.offers);
    const repHistorical = await record(rep, id, { historical: true, contents: ["PRICE"], price: { amount: 700, note: null }, sentOn: daysAgo(30) });
    const hist = await record(manager, id, { historical: true, contents: ["ABOUT_US", "PRICE"], price: { amount: 700, note: null }, sentOn: daysAgo(30) });
    const l = await lead(id);
    const openPrice = await prisma.dealTask.count({ where: { leadId: id, status: "OPEN" } });
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

// R3-2: návrh označený starým kódom (bez baseline) a potom poslaný novým systémom si zachová starý dátum.
tests.w3cOldDesignWindow = async () => {
    const offers = await import("../../lib/commands/offers");
    const { createDesignAs } = await import("../../lib/commands/tracking");
    const bt = await import("../../lib/domain/businessTime");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    await createDesignAs(manager, { leadId: id, label: "stary" });
    const d = await prisma.design.findFirstOrThrow({ where: { leadId: id } });
    const oldAt = bt.businessDayStart(bt.addBusinessCalendarDays(bt.businessDate(new Date()), -10));
    await prisma.design.update({ where: { id: d.id }, data: { sentAt: oldAt } }); // zápis „starého kódu", legacySentAt ostal prázdny
    const r = await offers.recordOfferSentAs(rep, { leadId: id, expectedRevision: await leadRev(id), idempotencyKey: key(), contents: ["DESIGN"], designIds: [d.id], sentOn: bt.businessDate(new Date()), followUp: false });
    const after = await prisma.design.findUniqueOrThrow({ where: { id: d.id } });
    check(
        "R3-2: a design sent by old code keeps its old date when the new system sends it again",
        codeOf(r) === "OK" && after.sentAt?.getTime() === oldAt.getTime() && after.legacySentAt?.getTime() === oldAt.getTime(),
        `sentAt=${after.sentAt?.toISOString()} legacy=${after.legacySentAt?.toISOString()}`,
    );
};

// R3-4: starý obchod s Lead.designSentAt, ale bez jediného Design riadku, sa nezobrazí ako „návrh neposlaný".
tests.w3cLegacyNoDesignRow = async () => {
    const { getDealList, getDealDetail } = await import("../../lib/queries/pipeline");
    const { dealScope } = await import("../../lib/domain/dealScope");
    const { dealCapabilities } = await import("../../lib/domain/dealCapabilities");
    const rep = await makeUser("SALES_REP");
    const id = await makeDeal(rep);
    const at = new Date(Date.now() - 20 * 86_400_000);
    await prisma.lead.update({ where: { id }, data: { designSentAt: at, hadLegacySends: true } });
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
    await prisma.lead.update({ where: { id }, data: { hadLegacySends: true } });
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
    const finish = async (m: AccessUser, leadId: string, extra: Partial<Parameters<typeof tasks.finishTaskAs>[1]> = {}) =>
        tasks.finishTaskAs(m, {
            taskId: (await openTask(leadId))!.id,
            expectedRevision: await leadRev(leadId),
            idempotencyKey: key(),
            ...extra,
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
            p1.nextActionKind === "SEND_DESIGN" && t.status === "OPEN" && t.contents.join() === "PRICE",
        `${codeOf(done)} ${codeOf(otherCall)} ${codeOf(priceTask)} ${p1.nextActionKind} ${t.status} ${t.contents}`,
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
    const base2 = { taskId: t2.id, idempotencyKey: key(), price: { amount: 700, note: null }, sentOn: today };
    const optOut = await tasks.finishAndSendAs(manager, { ...base2, expectedRevision: await leadRev(id2), followUp: false as unknown as true });
    const fs = await tasks.finishAndSendAs(manager, { ...base2, idempotencyKey: key(), expectedRevision: await leadRev(id2) });
    const l2 = await lead(id2);
    const id3 = await makeDeal(rep);
    const dz = await design(manager, id3, "Variant B");
    await ask(rep, id3, manager.id, { contents: ["DESIGN"], step: undefined });
    await finish(manager, id3, { designs: [{ id: dz.id, version: dz.currentVersion }] });
    await ask(rep, id3, manager.id, { step: undefined });
    const t3 = (await openTask(id3))!;
    const fs3 = await tasks.finishAndSendAs(manager, { taskId: t3.id, expectedRevision: await leadRev(id3), idempotencyKey: key(), price: { amount: 800, note: null }, sentOn: today });
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
    const keepButCancel = await send(rep, id5, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "KEEP_OPEN", cancelTask: { taskId: t5.id, reason: "x" } });
    const cancelNoReason = await send(rep, id5, { contents: ["PRICE"], price: { amount: 1, note: null }, overlap: "CANCEL_TASK", cancelTask: { taskId: t5.id, reason: " " } });
    const cancelNoOverlap = await send(rep, id5, { contents: ["ABOUT_US"], cancelTask: { taskId: t5.id, reason: "netreba" } });
    check(
        "R01-5: send with KEEP_OPEN + cancelTask, CANCEL_TASK without a reason, or cancelTask without the choice are refused; the task stays OPEN",
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
    const { sendCompletesStep } = await import("../../lib/domain/tasks");
    const manager = await makeUser("MANAGER");
    const rep = await makeUser("SALES_REP");
    const P = [{ kind: "PRICE" as const }];
    const D = [{ kind: "DESIGN" as const }];
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
    check(
        "R03-1: návrh first → step stays 'Poslať návrh', last price + call → CALL; price first → 'Poslať návrh', last návrh + call → CALL",
        codeOf(aDesign) === "OK" && aMid.nextActionKind === "SEND_DESIGN" && codeOf(aPrice) === "OK" && aEnd.nextActionKind === "CALL" &&
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
    const managerCancel = await send(manager, id, { contents: ["PRICE"], overlap: "CANCEL_TASK", cancelTask: { taskId: stillOpen!.id, reason: "netreba" } });
    const before = await leadRev(id);
    const cancel = await send(rep, id, { contents: ["PRICE"], overlap: "CANCEL_TASK", cancelTask: { taskId: stillOpen!.id, reason: "cenu som zistil sám" }, followUp: true });
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
    const noAmount = await finish(manager, id, { designs: [{ id: good.id, version: good.currentVersion }] });
    const withNoUrl = await finish(manager, id, { price: { amount: 1285, note: null }, designs: [{ id: noUrl.id, version: 1 }] });
    const byRep = await finish(rep, id, { price: { amount: 1285, note: null }, designs: [{ id: good.id, version: 1 }] });
    const task = (await openTask(id))!;
    const k = key();
    const rev = await leadRev(id);
    const input = { taskId: task.id, expectedRevision: rev, idempotencyKey: k, price: { amount: 1285, note: "Web 900 · eshop 385" }, designs: [{ id: good.id, version: good.currentVersion }] };
    const done = await tasks.finishTaskAs(manager, input);
    const replay = await tasks.finishTaskAs(manager, input);
    const conflict = await tasks.finishTaskAs(manager, { ...input, price: { amount: 1300, note: null } });
    const l = await lead(id);
    const t = await prisma.dealTask.findUniqueOrThrow({ where: { id: task.id } });
    const d = await detail(id, rep);
    const p = await pending(id);
    check(
        "W3-4: finish needs an amount and a návrh with a URL; the rep cannot finish; DONE saves the price + result, step due today, one bump",
        codeOf(noAmount) !== "OK" && codeOf(withNoUrl) !== "OK" && codeOf(byRep) === "ERR:FORBIDDEN" && codeOf(done) === "OK" &&
            Number(l.price) === 1285 && l.priceNote === "Web 900 · eshop 385" && t.status === "DONE" && t.closedById === manager.id &&
            l.nextActionKind === "SEND_DESIGN" && l.nextActionAt !== null && bt.businessDate(l.nextActionAt) === today && l.revision === rev + 1 &&
            d?.section === "TODAY" && p.length === 2,
        `${codeOf(noAmount)} ${codeOf(withNoUrl)} ${codeOf(byRep)} ${codeOf(done)} price=${l.price} status=${t.status} section=${d?.section} pending=${p.length}`,
    );
    check("W3-4: finish retry with the same key = OK, with a changed amount = conflict", codeOf(replay) === "OK" && codeOf(conflict) === "ERR:IDEMPOTENCY_CONFLICT", `${codeOf(replay)} ${codeOf(conflict)}`);

    // „Vybavil som to sám"
    const id2 = await makeDeal(rep);
    await ask(rep, id2, manager.id);
    const t2 = (await openTask(id2))!;
    const k2 = key();
    const rev2 = await leadRev(id2);
    const fsInput = { taskId: t2.id, expectedRevision: rev2, idempotencyKey: k2, price: { amount: 990, note: null }, extraContents: ["ABOUT_US" as const], sentOn: today, followUp: true as const };
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
    const noReason = await tasks.declineTaskAs(manager, { taskId: t3.id, expectedRevision: await leadRev(id3), idempotencyKey: key(), reason: " " });
    const dec = await tasks.declineTaskAs(manager, { taskId: t3.id, expectedRevision: await leadRev(id3), idempotencyKey: key(), reason: "zavolaj im a zisti, čo chcú" });
    const l3 = await lead(id3);
    const p3 = await pending(id3);
    check(
        "W3-4: decline needs a reason, keeps the step (SEND_QUOTE, due today), the reason waits as 'zamietnuté'",
        codeOf(noReason) !== "OK" && codeOf(dec) === "OK" && l3.nextActionKind === "SEND_QUOTE" && l3.nextActionAt !== null &&
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
    const dec = await tasks.declineTaskAs(manager, { taskId: t3, expectedRevision: await leadRev(id3), idempotencyKey: key(), reason: "pokračuj ty" });
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
        tasks.finishTaskAs(manager2, { taskId: task.id, expectedRevision: rev, idempotencyKey: key(), price: { amount: 1, note: null } }),
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
                        contents: ts === "OPEN-HANDOVER" ? [] : ["PRICE"],
                        status: ts === "OPEN-HELP" || ts === "OPEN-HANDOVER" ? "OPEN" : ts,
                        text: "x",
                        requestedById: rep.id,
                        assigneeId: manager.id,
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
            codeOf(empty) === "OK" && l2.nextActionNote === "Poslať úvodný email (o nás + cenník)" &&
            codeOf(quote) === "OK" && l3.nextActionNote === "Poslať cenu" &&
            codeOf(noneWithNote) !== "OK" && codeOf(lostWithStep) !== "OK",
        `${codeOf(r)} call="${call.note}" step="${l.nextActionNote}" empty="${l2.nextActionNote}" quote="${l3.nextActionNote}" ${codeOf(noneWithNote)} ${codeOf(lostWithStep)}`,
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
