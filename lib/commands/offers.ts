import { z } from "zod";
import { AccessError, FORBIDDEN, isUniqueViolation, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealWork } from "@/lib/access/leads";
import { withLockTx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { sourceFor } from "@/lib/commands/dealWork";
import { businessDate, isValidBusinessDate } from "@/lib/domain/businessTime";
import { activityReplay } from "@/lib/domain/idempotency";
import { CORRECTABLE_TYPES, correctRecord, recordOffer } from "@/lib/domain/offerMutations";
import { isValidSentOn, OFFER_CONTENTS, offerFingerprint, offerFingerprintOfMeta } from "@/lib/domain/offers";
import { dismissInputSchema, fulfilsSchema, OVERLAP_CHOICES, overlappingKinds, sortTaskContents, TASK_CONTENTS, withdrawMatchesOverlap, type ItemRef } from "@/lib/domain/tasks";
import { applyPartOps, assertDecidesResults, dismissItems, loadPending, openTaskWithParts } from "@/lib/domain/taskMutations";
import { refreshLockedStep, stepOnTaskClose } from "@/lib/domain/lockedStep";
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
        // R01-5: návrh poslaný mimo systému (obchod nemá Design) – DESIGN bez id.
        untrackedDesign: z.boolean().optional(),
        followUp: z.boolean(),
        followUpOn: z.string().optional(),
        // Wave 3 (§5.1, §6.4): voľba pri prekryve s otvorenou úlohou, zrušenie úlohy („už to netreba"),
        // použité vrátené položky a položky, ktoré sa v tom istom uložení neposielajú (napr. staršia cena).
        overlap: z.enum(OVERLAP_CHOICES).nullish(),
        // Wave 4 (§2.8): pri prekryve sa sťahujú ČASTI, ktoré sa práve robia – nie celá úloha. Zrušenie celej úlohy
        // (uspať, uzavrieť, preplánovať) je vlastný vstup iných príkazov a tu nemá čo robiť.
        withdrawParts: z
            .object({ taskId: z.string().min(1), kinds: z.array(z.enum(TASK_CONTENTS)).min(1).max(TASK_CONTENTS.length), reason: z.string().max(500) })
            .strict()
            .nullish(),
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
    if (input.historical && (input.overlap || input.withdrawParts || input.fulfils?.length || input.dismiss)) return { error: "Neplatné údaje." };
    // Voľba pri prekryve a stiahnutie častí sa musia zhodovať (R01-5): „už to netreba" = presne jedno withdrawParts
    // s dôvodom, „ostáva otvorená" / žiadna voľba = žiadne withdrawParts.
    if ((input.overlap === "WITHDRAW_PARTS") !== Boolean(input.withdrawParts)) return { error: "Neplatné údaje." };
    if (input.withdrawParts && !input.withdrawParts.reason.trim()) return { error: "Napíš, prečo to už netreba." };
    if (input.withdrawParts && new Set(input.withdrawParts.kinds).size !== input.withdrawParts.kinds.length) return { error: "Neplatné údaje." };
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
            untrackedDesign: input.untrackedDesign,
            price: input.price ?? null,
            followUp: input.followUp,
            followUpOn: input.followUpOn ?? null,
            overlap: input.overlap ?? null,
            withdrawParts: input.withdrawParts
                ? { taskId: input.withdrawParts.taskId, kinds: sortTaskContents(input.withdrawParts.kinds), reason: input.withdrawParts.reason.trim() }
                : null,
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
            const source = sourceFor(user);
            // Zamknutý krok (§5.1): odoslanie je len fakt, pokiaľ sa v tom istom uložení úloha neruší. Odoslanie toho,
            // na čom manažér práve robí, bez voľby neprejde (W3-R2-05); „už to netreba" ruší len vlastník.
            const open = input.historical ? null : await openTaskWithParts(tx, lead.id);
            if (!open && input.withdrawParts) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
            if (open && overlappingKinds(open, input.contents).length > 0 && !input.overlap) throw new AccessError("TASK_OVERLAP");
            let factOnly = Boolean(open);
            let closedTask = false;
            if (open && input.withdrawParts) {
                if (open.id !== input.withdrawParts.taskId) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
                // R01-4: sťahuje sa presne to, čo toto odoslanie prekrýva – nič navyše, nič mimo.
                if (!withdrawMatchesOverlap(open, input.contents, input.withdrawParts)) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
                if (lead.ownerId !== actor.id) throw new AccessError("FORBIDDEN", "Úlohu ruší vlastník obchodu.");
                const reason = input.withdrawParts.reason.trim();
                const stillOpen = open.parts.filter((p) => p.status === "REQUESTED").map((p) => p.kind);
                const { closed } = await applyPartOps(
                    tx,
                    actor,
                    open,
                    sortTaskContents(input.withdrawParts.kinds).map((kind) => ({ kind, op: "WITHDRAWN" as const, reason })),
                    source,
                    null,
                    { taskReason: stillOpen.every((k) => input.withdrawParts!.kinds.includes(k)) ? reason : null },
                );
                if (closed) {
                    // Krok sa neodomyká hneď (R02-2): najprv sa odoslanie zapíše a požiadavky prepočítajú. Potom buď vyhrá
                    // vyžiadaný „Zavolať, či prišlo" (recordOffer), alebo sa krok odvodí kanonicky ako pri každom konci úlohy.
                    closedTask = true;
                    factOnly = !input.followUp;
                }
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
                    untrackedDesign: input.untrackedDesign,
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
            // Kým úloha ostáva otvorená, krok sa nepreplánuje – len presne nasleduje, čo ešte ostáva (P6, §2.8).
            if (closedTask && !input.followUp && open) await stepOnTaskClose(tx, actor, lead, open, source);
            else if (factOnly) await refreshLockedStep(tx, actor, lead, source);
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
            const { lead, actor, isManager } = await requireDealWork(tx, user, pre.leadId, {
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
            // Kým je úloha otvorená, krok nie je rozhodnutie používateľa a sám ho opraviť nemôže – prečiarknuté odoslanie
            // otvorilo prácu naspäť, takže sa odvodí znova (P6, R02-5). Bez úlohy je to nič a krok ostáva, aký bol.
            await refreshLockedStep(tx, actor, lead, sourceFor(user));
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa opraviť.", "correctRecord");
    }
}
