import { z } from "zod";
import type { DealRequestKind } from "@/app/generated/prisma/enums";
import type { Lead } from "@/app/generated/prisma/client";
import { AccessError, FORBIDDEN, isUniqueViolation, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealWork, type ClosedPolicy } from "@/lib/access/leads";
import { withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { createPlanningActivity, describeNextAction } from "@/lib/activityLog";
import { ensureOpenRequest, closeRequestsForStatus } from "@/lib/domain/dealRequests";
import * as deal from "@/lib/domain/dealMutations";
import { idempotentReplay } from "@/lib/domain/idempotency";
import {
    dealStateForFollowUp,
    FOLLOW_UP_NEXT_KINDS,
    FOLLOW_UP_OUTCOMES,
} from "@/lib/domain/leadFlow";
import { bump, bumpLeadOnce, markLeadBumped } from "@/lib/domain/revision";
import { resolveSchedule, scheduleSchema } from "@/lib/domain/schedule";
import { can } from "@/lib/permissions";

// Akcie obchodníka na VLASTNÝCH obchodoch (/dashboard/clients). Guard: requireDealWork – manažér alebo vlastník
// s clients.work; uzavreté obchody sú pre obchodníka len na čítanie (okrem REOPEN požiadavky). Zdroj CLIENTS.

export type Ok = { success: true };
export type CommandResult = Ok | ActionError;
type Actor = { id: string; firstName: string };

async function owned(
    user: AccessUser,
    leadId: string,
    label: string,
    fn: (tx: Tx, lead: Lead, actor: Actor) => Promise<void>,
    opts: { expectedRevision?: number; closedPolicy?: ClosedPolicy } = {},
): Promise<CommandResult> {
    if (!can(user, "clients.work") && !can(user, "pipeline.manage")) return FORBIDDEN;
    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealWork(tx, user, leadId, {
                expectedRevision: opts.expectedRevision,
                closedPolicy: opts.closedPolicy ?? "reject",
            });
            await fn(tx, lead, actor);
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa uložiť.", label);
    }
}

// ── Follow-up hovor ─────────────────────────────────────────────────────────

const followUpSchema = z.object({
    leadId: z.string().min(1),
    outcome: z.enum(FOLLOW_UP_OUTCOMES),
    expectedRevision: z.number().int().min(0),
    idempotencyKey: z.string().min(8).max(100),
    schedule: scheduleSchema.nullish(),
    note: z.string().max(5000).nullish(),
    nextKind: z.enum(FOLLOW_UP_NEXT_KINDS).nullish(),
    lostReason: z.string().max(500).nullish(),
});

export type FollowUpInput = z.input<typeof followUpSchema>;

export async function logFollowUpAs(user: AccessUser, raw: FollowUpInput): Promise<CommandResult> {
    if (!can(user, "clients.work") && !can(user, "pipeline.manage")) return FORBIDDEN;
    const parsed = followUpSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const replayKey = { userId: user.id, leadId: input.leadId, source: "CLIENTS" as const, outcome: input.outcome };

    const replay = await idempotentReplay(input.idempotencyKey, replayKey);
    if (replay) return "error" in replay ? replay : { success: true };

    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealWork(tx, user, input.leadId, {
                expectedRevision: input.expectedRevision,
                closedPolicy: "reject",
            });
            const now = new Date();
            const when = input.schedule ? resolveSchedule(input.schedule, now) : null;
            let state: ReturnType<typeof dealStateForFollowUp>;
            try {
                state = dealStateForFollowUp(
                    input.outcome,
                    { when, nextKind: input.nextKind, note: input.note, lostReason: input.lostReason },
                    lead,
                    now,
                );
            } catch (error) {
                throw new AccessError("FORBIDDEN", error instanceof Error ? error.message : "Neplatný výsledok.");
            }
            const note = input.note?.trim() || null;

            await tx.activity.create({
                data: {
                    leadId: lead.id,
                    userId: actor.id,
                    type: "CALL",
                    category: "BUSINESS",
                    source: "CLIENTS",
                    outcome: input.outcome,
                    note,
                    idempotencyKey: input.idempotencyKey,
                },
            });

            const { closes, lostReason, request, status, ...next } = state;
            await tx.lead.update({
                where: { id: lead.id },
                data: {
                    status,
                    ...next,
                    ...(closes ? { closedAt: now, lostReason: lostReason ?? null } : {}),
                    ...bump,
                },
            });
            markLeadBumped(tx, lead.id);

            await tx.activity.create({
                data: createPlanningActivity({
                    leadId: lead.id,
                    userId: actor.id,
                    type: !next.nextActionKind ? "NEXT_ACTION_CLEARED" : lead.nextActionKind ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                    source: "CLIENTS",
                    note: describeNextAction(next),
                }),
            });
            if (request) await ensureOpenRequest(tx, lead.id, request, actor, note, "CLIENTS");
            if (closes) await closeRequestsForStatus(tx, lead.id, status as "LOST" | "UNREACHABLE", actor.id, "CLIENTS");
        });
        return { success: true };
    } catch (error) {
        const lostRace =
            isUniqueViolation(error) ||
            (error instanceof AccessError && ["STALE", "DEAL_CLOSED", "NOT_FOUND"].includes(error.code));
        if (lostRace) {
            const again = await idempotentReplay(input.idempotencyKey, replayKey);
            if (again) return "error" in again ? again : { success: true };
        }
        return toActionError(error, "Nepodarilo sa uložiť. Skús znova.", "logFollowUp");
    }
}

// ── Detail obchodu ──────────────────────────────────────────────────────────

export const setClientNextActionAs = (user: AccessUser, leadId: string, input: deal.NextActionInput, expectedRevision: number) =>
    owned(user, leadId, "setClientNextAction", (tx, lead, actor) => deal.setNextAction(tx, actor, lead, input, "CLIENTS"), {
        expectedRevision,
    });

export const updateClientContactAs = (user: AccessUser, leadId: string, data: deal.DealContactInput) =>
    owned(user, leadId, "updateClientContact", (tx, lead, actor) => deal.updateDealContact(tx, actor, lead, data, "CLIENTS"));

export const saveClientQuoteAs = (user: AccessUser, leadId: string, input: { price: number | null; priceNote: string | null }) =>
    owned(user, leadId, "saveClientQuote", (tx, lead, actor) => deal.saveQuote(tx, actor, lead, input, "CLIENTS"));

export const setClientQuoteSentAs = (user: AccessUser, leadId: string, sent: boolean) =>
    owned(user, leadId, "setClientQuoteSent", (tx, lead, actor) => deal.setQuoteSent(tx, actor, lead, sent, "CLIENTS"));

export const setClientPriceDisclosedAs = (user: AccessUser, leadId: string, disclosed: boolean) =>
    owned(user, leadId, "setClientPriceDisclosed", (tx, lead, actor) => deal.setPriceDisclosed(tx, actor, lead, disclosed, "CLIENTS"));

export const logClientEmailSentAs = (user: AccessUser, leadId: string) =>
    owned(user, leadId, "logClientEmailSent", (tx, lead, actor) => deal.logSent(tx, actor, lead, "EMAIL_SENT", "CLIENTS"));

export const addClientNoteAs = (user: AccessUser, leadId: string, note: string) =>
    owned(user, leadId, "addClientNote", (tx, lead, actor) => deal.addBusinessNote(tx, actor, lead, { note }, "CLIENTS"));

// ── Požiadavky obchodníka ───────────────────────────────────────────────────

const REQUEST_KINDS = ["PRICE", "DESIGN", "EMAIL", "ORDER", "REOPEN", "OTHER"] as const satisfies readonly DealRequestKind[];

export async function createDealRequestAs(
    user: AccessUser,
    leadId: string,
    kind: DealRequestKind,
    note: string | null,
): Promise<{ success: true; created: boolean } | ActionError> {
    if (!(REQUEST_KINDS as readonly string[]).includes(kind)) return { error: "Neplatný druh požiadavky." };
    let created = false;
    const result = await owned(
        user,
        leadId,
        "createDealRequest",
        async (tx, lead, actor) => {
            created = (await ensureOpenRequest(tx, lead.id, kind, actor, note, "CLIENTS")).created;
        },
        // REOPEN len na uzavretom obchode; všetky ostatné len na otvorenom.
        { closedPolicy: kind === "REOPEN" ? "reopenRequestOnly" : "reject" },
    );
    return "error" in result ? result : { success: true, created };
}

export async function cancelOwnDealRequestAs(user: AccessUser, requestId: string, note: string | null): Promise<CommandResult> {
    if (!can(user, "clients.work") && !can(user, "pipeline.manage")) return FORBIDDEN;
    try {
        await withLockTx(async (tx) => {
            const pre = await tx.dealRequest.findUnique({
                where: { id: requestId },
                select: { leadId: true, lead: { select: { status: true } } },
            });
            if (!pre) throw new AccessError("NOT_FOUND");
            // Vlastník smie zrušiť vlastnú požiadavku na otvorenom obchode aj REOPEN na uzavretom. Stav sa overí pod zámkom;
            // ak sa medzitým zmenil, guard vráti DEAL_CLOSED/FORBIDDEN a klient sa obnoví.
            const policy: ClosedPolicy = can(user, "pipeline.manage")
                ? "allow"
                : ["WON", "LOST", "UNREACHABLE"].includes(pre.lead.status)
                  ? "reopenRequestOnly"
                  : "reject";
            const { actor } = await requireDealWork(tx, user, pre.leadId, { closedPolicy: policy });
            const request = await tx.dealRequest.findUnique({ where: { id: requestId } });
            if (!request || request.leadId !== pre.leadId) throw new AccessError("NOT_FOUND");
            if (request.createdById !== actor.id) throw new AccessError("FORBIDDEN", "Zrušiť môžeš len vlastnú požiadavku.");
            if (request.status !== "OPEN") throw new AccessError("STALE", "Požiadavka už bola vybavená.");
            const resolutionNote = note?.trim() || "Zrušené obchodníkom";
            await bumpLeadOnce(tx, request.leadId);
            await tx.dealRequest.update({
                where: { id: request.id },
                data: { status: "CANCELLED", resolvedById: actor.id, resolvedAt: new Date(), resolutionNote },
            });
            await tx.activity.create({
                data: {
                    leadId: request.leadId,
                    userId: actor.id,
                    type: "REQUEST_RESOLVED",
                    category: "BUSINESS",
                    source: "CLIENTS",
                    note: `Požiadavka zrušená: ${resolutionNote}`,
                    meta: { requestId: request.id, kind: request.kind, status: "CANCELLED" },
                },
            });
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa zrušiť požiadavku.", "cancelOwnDealRequest");
    }
}
