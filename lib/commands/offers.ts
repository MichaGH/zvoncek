import { z } from "zod";
import { AccessError, FORBIDDEN, isUniqueViolation, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealManage, requireDealWork } from "@/lib/access/leads";
import { withLockTx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { createAuditActivity } from "@/lib/activityLog";
import { sourceFor } from "@/lib/commands/dealWork";
import { businessDate, isValidBusinessDate } from "@/lib/domain/businessTime";
import { updateLead } from "@/lib/domain/dealMutations";
import { activityReplay } from "@/lib/domain/idempotency";
import { CORRECTABLE_TYPES, correctRecord, recordOffer } from "@/lib/domain/offerMutations";
import { isValidSentOn, OFFER_CONTENTS, offerFingerprint, offerFingerprintOfMeta } from "@/lib/domain/offers";
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
    if (input.followUpOn && (!input.followUp || !isValidBusinessDate(input.followUpOn) || input.followUpOn < businessDate(new Date()))) {
        return { error: "Neplatný dátum hovoru." };
    }

    const replayKey = {
        userId: user.id,
        leadId: input.leadId,
        types: ["OFFER_SENT"] as const,
        fingerprint: (row: { meta: unknown }) => offerFingerprintOfMeta(row.meta),
        want: offerFingerprint({ channel: "EMAIL", contents: input.contents, sentOn: input.sentOn, historical: input.historical, designIds: input.designIds }),
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
                },
                sourceFor(user),
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
