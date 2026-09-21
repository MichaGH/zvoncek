import { Prisma } from "@/app/generated/prisma/client";
import type { DealTask, Lead, PrismaClient } from "@/app/generated/prisma/client";
import type {
    ActivitySource,
    ActivityType,
    DealOwnershipReason,
    DealTaskContent,
    DealTaskPartStatus,
    DealTaskStatus,
    DealTaskType,
    NextActionKind,
} from "@/app/generated/prisma/enums";
import { AccessError } from "@/lib/access/errors";
import type { LockedUser, Tx } from "@/lib/access/locks";
import { createAuditActivity, createPlanningActivity, describeNextAction, type NextActionData } from "@/lib/activityLog";
import { businessTodayStart } from "@/lib/domain/businessTime";
import { hadNextAction, updateLead } from "@/lib/domain/leadWrites";
import { moneyToString, offerInstant, parseOfferMeta, type OfferContent } from "@/lib/domain/offers";
import { bumpLeadOnce } from "@/lib/domain/revision";
import {
    ACKNOWLEDGED_TEXT,
    dismissalReasonOfMeta,
    dismissedItemsOfMeta,
    dismissNeedsReason,
    fulfilsOfMeta,
    helpFallback,
    itemKey,
    parseTaskResult,
    pendingItems,
    requiredStepKinds,
    sortTaskContents,
    taskStatusOfParts,
    type Consumption,
    type DismissInput,
    type ItemRef,
    type PendingItem,
    type TaskResult,
    type TaskWithParts,
} from "@/lib/domain/tasks";
import { NEXT_ACTION_LABEL, TASK_CONTENT_LABEL } from "@/lib/dictionaries";
import { can } from "@/lib/permissions";

// Zápisy úloh pre manažéra (wave 3 – context/features/01-salesrep/wave-3-task-proposal-final.md §5–§6).
// Volajú ich príkazy pod zámkom Lead riadku (lib/commands/tasks.ts, dealWork.ts, pipeline.ts, offers.ts); revízia sa
// zvýši raz (updateLead / bumpLeadOnce). Každá udalosť úlohy = jeden Activity riadok s taskId; kľúč (idempotencyKey)
// má len hlavný riadok príkazu, vedľajšie riadky v tej istej transakcii ho nemajú.

type Actor = { id: string; firstName: string };
type Db = Pick<PrismaClient, "dealTask" | "dealTaskPart" | "activity"> | Tx;

const person = (u: { firstName: string; lastName?: string }) => `${u.firstName} ${u.lastName ?? ""}`.trim();

// ── Zámok (§5.1) ─────────────────────────────────────────────────────────────

export async function openTaskOf(tx: Db, leadId: string): Promise<DealTask | null> {
    return tx.dealTask.findFirst({ where: { leadId, status: "OPEN" }, orderBy: { createdAt: "asc" } });
}

// Otvorená úloha aj s časťami – prekryv odoslania sa rozhoduje podľa toho, čo sa EŠTE ROBÍ (§2.8).
export async function openTaskWithParts(tx: Db, leadId: string) {
    return tx.dealTask.findFirst({
        where: { leadId, status: "OPEN" },
        orderBy: { createdAt: "asc" },
        include: { parts: { select: { kind: true, status: true } } },
    });
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

// Čo úlohy obchodu vrátili. Wave 4: zdrojom je ČASŤ, nie úloha – čiastočne vybavená OTVORENÁ úloha teda
// prispieva položkami (cena hotová, návrh sa ešte robí). Preto sa čítajú úlohy všetkých stavov.
export const PART_SELECT = {
    kind: true,
    status: true,
    result: true,
    addedAt: true,
    addedBy: { select: { id: true, firstName: true } },
    resolvedAt: true,
    resolvedBy: { select: { id: true, firstName: true } },
    reason: true,
} as const;

export async function tasksWithPartsByLead(db: Db, leadIds: string[]): Promise<Map<string, TaskWithParts[]>> {
    const out = new Map<string, TaskWithParts[]>();
    if (leadIds.length === 0) return out;
    const tasks = await db.dealTask.findMany({
        where: { leadId: { in: leadIds }, type: "HELP" },
        select: { id: true, leadId: true, type: true, status: true, parts: { select: PART_SELECT } },
    });
    for (const t of tasks) {
        const list = out.get(t.leadId) ?? [];
        list.push({ id: t.id, type: t.type, status: t.status, parts: t.parts });
        out.set(t.leadId, list);
    }
    return out;
}

// Čo už niekto spotreboval – s FAKTAMI (kedy, kto, prečo), nie len odkazmi: bez nich by projekcia častí
// nevedela vyrobiť dátum odoslania, ktorý sľubuje (wave 4 §2.5, R02-2).
export async function consumptionByLead(db: Db, leadIds: string[]): Promise<Map<string, Consumption[]>> {
    const out = new Map<string, Consumption[]>();
    if (leadIds.length === 0) return out;
    const rows = await db.activity.findMany({
        where: {
            leadId: { in: leadIds },
            OR: [
                { type: "OFFER_SENT", revertedAt: null },
                { type: "TASK_RESULT_DISMISSED", taskId: { not: null } },
            ],
        },
        select: { id: true, leadId: true, type: true, taskId: true, meta: true, createdAt: true, user: { select: { id: true, firstName: true } } },
    });
    for (const r of rows) {
        const list = out.get(r.leadId) ?? [];
        if (r.type === "OFFER_SENT") {
            const meta = parseOfferMeta(r.meta);
            const at = meta ? offerInstant(meta, r.createdAt) : r.createdAt;
            for (const ref of fulfilsOfMeta(r.meta)) {
                list.push({ ref, state: "SENT", at, by: r.user, reason: null, activityId: r.id });
            }
        } else {
            const reason = dismissalReasonOfMeta(r.meta);
            for (const ref of dismissedItemsOfMeta(r.taskId, r.meta)) {
                list.push({ ref, state: "DISMISSED", at: r.createdAt, by: r.user, reason, activityId: r.id });
            }
        }
        out.set(r.leadId, list);
    }
    return out;
}

export async function pendingByLead(db: Db, leadIds: string[]): Promise<Map<string, PendingItem[]>> {
    const out = new Map<string, PendingItem[]>();
    if (leadIds.length === 0) return out;
    const tasks = await tasksWithPartsByLead(db, leadIds);
    if (tasks.size === 0) return out;
    const consumed = await consumptionByLead(db, [...tasks.keys()]);
    for (const [leadId, list] of tasks) {
        const own = consumed.get(leadId) ?? [];
        out.set(
            leadId,
            pendingItems(list, {
                fulfils: own.filter((c) => c.state === "SENT").map((c) => c.ref),
                dismissed: own.filter((c) => c.state === "DISMISSED").map((c) => c.ref),
            }),
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
    const refs: ItemRef[] = input.items.map((i) => ({
        taskId: i.taskId,
        kind: i.kind,
        ...(i.designId ? { designId: i.designId } : {}),
        ...(i.part ? { part: i.part } : {}),
    }));
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
                    items: items.map((r) => ({ kind: r.kind, ...(r.designId ? { designId: r.designId } : {}), ...(r.part ? { part: r.part } : {}) })),
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
        {
            items: pending.map((i) => ({
                taskId: i.taskId,
                kind: i.kind,
                ...(i.designId ? { designId: i.designId } : {}),
                ...(i.part ? { part: i.part } : {}),
            })),
            reason,
        },
        source,
        { pending },
    );
}

// ── Časti úlohy: jediné miesto, kde sa mení ich stav aj stav úlohy (wave 4 §2.4a) ──
// Každý koniec úlohy sú tie isté dva kroky: vyrieš menované časti, potom PREPOČÍTAJ stav úlohy. Nič iné o stave
// nerozhoduje a riadok na úrovni úlohy sa vyberá podľa VÝSLEDNÉHO stavu, nikdy podľa názvu akcie, ktorá ho spôsobila.

export type PartOp =
    | { kind: DealTaskContent; op: "DELIVERED"; result: TaskResult }
    | { kind: DealTaskContent; op: "DECLINED"; reason: string }
    | { kind: DealTaskContent; op: "WITHDRAWN"; reason: string };

const PART_ROW_TYPE = {
    DELIVERED: "TASK_PART_DONE",
    DECLINED: "TASK_PART_DECLINED",
    WITHDRAWN: "TASK_PART_WITHDRAWN",
} as const satisfies Record<PartOp["op"], ActivityType>;

const TASK_ROW_TYPE = {
    DONE: "TASK_DONE",
    DECLINED: "TASK_DECLINED",
    CANCELLED: "TASK_CANCELLED",
} as const;

export async function partsOf(tx: Db, taskId: string) {
    return tx.dealTaskPart.findMany({ where: { taskId }, select: { kind: true, status: true, result: true, reason: true } });
}

// Zlúčený výsledok všetkých dodaných častí – to, čo TASK_DONE.meta.result nieslo aj vo wave 3.
function mergedResult(parts: readonly { kind: DealTaskContent; status: DealTaskPartStatus; result: unknown }[]): TaskResult {
    const out: TaskResult = {};
    for (const p of parts) {
        if (p.status !== "DELIVERED") continue;
        const r = parseTaskResult(p.result);
        if (!r) continue;
        if (r.price) out.price = r.price;
        if (r.designs) out.designs = [...(out.designs ?? []), ...r.designs];
        if (r.answer) out.answer = out.answer ? `${out.answer}\n${r.answer}` : r.answer;
    }
    return out;
}

function opNote(ops: readonly PartOp[]): string {
    return ops
        .map((o) => {
            const label = TASK_CONTENT_LABEL[o.kind];
            if (o.op === "DELIVERED") return `${label}: ${resultNote(o.result) || "hotové"}`;
            return `${label} – ${o.op === "DECLINED" ? "nerobím" : "stiahnuté"}: ${o.reason}`;
        })
        .join(" · ");
}

// Veta na karte a v histórii: „Vybavené" nikdy nezamlčí, že časť nevyšla (Q10).
function taskCloseNote(
    status: DealTaskStatus,
    parts: readonly { kind: DealTaskContent; status: DealTaskPartStatus }[],
    taskReason: string | null,
): string {
    const say = (p: { kind: DealTaskContent; status: DealTaskPartStatus }) => {
        const label = TASK_CONTENT_LABEL[p.kind].toLowerCase();
        if (p.status === "DELIVERED") return `${label} odovzdaná`;
        if (p.status === "DECLINED") return `${label} zamietnutá`;
        return `${label} zrušená`;
    };
    const detail = sortTaskContents(parts.map((p) => p.kind))
        .map((k) => say(parts.find((p) => p.kind === k)!))
        .join(", ");
    const head = status === "DONE" ? "Vybavené" : status === "DECLINED" ? "Zamietnuté" : "Úloha zrušená";
    return `${head}: ${detail}${taskReason ? ` (${taskReason})` : ""}`;
}

// Vyrieš menované časti a prepočítaj stav úlohy. `primary` = hlavný riadok príkazu (s kľúčom); keď je null,
// hlavný riadok patrí volajúcemu (uzavretie obchodu, zmena vlastníka) a riadky častí sú vedľajšie.
export async function applyPartOps(
    tx: Tx,
    actor: Actor,
    task: DealTask,
    ops: readonly PartOp[],
    source: ActivitySource,
    primary: { key: string; fp: string } | null,
    opts: { taskReason?: string | null } = {},
): Promise<{ status: DealTaskStatus; closed: boolean }> {
    if (ops.length === 0) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    const now = new Date();
    for (const op of ops) {
        // Podmienený zápis: časť musí byť ešte REQUESTED (obrana do hĺbky – všetko beží pod zámkom Lead riadku).
        const n = await tx.dealTaskPart.updateMany({
            where: { taskId: task.id, kind: op.kind, status: "REQUESTED" },
            data: {
                status: op.op,
                resolvedById: actor.id,
                resolvedAt: now,
                ...(op.op === "DELIVERED" ? { result: op.result } : { reason: op.reason }),
            },
        });
        if (n.count !== 1) throw new AccessError("STALE", "Časť úlohy sa medzitým zmenila – obnovujem.");
    }

    const parts = await partsOf(tx, task.id);
    const status = taskStatusOfParts(parts);
    const closed = status !== "OPEN";
    if (status !== task.status) {
        const n = await tx.dealTask.updateMany({
            where: { id: task.id, status: task.status },
            data: {
                status,
                ...(closed
                    ? {
                          closedAt: now,
                          closedById: actor.id,
                          // closeReason drží len taký koniec, ktorý má JEDEN dôvod za celú úlohu; zmiešaný koniec
                          // necháva NULL a dôvody ostávajú na častiach.
                          closeReason: opts.taskReason ?? null,
                      }
                    : {}),
            },
        });
        if (n.count !== 1) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
    }

    // Hlavný riadok príkazu: dodanie vyhráva nad zamietnutím (jeden príkaz môže robiť oboje).
    const leadRowOp: PartOp["op"] = ops.some((o) => o.op === "DELIVERED")
        ? "DELIVERED"
        : ops.some((o) => o.op === "DECLINED")
          ? "DECLINED"
          : "WITHDRAWN";
    await tx.activity.create({
        data: {
            leadId: task.leadId,
            userId: actor.id,
            type: PART_ROW_TYPE[leadRowOp],
            category: "BUSINESS",
            source,
            taskId: task.id,
            note: opNote(ops),
            meta: { parts: sortTaskContents(ops.map((o) => o.kind)), ...(primary ? { fp: primary.fp } : {}) },
            ...(primary ? { idempotencyKey: primary.key } : {}),
        },
    });

    // Riadok na úrovni úlohy sa píše podľa VÝSLEDNÉHO stavu (§2.4a) – aby história, pendingSummary a všetci
    // doterajší čitatelia fungovali bez zmeny. Nikdy nenesie kľúč: ten má hlavný riadok príkazu.
    if (closed) {
        await tx.activity.create({
            data: {
                leadId: task.leadId,
                userId: actor.id,
                type: TASK_ROW_TYPE[status as "DONE" | "DECLINED" | "CANCELLED"],
                category: "BUSINESS",
                source,
                taskId: task.id,
                note: taskCloseNote(status, parts, opts.taskReason ?? null),
                ...(status === "DONE" ? { meta: { result: mergedResult(parts) } } : {}),
            },
        });
    }
    await bumpLeadOnce(tx, task.leadId);
    return { status, closed };
}

// Odmietnuté odovzdanie („Nie, pokračuj ty"): HANDOVER nemá časti, takže tu niet čo prepočítavať – je to jeden
// koniec s jedným dôvodom. Preto NIE JE súčasťou resolveTaskParts (tá rieši výhradne časti, §2.4a / B6).
export async function declineHandover(
    tx: Tx,
    actor: Actor,
    lead: Lead,
    task: DealTask,
    reason: string,
    source: ActivitySource,
    primary: { key: string; fp: string },
) {
    const n = await tx.dealTask.updateMany({
        where: { id: task.id, status: "OPEN" },
        data: { status: "DECLINED", closedAt: new Date(), closedById: actor.id, closeReason: reason },
    });
    if (n.count !== 1) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
    await tx.activity.create({
        data: {
            leadId: lead.id,
            userId: actor.id,
            type: "TASK_DECLINED",
            category: "BUSINESS",
            source,
            taskId: task.id,
            note: `Odovzdanie neprijaté: ${reason}`,
            meta: { fp: primary.fp },
            idempotencyKey: primary.key,
        },
    });
    // Krok ostáva, čím bol – klient ostáva u obchodníka; len sa odomkne a je splatný dnes (D16).
    await unlockStep(tx, lead);
}

// Prijaté odovzdanie: HANDOVER nemá časti, takže jeho koniec neprechádza prepočtom (§2.4a posledný riadok).
export async function acceptHandover(tx: Tx, actor: Actor, task: DealTask) {
    const n = await tx.dealTask.updateMany({
        where: { id: task.id, status: "OPEN" },
        data: { status: "DONE", closedAt: new Date(), closedById: actor.id },
    });
    if (n.count !== 1) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
}

// Zrušenie otvorenej úlohy (vlastník, uzavretie obchodu, zmena vlastníka): stiahne KAŽDÚ časť, ktorá sa ešte robí,
// s tým istým dôvodom – a §2.4a potom pomenuje výsledný stav. Už dodané časti prežijú a čakajú na odoslanie.
// Meno aj tvar vstupu ostávajú z wave 3, aby sa volajúci nemenili.
export async function cancelOpenTask(tx: Tx, actor: Actor, task: DealTask, reason: string, source: ActivitySource) {
    const open = (await partsOf(tx, task.id)).filter((p) => p.status === "REQUESTED");
    if (open.length === 0) {
        // HANDOVER (a teoreticky úloha bez častí): ostáva pôvodné správanie wave 3.
        const n = await tx.dealTask.updateMany({
            where: { id: task.id, status: "OPEN" },
            data: { status: "CANCELLED", closedAt: new Date(), closedById: actor.id, closeReason: reason },
        });
        if (n.count !== 1) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
        await tx.activity.create({
            data: {
                leadId: task.leadId,
                userId: actor.id,
                type: "TASK_CANCELLED",
                category: "BUSINESS",
                source,
                taskId: task.id,
                note: `Úloha zrušená: ${reason}`,
            },
        });
        await bumpLeadOnce(tx, task.leadId);
        return;
    }
    await applyPartOps(
        tx,
        actor,
        task,
        open.map((p) => ({ kind: p.kind, op: "WITHDRAWN" as const, reason })),
        source,
        null,
        { taskReason: reason },
    );
}

// „Zrušiť + zmeniť": vlastník stiahol poslednú časť a v tom istom uložení si vybral ďalší krok. Výslovne
// zvolený krok vyhráva nad záložným (P4) – volajúci ho už overil cez assertStepAllowed.
export async function setNextStepAfterTask(
    tx: Tx,
    actor: Actor,
    lead: Lead,
    step: { kind: NextActionKind; note: string | null },
    source: ActivitySource,
    now = new Date(),
): Promise<void> {
    const next: NextActionData = {
        nextActionKind: step.kind,
        nextActionAt: businessTodayStart(now),
        nextActionHasTime: false,
        nextActionMode: "SCHEDULED",
        nextActionNote: step.note,
    };
    await updateLead(tx, lead.id, next);
    await tx.activity.create({
        data: createPlanningActivity({
            leadId: lead.id,
            userId: actor.id,
            type: hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
            source,
            note: describeNextAction(next),
        }),
    });
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
    const contents = input.type === "HELP" ? sortTaskContents(input.contents) : [];
    const task = await tx.dealTask.create({
        data: {
            leadId: lead.id,
            type: input.type,
            text: input.text,
            requestedById: actor.id,
            assigneeId: input.assignee.id,
            // P6 (§2.6): kam sa krok vráti, keď nebude čo poslať – ručne zvolený krok pred zamknutím; systémový „Poslať …“
            // sa nahradí neutrálnym „Zavolať“ (R02-1).
            // Zapisuje sa RAZ a už sa neprepisuje; bez neho by „Iné"-only úloha nemala kam spadnúť (R02-3).
            // Ručne zvolený krok sa uloží tak, ako bol; systémový „Poslať …“ (alebo žiadny) sa nahradí neutrálnym
            // „Zavolať“ (R02-1) – jeho práca sa počas úlohy odošle a zamknutý krok by potom tvrdil, že sa má poslať znova.
            ...(input.type === "HELP"
                ? (() => {
                      const fb = helpFallback({ kind: lead.nextActionKind, note: lead.nextActionNote });
                      return { fallbackKind: fb.kind, fallbackNote: fb.note };
                  })()
                : { fallbackKind: lead.nextActionKind, fallbackNote: lead.nextActionNote }),
            // Wave 4: jedna časť na každý druh práce. Stav úlohy sa od nich odteraz odvodzuje.
            parts: { create: contents.map((kind) => ({ kind, addedById: actor.id })) },
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
            note: `${contentsText(input.type, contents)} → ${input.assignee.firstName}: ${input.text}`,
            meta: { fp: primary.fp, type: input.type, contents, assigneeId: input.assignee.id },
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

// ── Odovzdanie častí (§6.3, wave 4 §2.7) ────────────────────────────────────

// Čo manažér odovzdáva za JEDNU časť. Vyplnené pole nie je rozhodnutie (R02-4): manažér časť VÝSLOVNE zaškrtne
// a server odmietne hodnoty pre druh, ktorý v tomto uložení nemenoval.
export type DeliverInput = {
    price?: { amount: number; note: string | null } | null;
    designIds?: string[];
    answer?: string | null;
};

// Výsledok jednej časti: presne jeden kľúč, overený pod zámkom. Návrhy sa čítajú z DB, aby sa uložilo to, čo
// manažér naozaj potvrdil.
export async function buildPartResult(tx: Tx, lead: Lead, kind: DealTaskContent, input: DeliverInput): Promise<TaskResult> {
    const extra =
        (kind !== "PRICE" && input.price) || (kind !== "DESIGN" && input.designIds?.length) || (kind !== "OTHER" && input.answer?.trim());
    if (extra) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    if (kind === "PRICE") {
        if (!input.price) throw new AccessError("FORBIDDEN", "Doplň cenu.");
        return { price: { amount: moneyToString(input.price.amount), note: input.price.note?.trim() || null } };
    }
    if (kind === "DESIGN") {
        const ids = [...new Set(input.designIds ?? [])];
        if (ids.length === 0) throw new AccessError("FORBIDDEN", "Vyber návrh.");
        const found = await tx.design.findMany({
            where: { id: { in: ids }, leadId: lead.id, deletedAt: null },
            select: { id: true, label: true, targetUrl: true, currentVersion: true },
        });
        if (found.length !== ids.length) throw new AccessError("NOT_FOUND", "Návrh sa nenašiel.");
        if (found.some((d) => !d.targetUrl)) throw new AccessError("FORBIDDEN", "Návrh potrebuje odkaz (URL) – doplň ho v karte Návrh.");
        return {
            designs: ids.map((id) => {
                const d = found.find((f) => f.id === id)!;
                return { id: d.id, label: d.label, url: d.targetUrl!, version: d.currentVersion };
            }),
        };
    }
    const answer = input.answer?.trim();
    if (!answer) throw new AccessError("FORBIDDEN", "Napíš odpoveď.");
    return { answer };
}

export function resultNote(result: TaskResult): string {
    const parts: string[] = [];
    if (result.price) parts.push(`cena ${result.price.amount} €${result.price.note ? ` (${result.price.note})` : ""}`);
    for (const d of result.designs ?? []) parts.push(`návrh ${d.label ?? d.url}`);
    if (result.answer) parts.push(`odpoveď: ${result.answer}`);
    return parts.join(" · ");
}

// ── Pridanie a stiahnutie častí (wave 4 §2.7) ───────────────────────────────

// Druh, ktorý sa smie (znova) vyžiadať v TEJ ISTEJ úlohe: nový, alebo taký, ktorý vlastník predtým stiahol.
// Dodaný ani zamietnutý druh sa nepýta znova – to je NOVÁ úloha (§2.4).
export async function addParts(
    tx: Tx,
    actor: Actor,
    task: DealTask,
    kinds: readonly DealTaskContent[],
    message: string,
    source: ActivitySource,
    primary: { key: string; fp: string },
): Promise<void> {
    if (task.type !== "HELP") throw new AccessError("FORBIDDEN", "Odovzdanie nemá časti.");
    const wanted = sortTaskContents(kinds);
    if (wanted.length === 0) throw new AccessError("FORBIDDEN", "Vyber, čo pribúda.");
    const existing = await partsOf(tx, task.id);
    for (const kind of wanted) {
        const part = existing.find((p) => p.kind === kind);
        if (part && part.status !== "WITHDRAWN") {
            throw new AccessError("STALE", `${TASK_CONTENT_LABEL[kind]} v tejto úlohe už je – obnovujem.`);
        }
        if (part) {
            // Stiahnutá časť sa vracia do hry čistá: kto a kedy ju pridal znova, prečo sa stiahla, už neplatí.
            const n = await tx.dealTaskPart.updateMany({
                where: { taskId: task.id, kind, status: "WITHDRAWN" },
                data: { status: "REQUESTED", addedById: actor.id, addedAt: new Date(), resolvedById: null, resolvedAt: null, reason: null, result: Prisma.DbNull },
            });
            if (n.count !== 1) throw new AccessError("STALE", "Časť úlohy sa medzitým zmenila – obnovujem.");
        } else {
            await tx.dealTaskPart.create({ data: { taskId: task.id, kind, addedById: actor.id } });
        }
    }
    await tx.activity.create({
        data: {
            leadId: task.leadId,
            userId: actor.id,
            type: "TASK_PART_ADDED",
            category: "BUSINESS",
            source,
            taskId: task.id,
            // Správa je riadok vlákna – manažér vidí, PREČO to pribudlo, bez druhého TASK_MESSAGE.
            note: `Pridané: ${wanted.map((k) => TASK_CONTENT_LABEL[k]).join(" + ")} – ${message}`,
            meta: { parts: wanted, fp: primary.fp },
            idempotencyKey: primary.key,
        },
    });
    await bumpLeadOnce(tx, task.leadId);
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
    // Úloha skončila zrušením (nie prijatým odovzdaním): krok sa odvodí naposledy, ako pri každom inom konci úlohy (R01-5).
    let cancelled = false;
    if (open) {
        if (!target) {
            await cancelOpenTask(tx, actor, open, "obchod bez vlastníka", opts.source);
            taskEnded = cancelled = true;
        } else if (resolver) {
            if (open.type === "HANDOVER") {
                await acceptHandover(tx, actor, open);
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
                cancelled = true;
            }
            taskEnded = true;
        } else if (opts.taskAssignee && opts.taskAssignee.id !== open.assigneeId) {
            assertEligibleAssignee(opts.taskAssignee, target.id);
            await reassignTask(tx, actor, open, opts.taskAssignee, opts.source, null);
        }
    }

    // Výslovný krok prevzatia vyhráva; inak zrušená úloha odomkne krok podľa P6 (jeden zápis aj jeden riadok histórie).
    const derivesStep = Boolean(open && cancelled && !opts.step);
    if (derivesStep && open) {
        // lockedStep.ts číta z tohto modulu (aj cez requestMutations) – import až tu drží graf modulov bez cyklu.
        const { stepOnTaskClose } = await import("@/lib/domain/lockedStep");
        await stepOnTaskClose(tx, actor, lead, open, opts.source);
    }
    const step: Partial<NextActionData> = opts.step
        ? opts.step
        : taskEnded && !derivesStep && lead.nextActionKind
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
