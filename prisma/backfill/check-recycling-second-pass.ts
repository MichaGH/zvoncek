// Druhý review Feature 02: chýbajúce read-model, filter a concurrency scenáre. Iba vlastné fixture na dev kópii.
// npx tsx prisma/backfill/check-recycling-second-pass.ts --expect-endpoint ep-divine-waterfall-asbkuort
import "dotenv/config";
import prisma from "../../lib/db";
import type { AccessUser } from "../../lib/access/user";
import type { Prisma } from "../../app/generated/prisma/client";
import type { Role } from "../../app/generated/prisma/enums";
import { recycleLeadsAs } from "../../lib/commands/recycling";
import { askManagerAs, taskMessageAs } from "../../lib/commands/tasks";
import { changeOwnerAs, reopenDealAs } from "../../lib/commands/pipeline";
import { correctRecordAs, recordOfferSentAs } from "../../lib/commands/offers";
import { removeDesignAs, addDesignVersionAs, updateDesignMetaAs } from "../../lib/commands/tracking";
import { transferCallWorkAs } from "../../lib/commands/assignments";
import { getRemainingWork } from "../../lib/commands/admin";
import { getDealList, getDealCounts, getDealDetail, getDealScope, getHandedOverHistory } from "../../lib/queries/pipeline";
import { logCallAs } from "../../lib/commands/calls";
import { claimBatchAs } from "../../lib/commands/claims";
import { createDesignAs } from "../../lib/commands/tracking";
import { getDealsToday, getCallerToday } from "../../lib/queries/today";
import { getManagerToday } from "../../lib/queries/today/manager";
import { getContactsAddedDaily, getContactsAddingLog, getCallStats, getDemandStats } from "../../lib/queries/stats";
import { getAssignmentsOverview } from "../../lib/queries/calls/assignments";
import { getRecycleList, getRecycleCounts, getRecycleFirst, getRecycleHolders } from "../../lib/queries/recycling";
import { parseRecycleParams, RECYCLE_BUCKETS, type RecycleBucket, type RecycleParams } from "../../lib/domain/recycling";
import { resolveRange } from "../../lib/stats/range";
import { businessDate, businessTodayStart } from "../../lib/domain/businessTime";

const ep = new URL(process.env.DATABASE_URL ?? "postgres://x/none").hostname.split(".")[0].replace(/-pooler$/, "");
if (ep !== "ep-divine-waterfall-asbkuort" || process.argv[process.argv.indexOf("--expect-endpoint") + 1] !== ep) throw new Error("ABORT: development endpoint required");
const run = `rv2b_${Date.now().toString(36)}`;
const ids: string[] = [], users: string[] = [];
let checks = 0, failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    checks++; if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
async function user(role: Role): Promise<AccessUser> {
    const u = await prisma.user.create({ data: { username: `${run}_${users.length}`.slice(-20), firstName: run, lastName: role, role, password: "unused-review-fixture" } });
    users.push(u.id); return u;
}
async function lead(data: Prisma.LeadUncheckedCreateInput = {}) {
    const l = await prisma.lead.create({ data: { companyName: run, phone: `+000 ${run}`, status: "LOST", ...data } });
    ids.push(l.id); return l;
}
const key = () => crypto.randomUUID();
const rec = (actor: AccessUser, leadId: string, expectedRevision = 0) => recycleLeadsAs(actor, { items: [{ leadId, expectedRevision }] });
const failed = (v: unknown) => Boolean(v && typeof v === "object" && "error" in v);

async function readers(admin: AccessUser, rep: AccessUser, former: AccessUser, scout: AccessUser, caller: AccessUser) {
    const now = new Date(), yesterday = new Date(+now - 86_400_000);
    const l = await lead({ status: "ACTIVE", ownerId: rep.id, createdById: scout.id, createdAt: yesterday,
        pipelineEnteredAt: yesterday, handedOffById: caller.id, nextActionKind: "CALL", nextActionAt: businessTodayStart(), offerAboutUsAt: yesterday });
    const call = await prisma.activity.create({ data: { leadId: l.id, userId: caller.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "INTERESTED", createdAt: yesterday } });
    const send = await prisma.activity.create({ data: { leadId: l.id, userId: rep.id, type: "OFFER_SENT", category: "BUSINESS", source: "CLIENTS", createdAt: yesterday,
        meta: { channel: "EMAIL", contents: ["ABOUT_US"], sentOn: businessDate(yesterday), historical: false } } });
    await prisma.leadRequest.createMany({ data: [
        { leadId: l.id, content: "INFO", state: "SENT", requestedAt: yesterday, requestedById: caller.id, sourceActivityId: call.id, resolvedAt: yesterday, resolvedActivityId: send.id },
        { leadId: l.id, content: "PRICE", requestedAt: yesterday, requestedById: caller.id, sourceActivityId: call.id },
    ] });
    await prisma.dealOwnership.create({ data: { leadId: l.id, fromUserId: former.id, toUserId: rep.id, byUserId: admin.id, reason: "CHANGE", createdAt: now } });
    const design = await prisma.design.create({ data: { leadId: l.id, versions: { create: { version: 1 } } } });
    const task = await prisma.dealTask.create({ data: { leadId: l.id, type: "HELP", status: "CANCELLED", text: run, requestedById: rep.id, assigneeId: admin.id, closedAt: now,
        parts: { create: { kind: "PRICE", status: "WITHDRAWN", addedById: rep.id, resolvedById: rep.id, resolvedAt: now, reason: "fixture closed" } } } });
    const p = { scope: await getDealScope(admin), owner: "all" as const, query: run, viewerId: admin.id };
    const beforeList = await getDealList(p), beforeCounts = await getDealCounts(p), beforeToday = await getDealsToday(rep);
    const beforeManager = await getManagerToday(admin), beforeHistory = await getHandedOverHistory(former.id);
    const dailyArgs = { userId: scout.id, from: new Date(+now - 7 * 86_400_000), to: new Date(+now + 86_400_000) };
    const beforeDaily = await getContactsAddedDaily(dailyArgs);
    const beforeLog = await getContactsAddingLog({ range: resolveRange({ period: "all" }), userIds: [scout.id] });
    const statsArgs = { range: resolveRange({ period: "all" }), userId: caller.id };
    const beforeCalls = await getCallStats(statsArgs), beforeDemand = await getDemandStats(statsArgs);
    check("reader fixtures really qualify before archive", beforeList.rows.some((r) => r.id === l.id) && beforeCounts.all === 1 && beforeCounts.work === 1 && beforeCounts.today === 1
        && beforeToday?.urgent.some((r) => r.id === l.id) === true && beforeManager.reps.some((r) => r.id === rep.id && r.openDeals === 1)
        && beforeHistory.some((r) => r.leadId === l.id));
    const r = await rec(admin, l.id);
    const archive = await prisma.lead.findFirstOrThrow({ where: { archiveOfId: l.id } });
    const afterList = await getDealList(p), afterCounts = await getDealCounts(p), afterToday = await getDealsToday(rep);
    const afterManager = await getManagerToday(admin), afterHistory = await getHandedOverHistory(former.id);
    // Skontroluj aj skutočný sent-design reader; vyhľadávanie musí zostať súčasťou predikátu.
    const gotDesignRows = await getDealList({ ...p, view: "got_design", take: 500 });
    check("pipeline actual list and every pill count exclude archive/current NEW", !failed(r) && afterList.rows.length === 0
        && Object.entries(afterCounts).filter(([k]) => k !== "unassignedOpen").every(([, n]) => n === 0)
        && beforeCounts.got_design === 0 && gotDesignRows.rows.length === 0, afterCounts);
    check("owner dashboard and manager owner totals exclude archived active deal", afterToday?.openCount === 0 && !afterToday.urgent.some((r) => r.id === l.id || r.id === archive.id)
        && afterManager.reps.some((r) => r.id === rep.id && r.openDeals === 0 && r.overdue === 0 && r.newThisWeek === 0));
    check("ownership history really disappears after archive", !afterHistory.some((r) => r.leadId === l.id || r.leadId === archive.id));
    check("manager inbox and remaining deal work exclude archive", !afterManager.tasks.some((t) => t.leadId === archive.id) && (await getRemainingWork(rep.id)).deals === 0);
    check("contacts-added daily and adding-log retain one original attribution", JSON.stringify(beforeDaily) === JSON.stringify(await getContactsAddedDaily(dailyArgs))
        && JSON.stringify(beforeLog) === JSON.stringify(await getContactsAddingLog({ range: resolveRange({ period: "all" }), userIds: [scout.id] })) && beforeLog[0]?.total === 1);
    check("call and demand statistics retain real historical events", beforeCalls.totalCalls === 1 && JSON.stringify(beforeCalls) === JSON.stringify(await getCallStats(statsArgs))
        && beforeDemand.total === 2 && JSON.stringify(beforeDemand) === JSON.stringify(await getDemandStats(statsArgs)));

    const digest = async () => JSON.stringify({ lead: await prisma.lead.findUnique({ where: { id: archive.id } }),
        activity: await prisma.activity.findMany({ where: { leadId: archive.id }, orderBy: { id: "asc" } }),
        design: await prisma.design.findUnique({ where: { id: design.id } }), task: await prisma.dealTask.findUnique({ where: { id: task.id } }) });
    const snapshot = await digest();
    const denied = await Promise.all([
        correctRecordAs(admin, send.id, "review correction"), removeDesignAs(admin, design.id), addDesignVersionAs(admin, design.id, { note: "review" }),
        updateDesignMetaAs(admin, design.id, { label: "review" }), taskMessageAs(admin, { taskId: task.id, expectedRevision: 0, idempotencyKey: key(), text: "review" }),
        recordOfferSentAs(admin, { leadId: archive.id, expectedRevision: 0, idempotencyKey: key(), contents: ["ABOUT_US"], sentOn: businessDate(now), followUp: false }),
        reopenDealAs(admin, archive.id, { expectedRevision: 0, idempotencyKey: key() }),
    ]);
    check("seven ordinary mutation routes refuse archived parents/children", denied.every(failed), denied);
    check("refused archive mutations leave every sampled record unchanged", snapshot === await digest());

    const callStage = await lead({ status: "CALLING", callbackKind: "SCHEDULED", callbackAt: yesterday, assignedCallerId: caller.id, assignedCallerAt: yesterday });
    check("caller dashboard fixture qualifies before recycling", (await getCallerToday(caller)).urgent.some((r) => r.id === callStage.id));
    await rec(admin, callStage.id);
    const callerToday = await getCallerToday(caller), assignments = await getAssignmentsOverview();
    check("caller dashboard/assignment overview exclude archived scheduled call", !callerToday.urgent.some((r) => r.id === callStage.id) && callerToday.callbacksOverdue === 0
        && assignments.rows.some((r) => r.id === caller.id && r.scheduled === 0));
}

type Fixture = { id: string; number: number; bucket: RecycleBucket; eligible: boolean; holder: string | null; tries: number; lastAt: Date; round: number; got: string[] };
async function filters(admin: AccessUser, rep: AccessUser, a: AccessUser, b: AccessUser) {
    const q = `${run}_filters`, fixtures: Fixture[] = [];
    const base = Date.now(), ago = (days: number) => new Date(base - days * 86_400_000);
    async function add(bucket: RecycleBucket, opts: { days?: number; tries?: number; round?: number; holder?: string | null; got?: string[]; eligible?: boolean; name?: string } = {}) {
        const deal = bucket.startsWith("deal_");
        const status = bucket.endsWith("lost") ? "LOST" : bucket.endsWith("unreachable") ? "UNREACHABLE" : bucket.endsWith("active") ? "ACTIVE" : bucket.endsWith("snoozed") ? "SNOOZED" : "CALLING";
        const holder = opts.holder === undefined ? (deal ? rep.id : a.id) : opts.holder;
        const got = opts.got ?? [], lastAt = ago(opts.days ?? 100);
        const l = await lead({ companyName: `${q}${opts.name ?? ""}`, website: `${q}.invalid`, email: `${q}@example.invalid`, status,
            pipelineEnteredAt: deal ? ago(120) : null, callbackKind: status === "CALLING" ? (bucket === "call_retry" ? "RETRY" : "SCHEDULED") : null,
            ownerId: deal ? holder : null, assignedCallerId: deal ? null : holder, createdAt: lastAt, round: opts.round ?? 1,
            offerAboutUsAt: got.includes("info") ? ago(110) : null, offerPricelistAt: got.includes("pricelist") ? ago(110) : null,
            offerPriceAt: got.includes("price") ? ago(110) : null, designSentAt: got.includes("design") ? ago(110) : null });
        fixtures.push({ id: l.id, number: l.number, bucket, eligible: opts.eligible !== false, holder, got, lastAt, tries: opts.tries ?? 0, round: opts.round ?? 1 });
        for (let i = 0; i < (opts.tries ?? 0); i++) await prisma.activity.create({ data: { leadId: l.id, userId: a.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "NO_ANSWER", createdAt: lastAt } });
        return l;
    }
    await add("call_lost", { holder: null }); // žiadny kontakt: fallback createdAt
    const reverted = await add("call_retry", { days: 60, tries: 2 });
    await prisma.activity.create({ data: { leadId: reverted.id, userId: a.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "NO_ANSWER", createdAt: ago(1), revertedAt: new Date() } });
    const mixed = await add("deal_active", { days: 45, tries: 1, round: 2, got: ["info", "price"] });
    for (const [type, days] of [["CALL", 90], ["SMS_SENT", 80], ["OFFER_SENT", 70], ["CLIENT_REPLIED", 45], ["NOTE", 1], ["TASK_MESSAGE", 0]] as const) {
        await prisma.activity.create({ data: { leadId: mixed.id, userId: b.id, type, category: "BUSINESS", source: "CLIENTS", createdAt: ago(days) } });
    }
    await add("deal_lost", { days: 30 - 1 / 24, got: ["design"], round: 3 });
    await add("deal_unreachable", { days: 30 + 1 / 24, got: ["pricelist"], round: 2, holder: null });
    await add("call_scheduled", { days: 7 - 1 / 24, tries: 3, holder: b.id });
    await add("call_snoozed", { days: 7 + 1 / 24, round: 2, holder: b.id });
    await add("call_unreachable", { days: 90, holder: null });
    await add("deal_snoozed", { days: 150, got: ["design", "price"] });
    const tied = await add("call_lost", { days: 50, holder: null });
    const tieTime = ago(50);
    await prisma.activity.createMany({ data: [
        { id: `${run}_tie_a`, leadId: tied.id, userId: a.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "NOT_INTERESTED", createdAt: tieTime },
        { id: `${run}_tie_z`, leadId: tied.id, userId: b.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "BAD_NUMBER", createdAt: tieTime },
    ] });
    fixtures.find((f) => f.id === tied.id)!.holder = b.id;
    const blocked = await add("deal_active", { eligible: false });
    await prisma.dealTask.create({ data: { leadId: blocked.id, type: "HELP", text: run, requestedById: rep.id, assigneeId: admin.id } });
    const hidden = await add("call_lost", { eligible: false });
    await prisma.lead.update({ where: { id: hidden.id }, data: { deletedAt: new Date(), archiveOfId: tied.id } });
    const assigned = await add("call_retry", { days: 20, holder: a.id });
    await prisma.activity.create({ data: { leadId: assigned.id, userId: b.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "NOT_INTERESTED", createdAt: ago(20) } });
    for (const suffix of ["_%", "_under_score", "_back\\slash", "_O'Brien", "_Žltý"]) await add("call_lost", { name: suffix });

    function matches(f: Fixture, p: RecycleParams, without?: "buckets" | "holder") {
        return f.eligible && (without === "buckets" || p.buckets.includes(f.bucket)) && (without === "holder" || !p.holder || f.holder === (p.holder === "none" ? null : p.holder))
            && (!p.older || +f.lastAt < Date.now() - p.older * 86_400_000) && f.tries >= p.tries && (!p.got || f.got.includes(p.got))
            && (!p.round || (p.round === "1" ? f.round === 1 : f.round >= 2));
    }
    const cases: Record<string, string>[] = [
        {}, { older: "7" }, { older: "30" }, { older: "60" }, { older: "90" }, { tries: "1" }, { tries: "2" }, { tries: "3" },
        { got: "info" }, { got: "pricelist" }, { got: "price" }, { got: "design" }, { round: "1" }, { round: "2" },
        { holder: a.id }, { holder: b.id }, { holder: "none" }, { b: "call_retry,deal_active", tries: "1", round: "2", got: "price", older: "30" },
        { b: "call_lost,call_unreachable", holder: "none", older: "90" }, { b: "deal_lost,deal_snoozed", got: "design", round: "1" },
    ];
    for (const [i, patch] of cases.entries()) {
        const p = parseRecycleParams({ b: RECYCLE_BUCKETS.join(","), older: "0", q, ...patch });
        const list = await getRecycleList(p), counts = await getRecycleCounts(p), first = await getRecycleFirst(p, 3), holders = await getRecycleHolders(p);
        const expected = fixtures.filter((f) => matches(f, p)).sort((a, b) => +a.lastAt - +b.lastAt || a.id.localeCompare(b.id));
        const countOk = RECYCLE_BUCKETS.every((bucket) => counts[bucket] === fixtures.filter((f) => f.bucket === bucket && matches(f, p, "buckets")).length);
        const expectedHolders = new Map<string, number>();
        for (const f of fixtures.filter((f) => matches(f, p, "holder"))) { const h = f.holder ?? "none"; expectedHolders.set(h, (expectedHolders.get(h) ?? 0) + 1); }
        check(`filter matrix ${i + 1}: list/counts/first-N/holders agree with independent fixtures`, list.total === expected.length
            && JSON.stringify(list.rows.map((r) => r.id)) === JSON.stringify(expected.map((r) => r.id)) && countOk
            && JSON.stringify(first.map((r) => r.id)) === JSON.stringify(expected.slice(0, 3).map((r) => r.id))
            && holders.length === expectedHolders.size && holders.every((h) => h.count === expectedHolders.get(h.id)), { patch, expected: expected.length, actual: list.total });
    }
    const baseline = await getRecycleList(parseRecycleParams({ q, b: RECYCLE_BUCKETS.join(","), older: "0" }));
    check("recent reverted calls and internal notes do not reset last-contact/tries", baseline.rows.find((r) => r.id === reverted.id)?.tries === 2
        && baseline.rows.find((r) => r.id === mixed.id)?.lastAt === fixtures.find((f) => f.id === mixed.id)!.lastAt.toISOString());
    check("last-call tie order and assigned-caller precedence", baseline.rows.find((r) => r.id === tied.id)?.lastOutcome === "BAD_NUMBER"
        && baseline.rows.find((r) => r.id === tied.id)?.holderName === `${b.firstName} ${b.lastName}`
        && baseline.rows.find((r) => r.id === assigned.id)?.holderName === `${a.firstName} ${a.lastName}`);
    for (const suffix of ["_%", "_under_score", "_back\\slash", "_O'Brien", "_Žltý"]) {
        const result = await getRecycleList(parseRecycleParams({ q: `${q}${suffix}`, b: RECYCLE_BUCKETS.join(","), older: "0" }));
        check(`literal search ${suffix}`, result.total === 1, result.total);
    }
    const numeric = await getRecycleList(parseRecycleParams({ q: `#${tied.number}`, b: RECYCLE_BUCKETS.join(","), older: "0" }));
    check("number search identifies exactly the live contact", numeric.total === 1 && numeric.rows[0]?.id === tied.id);
}

async function waitForWaiter(table: "Lead" | "User", mode: "recycle" | "other", signal: string, blockerPid: number) {
    const end = Date.now() + 4_000;
    while (Date.now() < end) {
        // Follow only this fixture's lock queue; other suites may have unrelated waiters with the same SQL.
        const rows = await prisma.$queryRaw<{ query: string }[]>`WITH RECURSIVE waiting AS (
            SELECT pid, query FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
            UNION
            SELECT a.pid, a.query FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT DISTINCT query FROM waiting`;
        if (rows.some((r) => r.query.includes(`FROM "${table}"`) && (mode === "recycle" ? r.query.includes(signal) : !r.query.includes(signal)))) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`No ${table}/${mode} lock waiter observed`);
}
async function forced<A, B>(table: "Lead" | "User", id: string, firstMode: "recycle" | "other", first: () => Promise<A>, second: () => Promise<B>) {
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>((resolve) => { ready = resolve; }), unblock = new Promise<void>((resolve) => { release = resolve; });
    let blockerPid = 0;
    const blocker = prisma.$transaction(async (tx) => {
        blockerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
        if (table === "Lead") await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${id} FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
        ready(); await unblock;
    }, { timeout: 30_000 });
    try {
        await held;
        const one = first();
        await waitForWaiter(table, firstMode, table === "Lead" ? "ANY(" : "FOR SHARE", blockerPid);
        const two = second();
        await waitForWaiter(table, firstMode === "recycle" ? "other" : "recycle", table === "Lead" ? "ANY(" : "FOR SHARE", blockerPid);
        release();
        return await Promise.all([one, two]);
    } finally { release(); await blocker; }
}

async function races(admin: AccessUser, rep: AccessUser, targetRep: AccessUser, caller: AccessUser, targetCaller: AccessUser) {
    for (const first of ["recycle", "other"] as const) {
        const l = await lead({ status: "ACTIVE", ownerId: rep.id, pipelineEnteredAt: new Date(), nextActionKind: "CALL" });
        const recycle = () => rec(admin, l.id), ask = () => askManagerAs(rep, { leadId: l.id, expectedRevision: 0, idempotencyKey: key(), type: "HELP", contents: ["DESIGN"], assigneeId: admin.id, text: run });
        const [a, b] = first === "recycle" ? await forced("Lead", l.id, first, recycle, ask) : await forced("Lead", l.id, first, ask, recycle);
        const state = await prisma.lead.findUniqueOrThrow({ where: { id: l.id }, include: { tasks: true } });
        check(`recycle vs new manager task (${first} first)`, first === "recycle"
            ? !failed(a) && failed(b) && state.round === 2 && state.tasks.length === 0
            : !failed(a) && !failed(b) && "recycled" in b && b.recycled === 0 && state.round === 1 && state.tasks.some((t) => t.status === "OPEN"), { a, b });
        if (first === "other") {
            const blocked = await rec(admin, l.id, state.revision);
            check("fresh revision still cannot recycle open manager work", "skipped" in blocked && blocked.skipped[0]?.reason === "OPEN_TASK", blocked);
        }
    }
    for (const first of ["recycle", "other"] as const) {
        const l = await lead({ status: "ACTIVE", ownerId: rep.id, pipelineEnteredAt: new Date() });
        const recycle = () => rec(admin, l.id), change = () => changeOwnerAs(admin, l.id, { ownerId: targetRep.id, expectedRevision: 0, idempotencyKey: key() });
        const [a, b] = first === "recycle" ? await forced("Lead", l.id, first, recycle, change) : await forced("Lead", l.id, first, change, recycle);
        const state = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
        check(`recycle vs owner change (${first} first)`, first === "recycle"
            ? !failed(a) && failed(b) && state.round === 2 && state.ownerId === null
            : !failed(a) && "recycled" in b && b.recycled === 0 && state.round === 1 && state.ownerId === targetRep.id, { a, b });
    }
    for (const first of ["recycle", "other"] as const) {
        const l = await lead({ status: "CALLING", callbackKind: "RETRY", assignedCallerId: caller.id });
        const recycle = () => rec(admin, l.id), transfer = () => transferCallWorkAs(admin, { fromUserId: caller.id, toUserId: targetCaller.id, kind: "RETRY", limit: 1 });
        const [a, b] = first === "recycle" ? await forced("User", caller.id, first, recycle, transfer) : await forced("User", caller.id, first, transfer, recycle);
        const state = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
        check(`recycle vs caller transfer (${first} first)`, first === "recycle"
            ? !failed(a) && "moved" in b && b.moved === 0 && state.round === 2 && state.assignedCallerId === null
            : "moved" in a && a.moved === 1 && "recycled" in b && b.recycled === 0 && state.round === 1 && state.assignedCallerId === targetCaller.id, { a, b });
    }
}

async function inheritedPipelineSearch(admin: AccessUser, owner: AccessUser) {
    const a = await lead({ companyName: `${run}_search_ALPHA`, status: "ACTIVE", pipelineEnteredAt: new Date(), ownerId: owner.id, designSentAt: new Date() });
    const b = await lead({ companyName: `${run}_search_BETA`, status: "ACTIVE", pipelineEnteredAt: new Date(), ownerId: owner.id, designSentAt: new Date() });
    const actual = await lead({ companyName: `${run}_search_ALPHA_actual`, status: "ACTIVE", pipelineEnteredAt: new Date(), ownerId: owner.id });
    await prisma.design.create({ data: { leadId: actual.id, sentAt: new Date() } });
    const foreign = await lead({ companyName: `${run}_search_ALPHA_foreign`, status: "ACTIVE", pipelineEnteredAt: new Date(), ownerId: admin.id, designSentAt: new Date() });
    await prisma.design.create({ data: { leadId: foreign.id, sentAt: new Date() } });
    const p = { scope: await getDealScope(owner), owner: { userId: owner.id }, query: a.companyName!, viewerId: owner.id };
    const plain = await getDealList(p), got = await getDealList({ ...p, view: "got_design" }), counts = await getDealCounts(p);
    check("pipeline search control matches only scoped ALPHA records", plain.rows.length === 2 && plain.rows.every((r) => [a.id, actual.id].includes(r.id)));
    check("INHERITED: got_design preserves search for legacy and actual sent designs", got.rows.length === 2 && got.rows.every((r) => [a.id, actual.id].includes(r.id)) && counts.got_design === 2,
        { expected: 2, actualRows: got.rows.length, actualCount: counts.got_design, returnedUnrelatedBeta: got.rows.some((row) => row.id === b.id) });
    const noMatch = { ...p, query: `${run}_search_ABSENT`, view: "got_design" };
    check("sent-design no-match list and count both empty", (await getDealList(noMatch)).rows.length === 0 && (await getDealCounts(noMatch)).got_design === 0);
    await rec(admin, a.id);
    await rec(admin, actual.id);
    const after = await getDealList({ ...p, view: "got_design" });
    check("INHERITED: search for recycled ALPHA does not return unrelated BETA", after.rows.length === 0,
        { expected: 0, actualRows: after.rows.length, returnedUnrelatedBeta: after.rows.some((row) => row.id === b.id) });
}

async function fullRoundWorkflow(admin: AccessUser, rep: AccessUser) {
    const l = await lead({ companyName: `${run}_cycle`, status: "NEW", assignedCallerId: rep.id });
    const first = await logCallAs(rep, { leadId: l.id, outcome: "INTERESTED", asked: ["PRICE", "DESIGN"], expectedRevision: 0, idempotencyKey: key() });
    if (failed(first)) throw new Error(`old-round call failed: ${JSON.stringify(first)}`);
    const designResult = await createDesignAs(admin, { leadId: l.id, label: "Old proposal", url: "https://example.invalid/old-proposal" });
    if (failed(designResult)) throw new Error(`old design failed: ${JSON.stringify(designResult)}`);
    const design = await prisma.design.findFirstOrThrow({ where: { leadId: l.id } });
    const oldRev = (await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).revision;
    const offer = await recordOfferSentAs(rep, { leadId: l.id, expectedRevision: oldRev, idempotencyKey: key(), contents: ["ABOUT_US", "PRICE", "DESIGN"],
        price: { amount: 750, note: "Old quote" }, designIds: [design.id], sentOn: businessDate(new Date()), followUp: true });
    if (failed(offer)) throw new Error(`old offer failed: ${JSON.stringify(offer)}`);
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    check("full cycle old deal really has price, sent proposal and resolved asks", before.price?.toString() === "750" && before.designSentAt !== null
        && await prisma.leadRequest.count({ where: { leadId: l.id, state: "SENT" } }) === 2);
    await rec(admin, l.id, before.revision);
    const archive = await prisma.lead.findFirstOrThrow({ where: { archiveOfId: l.id } });
    const archivedActivityIds = (await prisma.activity.findMany({ where: { leadId: archive.id }, select: { id: true } })).map((a) => a.id);
    // Čelo fronty iba z našich fixture, aby claim nesiahol na ostatné kontakty vetvy.
    await prisma.lead.update({ where: { id: l.id }, data: { roundStartedAt: new Date("1900-01-01Z") } });
    for (let i = 0; i < 9; i++) await lead({ status: "NEW", createdAt: new Date("1901-01-01Z") });
    const claimed = await claimBatchAs(rep);
    const held = await prisma.lead.findMany({ where: { assignedCallerId: rep.id, deletedAt: null, status: "NEW" }, select: { id: true } });
    check("full cycle real claim gets only ten review fixtures including recycled deal", "claimed" in claimed && claimed.claimed === 10 && held.length === 10
        && held.some((h) => h.id === l.id) && held.every((h) => ids.includes(h.id)), claimed);
    const claimedLead = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    const second = await logCallAs(rep, { leadId: l.id, outcome: "INTERESTED", asked: ["PRICELIST"], expectedRevision: claimedLead.revision, idempotencyKey: key() });
    const detail = await getDealDetail(l.id, await getDealScope(rep), { manage: false });
    check("full cycle round-two positive call creates a clean new deal projection", !failed(second) && detail !== null && detail.price === null && detail.priceNote === null
        && detail.designs.length === 0 && detail.tasks.length === 0 && detail.pending.length === 0 && detail.priceHistory.length === 0
        && detail.offers.offerAboutUsAt === null && detail.offers.offerPriceAt === null && detail.offers.designSentAt === null
        && detail.asked.length === 1 && detail.asked[0] === "PRICELIST" && detail.nextActionKind === "SEND_EMAIL"
        && detail.activities.every((a) => !archivedActivityIds.includes(a.id)));
    const movedDesign = await prisma.design.findUniqueOrThrow({ where: { id: design.id } });
    check("full cycle original requests/send/design remain attached to archive", movedDesign.leadId === archive.id
        && await prisma.leadRequest.count({ where: { leadId: archive.id, state: "SENT" } }) === 2
        && await prisma.activity.count({ where: { leadId: archive.id, type: "OFFER_SENT" } }) === 1
        && (await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).round === 2);
}

async function main() {
    console.log(`endpoint=${ep} run=${run}`);
    const foreignKeys = await prisma.$queryRaw<{ child: string; column: string }[]>`SELECT c.conrelid::regclass::text AS child, a.attname AS column
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = '"Lead"'::regclass`;
    const children = foreignKeys.map((f) => `${f.child.replaceAll('"', '')}.${f.column}`).sort();
    check("database FK inventory contains exactly the five moved children and archive relation", JSON.stringify(children)
        === JSON.stringify(["Activity.leadId", "DealOwnership.leadId", "DealTask.leadId", "Design.leadId", "Lead.archiveOfId", "LeadRequest.leadId"].sort()), children);
    const admin = await user("ADMIN"), rep = await user("SALES_REP"), former = await user("SALES_REP"), scout = await user("SCOUT"), caller = await user("TELESALES"), otherCaller = await user("TELESALES");
    await readers(admin, rep, former, scout, caller);
    await filters(admin, rep, caller, otherCaller);
    // Filter fixtures používajú rovnakého volajúceho; presuny musia mať vlastné účty, nech necielia na iné fixture.
    await races(admin, rep, former, await user("TELESALES"), await user("TELESALES"));
    await fullRoundWorkflow(admin, await user("SALES_REP"));
    await inheritedPipelineSearch(admin, await user("SALES_REP"));
}
main().catch((e) => { failures++; console.error(e); }).finally(async () => {
    try {
        const archives = await prisma.lead.findMany({ where: { archiveOfId: { in: ids } }, select: { id: true } });
        const all = [...ids, ...archives.map((a) => a.id)];
        await prisma.leadRequest.deleteMany({ where: { leadId: { in: all } } });
        await prisma.activity.deleteMany({ where: { leadId: { in: all } } });
        await prisma.dealOwnership.deleteMany({ where: { leadId: { in: all } } });
        await prisma.dealTask.deleteMany({ where: { leadId: { in: all } } });
        await prisma.lead.deleteMany({ where: { id: { in: archives.map((a) => a.id) } } });
        await prisma.lead.deleteMany({ where: { id: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
        console.log(`cleanup complete; ${checks - failures}/${checks} passed; failures=${failures}`);
    } finally { await prisma.$disconnect(); process.exitCode = failures ? 1 : 0; }
});
