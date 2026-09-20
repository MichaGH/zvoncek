import type { DealTask, Lead, PrismaClient } from "@/app/generated/prisma/client";
import type { ActivitySource, DealOwnershipReason, DealTaskContent, DealTaskType, NextActionKind } from "@/app/generated/prisma/enums";
import { AccessError } from "@/lib/access/errors";
import type { LockedUser, Tx } from "@/lib/access/locks";
import { createAuditActivity, createPlanningActivity, describeNextAction, type NextActionData } from "@/lib/activityLog";
import { businessTodayStart } from "@/lib/domain/businessTime";
import { hadNextAction, updateLead } from "@/lib/domain/leadWrites";
import { moneyToString, type OfferContent } from "@/lib/domain/offers";
import { bumpLeadOnce } from "@/lib/domain/revision";
import {
    ACKNOWLEDGED_TEXT,
    dismissedItemsOfMeta,
    dismissNeedsReason,
    fulfilsOfMeta,
    itemKey,
    pendingItems,
    requiredStepKinds,
    type DismissInput,
    type ItemRef,
    type PendingItem,
    type TaskResult,
} from "@/lib/domain/tasks";
import { NEXT_ACTION_LABEL, TASK_CONTENT_LABEL } from "@/lib/dictionaries";
import { can } from "@/lib/permissions";

// Zápisy úloh pre manažéra (wave 3 – context/features/01-salesrep/wave-3-task-proposal-final.md §5–§6).
// Volajú ich príkazy pod zámkom Lead riadku (lib/commands/tasks.ts, dealWork.ts, pipeline.ts, offers.ts); revízia sa
// zvýši raz (updateLead / bumpLeadOnce). Každá udalosť úlohy = jeden Activity riadok s taskId; kľúč (idempotencyKey)
// má len hlavný riadok príkazu, vedľajšie riadky v tej istej transakcii ho nemajú.

type Actor = { id: string; firstName: string };
type Db = Pick<PrismaClient, "dealTask" | "activity"> | Tx;

const person = (u: { firstName: string; lastName?: string }) => `${u.firstName} ${u.lastName ?? ""}`.trim();

// ── Zámok (§5.1) ─────────────────────────────────────────────────────────────

export async function openTaskOf(tx: Db, leadId: string): Promise<DealTask | null> {
    return tx.dealTask.findFirst({ where: { leadId, status: "OPEN" }, orderBy: { createdAt: "asc" } });
}

// Každý zápis Lead.nextAction* / Lead.status mimo príkazov úloh a výslovných foriem (zrušiť + zmeniť, prekryv)
// ide cez túto kontrolu pod zámkom Lead riadku.
export async function assertStepUnlocked(tx: Tx, leadId: string): Promise<void> {
    if (await openTaskOf(tx, leadId)) throw new AccessError("STEP_LOCKED");
}

// Otvorená úloha, ktorú formulár výslovne ruší (cancelTask) – musí to byť presne tá otvorená úloha obchodu.
export async function requireOpenTask(tx: Tx, leadId: string, taskId: string): Promise<DealTask> {
    const open = await openTaskOf(tx, leadId);
    if (!open || open.id !== taskId) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
    return open;
}

// Krok bez dátumu, kým je zamknutý (I8); pri odomknutí (vybavené / zamietnuté / zrušené bez nového kroku) je splatný dnes.
export async function unlockStep(tx: Tx, lead: Pick<Lead, "id" | "nextActionKind">, now = new Date()): Promise<void> {
    await updateLead(tx, lead.id, lead.nextActionKind ? { nextActionAt: businessTodayStart(now), nextActionHasTime: false } : {});
}

// ── Vrátené položky (§6.13) ─────────────────────────────────────────────────

export async function pendingByLead(db: Db, leadIds: string[]): Promise<Map<string, PendingItem[]>> {
    const out = new Map<string, PendingItem[]>();
    if (leadIds.length === 0) return out;
    // [WAVE 4] Čiastočné vybavenie (wave-4-proposal.md §2.4): položky vráti aj OTVORENÁ úloha s čiastočným výsledkom
    // (cena hotová, návrh ešte nie) – tento filter a returnedItems v lib/domain/tasks.ts sa rozšíria spolu.
    const tasks = await db.dealTask.findMany({
        where: { leadId: { in: leadIds }, status: { in: ["DONE", "DECLINED"] } },
        select: {
            id: true,
            leadId: true,
            type: true,
            status: true,
            result: true,
            closeReason: true,
            closedAt: true,
            closedBy: { select: { id: true, firstName: true } },
        },
    });
    if (tasks.length === 0) return out;
    const withTasks = [...new Set(tasks.map((t) => t.leadId))];
    const rows = await db.activity.findMany({
        where: {
            leadId: { in: withTasks },
            OR: [
                { type: "OFFER_SENT", revertedAt: null },
                { type: "TASK_RESULT_DISMISSED", taskId: { not: null } },
            ],
        },
        select: { leadId: true, type: true, taskId: true, meta: true },
    });
    for (const leadId of withTasks) {
        const own = rows.filter((r) => r.leadId === leadId);
        out.set(
            leadId,
            pendingItems(
                tasks.filter((t) => t.leadId === leadId),
                {
                    fulfils: own.filter((r) => r.type === "OFFER_SENT").flatMap((r) => fulfilsOfMeta(r.meta)),
                    dismissed: own.filter((r) => r.type === "TASK_RESULT_DISMISSED").flatMap((r) => dismissedItemsOfMeta(r.taskId, r.meta)),
                },
            ),
        );
    }
    return out;
}

export async function loadPending(db: Db, leadId: string): Promise<PendingItem[]> {
    return (await pendingByLead(db, [leadId])).get(leadId) ?? [];
}

// I10: kým čaká vrátená cena / návrh, krok ostáva „Poslať …". `cleared` = položky, ktoré spotrebuje to isté uloženie.
export async function assertStepAllowed(tx: Tx, leadId: string, kind: NextActionKind | null, cleared: readonly ItemRef[] = []) {
    const done = new Set(cleared.map(itemKey));
    const pending = (await loadPending(tx, leadId)).filter((i) => !done.has(itemKey(i)));
    const required = requiredStepKinds(pending);
    if (required && (!kind || !required.includes(kind))) {
        const what = pending.filter((i) => i.kind === "PRICE" || i.kind === "DESIGN").map((i) => i.label).join(", ");
        throw new AccessError(
            "RESULT_PENDING",
            `Ešte neposlané: ${what}. Krok ostáva „${required.map((k) => NEXT_ACTION_LABEL[k]).join("“ / „")}“, kým to nepošleš alebo neodmietneš („Neposielam“).`,
        );
    }
}

function itemLabel(i: PendingItem): string {
    return i.kind === "DECLINED" ? "zamietnutie" : i.label;
}

// Kto rozhoduje o vrátených výsledkoch („Neposielam" / „Beriem na vedomie" / staršia cena nahradená): vlastník; na
// obchode bez vlastníka manažér (§5.2). Volá sa pred KAŽDÝM odmietnutím z používateľského vstupu – samostatným
// (dismissResultsAs) aj vloženým do odoslania (recordOfferSentAs) či kontaktu (logFollowUpAs), R01-1. Systémové
// odmietnutie pri uzavretí obchodu (dismissAllPending) sem nepatrí.
export function assertDecidesResults(lead: Pick<Lead, "ownerId">, actor: Pick<LockedUser, "id" | "role">): void {
    const allowed = lead.ownerId === actor.id || (lead.ownerId === null && can(actor, "deals.manage"));
    if (!allowed) throw new AccessError("FORBIDDEN", "O vrátenom výsledku rozhoduje vlastník obchodu.");
}

// „Neposielam" / „Beriem na vedomie": jeden TASK_RESULT_DISMISSED riadok na úlohu, s presne menovanými položkami.
export async function dismissItems(
    tx: Tx,
    actor: Actor,
    leadId: string,
    input: DismissInput,
    source: ActivitySource,
    opts: { key?: string; fp?: string; pending?: PendingItem[] } = {},
): Promise<ItemRef[]> {
    const pending = opts.pending ?? (await loadPending(tx, leadId));
    const byKey = new Map(pending.map((i) => [itemKey(i), i]));
    const refs: ItemRef[] = input.items.map((i) => ({ taskId: i.taskId, kind: i.kind, ...(i.designId ? { designId: i.designId } : {}) }));
    if (new Set(refs.map(itemKey)).size !== refs.length) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    for (const r of refs) {
        if (!byKey.has(itemKey(r))) throw new AccessError("STALE", "Výsledok už bol vybavený – obnovujem.");
    }
    const reason = input.reason?.trim() || null;
    if (dismissNeedsReason(refs) && !reason) throw new AccessError("FORBIDDEN", "Napíš, prečo sa to neposiela.");
    const tasks = [...new Set(refs.map((r) => r.taskId))];
    if (opts.key && tasks.length !== 1) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    for (const taskId of tasks) {
        const items = refs.filter((r) => r.taskId === taskId);
        const labels = items.map((r) => itemLabel(byKey.get(itemKey(r))!)).join(", ");
        const neposielam = dismissNeedsReason(items);
        await tx.activity.create({
            data: {
                leadId,
                userId: actor.id,
                type: "TASK_RESULT_DISMISSED",
                category: "BUSINESS",
                source,
                taskId,
                note: neposielam ? `Neposielam: ${labels}${reason ? ` – ${reason}` : ""}` : `${ACKNOWLEDGED_TEXT}: ${labels}${reason ? ` – ${reason}` : ""}`,
                meta: {
                    items: items.map((r) => ({ kind: r.kind, ...(r.designId ? { designId: r.designId } : {}) })),
                    reason: reason ?? (neposielam ? null : ACKNOWLEDGED_TEXT),
                    ...(opts.fp ? { fp: opts.fp } : {}),
                },
                ...(opts.key ? { idempotencyKey: opts.key } : {}),
            },
        });
    }
    await bumpLeadOnce(tx, leadId);
    return refs;
}

// Uzavretie obchodu: všetko, čo ešte čaká, sa odmietne s pevným dôvodom (W3-R3-04); znovuotvorenie to neoživí.
export async function dismissAllPending(tx: Tx, actor: Actor, leadId: string, reason: string, source: ActivitySource) {
    const pending = await loadPending(tx, leadId);
    if (pending.length === 0) return;
    await dismissItems(
        tx,
        actor,
        leadId,
        { items: pending.map((i) => ({ taskId: i.taskId, kind: i.kind, ...(i.designId ? { designId: i.designId } : {}) })), reason },
        source,
        { pending },
    );
}

// ── Uzavretie úlohy ──────────────────────────────────────────────────────────

async function closeTask(
    tx: Tx,
    task: DealTask,
    data: { status: "DONE" | "DECLINED" | "CANCELLED"; closedById: string; closeReason?: string | null; result?: TaskResult },
) {
    // Podmienený zápis: úloha musí byť ešte OPEN (obrana do hĺbky – všetko beží pod zámkom Lead riadku).
    const n = await tx.dealTask.updateMany({
        where: { id: task.id, status: "OPEN" },
        data: {
            status: data.status,
            closedAt: new Date(),
            closedById: data.closedById,
            closeReason: data.closeReason ?? null,
            ...(data.result ? { result: data.result } : {}),
        },
    });
    if (n.count !== 1) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
}

// Zrušenie otvorenej úlohy (vlastník, uzavretie obchodu, zmena vlastníka) – vedľajší riadok bez kľúča.
export async function cancelOpenTask(tx: Tx, actor: Actor, task: DealTask, reason: string, source: ActivitySource) {
    await closeTask(tx, task, { status: "CANCELLED", closedById: actor.id, closeReason: reason });
    await tx.activity.create({
        data: { leadId: task.leadId, userId: actor.id, type: "TASK_CANCELLED", category: "BUSINESS", source, taskId: task.id, note: `Úloha zrušená: ${reason}` },
    });
    await bumpLeadOnce(tx, task.leadId);
}

// ── Vznik úlohy (§6.1, §6.8) ────────────────────────────────────────────────

export type CreateTaskInput = {
    type: DealTaskType;
    contents: DealTaskContent[];
    text: string;
    assignee: LockedUser;
    step: { kind: NextActionKind | null; note: string | null }; // HANDOVER: aktuálny krok obchodu
};

export function contentsText(type: DealTaskType, contents: readonly DealTaskContent[]): string {
    return type === "HANDOVER" ? "Odovzdať manažérovi" : contents.map((c) => TASK_CONTENT_LABEL[c]).join(" + ");
}

export async function createTask(
    tx: Tx,
    actor: Actor,
    lead: Lead,
    input: CreateTaskInput,
    source: ActivitySource,
    primary: { key: string; fp: string },
): Promise<DealTask> {
    // Zamknutý krok: zvolený druh + poznámka, bez dátumu (I8). Spiaci obchod sa v tej istej transakcii zobudí (§5.3).
    const next: NextActionData = {
        nextActionKind: input.step.kind,
        nextActionAt: null,
        nextActionHasTime: false,
        nextActionMode: "SCHEDULED",
        nextActionNote: input.step.note?.trim() || null,
    };
    const wakes = lead.status === "SNOOZED";
    await updateLead(tx, lead.id, { ...next, ...(wakes ? { status: "ACTIVE" } : {}) });
    const stepChanged =
        lead.nextActionKind !== next.nextActionKind ||
        lead.nextActionAt !== null ||
        (lead.nextActionNote ?? null) !== next.nextActionNote ||
        lead.nextActionMode !== "SCHEDULED";
    if (stepChanged) {
        await tx.activity.create({
            data: createPlanningActivity({
                leadId: lead.id,
                userId: actor.id,
                type: !next.nextActionKind ? "NEXT_ACTION_CLEARED" : hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                source,
                note: `${describeNextAction(next)} · 🔒 čaká na úlohu`,
            }),
        });
    }
    if (wakes) {
        await tx.activity.create({
            data: createAuditActivity({ leadId: lead.id, userId: actor.id, type: "STATUS_CHANGED", source, note: "Obchod sa zobudil – úloha pre manažéra" }),
        });
    }
    const task = await tx.dealTask.create({
        data: {
            leadId: lead.id,
            type: input.type,
            contents: input.type === "HELP" ? input.contents : [],
            text: input.text,
            requestedById: actor.id,
            assigneeId: input.assignee.id,
        },
    });
    await tx.activity.create({
        data: {
            leadId: lead.id,
            userId: actor.id,
            type: "TASK_CREATED",
            category: "BUSINESS",
            source,
            taskId: task.id,
            note: `${contentsText(input.type, task.contents)} → ${input.assignee.firstName}: ${input.text}`,
            meta: { fp: primary.fp, type: input.type, contents: task.contents, assigneeId: input.assignee.id },
            idempotencyKey: primary.key,
        },
    });
    return task;
}

// ── Správy (§6.2) ────────────────────────────────────────────────────────────

export async function addTaskMessage(
    tx: Tx,
    actor: Actor,
    task: DealTask,
    text: string,
    source: ActivitySource,
    primary: { key: string; fp: string },
) {
    await tx.activity.create({
        data: {
            leadId: task.leadId,
            userId: actor.id,
            type: "TASK_MESSAGE",
            category: "BUSINESS",
            source,
            taskId: task.id,
            note: text,
            meta: { fp: primary.fp },
            idempotencyKey: primary.key,
        },
    });
    await bumpLeadOnce(tx, task.leadId);
}

// ── Vybavenie (§6.3) ─────────────────────────────────────────────────────────

export type FinishInput = {
    price?: { amount: number; note: string | null } | null;
    designIds?: string[];
    answer?: string | null;
};

// Overí, že výsledok pokrýva každý zaškrtnutý obsah (I5) a nič navyše; cenu uloží na obchod; návrhy prečíta pod zámkom.
export async function buildTaskResult(tx: Tx, lead: Lead, task: DealTask, input: FinishInput): Promise<TaskResult> {
    const wants = (c: DealTaskContent) => task.contents.includes(c);
    const result: TaskResult = {};
    if (wants("PRICE")) {
        if (!input.price) throw new AccessError("FORBIDDEN", "Doplň cenu.");
        result.price = { amount: moneyToString(input.price.amount), note: input.price.note?.trim() || null };
    } else if (input.price) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    if (wants("DESIGN")) {
        const ids = [...new Set(input.designIds ?? [])];
        if (ids.length === 0) throw new AccessError("FORBIDDEN", "Vyber návrh.");
        const found = await tx.design.findMany({
            where: { id: { in: ids }, leadId: lead.id, deletedAt: null },
            select: { id: true, label: true, targetUrl: true, currentVersion: true },
        });
        if (found.length !== ids.length) throw new AccessError("NOT_FOUND", "Návrh sa nenašiel.");
        const noUrl = found.filter((d) => !d.targetUrl);
        if (noUrl.length) throw new AccessError("FORBIDDEN", "Návrh potrebuje odkaz (URL) – doplň ho v karte Návrh.");
        result.designs = ids.map((id) => {
            const d = found.find((f) => f.id === id)!;
            return { id: d.id, label: d.label, url: d.targetUrl!, version: d.currentVersion };
        });
    } else if (input.designIds?.length) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    if (wants("OTHER")) {
        const answer = input.answer?.trim();
        if (!answer) throw new AccessError("FORBIDDEN", "Napíš odpoveď.");
        result.answer = answer;
    } else if (input.answer?.trim()) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    return result;
}

export function resultNote(result: TaskResult): string {
    const parts: string[] = [];
    if (result.price) parts.push(`cena ${result.price.amount} €${result.price.note ? ` (${result.price.note})` : ""}`);
    for (const d of result.designs ?? []) parts.push(`návrh ${d.label ?? d.url}`);
    if (result.answer) parts.push(`odpoveď: ${result.answer}`);
    return parts.join(" · ");
}

// Úloha DONE + TASK_DONE (hlavný riadok, ak je daný kľúč) + odomknutie. Cenu na obchod ukladá volajúci (saveQuote).
export async function markTaskDone(
    tx: Tx,
    actor: Actor,
    lead: Lead,
    task: DealTask,
    result: TaskResult,
    source: ActivitySource,
    primary: { key: string; fp: string } | null,
    opts: { unlock?: boolean } = {},
) {
    await closeTask(tx, task, { status: "DONE", closedById: actor.id, result });
    await tx.activity.create({
        data: {
            leadId: lead.id,
            userId: actor.id,
            type: "TASK_DONE",
            category: "BUSINESS",
            source,
            taskId: task.id,
            note: `Vybavené: ${resultNote(result)}`,
            meta: { result, ...(primary ? { fp: primary.fp } : {}) },
            ...(primary ? { idempotencyKey: primary.key } : {}),
        },
    });
    if (opts.unlock !== false) await unlockStep(tx, lead);
    await bumpLeadOnce(tx, lead.id);
}

// ── Zamietnutie (§6.6) ───────────────────────────────────────────────────────

export async function declineTask(
    tx: Tx,
    actor: Actor,
    lead: Lead,
    task: DealTask,
    reason: string,
    source: ActivitySource,
    primary: { key: string; fp: string },
) {
    await closeTask(tx, task, { status: "DECLINED", closedById: actor.id, closeReason: reason });
    await tx.activity.create({
        data: {
            leadId: lead.id,
            userId: actor.id,
            type: "TASK_DECLINED",
            category: "BUSINESS",
            source,
            taskId: task.id,
            note: `Zamietnuté: ${reason}`,
            meta: { fp: primary.fp },
            idempotencyKey: primary.key,
        },
    });
    // Krok ostáva, čím bol („Poslať cenu" – stále sa musí stať), len je odomknutý a splatný dnes (D16).
    await unlockStep(tx, lead);
}

// ── Presun úlohy inému manažérovi (D17) ─────────────────────────────────────

export function assertEligibleAssignee(user: LockedUser | undefined, ownerId: string | null): LockedUser {
    if (!user || user.deletedAt || !can(user, "requests.resolve")) {
        throw new AccessError("FORBIDDEN", "Úlohu môže dostať len aktívny manažér.");
    }
    if (user.id === ownerId) throw new AccessError("FORBIDDEN", "Úloha nemôže patriť vlastníkovi obchodu.");
    return user;
}

export async function reassignTask(
    tx: Tx,
    actor: Actor,
    task: DealTask,
    to: LockedUser,
    source: ActivitySource,
    primary: { key: string; fp: string } | null,
) {
    if (to.id === task.assigneeId) return;
    const n = await tx.dealTask.updateMany({ where: { id: task.id, status: "OPEN" }, data: { assigneeId: to.id } });
    if (n.count !== 1) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
    await tx.activity.create({
        data: {
            leadId: task.leadId,
            userId: actor.id,
            type: "TASK_REASSIGNED",
            category: "BUSINESS",
            source,
            taskId: task.id,
            note: `Úloha presunutá → ${person(to)}`,
            meta: { fromUserId: task.assigneeId, toUserId: to.id, ...(primary ? { fp: primary.fp } : {}) },
            ...(primary ? { idempotencyKey: primary.key } : {}),
        },
    });
    await bumpLeadOnce(tx, task.leadId);
}

// ── Vlastníctvo (I6, §6.10) ─────────────────────────────────────────────────

export async function recordOwnership(
    tx: Tx,
    row: { leadId: string; fromUserId: string | null; toUserId: string | null; byUserId: string; reason: DealOwnershipReason; note?: string | null },
) {
    await tx.dealOwnership.create({
        data: {
            leadId: row.leadId,
            fromUserId: row.fromUserId,
            toUserId: row.toUserId,
            byUserId: row.byUserId,
            reason: row.reason,
            note: row.note?.trim() || null,
        },
    });
}

export type OwnerTransitionOpts = {
    kind: "CHANGE" | "BULK" | "TAKEOVER";
    source: ActivitySource;
    note?: string | null;
    // Nový vlastník je obchodník a úloha ostáva: komu pôjde (inak ostáva doterajší manažér). Volajúci ho zamkol.
    taskAssignee?: LockedUser | null;
    // Prevzatie: manažér si nastaví vlastný krok (inak ostáva krok obchodu, pri skončenej úlohe splatný dnes).
    step?: NextActionData;
    // Hlavný riadok OWNER_CHANGED: kľúč + odtlačok (jednotlivá zmena), alebo značka hromadnej operácie.
    primary?: { key: string; fp: string } | null;
    bulk?: { opId: string; fp: string };
};

// JEDEN prechod vlastníka pre prevzatie, odovzdanie, výber vlastníka aj hromadný presun (§6.10):
//   nový vlastník obchodník  → úloha ostáva (aj zámok), prípadne ide inému manažérovi
//   nový vlastník manažér    → HELP zrušená „klienta prevzal X", HANDOVER vybavená (prijaté odovzdanie)
//   nikto                    → úloha zrušená „obchod bez vlastníka"
// Vrátené výsledky idú s obchodom. Jeden zápis vlastníka, jeden OWNER_CHANGED, jeden DealOwnership, jedna revízia.
export async function ownerTransition(
    tx: Tx,
    actor: Actor,
    lead: Lead,
    target: LockedUser | null,
    opts: OwnerTransitionOpts,
): Promise<{ changed: boolean; reason: DealOwnershipReason | null }> {
    if ((target?.id ?? null) === lead.ownerId) return { changed: false, reason: null };
    if (target && (target.deletedAt || !can(target, "deals.receive"))) {
        throw new AccessError("FORBIDDEN", "Tento používateľ nemôže vlastniť obchody.");
    }
    const open = await openTaskOf(tx, lead.id);
    const resolver = Boolean(target && can(target, "requests.resolve"));
    const reason: DealOwnershipReason = resolver && open?.type === "HANDOVER" ? "HANDOVER" : opts.kind;

    let taskEnded = false;
    if (open) {
        if (!target) {
            await cancelOpenTask(tx, actor, open, "obchod bez vlastníka", opts.source);
            taskEnded = true;
        } else if (resolver) {
            if (open.type === "HANDOVER") {
                await closeTask(tx, open, { status: "DONE", closedById: actor.id });
                await tx.activity.create({
                    data: {
                        leadId: lead.id,
                        userId: actor.id,
                        type: "TASK_DONE",
                        category: "BUSINESS",
                        source: opts.source,
                        taskId: open.id,
                        note: `Odovzdanie prijaté – klienta preberá ${person(target)}`,
                    },
                });
            } else {
                await cancelOpenTask(tx, actor, open, `klienta prevzal ${person(target)}`, opts.source);
            }
            taskEnded = true;
        } else if (opts.taskAssignee && opts.taskAssignee.id !== open.assigneeId) {
            assertEligibleAssignee(opts.taskAssignee, target.id);
            await reassignTask(tx, actor, open, opts.taskAssignee, opts.source, null);
        }
    }

    const step: Partial<NextActionData> = opts.step
        ? opts.step
        : taskEnded && lead.nextActionKind
          ? { nextActionAt: businessTodayStart(), nextActionHasTime: false }
          : {};
    await updateLead(tx, lead.id, { ownerId: target?.id ?? null, ...step });

    const toName = target ? person(target) : null;
    const label = reason === "HANDOVER" ? "Odovzdanie prijaté" : reason === "TAKEOVER" ? "Klienta prevzal" : reason === "BULK" ? "Hromadný presun obchodov" : "Vlastník";
    await tx.activity.create({
        data: {
            ...createAuditActivity({
                leadId: lead.id,
                userId: actor.id,
                type: "OWNER_CHANGED",
                source: opts.source,
                note: toName ? `${label} → ${toName}${opts.note?.trim() ? ` – ${opts.note.trim()}` : ""}` : "Vlastník príležitosti bol odobratý",
            }),
            meta: {
                reason,
                fromUserId: lead.ownerId,
                toUserId: target?.id ?? null,
                ...(opts.primary ? { fp: opts.primary.fp } : {}),
                ...(opts.bulk ? { bulkOpId: opts.bulk.opId, bulkFp: opts.bulk.fp } : {}),
            },
            ...(opts.primary ? { idempotencyKey: opts.primary.key } : {}),
        },
    });
    await recordOwnership(tx, { leadId: lead.id, fromUserId: lead.ownerId, toUserId: target?.id ?? null, byUserId: actor.id, reason, note: opts.note });

    if (opts.step) {
        await tx.activity.create({
            data: createPlanningActivity({
                leadId: lead.id,
                userId: actor.id,
                type: !opts.step.nextActionKind ? "NEXT_ACTION_CLEARED" : hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                source: opts.source,
                note: describeNextAction(opts.step),
            }),
        });
    }
    return { changed: true, reason };
}

// ── „Čo sme poslali" s vrátenými položkami (§6.4) ───────────────────────────

// Pod zámkom Lead riadku: úloha je DONE HELP toho istého obchodu, položka ešte čaká, obsah je v jej výsledku AJ
// v odoslaní, návrh je v oboch. Jedno odoslanie spotrebuje najviac jednu cenu a každý návrh najviac raz (I9).
export function validateFulfils(
    fulfils: readonly ItemRef[],
    send: { contents: readonly OfferContent[]; designIds: readonly string[]; historical: boolean },
    pending: readonly PendingItem[],
): void {
    if (fulfils.length === 0) return;
    if (send.historical) throw new AccessError("FORBIDDEN", "Spätný záznam nič nevybavuje.");
    const byKey = new Map(pending.map((i) => [itemKey(i), i]));
    const keys = fulfils.map(itemKey);
    if (new Set(keys).size !== keys.length) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    if (fulfils.filter((f) => f.kind === "PRICE").length > 1) {
        throw new AccessError("FORBIDDEN", "Jedno odoslanie môže použiť len jednu vrátenú cenu.");
    }
    const designIds = fulfils.filter((f) => f.kind === "DESIGN").map((f) => f.designId);
    if (new Set(designIds).size !== designIds.length) throw new AccessError("FORBIDDEN", "Každý návrh sa dá použiť len raz.");
    for (const f of fulfils) {
        const item = byKey.get(itemKey(f));
        if (!item) throw new AccessError("STALE", "Vrátený výsledok sa medzitým zmenil – obnovujem.");
        if (f.kind === "PRICE" && !send.contents.includes("PRICE")) throw new AccessError("FORBIDDEN", "Odoslanie neobsahuje cenu.");
        if (f.kind === "DESIGN" && (!send.contents.includes("DESIGN") || !send.designIds.includes(f.designId ?? ""))) {
            throw new AccessError("FORBIDDEN", "Odoslanie neobsahuje tento návrh.");
        }
    }
}
