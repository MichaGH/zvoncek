import { z } from "zod";
import { AccessError, FORBIDDEN, isUniqueViolation, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealManage, requireDealWork } from "@/lib/access/leads";
import { withLockTx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { createAuditActivity } from "@/lib/activityLog";
import { sourceFor } from "@/lib/commands/dealWork";
import { businessDate, isValidBusinessDate } from "@/lib/domain/businessTime";
import { cancelTaskSchema, updateLead } from "@/lib/domain/dealMutations";
import { activityReplay } from "@/lib/domain/idempotency";
import { CORRECTABLE_TYPES, correctRecord, recordOffer } from "@/lib/domain/offerMutations";
import { isValidSentOn, OFFER_CONTENTS, offerFingerprint, offerFingerprintOfMeta } from "@/lib/domain/offers";
import { dismissInputSchema, fulfilsSchema, OVERLAP_CHOICES, overlapsTask, type ItemRef } from "@/lib/domain/tasks";
import { assertDecidesResults, cancelOpenTask, dismissItems, loadPending, openTaskOf, requireOpenTask, unlockStep } from "@/lib/domain/taskMutations";
import { can } from "@/lib/permissions";

// „Čo sme poslali" + opravy + potvrdenie starých záznamov (round 2, wave 3a – §2c).
// Guard: requireDealWork (vlastník alebo manažér); spätné záznamy a potvrdenie starých len manažér.

type Result = { success: true } | ActionError;

const recordSchema = z
    .object({
        leadId: z.string().min(1),
        expectedRevision: z.number().int().min(0),
        idempotencyKey: z.string().min(8).max(100),
        contents: z.array(z.enum(OFFER_CONTENTS)).min(1).max(OFFER_CONTENTS.length),
        sentOn: z.string(),
        historical: z.boolean().default(false),
        price: z
            .object({ amount: z.number().finite().min(0).max(10_000_000), note: z.string().max(2000).nullable() })
            .strict()
            .nullish(),
        designIds: z.array(z.string().min(1)).max(10).optional(),
        followUp: z.boolean(),
        followUpOn: z.string().optional(),
        // Wave 3 (§5.1, §6.4): voľba pri prekryve s otvorenou úlohou, zrušenie úlohy („už to netreba"),
        // použité vrátené položky a položky, ktoré sa v tom istom uložení neposielajú (napr. staršia cena).
        overlap: z.enum(OVERLAP_CHOICES).nullish(),
        cancelTask: cancelTaskSchema.nullish(),
        fulfils: fulfilsSchema.nullish(),
        dismiss: dismissInputSchema.nullish(),
    })
    .strict();

export type RecordOfferSentInput = z.input<typeof recordSchema>;

export async function recordOfferSentAs(user: AccessUser, raw: RecordOfferSentInput): Promise<Result> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    if (!isValidSentOn(input.sentOn, businessDate(new Date()))) return { error: "Neplatný dátum odoslania." };
    if (input.historical && (!can(user, "deals.manage") || input.followUp)) return { error: "Neplatné údaje." };
    // Spätný záznam nikdy nevybavuje úlohy ani ich výsledky (§4.2).
    if (input.historical && (input.overlap || input.cancelTask || input.fulfils?.length || input.dismiss)) return { error: "Neplatné údaje." };
    // Voľba pri prekryve a zrušenie úlohy sa musia zhodovať (R01-5): „zrušiť" = presne jedno cancelTask s dôvodom,
    // „ostáva otvorená" / žiadna voľba = žiadne cancelTask.
    if ((input.overlap === "CANCEL_TASK") !== Boolean(input.cancelTask)) return { error: "Neplatné údaje." };
    if (input.cancelTask && !input.cancelTask.reason?.trim()) return { error: "Napíš, prečo úlohu rušíš." };
    if (input.followUpOn && (!input.followUp || !isValidBusinessDate(input.followUpOn) || input.followUpOn < businessDate(new Date()))) {
        return { error: "Neplatný dátum hovoru." };
    }

    const replayKey = {
        userId: user.id,
        leadId: input.leadId,
        types: ["OFFER_SENT"] as const,
        fingerprint: (row: { meta: unknown }) => offerFingerprintOfMeta(row.meta),
        want: offerFingerprint({
            channel: "EMAIL",
            contents: input.contents,
            sentOn: input.sentOn,
            historical: input.historical,
            designIds: input.designIds,
            price: input.price ?? null,
            followUp: input.followUp,
            followUpOn: input.followUpOn ?? null,
            overlap: input.overlap ?? null,
            cancelTask: input.cancelTask ?? null,
            fulfils: input.fulfils ?? [],
            dismiss: input.dismiss ?? null,
        }),
    };
    const first = await activityReplay(input.idempotencyKey, replayKey);
    if (first) return first;

    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealWork(tx, user, input.leadId, {
                expectedRevision: input.expectedRevision,
                closedPolicy: can(user, "deals.manage") ? "allow" : "reject",
            });
            // Spätný záznam patrí len k starým obchodom, kým ich manažér nepotvrdí.
            if (input.historical && (!lead.hadLegacySends || lead.legacySendsReviewedAt)) {
                throw new AccessError("FORBIDDEN", "Spätný záznam je len pre neoverené staré obchody.");
            }
            const source = sourceFor(user);
            // Zamknutý krok (§5.1): odoslanie je len fakt, pokiaľ sa v tom istom uložení úloha neruší. Odoslanie toho,
            // na čom manažér práve robí, bez voľby neprejde (W3-R2-05); „už to netreba" ruší len vlastník.
            const open = input.historical ? null : await openTaskOf(tx, lead.id);
            if (!open && input.cancelTask) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
            if (open && overlapsTask(open, input.contents) && !input.overlap) throw new AccessError("TASK_OVERLAP");
            let factOnly = Boolean(open);
            if (open && input.cancelTask) {
                const task = await requireOpenTask(tx, lead.id, input.cancelTask.taskId);
                if (lead.ownerId !== actor.id) throw new AccessError("FORBIDDEN", "Úlohu ruší vlastník obchodu.");
                await cancelOpenTask(tx, actor, task, input.cancelTask.reason!.trim(), source);
                await unlockStep(tx, lead);
                factOnly = false;
            }
            let dismissed: ItemRef[] = [];
            if (input.dismiss) {
                assertDecidesResults(lead, actor);
                dismissed = await dismissItems(tx, actor, lead.id, input.dismiss, source, { pending: await loadPending(tx, lead.id) });
            }
            await recordOffer(
                tx,
                actor,
                lead,
                {
                    channel: "EMAIL",
                    contents: input.contents,
                    sentOn: input.sentOn,
                    historical: input.historical,
                    price: input.price ?? null,
                    designIds: input.designIds,
                    followUp: input.followUp,
                    followUpOn: input.followUpOn,
                    idempotencyKey: input.idempotencyKey,
                    fulfils: (input.fulfils ?? []).map((f) => ({ taskId: f.taskId, kind: f.kind, ...(f.designId ? { designId: f.designId } : {}) })),
                    dismissedInSave: dismissed,
                    factOnly,
                    fp: replayKey.want,
                },
                source,
            );
        });
        return { success: true };
    } catch (error) {
        if (isUniqueViolation(error) || (error instanceof AccessError && error.code === "STALE")) {
            const again = await activityReplay(input.idempotencyKey, replayKey);
            if (again) return again;
        }
        return toActionError(error, "Nepodarilo sa uložiť.", "recordOfferSent");
    }
}

// Prečiarknutie záznamu (odoslanie, SMS, odpoveď klienta). Autor alebo manažér; dôvod povinný.
export async function correctRecordAs(user: AccessUser, activityId: string, reasonRaw: string): Promise<Result> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
    if (reason.length < 3 || reason.length > 500) return { error: "Napíš krátky dôvod opravy." };
    try {
        await withLockTx(async (tx) => {
            const pre = await tx.activity.findUnique({ where: { id: activityId }, select: { leadId: true } });
            if (!pre) throw new AccessError("NOT_FOUND");
            const { actor, isManager } = await requireDealWork(tx, user, pre.leadId, {
                closedPolicy: can(user, "deals.manage") ? "allow" : "reject",
            });
            const activity = await tx.activity.findUnique({
                where: { id: activityId },
                select: { id: true, leadId: true, type: true, userId: true, revertedAt: true, meta: true },
            });
            if (!activity || activity.leadId !== pre.leadId) throw new AccessError("NOT_FOUND");
            if (!(CORRECTABLE_TYPES as readonly string[]).includes(activity.type)) {
                throw new AccessError("FORBIDDEN", "Tento záznam sa nedá opraviť.");
            }
            if (activity.userId !== actor.id && !isManager) throw new AccessError("FORBIDDEN", "Opraviť môže autor alebo manažér.");
            if (activity.revertedAt) throw new AccessError("STALE", "Záznam už bol opravený.");
            await correctRecord(tx, actor, activity, reason);
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa opraviť.", "correctRecord");
    }
}

// Manažér potvrdí, že staré záznamy obchodu sú doplnené – odvtedy prázdne znamená „nie", nie „?".
export async function confirmLegacyReviewedAs(user: AccessUser, leadId: string): Promise<Result> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealManage(tx, user, leadId);
            if (!lead.hadLegacySends) throw new AccessError("FORBIDDEN", "Obchod nemá staré záznamy.");
            if (lead.legacySendsReviewedAt) throw new AccessError("STALE", "Už potvrdené.");
            await updateLead(tx, lead.id, { legacySendsReviewedAt: new Date() });
            await tx.activity.create({
                data: createAuditActivity({
                    leadId: lead.id,
                    userId: actor.id,
                    type: "CONTACT_UPDATED",
                    source: "PIPELINE",
                    note: "Staré záznamy o odoslaní overené – doplnené je všetko, čo klient dostal",
                }),
            });
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa uložiť.", "confirmLegacyReviewed");
    }
}
