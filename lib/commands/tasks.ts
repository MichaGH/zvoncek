import { z } from "zod";
import type { DealTask } from "@/app/generated/prisma/client";
import { AccessError, FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { isOpenDealStatus, requireDealManage, requireDealWork } from "@/lib/access/leads";
import { withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import type { NextActionData } from "@/lib/activityLog";
import { sourceFor } from "@/lib/commands/dealWork";
import { businessDate, businessTodayStart, isValidBusinessDate } from "@/lib/domain/businessTime";
import { saveQuote } from "@/lib/domain/dealMutations";
import { runKeyed } from "@/lib/domain/idempotency";
import { FOLLOW_UP_NEXT_KINDS } from "@/lib/domain/leadFlow";
import { defaultStepNote, nextStepOption } from "@/lib/domain/nextStepOptions";
import { recordOffer } from "@/lib/domain/offerMutations";
import { outstandingOf } from "@/lib/domain/requestMutations";
import { isValidSentOn, moneyToString, OFFER_CONTENTS, type OfferContent } from "@/lib/domain/offers";
import { resolveSchedule, scheduleSchema } from "@/lib/domain/schedule";
import {
    canonical,
    ITEM_KINDS,
    sortedItems,
    stepAfterTask,
    TASK_CONTENTS,
    TASK_REASON_MAX,
    TASK_TEXT_MAX,
    TASK_TYPES,
    type ItemRef,
} from "@/lib/domain/tasks";
import {
    addTaskMessage,
    assertDecidesResults,
    assertEligibleAssignee,
    assertStepAllowed,
    buildTaskResult,
    createTask,
    declineTask,
    dismissItems,
    loadPending,
    markTaskDone,
    openTaskOf,
    ownerTransition,
    reassignTask,
} from "@/lib/domain/taskMutations";
import prisma from "@/lib/db";
import { can } from "@/lib/permissions";

// Úlohy pre manažéra (wave 3 – context/features/01-salesrep/wave-3-task-proposal-final.md §6). Každý príkaz:
// jeden hlavný riadok s kľúčom a odtlačkom (runKeyed), expectedRevision, zámky Team → User → Lead (§5.5 tabuľka),
// jedno zvýšenie revízie. Telá zápisov sú v lib/domain/taskMutations.ts.

type Result = { success: true } | ActionError;

const base = {
    expectedRevision: z.number().int().min(0),
    idempotencyKey: z.string().min(8).max(100),
};
const money = z.object({ amount: z.number().finite().min(0).max(10_000_000), note: z.string().max(2000).nullish() }).strict();
const designPick = z.object({ id: z.string().min(1), version: z.number().int().min(1) }).strict();
const trim = (v: string | null | undefined) => v?.trim() || null;
const fail = (label: string) => (error: unknown) => toActionError(error, "Nepodarilo sa uložiť.", label);

// Úloha podľa id bez zámku (na nájdenie obchodu); pod zámkom sa prečíta znova.
async function leadOfTask(taskId: string): Promise<string | null> {
    return (await prisma.dealTask.findUnique({ where: { id: taskId }, select: { leadId: true } }))?.leadId ?? null;
}

async function lockedTask(tx: Tx, taskId: string, leadId: string): Promise<DealTask> {
    const task = await tx.dealTask.findUnique({ where: { id: taskId } });
    if (!task || task.leadId !== leadId) throw new AccessError("NOT_FOUND");
    if (task.status !== "OPEN") throw new AccessError("STALE", "Úloha už bola uzavretá – obnovujem.");
    return task;
}

// ── Požiadať manažéra / Odovzdať manažérovi (§6.1, §6.8) ─────────────────────

const askSchema = z
    .object({
        leadId: z.string().min(1),
        ...base,
        type: z.enum(TASK_TYPES),
        contents: z.array(z.enum(TASK_CONTENTS)).max(TASK_CONTENTS.length).default([]),
        text: z.string().max(TASK_TEXT_MAX),
        assigneeId: z.string().min(1),
        // HELP: krok po vybavení sa odvodí (stepAfterTask) – cena → „Poslať cenu", návrh → „Poslať návrh", iné → ostáva.
        // Posiela sa len pri „Iné", keď ho obchodník zmenil; pri cene / návrhu sa prijme len ten istý druh. HANDOVER: nikdy.
        step: z.object({ kind: z.enum(FOLLOW_UP_NEXT_KINDS), note: z.string().max(1000).nullish() }).strict().nullish(),
    })
    .strict();
export type AskManagerInput = z.input<typeof askSchema>;

export async function askManagerAs(user: AccessUser, raw: AskManagerInput): Promise<Result> {
    if (!can(user, "deals.work") || can(user, "requests.resolve")) return FORBIDDEN;
    const parsed = askSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const text = input.text.trim();
    if (!text) return { error: input.type === "HANDOVER" ? "Napíš, prečo odovzdávaš (napr. čo si objednávajú)." : "Napíš, čo potrebuješ." };
    const contents = [...new Set(input.contents)].sort();
    if (input.type === "HELP") {
        if (contents.length === 0) return { error: "Vyber, čo potrebuješ (cena / návrh / iné)." };
    } else if (contents.length || input.step) return { error: "Neplatné údaje." };
    const step = input.type === "HELP" && input.step ? { kind: input.step.kind, note: trim(input.step.note) } : null;
    const fp = canonical({ type: input.type, contents, assigneeId: input.assigneeId, text, step });

    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId: input.leadId, types: ["TASK_CREATED"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor, users } = await requireDealWork(tx, user, input.leadId, {
                    expectedRevision: input.expectedRevision,
                    lockUserIds: [input.assigneeId],
                });
                // Len vlastník – obchodník, nie manažér (na svojom obchode úlohy nemá, D7), nie telesales (D9).
                if (lead.ownerId !== actor.id || !can(actor, "deals.work") || can(actor, "requests.resolve")) {
                    throw new AccessError("FORBIDDEN", "Úlohu zadáva vlastník obchodu.");
                }
                if (await openTaskOf(tx, lead.id)) throw new AccessError("STALE", "Obchod už má otvorenú úlohu – obnovujem.");
                const assignee = assertEligibleAssignee(users.get(input.assigneeId), lead.ownerId);
                let lockedStep = { kind: lead.nextActionKind, note: lead.nextActionNote };
                if (input.type === "HELP") {
                    // Wave 5: krok sa odvodí z CELEJ nevybavenej práce – čo klient pýta aj čo sa ide robiť (§6.8).
                    const auto = stepAfterTask(contents, lockedStep, await loadPending(tx, lead.id), defaultStepNote, await outstandingOf(tx, lead.id));
                    // Pevný krok (cena / návrh) sa zmeniť nedá; pri „Iné" platí zvolený krok, ak ho I10 dovolí.
                    if (step && auto.fixed && step.kind !== auto.kind) throw new AccessError("STALE", "Krok po vybavení sa zmenil – obnovujem.");
                    if (step && !auto.fixed) await assertStepAllowed(tx, lead.id, step.kind);
                    lockedStep = step
                        ? { kind: step.kind, note: step.note ?? (step.kind === lead.nextActionKind ? lead.nextActionNote : defaultStepNote(step.kind)) }
                        : { kind: auto.kind, note: auto.note };
                }
                await createTask(
                    tx,
                    actor,
                    lead,
                    { type: input.type, contents, text, assignee, step: lockedStep },
                    sourceFor(user),
                    { key: input.idempotencyKey, fp },
                );
            }),
        fail("askManager"),
    );
}

// ── Správa k úlohe (§6.2) ────────────────────────────────────────────────────

const messageSchema = z.object({ taskId: z.string().min(1), ...base, text: z.string().max(2000) }).strict();
export type TaskMessageInput = z.input<typeof messageSchema>;

export async function taskMessageAs(user: AccessUser, raw: TaskMessageInput): Promise<Result> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const text = input.text.trim();
    if (!text) return { error: "Napíš správu." };
    const leadId = await leadOfTask(input.taskId);
    if (!leadId) return { error: "Nenašlo sa.", code: "NOT_FOUND" };
    const fp = canonical({ taskId: input.taskId, text });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId, types: ["TASK_MESSAGE"], fp },
        () =>
            withLockTx(async (tx) => {
                // Vlastník alebo manažér (priradený manažér má deals.manage); cudzí obchod = NOT_FOUND.
                const { actor } = await requireDealWork(tx, user, leadId, { expectedRevision: input.expectedRevision });
                const task = await lockedTask(tx, input.taskId, leadId);
                await addTaskMessage(tx, actor, task, text, sourceFor(user), { key: input.idempotencyKey, fp });
            }),
        fail("taskMessage"),
    );
}

// ── Vybavené (§6.3) a „Vybavil som to sám" (§6.5) ───────────────────────────

const finishFields = {
    taskId: z.string().min(1),
    ...base,
    price: money.nullish(),
    designs: z.array(designPick).max(10).optional(),
    answer: z.string().max(5000).nullish(),
};
const finishSchema = z.object(finishFields).strict();
export type FinishTaskInput = z.input<typeof finishSchema>;

function finishFp(input: z.infer<typeof finishSchema>) {
    return {
        taskId: input.taskId,
        price: input.price ? { amount: moneyToString(input.price.amount), note: trim(input.price.note) } : null,
        designs: [...(input.designs ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
        answer: trim(input.answer),
    };
}

async function resolverTaskTx(tx: Tx, user: AccessUser, taskId: string, leadId: string, expectedRevision: number, lockUserIds: string[] = []) {
    const { lead, actor, users } = await requireDealManage(tx, user, leadId, { expectedRevision, lockUserIds });
    if (!can(actor, "requests.resolve")) throw new AccessError("FORBIDDEN");
    const task = await lockedTask(tx, taskId, leadId);
    return { lead, actor, users, task };
}

// Návrhy vo výsledku: verzia, ktorú manažér videl, musí byť aktuálna (inak by sa uložilo niečo iné, než potvrdil).
async function checkDesignVersions(tx: Tx, leadId: string, picks: { id: string; version: number }[]) {
    if (!picks.length) return;
    const found = await tx.design.findMany({ where: { id: { in: picks.map((p) => p.id) }, leadId }, select: { id: true, currentVersion: true } });
    for (const p of picks) {
        if (found.find((f) => f.id === p.id)?.currentVersion !== p.version) {
            throw new AccessError("STALE", "Návrh sa medzitým zmenil – obnovujem.");
        }
    }
}

export async function finishTaskAs(user: AccessUser, raw: FinishTaskInput): Promise<Result> {
    if (!can(user, "requests.resolve") || !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = finishSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const leadId = await leadOfTask(input.taskId);
    if (!leadId) return { error: "Nenašlo sa.", code: "NOT_FOUND" };
    const fp = canonical(finishFp(input));
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId, types: ["TASK_DONE"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor, task } = await resolverTaskTx(tx, user, input.taskId, leadId, input.expectedRevision);
                if (task.type !== "HELP") throw new AccessError("FORBIDDEN", "Odovzdanie sa prijíma cez „Preberám“.");
                await checkDesignVersions(tx, lead.id, input.designs ?? []);
                const result = await buildTaskResult(tx, lead, task, {
                    price: input.price ? { amount: input.price.amount, note: trim(input.price.note) } : null,
                    designIds: input.designs?.map((d) => d.id),
                    answer: input.answer,
                });
                // Cena sa uloží aj na obchod – rovnaké pravidlá ako cenové okienko (nová suma bez rozpisu zmaže starý rozpis).
                if (input.price) {
                    await saveQuote(tx, actor, lead, { price: input.price.amount, priceNote: trim(input.price.note) }, sourceFor(user));
                }
                await markTaskDone(tx, actor, lead, task, result, sourceFor(user), { key: input.idempotencyKey, fp });
            }),
        fail("finishTask"),
    );
}

const finishSendSchema = z
    .object({
        ...finishFields,
        extraContents: z.array(z.enum(["ABOUT_US", "PRICELIST"])).max(2).default([]),
        sentOn: z.string(),
        // Po odoslaní nasleduje vždy „Zavolať, či prišlo" (§6.5, R01-2) – bez voľby vypnúť ho, inak by ostal krok
        // „Poslať…" pre niečo, čo už odišlo. `followUp` sa prijíma len ako true (starší klient).
        followUp: z.literal(true).optional(),
        followUpOn: z.string().optional(),
    })
    .strict();
export type FinishAndSendInput = z.input<typeof finishSendSchema>;

// Manažér to urobil a poslal sám: výsledok + odoslanie (s fulfils na túto úlohu) + DONE + krok z odoslania – jeden príkaz.
export async function finishAndSendAs(user: AccessUser, raw: FinishAndSendInput): Promise<Result> {
    if (!can(user, "requests.resolve") || !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = finishSendSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const today = businessDate(new Date());
    if (!isValidSentOn(input.sentOn, today)) return { error: "Neplatný dátum odoslania." };
    if (input.followUpOn && (!isValidBusinessDate(input.followUpOn) || input.followUpOn < today)) {
        return { error: "Neplatný dátum hovoru." };
    }
    const leadId = await leadOfTask(input.taskId);
    if (!leadId) return { error: "Nenašlo sa.", code: "NOT_FOUND" };
    const fp = canonical({
        ...finishFp(input),
        send: { extra: [...input.extraContents].sort(), sentOn: input.sentOn, followUpOn: input.followUpOn ?? null },
    });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId, types: ["TASK_DONE"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor, task } = await resolverTaskTx(tx, user, input.taskId, leadId, input.expectedRevision);
                if (task.type !== "HELP" || !(task.contents.includes("PRICE") || task.contents.includes("DESIGN"))) {
                    throw new AccessError("FORBIDDEN", "Poslať sa dá len cena alebo návrh.");
                }
                await checkDesignVersions(tx, lead.id, input.designs ?? []);
                const result = await buildTaskResult(tx, lead, task, {
                    price: input.price ? { amount: input.price.amount, note: trim(input.price.note) } : null,
                    designIds: input.designs?.map((d) => d.id),
                    answer: input.answer,
                });
                await markTaskDone(tx, actor, lead, task, result, sourceFor(user), { key: input.idempotencyKey, fp });
                const contents: OfferContent[] = [
                    ...input.extraContents,
                    ...(result.price ? (["PRICE"] as const) : []),
                    ...(result.designs ? (["DESIGN"] as const) : []),
                ];
                const fulfils: ItemRef[] = [
                    ...(result.price ? [{ taskId: task.id, kind: "PRICE" as const }] : []),
                    ...(result.designs ?? []).map((d) => ({ taskId: task.id, kind: "DESIGN" as const, designId: d.id })),
                ];
                // Hovor po odoslaní, pokiaľ nečaká iný vrátený a neposlaný výsledok staršej úlohy – vtedy krok ostáva
                // „Poslať…" pre ten (I10; krok bol pri žiadosti odvodený tak, aby mu zodpovedal).
                const otherPending = (await loadPending(tx, lead.id)).some(
                    (i) => i.taskId !== task.id && (i.kind === "PRICE" || i.kind === "DESIGN"),
                );
                // Cenu na obchod uloží odoslanie (rovnaké pravidlá ako „Čo sme poslali"); obsah je presne výsledok úlohy.
                await recordOffer(
                    tx,
                    actor,
                    lead,
                    {
                        channel: "EMAIL",
                        contents: contents.filter((c) => (OFFER_CONTENTS as readonly string[]).includes(c)),
                        sentOn: input.sentOn,
                        historical: false,
                        price: input.price ? { amount: input.price.amount, note: trim(input.price.note) } : null,
                        designIds: result.designs?.map((d) => d.id),
                        followUp: !otherPending,
                        followUpOn: otherPending ? undefined : input.followUpOn,
                        fulfils,
                    },
                    sourceFor(user),
                );
            }),
        fail("finishAndSend"),
    );
}

// ── Zamietnuť (§6.6, §6.8 „Nie, pokračuj ty") ────────────────────────────────

const declineSchema = z.object({ taskId: z.string().min(1), ...base, reason: z.string().max(TASK_REASON_MAX) }).strict();
export type DeclineTaskInput = z.input<typeof declineSchema>;

export async function declineTaskAs(user: AccessUser, raw: DeclineTaskInput): Promise<Result> {
    if (!can(user, "requests.resolve") || !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = declineSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const reason = input.reason.trim();
    if (!reason) return { error: "Napíš dôvod – uvidí ho obchodník." };
    const leadId = await leadOfTask(input.taskId);
    if (!leadId) return { error: "Nenašlo sa.", code: "NOT_FOUND" };
    const fp = canonical({ taskId: input.taskId, reason });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId, types: ["TASK_DECLINED"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor, task } = await resolverTaskTx(tx, user, input.taskId, leadId, input.expectedRevision);
                await declineTask(tx, actor, lead, task, reason, sourceFor(user), { key: input.idempotencyKey, fp });
            }),
        fail("declineTask"),
    );
}

// ── Presunúť inému manažérovi (D17) ─────────────────────────────────────────

const reassignSchema = z.object({ taskId: z.string().min(1), ...base, assigneeId: z.string().min(1) }).strict();
export type ReassignTaskInput = z.input<typeof reassignSchema>;

export async function reassignTaskAs(user: AccessUser, raw: ReassignTaskInput): Promise<Result> {
    if (!can(user, "requests.resolve") || !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = reassignSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const pre = await prisma.dealTask.findUnique({ where: { id: input.taskId }, select: { leadId: true, assigneeId: true } });
    if (!pre) return { error: "Nenašlo sa.", code: "NOT_FOUND" };
    const fp = canonical({ taskId: input.taskId, assigneeId: input.assigneeId });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId: pre.leadId, types: ["TASK_REASSIGNED"], fp },
        () =>
            withLockTx(async (tx) => {
                // Zámky: aktér, doterajší a nový manažér (FOR SHARE, vzostupne), potom Lead.
                const { lead, actor, users, task } = await resolverTaskTx(tx, user, input.taskId, pre.leadId, input.expectedRevision, [
                    pre.assigneeId,
                    input.assigneeId,
                ]);
                if (task.assigneeId !== pre.assigneeId) throw new AccessError("STALE", "Úloha sa medzitým presunula – obnovujem.");
                if (input.assigneeId === task.assigneeId) throw new AccessError("FORBIDDEN", "Úloha už patrí tomuto manažérovi.");
                const to = assertEligibleAssignee(users.get(input.assigneeId), lead.ownerId);
                await reassignTask(tx, actor, task, to, sourceFor(user), { key: input.idempotencyKey, fp });
            }),
        fail("reassignTask"),
    );
}

// ── „Neposielam" / „Beriem na vedomie" (§6.13, D19) ──────────────────────────

const dismissSchema = z
    .object({
        leadId: z.string().min(1),
        ...base,
        taskId: z.string().min(1),
        items: z
            .array(z.object({ kind: z.enum(ITEM_KINDS), designId: z.string().min(1).optional() }).strict())
            .min(1)
            .max(20),
        reason: z.string().max(TASK_REASON_MAX).nullish(),
    })
    .strict();
export type DismissResultsInput = z.input<typeof dismissSchema>;

export async function dismissResultsAs(user: AccessUser, raw: DismissResultsInput): Promise<Result> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = dismissSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const items = sortedItems(input.items.map((i) => ({ taskId: input.taskId, kind: i.kind, ...(i.designId ? { designId: i.designId } : {}) })));
    const fp = canonical({ taskId: input.taskId, items, reason: trim(input.reason) });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId: input.leadId, types: ["TASK_RESULT_DISMISSED"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor } = await requireDealWork(tx, user, input.leadId, { expectedRevision: input.expectedRevision });
                // Rozhoduje vlastník (aj manažér na svojom obchode); na obchode bez vlastníka manažér (§5.2).
                assertDecidesResults(lead, actor);
                await dismissItems(tx, actor, lead.id, { items, reason: input.reason }, sourceFor(user), { key: input.idempotencyKey, fp });
            }),
        fail("dismissResults"),
    );
}

// ── Preberám klienta / prijatie odovzdania (§6.8, §6.9) ──────────────────────

const takeoverSchema = z
    .object({
        leadId: z.string().min(1),
        ...base,
        note: z.string().max(1000).nullish(),
        step: z
            .object({ kind: z.enum(FOLLOW_UP_NEXT_KINDS), schedule: scheduleSchema.nullish(), note: z.string().max(1000).nullish() })
            .strict(),
    })
    .strict();
export type TakeoverInput = z.input<typeof takeoverSchema>;

export async function takeoverAs(user: AccessUser, raw: TakeoverInput): Promise<Result> {
    if (!can(user, "deals.manage") || !can(user, "deals.receive")) return FORBIDDEN;
    const parsed = takeoverSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const pre = await prisma.lead.findUnique({
        where: { id: input.leadId },
        select: { ownerId: true, tasks: { where: { status: "OPEN" }, select: { assigneeId: true } } },
    });
    if (!pre) return { error: "Nenašlo sa.", code: "NOT_FOUND" };
    const stepNote = trim(input.step.note);
    const fp = canonical({
        ownerId: user.id,
        note: trim(input.note),
        step: { kind: input.step.kind, schedule: input.step.schedule ?? null, note: stepNote },
    });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId: input.leadId, types: ["OWNER_CHANGED"], fp },
        () =>
            withLockTx(async (tx) => {
                // Zámky: aktér (= nový vlastník), doterajší vlastník, manažér úlohy, ktorá skončí; potom Lead (§5.5).
                const { lead, actor, users } = await requireDealManage(tx, user, input.leadId, {
                    expectedRevision: input.expectedRevision,
                    lockUserIds: [pre.ownerId ?? "", ...pre.tasks.map((t) => t.assigneeId)].filter(Boolean),
                });
                if (!isOpenDealStatus(lead.status)) throw new AccessError("DEAL_CLOSED");
                if (lead.ownerId === actor.id) throw new AccessError("FORBIDDEN", "Obchod už je tvoj.");
                const me = users.get(actor.id);
                if (!me || !can(me, "deals.receive")) throw new AccessError("FORBIDDEN");
                const option = nextStepOption(input.step.kind);
                const when = input.step.schedule ? resolveSchedule(input.step.schedule) : null;
                const inProgress = option?.mode === "IN_PROGRESS";
                const step: NextActionData = {
                    nextActionKind: input.step.kind,
                    nextActionAt: inProgress ? new Date() : (when?.at ?? businessTodayStart()),
                    nextActionHasTime: inProgress ? false : (when?.hasTime ?? false),
                    nextActionMode: option?.mode ?? "SCHEDULED",
                    nextActionNote: stepNote ?? defaultStepNote(input.step.kind),
                };
                await assertStepAllowed(tx, lead.id, step.nextActionKind);
                await ownerTransition(tx, actor, lead, me, {
                    kind: "TAKEOVER",
                    source: "PIPELINE",
                    note: input.note,
                    step,
                    primary: { key: input.idempotencyKey, fp },
                });
            }),
        fail("takeover"),
    );
}
