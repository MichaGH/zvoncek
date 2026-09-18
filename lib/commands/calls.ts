import { z } from "zod";
import {
    AccessError,
    FORBIDDEN,
    isUniqueViolation,
    toActionError,
    type ActionError,
} from "@/lib/access/errors";
import { lockLeadWithUsers, requireCallLead } from "@/lib/access/leads";
import { lockTeams, lockUsers, withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { createAuditActivity, createPlanningActivity, describeNextAction } from "@/lib/activityLog";
import { ensureOpenRequest } from "@/lib/domain/dealRequests";
import { resolveDealOwner } from "@/lib/domain/dealRouting";
import { FIRST_CALL_OUTCOMES, isHandoffOutcome, leadStateForOutcome } from "@/lib/domain/leadFlow";
import { bump, markLeadBumped } from "@/lib/domain/revision";
import { isDayOnlySnooze, resolveSchedule, scheduleSchema } from "@/lib/domain/schedule";
import { can } from "@/lib/permissions";
import { idempotentReplay, type HandoffRecipient, type LogCallResult } from "@/lib/domain/idempotency";

type Recipient = HandoffRecipient;

const logCallSchema = z.object({
    leadId: z.string().min(1),
    outcome: z.enum(FIRST_CALL_OUTCOMES),
    expectedRevision: z.number().int().min(0),
    idempotencyKey: z.string().min(8).max(100),
    note: z.string().max(5000).optional(),
    callbackNote: z.string().max(500).optional(),
    schedule: scheduleSchema.optional(),
    email: z.string().max(200).optional(),
});

export type LogCallInput = z.input<typeof logCallSchema>;

export async function logCallAs(user: AccessUser, raw: LogCallInput): Promise<LogCallResult> {
    if (!can(user, "calls.work")) return FORBIDDEN;

    const parsed = logCallSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const { outcome } = input;
    if (outcome === "CALL_AGAIN" && !input.schedule) return { error: "Vyber termín." };
    if (outcome === "SNOOZE" && !(input.schedule && isDayOnlySnooze(input.schedule))) return { error: "Vyber dátum." };

    const replayKey = { userId: user.id, leadId: input.leadId, source: "CALL_QUEUE" as const, outcome };
    const replay = await idempotentReplay(input.idempotencyKey, replayKey);
    if (replay) return replay;

    try {
        const result = await withLockTx(async (tx) => {
            const handoff = isHandoffOutcome(outcome);

            // Zámky v poradí Team → User → Lead (§10.1). Tím a vedúceho len pre handoff.
            let preTeamId: string | null = null;
            let leaderId: string | null = null;
            if (handoff) {
                const pre = await tx.user.findUnique({ where: { id: user.id }, select: { teamId: true } });
                preTeamId = pre?.teamId ?? null;
                if (preTeamId) {
                    const teams = await lockTeams(tx, [preTeamId], "SHARE");
                    leaderId = teams.get(preTeamId)?.leaderId ?? null;
                }
            }
            const users = await lockUsers(tx, [user.id, leaderId], "SHARE");
            const caller = users.get(user.id);
            if (!caller || caller.deletedAt) throw new AccessError("UNAUTHENTICATED");
            if (!can(caller, "calls.work")) throw new AccessError("FORBIDDEN");
            if (handoff && caller.teamId !== preTeamId) throw new AccessError("RETRYABLE");
            const ownerId = handoff ? resolveDealOwner(caller, leaderId ? users.get(leaderId) : null) : null;

            const { lead } = await requireCallLead(tx, user, input.leadId, input.expectedRevision);

            const now = new Date();
            const when = input.schedule ? resolveSchedule(input.schedule, now) : null;
            const callbackNote = input.callbackNote?.trim() || null;
            const note = input.note?.trim() ?? null;

            const call = await tx.activity.create({
                data: {
                    leadId: lead.id,
                    userId: user.id,
                    type: "CALL",
                    category: "BUSINESS",
                    source: "CALL_QUEUE",
                    outcome,
                    note: note || null,
                    idempotencyKey: input.idempotencyKey,
                },
                select: { id: true, createdAt: true },
            });

            const flow = leadStateForOutcome(outcome, when, callbackNote, now);
            const { keepsAssignment, ...state } = flow;
            const email = input.email?.trim();
            const updated = await tx.lead.update({
                where: { id: lead.id },
                data: {
                    ...state,
                    ...(keepsAssignment ? {} : { assignedCallerId: null, assignedCallerAt: null }),
                    ...(note !== null && note !== (lead.note ?? "") ? { note: note || null } : {}),
                    ...(handoff && email ? { email } : {}),
                    ...(handoff
                        ? {
                              pipelineEnteredAt: call.createdAt,
                              handedOffById: user.id,
                              ownerId,
                              closedAt: null,
                          }
                        : {}),
                    ...bump,
                },
                select: { revision: true },
            });
            markLeadBumped(tx, lead.id);

            let recipient: Recipient | undefined;
            if (handoff) {
                await tx.activity.create({
                    data: createPlanningActivity({
                        leadId: lead.id,
                        userId: user.id,
                        type: "NEXT_ACTION_SET",
                        source: "CALL_QUEUE",
                        note: describeNextAction(state),
                    }),
                });
                const owner = ownerId ? (users.get(ownerId) ?? caller) : null;
                recipient = owner ? { id: owner.id, name: `${owner.firstName} ${owner.lastName}`.trim() } : null;
                if (recipient) {
                    await tx.activity.create({
                        data: createAuditActivity({
                            leadId: lead.id,
                            userId: user.id,
                            type: "OWNER_CHANGED",
                            source: "CALL_QUEUE",
                            note: `Priradené automaticky: ${recipient.name}`,
                        }),
                    });
                }
                if (outcome === "WANTS_DESIGN") {
                    await ensureOpenRequest(tx, lead.id, "DESIGN", caller, callbackNote, "CALL_QUEUE");
                }
            }

            // Evidencia pre vrátenie – zápis na Activity, revízia leadu sa NEzvyšuje.
            await tx.activity.update({ where: { id: call.id }, data: { leadRevision: updated.revision } });

            return handoff ? { success: true as const, recipient } : { success: true as const };
        });
        return result;
    } catch (error) {
        // Súbežné odoslanie s tým istým kľúčom: druhý pokus čakal na zámok leadu a vidí zmenenú revíziu
        // (alebo narazí na unique index). Ak kľúč medzitým existuje, je to ten istý submit → úspech.
        const lostRace =
            isUniqueViolation(error) ||
            (error instanceof AccessError && (error.code === "STALE" || error.code === "NOT_ASSIGNED"));
        if (lostRace) {
            const again = await idempotentReplay(input.idempotencyKey, replayKey);
            if (again) return again;
        }
        return toActionError(error, "Nepodarilo sa uložiť. Skús znova.", "logCall");
    }
}

const contactSchema = z.object({
    companyName: z.string().max(200).nullable().optional(),
    website: z.string().max(300).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    email: z.string().max(200).nullable().optional(),
});

// Úprava telefónu/emailu z fronty a histórie – mutácia AKTUÁLNEJ zodpovednosti (§5.4).
// Volajúci: len lead, ktorý mu je práve priradený vo fáze volania. Manažér: akýkoľvek lead. Inak NOT_FOUND.
export type ContactPatch = { companyName?: string | null; website?: string | null; phone?: string | null; email?: string | null };

export async function updateLeadContactAs(
    user: AccessUser,
    leadId: string,
    data: ContactPatch,
): Promise<{ success: true } | ActionError> {
    const parsed = contactSchema.safeParse(data);
    if (!parsed.success) return { error: "Neplatné údaje." };

    try {
        await withLockTx(async (tx) => {
            const lead = await lockForContactEdit(tx, user, leadId);
            const changes = Object.fromEntries(
                Object.entries(parsed.data)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [k, typeof v === "string" ? v.trim() || null : v]),
            );
            await tx.lead.update({ where: { id: lead.id }, data: { ...changes, ...bump } });
            markLeadBumped(tx, lead.id);
            await tx.activity.create({
                data: createAuditActivity({
                    leadId: lead.id,
                    userId: user.id,
                    type: "CONTACT_UPDATED",
                    source: "CALL_QUEUE",
                    note: "Kontaktné údaje boli upravené",
                }),
            });
        });
    } catch (error) {
        return toActionError(error, "Nepodarilo sa uložiť kontakt.", "updateLeadContact");
    }
    return { success: true };
}

async function lockForContactEdit(tx: Tx, user: AccessUser, leadId: string) {
    if (can(user, "deals.manage")) {
        // Manažér: zámok priradeného volajúceho (ak je) + aktéra, potom Lead.
        const { lead, users } = await lockLeadWithUsers(tx, leadId, [user.id]);
        const actor = users.get(user.id);
        if (!actor || actor.deletedAt) throw new AccessError("UNAUTHENTICATED");
        if (!can(actor, "deals.manage")) throw new AccessError("NOT_FOUND");
        if (lead.deletedAt) throw new AccessError("NOT_FOUND");
        return lead;
    }
    if (!can(user, "calls.work")) throw new AccessError("NOT_FOUND");
    try {
        const { lead } = await requireCallLead(tx, user, leadId);
        return lead;
    } catch (error) {
        if (error instanceof AccessError && error.code === "NOT_ASSIGNED") throw new AccessError("NOT_FOUND");
        throw error;
    }
}
