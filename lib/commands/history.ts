import { z } from "zod";
import type { Lead } from "@/app/generated/prisma/client";
import { AccessError, FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { lockLeadWithUsers } from "@/lib/access/leads";
import { withLockTx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { deleteRequestsOfActivity } from "@/lib/domain/requestMutations";
import { bump, markLeadBumped } from "@/lib/domain/revision";
import { recordOwnership } from "@/lib/domain/taskMutations";
import { can } from "@/lib/permissions";

// Stav leadu musí zodpovedať tomu, čo hovor vytvoril (§5.4 krok 3, obrana do hĺbky).
function stateMatchesCall(lead: Lead, activity: { userId: string; outcome: string | null }): boolean {
    if (lead.pipelineEnteredAt !== null) {
        return lead.handedOffById === activity.userId && lead.status === "ACTIVE";
    }
    switch (activity.outcome) {
        case "NO_ANSWER":
            return lead.status === "CALLING" && lead.callbackKind === "RETRY" && lead.assignedCallerId === activity.userId;
        case "CALL_AGAIN":
            return lead.status === "CALLING" && lead.callbackKind === "SCHEDULED" && lead.assignedCallerId === activity.userId;
        case "SNOOZE":
            return lead.status === "SNOOZED" && lead.assignedCallerId === activity.userId;
        case "NOT_INTERESTED":
            return lead.status === "LOST" && lead.assignedCallerId === null;
        case "BAD_NUMBER":
            return lead.status === "UNREACHABLE" && lead.assignedCallerId === null;
        default:
            return false;
    }
}

// Vrátenie výsledku hovoru (oprava omylu), nahrádza resetLeadToCalls. Lead ide späť autorovi hovoru ako RETRY, nikdy NEW.
export async function revertCallResultAs(
    user: AccessUser,
    activityId: string,
    expectedRevision: number,
): Promise<{ success: true } | ActionError> {
    if (!can(user, "callHistory.revert") && !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = z.object({ activityId: z.string().min(1), expectedRevision: z.number().int().min(0) }).safeParse({
        activityId,
        expectedRevision,
    });
    if (!parsed.success) return { error: "Neplatné údaje." };

    try {
        await withLockTx(async (tx) => {
            const activity = await tx.activity.findUnique({
                where: { id: activityId },
                select: {
                    id: true,
                    leadId: true,
                    userId: true,
                    type: true,
                    source: true,
                    outcome: true,
                    leadRevision: true,
                    revertedAt: true,
                },
            });
            if (!activity) throw new AccessError("NOT_FOUND");

            // Autor (lead mu bude priradený späť) + aktér FOR SHARE, potom Lead (§10.1).
            const { lead, users } = await lockLeadWithUsers(tx, activity.leadId, [activity.userId, user.id]);
            const actor = users.get(user.id);
            if (!actor || actor.deletedAt) throw new AccessError("UNAUTHENTICATED");
            if (lead.deletedAt) throw new AccessError("NOT_FOUND");
            if (lead.revision !== expectedRevision) throw new AccessError("STALE");

            if (activity.type !== "CALL" || activity.source !== "CALL_QUEUE") {
                throw new AccessError("FORBIDDEN", "Vrátiť sa dá len výsledok hovoru z fronty volaní.");
            }
            if (activity.revertedAt) throw new AccessError("FORBIDDEN", "Už bolo vrátené.");

            const latest = await tx.activity.findFirst({
                where: { leadId: lead.id, type: "CALL", revertedAt: null },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                select: { id: true },
            });
            if (latest?.id !== activity.id) {
                throw new AccessError("FORBIDDEN", "Vrátiť sa dá len posledný hovor na kontakte.");
            }

            const isAuthor = activity.userId === actor.id && can(actor, "callHistory.revert");
            if (!isAuthor && !can(actor, "deals.manage")) throw new AccessError("FORBIDDEN");

            if (activity.leadRevision === null || activity.leadRevision !== lead.revision) {
                throw new AccessError("FORBIDDEN", "Kontakt sa od hovoru zmenil – vrátenie nie je možné.");
            }
            if (!stateMatchesCall(lead, activity)) {
                throw new AccessError("FORBIDDEN", "Kontakt sa od hovoru zmenil – vrátenie nie je možné.");
            }

            // Čo klient pýtal v tomto hovore, ide preč s ním (R01-9). Ak už niečo z toho dostal, vrátenie sa odmietne –
            // odoslanie ostáva pravdou a požiadavka, ktorú splnilo, sa nesmie stratiť.
            await deleteRequestsOfActivity(tx, lead.id, activity.id);

            const now = new Date();
            // revertedAt je evidencia na Activity – revíziu nezvyšuje.
            await tx.activity.update({ where: { id: activity.id }, data: { revertedAt: now, revertedById: actor.id } });
            await tx.lead.update({
                where: { id: lead.id },
                data: {
                    status: "CALLING",
                    callbackKind: "RETRY",
                    callbackAt: null,
                    callbackNote: null,
                    callbackHasTime: false,
                    assignedCallerId: activity.userId,
                    assignedCallerAt: now,
                    pipelineEnteredAt: null,
                    handedOffById: null,
                    ownerId: null,
                    closedAt: null,
                    nextActionKind: null,
                    nextActionAt: null,
                    nextActionHasTime: false,
                    nextActionNote: null,
                    nextActionMode: "SCHEDULED",
                    lostReason: null,
                    ...bump,
                },
            });
            markLeadBumped(tx, lead.id);
            // Po úlohe sa vrátiť nedá (úloha zvýši revíziu – §6.12). Zrušené odovzdanie sa zapíše do histórie vlastníctva;
            // História obchodníka riadky REVERT nezobrazuje.
            if (lead.ownerId) {
                await recordOwnership(tx, { leadId: lead.id, fromUserId: lead.ownerId, toUserId: null, byUserId: actor.id, reason: "REVERT" });
            }
            await tx.activity.create({
                data: {
                    leadId: lead.id,
                    userId: actor.id,
                    type: "CALL_REVERTED",
                    category: "AUDIT",
                    source: "CALL_QUEUE",
                    note: "Výsledok hovoru vrátený – kontakt je späť v „Skúsiť znova“",
                    meta: { revertedActivityId: activity.id, previousOutcome: activity.outcome },
                },
            });
        });
    } catch (error) {
        return toActionError(error, "Nepodarilo sa vrátiť výsledok hovoru.", "revertCallResult");
    }
    return { success: true };
}
