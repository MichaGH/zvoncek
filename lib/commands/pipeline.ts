import { businessDate, isValidBusinessDate } from "@/lib/domain/businessTime";
import { z } from "zod";
import type { LeadStatus, ProjectType } from "@/app/generated/prisma/enums";
import { AccessError, FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealManage } from "@/lib/access/leads";
import { lockUsers, withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import type { Lead } from "@/app/generated/prisma/client";
import * as deal from "@/lib/domain/dealMutations";
import { withdrawInputSchema } from "@/lib/domain/clientRequests";
import { runKeyed } from "@/lib/domain/idempotency";
import { canonical } from "@/lib/domain/tasks";
import { ownerTransition } from "@/lib/domain/taskMutations";
import { can } from "@/lib/permissions";
import prisma from "@/lib/db";

// Manažérske mutácie obchodu (pipeline). Guard: requireDealManage (deals.manage + značka obchodu, akýkoľvek stav).
// Telá sú v lib/domain/dealMutations.ts, zdieľané s client akciami. Wave 3 (§5.5): stav, „Stratené", znovuotvorenie
// a vlastník nesú expectedRevision + kľúč (dvojklik vráti prvý úspech); otvorenú úlohu ruší len výslovné cancelTask.

export type Ok = { success: true };
export type CommandResult = Ok | ActionError;

async function managed(
    user: AccessUser,
    leadId: string,
    label: string,
    fn: (tx: Tx, lead: Lead, actor: { id: string; firstName: string }) => Promise<void>,
    opts: { expectedRevision?: number; lockUserIds?: string[] } = {},
): Promise<CommandResult> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealManage(tx, user, leadId, opts);
            await fn(tx, lead, actor);
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa uložiť.", label);
    }
}

export const updateLeadAs = (user: AccessUser, leadId: string, data: deal.DealContactInput) =>
    managed(user, leadId, "updateLead", (tx, lead, actor) => deal.updateDealContact(tx, actor, lead, data, "PIPELINE"));

// D5: cenové okienko smie pripojiť krátky dôvod („pridali sme EN jazyk") – nepovinne, preklep formulár nepotrebuje.
export const saveQuoteAs = (user: AccessUser, leadId: string, input: { price: number | null; priceNote: string | null; reason?: string | null }) =>
    managed(user, leadId, "saveQuote", (tx, lead, actor) =>
        deal.saveQuote(tx, actor, lead, { price: input.price, priceNote: input.priceNote }, "PIPELINE", { via: "EDIT", reason: input.reason }),
    );

export const setProjectTypeAs = (user: AccessUser, leadId: string, projectType: ProjectType | null) =>
    managed(user, leadId, "setProjectType", (tx, lead, actor) => deal.setProjectType(tx, actor, lead, projectType));

export const setNextActionAs = (user: AccessUser, leadId: string, input: deal.NextActionInput, expectedRevision: number) =>
    managed(user, leadId, "setNextAction", (tx, lead, actor) => deal.setNextAction(tx, actor, lead, input, "PIPELINE"), {
        expectedRevision,
    });

export const addBusinessNoteAs = (user: AccessUser, leadId: string, note: string) =>
    managed(user, leadId, "addBusinessNote", (tx, lead, actor) => deal.addBusinessNote(tx, actor, lead, { note }, "PIPELINE"));

const keyed = {
    expectedRevision: z.number().int().min(0),
    idempotencyKey: z.string().min(8).max(100),
};
const trim = (v: string | null | undefined) => v?.trim() || null;
const withdrawFp = (w: { ids: string[]; reason: string } | null | undefined) =>
    w ? { ids: [...new Set(w.ids)].sort(), reason: trim(w.reason) } : undefined;
const cancelFp = (c: deal.CancelTaskInput | null | undefined) => (c ? { taskId: c.taskId, reason: trim(c.reason) } : null);

// ── Stav, „Stratené", znovuotvorenie ────────────────────────────────────────

const statusSchema = z
    .object({
        status: z.enum(deal.DEAL_STATUSES),
        ...keyed,
        cancelTask: deal.cancelTaskSchema.nullish(),
        withdraw: withdrawInputSchema.nullish(),
        // Uspatie s otvorenou úlohou: kedy sa obchod zobudí (obchodný deň, YYYY-MM-DD). Bez neho by zrušená úloha
        // odomkla krok „dnes" a spiaci obchod by bol hneď „zobudený" (R01-5).
        snoozeUntil: z.string().nullish(),
    })
    .strict();
export type ChangeStatusInput = z.input<typeof statusSchema>;

export async function changeStatusAs(user: AccessUser, leadId: string, raw: ChangeStatusInput): Promise<CommandResult> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    const parsed = statusSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatný stav obchodu." };
    const input = parsed.data;
    const snoozeUntil = trim(input.snoozeUntil);
    if (snoozeUntil && (input.status !== "SNOOZED" || !isValidBusinessDate(snoozeUntil) || snoozeUntil <= businessDate(new Date()))) {
        return { error: "Neplatný dátum zobudenia." };
    }
    const fp = canonical({
        status: input.status,
        cancelTask: cancelFp(input.cancelTask),
        withdraw: withdrawFp(input.withdraw),
        ...(snoozeUntil ? { snoozeUntil } : {}),
    });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId, types: ["STATUS_CHANGED", "DEAL_REOPENED"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor, people } = await manageWithOwner(tx, user, leadId, input.expectedRevision);
                await deal.changeDealStatus(tx, actor, lead, input.status, "PIPELINE", {
                    cancelTask: input.cancelTask,
                    primary: { key: input.idempotencyKey, fp },
                    people,
                    withdraw: input.withdraw,
                    snoozeUntil,
                });
            }),
        (error) => toActionError(error, "Nepodarilo sa uložiť.", "changeStatus"),
    );
}

const lostSchema = z
    .object({ reason: z.string().max(500).nullish(), ...keyed, cancelTask: deal.cancelTaskSchema.nullish(), withdraw: withdrawInputSchema.nullish() })
    .strict();
export type MarkLostInput = z.input<typeof lostSchema>;

export async function markLostAs(user: AccessUser, leadId: string, raw: MarkLostInput): Promise<CommandResult> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    const parsed = lostSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const fp = canonical({ status: "LOST", reason: trim(input.reason), cancelTask: cancelFp(input.cancelTask), withdraw: withdrawFp(input.withdraw) });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId, types: ["STATUS_CHANGED"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor } = await requireDealManage(tx, user, leadId, { expectedRevision: input.expectedRevision });
                await deal.markLost(tx, actor, lead, trim(input.reason), "PIPELINE", {
                    cancelTask: input.cancelTask,
                    primary: { key: input.idempotencyKey, fp },
                    withdraw: input.withdraw,
                });
            }),
        (error) => toActionError(error, "Nepodarilo sa uložiť.", "markLost"),
    );
}

// Manažérsky zámok aj s doterajším vlastníkom (User pred Lead) – znovuotvorenie overuje, či ešte môže viesť obchod
// (R01-3); súbežná deaktivácia počká a potom uvidí otvorený obchod.
async function manageWithOwner(tx: Tx, user: AccessUser, leadId: string, expectedRevision: number) {
    const pre = await tx.lead.findUnique({ where: { id: leadId }, select: { ownerId: true } });
    const { lead, actor, users } = await requireDealManage(tx, user, leadId, {
        expectedRevision,
        lockUserIds: pre?.ownerId ? [pre.ownerId] : [],
    });
    if (lead.ownerId !== (pre?.ownerId ?? null)) throw new AccessError("STALE", "Obchod sa medzitým zmenil – obnovujem.");
    const people: deal.ReopenPeople = { owner: lead.ownerId ? (users.get(lead.ownerId) ?? null) : null, me: actor };
    return { lead, actor, people };
}

const reopenSchema = z.object({ ...keyed }).strict();
export type ReopenInput = z.input<typeof reopenSchema>;

export async function reopenDealAs(user: AccessUser, leadId: string, raw: ReopenInput): Promise<CommandResult> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    const parsed = reopenSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    // Znovuotvorenie má jeden pevný krok (Zavolať dnes); výber kroku v UI zatiaľ nie je.
    const fp = canonical({ step: { kind: "CALL", note: deal.REOPEN_STEP_NOTE } });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId, types: ["DEAL_REOPENED"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor, people } = await manageWithOwner(tx, user, leadId, input.expectedRevision);
                await deal.reopenDeal(tx, actor, lead, "PIPELINE", { key: input.idempotencyKey, fp }, people);
            }),
        (error) => toActionError(error, "Nepodarilo sa uložiť.", "reopenDeal"),
    );
}

// ── Vlastník (§6.10) ────────────────────────────────────────────────────────

const ownerSchema = z
    .object({
        ownerId: z.string().min(1).nullable(),
        ...keyed,
        // Nový vlastník je obchodník a obchod má otvorenú úlohu: „Úlohy pôjdu: [manažér]" (null = ostáva doterajší).
        taskAssigneeId: z.string().min(1).nullish(),
    })
    .strict();
export type ChangeOwnerInput = z.input<typeof ownerSchema>;

export async function changeOwnerAs(user: AccessUser, leadId: string, raw: ChangeOwnerInput): Promise<CommandResult> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    const parsed = ownerSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const pre = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { ownerId: true, tasks: { where: { status: "OPEN" }, select: { assigneeId: true } } },
    });
    if (!pre) return { error: "Nenašlo sa.", code: "NOT_FOUND" };
    const fp = canonical({ ownerId: input.ownerId, taskAssigneeId: input.taskAssigneeId ?? null });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId, types: ["OWNER_CHANGED"], fp },
        () =>
            withLockTx(async (tx) => {
                // Zámky (§5.5): aktér, starý a nový vlastník, manažér úlohy, nový manažér úlohy – FOR SHARE, potom Lead.
                // Zmena medzi predčítaním a zámkom zmení revíziu → STALE.
                const { lead, actor, users } = await requireDealManage(tx, user, leadId, {
                    expectedRevision: input.expectedRevision,
                    lockUserIds: [pre.ownerId, input.ownerId, input.taskAssigneeId, ...pre.tasks.map((t) => t.assigneeId)].filter(
                        (id): id is string => Boolean(id),
                    ),
                });
                const target = input.ownerId ? users.get(input.ownerId) : null;
                if (input.ownerId && !target) throw new AccessError("FORBIDDEN", "Tento používateľ nemôže vlastniť obchody.");
                await ownerTransition(tx, actor, lead, target ?? null, {
                    kind: "CHANGE",
                    source: "PIPELINE",
                    taskAssignee: input.taskAssigneeId ? (users.get(input.taskAssigneeId) ?? null) : null,
                    primary: { key: input.idempotencyKey, fp },
                });
            }),
        (error) => toActionError(error, "Nepodarilo sa uložiť.", "changeOwner"),
    );
}

// ── Hromadný presun obchodov (§5.5, §6.10) ──────────────────────────────────

const BULK_BATCH = 200;

const transferSchema = z
    .object({
        operationId: z.string().min(8).max(100), // jeden na odoslanie; opakovanie s tým istým id pokračuje
        fromOwnerId: z.string().min(1).nullable(), // null = nepriradené
        handedOffById: z.string().min(1).nullish(),
        statuses: z.array(z.enum(deal.DEAL_STATUSES)).max(deal.DEAL_STATUSES.length).optional(),
        toOwnerId: z.string().min(1),
        taskAssigneeId: z.string().min(1).nullish(), // otvorené úlohy u nového obchodníka pôjdu tomuto manažérovi
        limit: z.number().int().min(1).optional(),
    })
    .strict();
export type TransferDealsInput = z.input<typeof transferSchema>;

type BulkMark = { bulkOpId: string; bulkFp: string };

// Po dávkach po 200 (každá dávka = transakcia), každý obchod atomicky: vlastník + úloha + OWNER_CHANGED + DealOwnership +
// jedna revízia. Opakovanie s tým istým operationId (a tým istým bulkFp) pokračuje a vráti celkový počet (W3-R2-11).
export async function transferDealsAs(
    user: AccessUser,
    raw: TransferDealsInput,
): Promise<{ moved: number; skipped: number } | ActionError> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    const parsed = transferSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const statuses = [...new Set(input.statuses?.length ? input.statuses : (["ACTIVE", "SNOOZED"] as const))].sort();
    if (input.fromOwnerId === input.toOwnerId) return { error: "Zdroj a cieľ sú rovnakí." };
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    const bulkFp = canonical({
        from: input.fromOwnerId,
        to: input.toOwnerId,
        statuses,
        handedOffBy: input.handedOffById ?? null,
        taskAssignee: input.taskAssigneeId ?? null,
        limit: input.limit ?? null,
    });
    const mark: BulkMark = { bulkOpId: input.operationId, bulkFp };

    // Opakovanie: tá istá operácia s iným obsahom = konflikt, nie pokračovanie.
    const earlier = await prisma.activity.findMany({
        where: { type: "OWNER_CHANGED", meta: { path: ["bulkOpId"], equals: input.operationId } },
        select: { meta: true, userId: true },
    });
    if (earlier.some((e) => (e.meta as BulkMark | null)?.bulkFp !== bulkFp || e.userId !== user.id)) {
        return { error: "Tento presun sa medzitým zmenil – obnovujem.", code: "IDEMPOTENCY_CONFLICT" };
    }
    const alreadyMoved = earlier.length;

    let moved = 0;
    let skipped = 0;
    let cursor = "";
    try {
        while (alreadyMoved + moved < limit) {
            const batch = Math.min(BULK_BATCH, limit - alreadyMoved - moved);
            const result = await transferBatch(user, input, statuses, mark, cursor, batch);
            moved += result.moved;
            skipped += result.skipped;
            cursor = result.cursor;
            if (result.seen < batch) break;
        }
    } catch (error) {
        const e = toActionError(error, "Presun sa nepodaril.", "transferDeals");
        const total = alreadyMoved + moved;
        return { ...e, error: total ? `${e.error} (presunuté už: ${total})` : e.error };
    }
    return { moved: alreadyMoved + moved, skipped };
}

async function transferBatch(
    user: AccessUser,
    input: z.infer<typeof transferSchema>,
    statuses: readonly string[],
    mark: BulkMark,
    cursor: string,
    batch: number,
): Promise<{ moved: number; skipped: number; seen: number; cursor: string }> {
    // 1. Predčítanie bez zámku: kandidáti (poradie id od kurzora), ich vlastníci a manažéri otvorených úloh.
    const candidates = await prisma.lead.findMany({
        where: {
            pipelineEnteredAt: { not: null },
            deletedAt: null,
            ownerId: input.fromOwnerId,
            status: { in: statuses as LeadStatus[] },
            ...(input.handedOffById ? { handedOffById: input.handedOffById } : {}),
            id: { gt: cursor },
        },
        orderBy: { id: "asc" },
        take: batch,
        select: { id: true, ownerId: true, tasks: { where: { status: "OPEN" }, select: { id: true, assigneeId: true } } },
    });
    if (candidates.length === 0) return { moved: 0, skipped: 0, seen: 0, cursor };
    const nextCursor = candidates[candidates.length - 1].id;
    const seenTask = new Map(candidates.map((c) => [c.id, c.tasks[0] ?? null]));

    return withLockTx(
        async (tx) => {
            // 2. Celá množina používateľov zoradená (FOR SHARE), potom 3. obchody zoradené (FOR UPDATE SKIP LOCKED).
            const userIds = [
                user.id,
                input.toOwnerId,
                input.fromOwnerId,
                input.taskAssigneeId,
                ...candidates.flatMap((c) => c.tasks.map((t) => t.assigneeId)),
            ];
            const users = await lockUsers(tx, userIds, "SHARE");
            const actor = users.get(user.id);
            if (!actor || actor.deletedAt || !can(actor, "deals.manage")) throw new AccessError("FORBIDDEN");
            const target = users.get(input.toOwnerId);
            if (!target || target.deletedAt || !can(target, "deals.receive")) {
                throw new AccessError("FORBIDDEN", "Cieľ nemôže vlastniť obchody.");
            }
            const taskAssignee = input.taskAssigneeId ? (users.get(input.taskAssigneeId) ?? null) : null;
            const locked = await tx.$queryRaw<{ id: string }[]>`
                SELECT id FROM "Lead" WHERE id = ANY(${candidates.map((c) => c.id)}) ORDER BY id FOR UPDATE SKIP LOCKED`;
            let moved = 0;
            let skipped = candidates.length - locked.length;
            // 4. Znova pod zámkom: vlastník aj úloha musia byť tie z predčítania, inak sa obchod preskočí.
            const lockedIds = locked.map((l) => l.id);
            const leads = await tx.lead.findMany({ where: { id: { in: lockedIds } } });
            const openTasks = await tx.dealTask.findMany({
                where: { leadId: { in: lockedIds }, status: "OPEN" },
                select: { id: true, leadId: true, assigneeId: true },
            });
            for (const id of lockedIds) {
                const lead = leads.find((l) => l.id === id);
                if (!lead) {
                    skipped++;
                    continue;
                }
                const open = openTasks.find((t) => t.leadId === id) ?? null;
                const before = seenTask.get(id) ?? null;
                const same =
                    lead.ownerId === input.fromOwnerId &&
                    lead.deletedAt === null &&
                    lead.pipelineEnteredAt !== null &&
                    statuses.includes(lead.status) &&
                    (open?.id ?? null) === (before?.id ?? null) &&
                    (open?.assigneeId ?? null) === (before?.assigneeId ?? null);
                if (!same) {
                    skipped++;
                    continue;
                }
                const r = await ownerTransition(tx, actor, lead, target, {
                    kind: "BULK",
                    source: "PIPELINE",
                    taskAssignee,
                    bulk: { opId: mark.bulkOpId, fp: mark.bulkFp },
                });
                if (r.changed) moved++;
            }
            return { moved, skipped, seen: candidates.length, cursor: nextCursor };
        },
        { timeout: 60_000 },
    );
}
