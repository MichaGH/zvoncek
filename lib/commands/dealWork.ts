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
import { noteWithReply, REPLY_KEYS } from "@/lib/domain/clientReplies";
import { bump, bumpLeadOnce, markLeadBumped } from "@/lib/domain/revision";
import { resolveSchedule, scheduleSchema } from "@/lib/domain/schedule";
import { can } from "@/lib/permissions";

// Práca na obchode – jedna sada príkazov pre VLASTNÍKA aj manažéra (/dashboard/pipeline).
// Guard: requireDealWork – manažér alebo vlastník s deals.work; uzavreté obchody sú pre vlastníka len na čítanie
// (okrem REOPEN požiadavky). Manažérske zmeny stavu/vlastníka/návrhov sú v lib/commands/pipeline.ts.
//
// Zdroj aktivity sa určuje podľa AKTÉRA, nie podľa cesty (round 2, D-01): manažér = PIPELINE, ostatní = CLIENTS.
// Štatistiky tak vedia rozlíšiť „follow-up obchodníka" od manažérskeho zásahu aj po zlúčení obrazoviek.

function sourceFor(user: AccessUser): "PIPELINE" | "CLIENTS" {
    return can(user, "deals.manage") ? "PIPELINE" : "CLIENTS";
}

export type Ok = { success: true };
export type CommandResult = Ok | ActionError;
type Actor = { id: string; firstName: string };
type Source = "PIPELINE" | "CLIENTS";

async function owned(
    user: AccessUser,
    leadId: string,
    label: string,
    fn: (tx: Tx, lead: Lead, actor: Actor, source: Source) => Promise<void>,
    opts: { expectedRevision?: number; closedPolicy?: ClosedPolicy } = {},
): Promise<CommandResult> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealWork(tx, user, leadId, {
                expectedRevision: opts.expectedRevision,
                closedPolicy: opts.closedPolicy ?? "reject",
            });
            await fn(tx, lead, actor, sourceFor(user));
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
    reply: z.enum(REPLY_KEYS as [string, ...string[]]).nullish(),
});

export type FollowUpInput = z.input<typeof followUpSchema>;

export async function logFollowUpAs(user: AccessUser, raw: FollowUpInput): Promise<CommandResult> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = followUpSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const source = sourceFor(user);
    const replayKey = { userId: user.id, leadId: input.leadId, source, outcome: input.outcome };

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
            // V histórii chceme čítať „čo povedali" bez lúštenia meta; kľúč ostáva strojovo spracovateľný.
            const note = noteWithReply(input.reply, input.note);

            await tx.activity.create({
                data: {
                    leadId: lead.id,
                    userId: actor.id,
                    type: "CALL",
                    category: "BUSINESS",
                    source,
                    outcome: input.outcome,
                    note,
                    ...(input.reply ? { meta: { reply: input.reply } } : {}),
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
                    source,
                    note: describeNextAction(next),
                }),
            });
            if (request) await ensureOpenRequest(tx, lead.id, request, actor, note, source);
            if (closes) await closeRequestsForStatus(tx, lead.id, status as "LOST" | "UNREACHABLE", actor.id, source);
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

export const setDealNextActionAs = (user: AccessUser, leadId: string, input: deal.NextActionInput, expectedRevision: number) =>
    owned(user, leadId, "setDealNextAction", (tx, lead, actor, source) => deal.setNextAction(tx, actor, lead, input, source), {
        expectedRevision,
    });

export const updateDealContactAs = (user: AccessUser, leadId: string, data: deal.DealContactInput) =>
    owned(user, leadId, "updateDealContact", (tx, lead, actor, source) => deal.updateDealContact(tx, actor, lead, data, source));

export const saveDealQuoteAs = (user: AccessUser, leadId: string, input: { price: number | null; priceNote: string | null }) =>
    owned(user, leadId, "saveDealQuote", (tx, lead, actor, source) => deal.saveQuote(tx, actor, lead, input, source));

export const setDealQuoteSentAs = (user: AccessUser, leadId: string, sent: boolean) =>
    owned(user, leadId, "setDealQuoteSent", (tx, lead, actor, source) => deal.setQuoteSent(tx, actor, lead, sent, source));

export const setDealPriceDisclosedAs = (user: AccessUser, leadId: string, disclosed: boolean) =>
    owned(user, leadId, "setDealPriceDisclosed", (tx, lead, actor, source) => deal.setPriceDisclosed(tx, actor, lead, disclosed, source));

export const logDealEmailSentAs = (user: AccessUser, leadId: string) =>
    owned(user, leadId, "logDealEmailSent", (tx, lead, actor, source) => deal.logSent(tx, actor, lead, "EMAIL_SENT", source));

export const addDealNoteAs = (user: AccessUser, leadId: string, note: string) =>
    owned(user, leadId, "addDealNote", (tx, lead, actor, source) => deal.addBusinessNote(tx, actor, lead, { note }, source));

// ── Požiadavky obchodníka ───────────────────────────────────────────────────

const REQUEST_KINDS = ["PRICE", "DESIGN", "EMAIL", "ORDER", "REOPEN", "OTHER"] as const satisfies readonly DealRequestKind[];

// Pri týchto druhoch nedáva požiadavka bez textu zmysel – manažér by nevedel, čo si klient objednáva
// alebo čo má návrh obsahovať (round 2, D-08/B-05). Vynútené na serveri, nielen v UI.
const REQUIRE_NOTE: DealRequestKind[] = ["ORDER", "DESIGN", "OTHER"];

export async function createDealRequestAs(
    user: AccessUser,
    leadId: string,
    kind: DealRequestKind,
    note: string | null,
): Promise<{ success: true; created: boolean } | ActionError> {
    if (!(REQUEST_KINDS as readonly string[]).includes(kind)) return { error: "Neplatný druh požiadavky." };
    if (REQUIRE_NOTE.includes(kind) && !note?.trim()) {
        return { error: kind === "ORDER" ? "Napíš, čo si klient objednáva." : "Napíš, čo presne treba." };
    }
    let created = false;
    const result = await owned(
        user,
        leadId,
        "createDealRequest",
        async (tx, lead, actor, source) => {
            created = (await ensureOpenRequest(tx, lead.id, kind, actor, note, source)).created;
        },
        // REOPEN len na uzavretom obchode; všetky ostatné len na otvorenom.
        { closedPolicy: kind === "REOPEN" ? "reopenRequestOnly" : "reject" },
    );
    return "error" in result ? result : { success: true, created };
}

export async function cancelOwnDealRequestAs(user: AccessUser, requestId: string, note: string | null): Promise<CommandResult> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    try {
        await withLockTx(async (tx) => {
            const pre = await tx.dealRequest.findUnique({
                where: { id: requestId },
                select: { leadId: true, lead: { select: { status: true } } },
            });
            if (!pre) throw new AccessError("NOT_FOUND");
            // Vlastník smie zrušiť vlastnú požiadavku na otvorenom obchode aj REOPEN na uzavretom. Stav sa overí pod zámkom;
            // ak sa medzitým zmenil, guard vráti DEAL_CLOSED/FORBIDDEN a klient sa obnoví.
            const policy: ClosedPolicy = can(user, "deals.manage")
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
                    source: sourceFor(user),
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
