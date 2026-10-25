// Dodatočné regresné kontroly implementačného review Feature 02. Iba vlastné fixture na dev kópii.
// npx tsx prisma/backfill/check-recycling-review.ts --expect-endpoint ep-divine-waterfall-asbkuort
import "dotenv/config";
import prisma from "../../lib/db";
import type { AccessUser } from "../../lib/access/user";
import { recycleLeadsAs } from "../../lib/commands/recycling";
import { logCallAs } from "../../lib/commands/calls";
import { revertCallResultAs } from "../../lib/commands/history";
import { getCallHistory } from "../../lib/queries/calls/history";
import { getContactsAddedStats } from "../../lib/queries/stats";
import { getRecycleList, getRecycleCounts, getRecycleFirst, getRecycleHolders } from "../../lib/queries/recycling";
import { parseRecycleParams, RECYCLE_BUCKETS, RECYCLE_BUCKET_RULE, RECYCLE_SORTS } from "../../lib/domain/recycling";
import type { Prisma } from "../../app/generated/prisma/client";
import { resolveRange } from "../../lib/stats/range";

const endpoint = new URL(process.env.DATABASE_URL ?? "postgres://x/none").hostname.split(".")[0].replace(/-pooler$/, "");
const expected = process.argv[process.argv.indexOf("--expect-endpoint") + 1];
if (endpoint !== "ep-divine-waterfall-asbkuort" || expected !== endpoint) throw new Error("ABORT: review checks require the development copy.");
const run = `rv02_${Date.now().toString(36)}`;
const ids: string[] = [];
const users: string[] = [];
let failures = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
async function makeUser(role: "ADMIN" | "TELESALES" | "SALES_REP" | "SCOUT"): Promise<AccessUser> {
    const u = await prisma.user.create({ data: { username: `${run}_${users.length}`.slice(-20), firstName: run, lastName: role, role, password: "unused-review-account" } });
    users.push(u.id);
    return u;
}
async function lead(data: Prisma.LeadUncheckedCreateInput = {}) {
    const l = await prisma.lead.create({ data: { companyName: run, phone: `+000 ${run}`, status: "LOST", createdAt: new Date("2020-01-01Z"), ...data } });
    ids.push(l.id);
    return l;
}
const revisionItems = async (leadIds: string[]) => (await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, revision: true } }))
    .map((l) => ({ leadId: l.id, expectedRevision: l.revision }));

async function main() {
    console.log(`endpoint=${endpoint} run=${run}`);
    const admin = await makeUser("ADMIN");
    const caller = await makeUser("TELESALES");
    const scout = await makeUser("SCOUT");

    // Archivácia musí meniť iba leadId detí, nie ich historické timestampy.
    const l = await lead({ pipelineEnteredAt: new Date("2020-01-02Z"), ownerId: admin.id, createdById: scout.id });
    const oldTime = new Date("2020-02-03T04:05:06Z");
    const design = await prisma.design.create({ data: { leadId: l.id, label: "timestamp fixture", updatedAt: oldTime,
        versions: { create: { version: 1, url: "https://example.invalid/review" } },
        tracker: { create: { token: run, events: { create: { type: "PAGE_VIEW", versionAtView: 1 } } } } } });
    const request = await prisma.leadRequest.create({ data: { leadId: l.id, content: "DESIGN", requestedAt: oldTime, updatedAt: oldTime } });
    await prisma.design.create({ data: { leadId: l.id, label: "another timestamp", sentAt: oldTime,
        deletedAt: oldTime, createdAt: oldTime, updatedAt: new Date("2021-03-04T05:06:07Z"), repoUrl: "https://example.invalid/repo", isLive: false } });
    await prisma.leadRequest.create({ data: { leadId: l.id, content: "INFO", state: "WITHDRAWN", requestedAt: oldTime,
        updatedAt: new Date("2022-04-05T06:07:08Z"), resolvedAt: oldTime, requestedById: caller.id, migrationKey: run } });
    await prisma.activity.create({ data: { leadId: l.id, userId: caller.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE",
        outcome: "NO_ANSWER", createdAt: oldTime, note: "preserve me", leadRevision: 0, meta: { fixture: run } } });
    await prisma.dealOwnership.create({ data: { leadId: l.id, fromUserId: caller.id, toUserId: admin.id, byUserId: admin.id, reason: "CHANGE", createdAt: oldTime } });
    await prisma.dealTask.create({ data: { leadId: l.id, type: "HELP", status: "DONE", text: run, requestedById: caller.id,
        assigneeId: admin.id, createdAt: oldTime, closedAt: oldTime, closedById: admin.id, fallbackKind: "CALL", fallbackNote: "keep" } });
    const childSnapshot = async (leadId: string) => Promise.all([
        prisma.activity.findMany({ where: { leadId }, orderBy: { id: "asc" } }),
        prisma.leadRequest.findMany({ where: { leadId }, orderBy: { id: "asc" } }),
        prisma.dealTask.findMany({ where: { leadId }, orderBy: { id: "asc" } }),
        prisma.dealOwnership.findMany({ where: { leadId }, orderBy: { id: "asc" } }),
        prisma.design.findMany({ where: { leadId }, orderBy: { id: "asc" } }),
    ]);
    const childrenBefore = await childSnapshot(l.id);
    const statsBefore = await getContactsAddedStats({ range: resolveRange({ period: "all" }), userId: scout.id });
    const first = await recycleLeadsAs(admin, { items: [{ leadId: l.id, expectedRevision: l.revision }] });
    check("timestamp fixture recycled", !("error" in first) && first.recycled === 1, first);
    const movedDesign = await prisma.design.findUniqueOrThrow({ where: { id: design.id }, include: { tracker: { include: { events: true } }, versions: true } });
    const movedRequest = await prisma.leadRequest.findUniqueOrThrow({ where: { id: request.id } });
    const childrenAfter = await childSnapshot(movedDesign.leadId);
    for (const [i, name] of ["Activity", "LeadRequest", "DealTask", "DealOwnership", "Design"].entries()) {
        const withoutLead = (rows: { leadId: string }[]) => rows.map(({ leadId, ...fields }) => { void leadId; return fields; });
        check(`all ${name} scalar values preserved except leadId`, JSON.stringify(withoutLead(childrenBefore[i])) === JSON.stringify(withoutLead(childrenAfter[i])));
    }
    check("archived Design.updatedAt preserved", +movedDesign.updatedAt === +oldTime, { before: oldTime, after: movedDesign.updatedAt });
    check("archived LeadRequest.updatedAt preserved", +movedRequest.updatedAt === +oldTime, { before: oldTime, after: movedRequest.updatedAt });
    check("nested versions/events retained", movedDesign.versions.length === 1 && movedDesign.tracker?.events.length === 1);
    const archiveBeforeIngest = await prisma.lead.findUniqueOrThrow({ where: { id: movedDesign.leadId } });
    const { POST } = await import("../../app/api/p/route");
    const ingest = await POST(new Request("http://localhost:3100/api/p", { method: "POST", body: JSON.stringify({ p: run, e: "engaged", d: 1234 }) }));
    const archiveAfterIngest = await prisma.lead.findUniqueOrThrow({ where: { id: movedDesign.leadId } });
    const ingestedEvents = await prisma.trackerEvent.count({ where: { trackerId: movedDesign.tracker!.id } });
    check("old tracker accepts events on archived design without revision bump", ingest.status === 204 && ingestedEvents === 2 && archiveBeforeIngest.revision === archiveAfterIngest.revision);
    const statsAfter = await getContactsAddedStats({ range: resolveRange({ period: "all" }), userId: scout.id });
    check("contacts-added total unchanged", statsBefore.total === 1 && statsAfter.total === 1);

    // Druhé kolo so skutočným hovorom, potom tretie; staré kľúče a revert nesmú zmeniť živý kontakt.
    const roundTwo = await prisma.lead.update({ where: { id: l.id }, data: { assignedCallerId: caller.id } });
    const callKey = crypto.randomUUID();
    const callInput = { leadId: l.id, outcome: "NOT_INTERESTED" as const, expectedRevision: roundTwo.revision, idempotencyKey: callKey };
    const call = await logCallAs(caller, callInput);
    check("real round-two first call", !("error" in call), call);
    const activity = await prisma.activity.findFirstOrThrow({ where: { leadId: l.id, idempotencyKey: callKey } });
    const second = await recycleLeadsAs(admin, { items: await revisionItems([l.id]) });
    const archives = await prisma.lead.findMany({ where: { archiveOfId: l.id }, orderBy: { round: "asc" } });
    const live = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    check("two independent archives, round three", !("error" in second) && live.round === 3 && archives.length === 2 && archives[0].round === 1 && archives[1].round === 2);
    const replay = await logCallAs(caller, callInput);
    const reverted = await revertCallResultAs(admin, activity.id, activity.leadRevision!);
    check("old call key cannot write into current round", "error" in replay, replay);
    check("archived call cannot be reverted", "error" in reverted, reverted);
    const history = await getCallHistory(admin, caller.id);
    check("round-two history uses live number, no edit/revert/link", history.some((h) => h.id === activity.id && h.lead.number === l.number && h.lead.archivedRound === 2 && !h.canEdit && !h.canRevert && h.lead.href === null));

    const dealCaller = await makeUser("SALES_REP");
    const interestedLead = await lead({ status: "NEW", assignedCallerId: dealCaller.id });
    const interested = await logCallAs(dealCaller, { leadId: interestedLead.id, outcome: "INTERESTED", asked: ["INFO"], expectedRevision: 0, idempotencyKey: crypto.randomUUID() });
    check("interested-call fixture created", !("error" in interested), interested);
    const liveHistory = await getCallHistory(dealCaller, dealCaller.id);
    check("live deal history keeps working owner link", liveHistory.some((h) => h.lead.href === `/dashboard/pipeline/${interestedLead.id}`));
    await recycleLeadsAs(admin, { items: await revisionItems([interestedLead.id]) });
    const archivedDealHistory = (await getCallHistory(admin, dealCaller.id)).find((h) => h.lead.archivedRound === 1);
    check("archived deal history has no dead detail link", archivedDealHistory !== undefined && archivedDealHistory.lead.href === null, archivedDealHistory?.lead);
    const ownerArchive = (await getCallHistory(dealCaller, dealCaller.id)).find((h) => h.lead.archivedRound === 1);
    check("former owner archive has correct number and no link/edit/revert", ownerArchive?.lead.number === interestedLead.number && ownerArchive.lead.href === null && !ownerArchive.canEdit && !ownerArchive.canRevert);

    // Každý kôš a všetky poradia musia mať rovnaký výber ako zoznam aj počty.
    const queryName = `${run}_filters`;
    for (const bucket of RECYCLE_BUCKETS) {
        const rule = RECYCLE_BUCKET_RULE[bucket];
        const f = await lead({ companyName: queryName, status: rule.status, callbackKind: rule.callbackKind ?? null,
            pipelineEnteredAt: rule.deal ? oldTime : null, assignedCallerId: rule.deal ? null : caller.id, ownerId: rule.deal ? admin.id : null });
        await prisma.activity.create({ data: { leadId: f.id, userId: caller.id, type: "CALL", source: "CALL_QUEUE", category: "BUSINESS", outcome: "NO_ANSWER", createdAt: oldTime } });
    }
    const params = parseRecycleParams({ b: RECYCLE_BUCKETS.join(","), older: "0", q: queryName });
    const list = await getRecycleList(params);
    const counts = await getRecycleCounts(params);
    check("all nine buckets returned and counted once", list.total === 9 && list.rows.length === 9 && RECYCLE_BUCKETS.every((b) => counts[b] === 1), counts);
    for (const sort of RECYCLE_SORTS) {
        const sorted = await getRecycleList({ ...params, sort });
        const picked = await getRecycleFirst({ ...params, sort }, 4);
        check(`first-N/list parity ${sort}`, JSON.stringify(picked.map((p) => p.id)) === JSON.stringify(sorted.rows.slice(0, 4).map((r) => r.id)));
    }
    await prisma.user.update({ where: { id: caller.id }, data: { deletedAt: new Date() } });
    const holders = await getRecycleHolders(params);
    const held = await getRecycleList({ ...params, holder: caller.id });
    check("deactivated holder remains selectable", holders.some((h) => h.id === caller.id && h.deactivated && h.count === 5) && held.total === 5);
    const staleActor = await makeUser("ADMIN");
    await prisma.user.update({ where: { id: staleActor.id }, data: { role: "SCOUT" } });
    const denied = await recycleLeadsAs(staleActor, { items: await revisionItems([list.rows[0].id]) });
    check("DB permission overrides stale ADMIN object", "error" in denied && denied.code === "FORBIDDEN", denied);

    // Zlyhanie po vytvorení archívu a presune Activity musí vrátiť celú transakciu späť.
    const rollbackLead = await lead({ pipelineEnteredAt: oldTime, ownerId: admin.id });
    const rollbackDesign = await prisma.design.create({ data: { leadId: rollbackLead.id } });
    const rollbackActivity = await prisma.activity.create({ data: { leadId: rollbackLead.id, userId: admin.id, type: "CALL", category: "BUSINESS", source: "CALL_QUEUE", outcome: "INTERESTED" } });
    let releaseDesign!: () => void;
    let designLocked!: () => void;
    const designRelease = new Promise<void>((resolve) => { releaseDesign = resolve; });
    const designReady = new Promise<void>((resolve) => { designLocked = resolve; });
    const designBlocker = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Design" WHERE id = ${rollbackDesign.id} FOR UPDATE`;
        designLocked();
        await designRelease;
    }, { timeout: 60_000 });
    let rolledBack;
    try {
        await designReady;
        rolledBack = await recycleLeadsAs(admin, { items: [{ leadId: rollbackLead.id, expectedRevision: 0 }] });
    } finally { releaseDesign(); await designBlocker; }
    const rollbackAfter = await prisma.lead.findUniqueOrThrow({ where: { id: rollbackLead.id } });
    const rollbackChild = await prisma.activity.findUniqueOrThrow({ where: { id: rollbackActivity.id } });
    const rollbackArchives = await prisma.lead.count({ where: { archiveOfId: rollbackLead.id } });
    check("child move timeout rolls back archive, moved history and reset atomically", "error" in rolledBack && rolledBack.code === "RETRYABLE" && rollbackAfter.round === 1 && rollbackAfter.revision === 0 && rollbackChild.leadId === rollbackLead.id && rollbackArchives === 0, rolledBack);

    const duplicateLeads = [await lead(), await lead()];
    const duplicateInput = { items: duplicateLeads.map((l) => ({ leadId: l.id, expectedRevision: 0 })) };
    const duplicates = await Promise.all([recycleLeadsAs(admin, duplicateInput), recycleLeadsAs(admin, duplicateInput)]);
    const duplicateArchives = await prisma.lead.count({ where: { archiveOfId: { in: duplicateLeads.map((l) => l.id) } } });
    check("concurrent identical requests produce two archives total", duplicateArchives === 2 && duplicates.every((r) => !("error" in r) && r.recycled === 2), duplicates);

    // RC-6 pôvodne iba strieda poradie Promise.all; to nezaručuje obe poradia zámku Lead.
    // Podržíme Lead a najprv počkáme na konkrétny DB waiter, až potom spustíme druhú operáciu.
    async function waitForLeadWaiter(kind: "recycle" | "call", blockerPid: number) {
        const end = Date.now() + 4_000;
        while (Date.now() < end) {
            const waiting = await prisma.$queryRaw<{ query: string }[]>`WITH RECURSIVE waiting AS (
                SELECT pid, query FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
                UNION
                SELECT a.pid, a.query FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
            ) SELECT DISTINCT query FROM waiting WHERE query LIKE '%FROM "Lead"%' AND query LIKE '%FOR UPDATE%'`;
            if (waiting.some((w) => kind === "recycle" ? w.query.includes("ANY(") : !w.query.includes("ANY("))) return;
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        throw new Error(`No ${kind} Lead waiter observed`);
    }
    const raceCaller = await makeUser("TELESALES");
    for (const order of ["recycle", "call"] as const) {
        const contested = await lead({ status: "CALLING", callbackKind: "RETRY", assignedCallerId: raceCaller.id });
        let releaseLead!: () => void;
        let heldLead!: () => void;
        const leadRelease = new Promise<void>((resolve) => { releaseLead = resolve; });
        const leadReady = new Promise<void>((resolve) => { heldLead = resolve; });
        let blockerPid = 0;
        const lock = prisma.$transaction(async (tx) => {
            blockerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
            await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${contested.id} FOR UPDATE`;
            heldLead();
            await leadRelease;
        }, { timeout: 30_000 });
        const rec = () => recycleLeadsAs(admin, { items: [{ leadId: contested.id, expectedRevision: 0 }] });
        const call = () => logCallAs(raceCaller, { leadId: contested.id, outcome: "NO_ANSWER", expectedRevision: 0, idempotencyKey: crypto.randomUUID() });
        let result;
        try {
            await leadReady;
            const first = order === "recycle" ? rec() : call();
            await waitForLeadWaiter(order, blockerPid);
            const second = order === "recycle" ? call() : rec();
            await waitForLeadWaiter(order === "recycle" ? "call" : "recycle", blockerPid);
            releaseLead();
            const [a, b] = await Promise.all([first, second]);
            result = order === "recycle" ? { r: a, c: b } : { r: b, c: a };
        } finally { releaseLead(); await lock; }
        const wonRecycle = "recycled" in result.r && result.r.recycled === 1;
        const wonCall = "success" in result.c;
        const state = await prisma.lead.findUniqueOrThrow({ where: { id: contested.id } });
        check(`forced ${order}-first race has exactly the expected winner`, order === "recycle"
            ? wonRecycle && !wonCall && state.round === 2 && state.status === "NEW"
            : !wonRecycle && wonCall && state.round === 1 && state.status === "CALLING", result);
    }

    // Dávka 100 + zamknutý 101. riadok: prvá transakcia môže commitnúť, retry nesmie duplikovať archívy.
    const bulkIds = Array.from({ length: 101 }, (_, i) => `${run}_bulk_${String(i).padStart(3, "0")}`);
    ids.push(...bulkIds);
    await prisma.lead.createMany({ data: bulkIds.map((id) => ({ id, companyName: run, status: "LOST" as const })) });
    const bulkItems = bulkIds.map((leadId) => ({ leadId, expectedRevision: 0 }));
    let unlock!: () => void;
    let locked!: () => void;
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const blocker = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${bulkIds[100]} FOR UPDATE`;
        locked();
        await release;
    }, { timeout: 180_000 });
    const started = Date.now();
    let partial;
    try {
        await ready;
        partial = await recycleLeadsAs(admin, { items: bulkItems });
    } finally { unlock(); await blocker; }
    const committed = await prisma.lead.count({ where: { archiveOfId: { in: bulkIds } } });
    check("later chunk timeout reports RETRYABLE with first 100 committed", "error" in partial && partial.code === "RETRYABLE" && committed === 100,
        { result: partial, committed, durationMs: Date.now() - started });
    const retryStart = Date.now();
    const retry = await recycleLeadsAs(admin, { items: bulkItems });
    const count = await prisma.lead.count({ where: { archiveOfId: { in: bulkIds } } });
    check("retry after partial commit creates exactly one archive per lead", !("error" in retry) && retry.recycled === 101 && count === 101,
        { retry, archives: count, durationMs: Date.now() - retryStart });

    if (process.argv.includes("--bulk-500")) {
        const capacityIds = Array.from({ length: 500 }, (_, i) => `${run}_capacity_${String(i).padStart(3, "0")}`);
        ids.push(...capacityIds);
        await prisma.lead.createMany({ data: capacityIds.map((id) => ({ id, companyName: run, status: "CALLING" as const, callbackKind: "RETRY" as const, assignedCallerId: raceCaller.id })) });
        await prisma.activity.createMany({ data: capacityIds.map((leadId) => ({ leadId, userId: raceCaller.id, type: "CALL" as const, source: "CALL_QUEUE" as const, category: "BUSINESS" as const, outcome: "NO_ANSWER" as const })) });
        const capacityItems = capacityIds.map((leadId) => ({ leadId, expectedRevision: 0 }));
        const tooMany = await recycleLeadsAs(admin, { items: [...capacityItems, { leadId: `${run}_extra`, expectedRevision: 0 }] });
        check("501 items rejected before writing", "error" in tooMany && await prisma.lead.count({ where: { archiveOfId: { in: capacityIds } } }) === 0, tooMany);
        const capacityStart = Date.now();
        const capacityResult = await recycleLeadsAs(admin, { items: capacityItems });
        const capacityArchives = await prisma.lead.count({ where: { archiveOfId: { in: capacityIds } } });
        const capacityLive = await prisma.lead.count({ where: { id: { in: capacityIds }, status: "NEW", round: 2, revision: 1, activities: { none: {} } } });
        check("500 retries across all five chunks recycle completely", !("error" in capacityResult) && capacityResult.recycled === 500 && capacityArchives === 500 && capacityLive === 500,
            { result: capacityResult, archives: capacityArchives, fresh: capacityLive, durationMs: Date.now() - capacityStart });
    }
}

main().catch((error) => { failures++; console.error(error); }).finally(async () => {
    try {
        const all = await prisma.lead.findMany({ where: { OR: [{ id: { in: ids } }, { archiveOfId: { in: ids } }] }, select: { id: true, archiveOfId: true } });
        const allIds = all.map((l) => l.id);
        await prisma.leadRequest.deleteMany({ where: { leadId: { in: allIds } } });
        await prisma.activity.deleteMany({ where: { leadId: { in: allIds } } });
        await prisma.dealTask.deleteMany({ where: { leadId: { in: allIds } } });
        await prisma.dealOwnership.deleteMany({ where: { leadId: { in: allIds } } });
        await prisma.lead.deleteMany({ where: { id: { in: all.filter((l) => l.archiveOfId).map((l) => l.id) } } });
        await prisma.lead.deleteMany({ where: { id: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
        console.log(`cleanup complete; failures=${failures}`);
    } finally { await prisma.$disconnect(); process.exitCode = failures ? 1 : 0; }
});
