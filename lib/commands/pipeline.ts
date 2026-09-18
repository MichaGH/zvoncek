import type { DealRequestStatus, LeadStatus, ProjectType } from "@/app/generated/prisma/enums";
import { AccessError, FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealManage } from "@/lib/access/leads";
import { lockUsers, withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import type { Lead } from "@/app/generated/prisma/client";
import * as deal from "@/lib/domain/dealMutations";
import { bumpLeadOnce } from "@/lib/domain/revision";
import { REQUEST_KIND_LABEL } from "@/lib/dictionaries";
import { can } from "@/lib/permissions";
import prisma from "@/lib/db";

// Manažérske mutácie obchodu (pipeline). Guard: requireDealManage (deals.manage + značka obchodu, akýkoľvek stav).
// Telá sú v lib/domain/dealMutations.ts, zdieľané s client akciami.

export type Ok = { success: true };
export type CommandResult = Ok | ActionError;

async function managed(
    user: AccessUser,
    leadId: string,
    label: string,
    fn: (tx: Tx, lead: Lead, actor: { id: string; firstName: string }) => Promise<void>,
    opts: { expectedRevision?: number; lockUserIds?: string[] } = {},
): Promise<CommandResult> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealManage(tx, user, leadId, opts);
            await fn(tx, lead, actor);
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa uložiť.", label);
    }
}

export const updateLeadAs = (user: AccessUser, leadId: string, data: deal.DealContactInput) =>
    managed(user, leadId, "updateLead", (tx, lead, actor) => deal.updateDealContact(tx, actor, lead, data, "PIPELINE"));

export const saveQuoteAs = (user: AccessUser, leadId: string, input: { price: number | null; priceNote: string | null }) =>
    managed(user, leadId, "saveQuote", (tx, lead, actor) => deal.saveQuote(tx, actor, lead, input, "PIPELINE"));

export const setQuoteSentAs = (user: AccessUser, leadId: string, sent: boolean) =>
    managed(user, leadId, "setQuoteSent", (tx, lead, actor) => deal.setQuoteSent(tx, actor, lead, sent, "PIPELINE"));

export const setPriceDisclosedAs = (user: AccessUser, leadId: string, disclosed: boolean) =>
    managed(user, leadId, "setPriceDisclosed", (tx, lead, actor) => deal.setPriceDisclosed(tx, actor, lead, disclosed, "PIPELINE"));

export const setProjectTypeAs = (user: AccessUser, leadId: string, projectType: ProjectType | null) =>
    managed(user, leadId, "setProjectType", (tx, lead, actor) => deal.setProjectType(tx, actor, lead, projectType));

export const setNextActionAs = (user: AccessUser, leadId: string, input: deal.NextActionInput, expectedRevision: number) =>
    managed(user, leadId, "setNextAction", (tx, lead, actor) => deal.setNextAction(tx, actor, lead, input, "PIPELINE"), {
        expectedRevision,
    });

export const logSentAs = (user: AccessUser, leadId: string, what: "QUOTE_SENT" | "EMAIL_SENT") =>
    managed(user, leadId, "logSent", (tx, lead, actor) => deal.logSent(tx, actor, lead, what, "PIPELINE"));

export const markLostAs = (user: AccessUser, leadId: string, reason: string | null) =>
    managed(user, leadId, "markLost", (tx, lead, actor) => deal.markLost(tx, actor, lead, reason, "PIPELINE"));

export const addBusinessNoteAs = (user: AccessUser, leadId: string, note: string, type: "NOTE" | "SMS_SENT" = "NOTE") =>
    managed(user, leadId, "addBusinessNote", (tx, lead, actor) => deal.addBusinessNote(tx, actor, lead, { note, type }, "PIPELINE"));

export const changeStatusAs = (user: AccessUser, leadId: string, status: LeadStatus) =>
    managed(user, leadId, "changeStatus", async (tx, lead, actor) => {
        if (!(deal.DEAL_STATUSES as readonly string[]).includes(status)) {
            throw new AccessError("FORBIDDEN", "Neplatný stav obchodu.");
        }
        await deal.changeDealStatus(tx, actor, lead, status as deal.DealStatus, "PIPELINE");
    });

export const reopenDealAs = (user: AccessUser, leadId: string) =>
    managed(user, leadId, "reopenDeal", (tx, lead, actor) => deal.reopenDeal(tx, actor, lead, "PIPELINE"));

// Cieľ zmeny vlastníka: User FOR SHARE (pred Lead), aktívny, deals.receive (§5.3).
export const changeOwnerAs = (user: AccessUser, leadId: string, ownerId: string | null) =>
    managed(
        user,
        leadId,
        "changeOwner",
        async (tx, lead, actor) => {
            let owner: { id: string; firstName: string; lastName: string } | null = null;
            if (ownerId) {
                const target = (await lockUsers(tx, [ownerId], "SHARE")).get(ownerId);
                if (!target || target.deletedAt || !can(target, "deals.receive")) {
                    throw new AccessError("FORBIDDEN", "Tento používateľ nemôže vlastniť obchody.");
                }
                owner = target;
            }
            await deal.changeOwner(tx, actor, lead, owner, "PIPELINE");
        },
        { lockUserIds: ownerId ? [ownerId] : [] },
    );

// ── Požiadavky ──────────────────────────────────────────────────────────────

// Manažér vybaví/zamietne požiadavku. DONE ručne len pre OTHER; ostatné druhy sa vybavia príslušnou akciou (§7.6).
export async function resolveDealRequestAs(
    user: AccessUser,
    requestId: string,
    status: Exclude<DealRequestStatus, "OPEN">,
    note: string | null,
): Promise<CommandResult> {
    if (!can(user, "requests.resolve") || !can(user, "deals.manage")) return FORBIDDEN;
    const text = note?.trim() || null;
    if (status === "CANCELLED" && !text) return { error: "Pri zamietnutí napíš dôvod.", code: "FORBIDDEN" };
    try {
        await withLockTx(async (tx) => {
            const pre = await tx.dealRequest.findUnique({ where: { id: requestId }, select: { leadId: true } });
            if (!pre) throw new AccessError("NOT_FOUND");
            const { actor } = await requireDealManage(tx, user, pre.leadId);
            const request = await tx.dealRequest.findUnique({ where: { id: requestId } });
            if (!request || request.leadId !== pre.leadId) throw new AccessError("NOT_FOUND");
            if (request.status !== "OPEN") throw new AccessError("STALE", "Požiadavka už bola vybavená.");
            if (status === "DONE" && request.kind !== "OTHER") {
                throw new AccessError(
                    "FORBIDDEN",
                    "Vybav cez príslušnú akciu (cena / návrh / email / výhra / znovuotvorenie).",
                );
            }
            await bumpLeadOnce(tx, request.leadId);
            const resolutionNote = text ?? "Vybavené";
            await tx.dealRequest.update({
                where: { id: request.id },
                data: { status, resolvedById: actor.id, resolvedAt: new Date(), resolutionNote },
            });
            await tx.activity.create({
                data: {
                    leadId: request.leadId,
                    userId: actor.id,
                    type: "REQUEST_RESOLVED",
                    category: "BUSINESS",
                    source: "PIPELINE",
                    note: `${REQUEST_KIND_LABEL[request.kind]} – ${status === "DONE" ? "vybavené" : "zamietnuté"}: ${resolutionNote}`,
                    meta: { requestId: request.id, kind: request.kind, status },
                },
            });
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa uložiť.", "resolveDealRequest");
    }
}

// ── Hromadný presun obchodov (§5.5) ─────────────────────────────────────────

export type TransferDealsInput = {
    fromOwnerId: string | null; // null = nepriradené
    handedOffById?: string | null;
    statuses?: LeadStatus[];
    toOwnerId: string;
    limit?: number;
};

export async function transferDealsAs(
    user: AccessUser,
    input: TransferDealsInput,
): Promise<{ moved: number; skipped: number } | ActionError> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    const statuses = (input.statuses?.length ? input.statuses : ["ACTIVE", "SNOOZED"]).filter((s) =>
        (deal.DEAL_STATUSES as readonly string[]).includes(s),
    );
    if (!statuses.length) return { error: "Vyber stavy." };
    if (input.fromOwnerId === input.toOwnerId) return { error: "Zdroj a cieľ sú rovnakí." };
    const limit = input.limit && input.limit > 0 ? input.limit : Number.POSITIVE_INFINITY;

    let moved = 0;
    try {
        while (moved < limit) {
            const batch = Math.min(200, limit - moved);
            const returned = await withLockTx(async (tx) => {
                const users = await lockUsers(tx, [user.id, input.toOwnerId], "SHARE");
                const actor = users.get(user.id);
                if (!actor || actor.deletedAt || !can(actor, "deals.manage")) throw new AccessError("FORBIDDEN");
                const target = users.get(input.toOwnerId);
                if (!target || target.deletedAt || !can(target, "deals.receive")) {
                    throw new AccessError("FORBIDDEN", "Cieľ nemôže vlastniť obchody.");
                }
                const rows = await tx.$queryRaw<{ id: string }[]>`
                    WITH picked AS (
                        SELECT id FROM "Lead"
                         WHERE "pipelineEnteredAt" IS NOT NULL AND "deletedAt" IS NULL
                           AND "ownerId" IS NOT DISTINCT FROM ${input.fromOwnerId}
                           AND status::text = ANY(${statuses})
                           AND (${input.handedOffById ?? null}::text IS NULL OR "handedOffById" = ${input.handedOffById ?? null})
                         ORDER BY id
                         LIMIT ${batch}
                         FOR UPDATE SKIP LOCKED
                    )
                    UPDATE "Lead" l SET "ownerId" = ${input.toOwnerId}, "revision" = l."revision" + 1
                      FROM picked
                     WHERE l.id = picked.id AND l."ownerId" IS NOT DISTINCT FROM ${input.fromOwnerId}
                       AND l."pipelineEnteredAt" IS NOT NULL
                 RETURNING l.id`;
                if (rows.length) {
                    await tx.activity.createMany({
                        data: rows.map((r) => ({
                            leadId: r.id,
                            userId: actor.id,
                            type: "OWNER_CHANGED" as const,
                            category: "AUDIT" as const,
                            source: "PIPELINE" as const,
                            note: `Hromadný presun obchodov → ${`${target.firstName} ${target.lastName}`.trim()}`,
                        })),
                    });
                }
                return rows.length;
            });
            moved += returned;
            if (returned < batch) break;
        }
    } catch (error) {
        const e = toActionError(error, "Presun sa nepodaril.", "transferDeals");
        return { ...e, error: moved ? `${e.error} (presunuté už: ${moved})` : e.error };
    }

    const remaining = await prisma.lead.count({
        where: {
            pipelineEnteredAt: { not: null },
            deletedAt: null,
            ownerId: input.fromOwnerId,
            status: { in: statuses as LeadStatus[] },
            ...(input.handedOffById ? { handedOffById: input.handedOffById } : {}),
        },
    });
    return { moved, skipped: Number.isFinite(limit) ? 0 : remaining };
}
