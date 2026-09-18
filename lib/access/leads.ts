import type { Lead, PrismaClient } from "@/app/generated/prisma/client";
import { AccessError } from "@/lib/access/errors";
import { lockLeadRow, lockUsers, type LockedUser, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";

// Prístup k leadom (plán §6.2). Mutácie: helper zamkne User riadky (vzostupne) a potom Lead riadok FOR UPDATE,
// rozsah/stav/revíziu overí pod zámkom. Kontrola vlastníctva a zápis prebehnú v tej istej transakcii.

const CALL_STAGE = ["NEW", "CALLING", "SNOOZED"] as const;
const OPEN_DEAL = ["ACTIVE", "SNOOZED"] as const;
const CLOSED_DEAL = ["WON", "LOST", "UNREACHABLE"] as const;

export function isOpenDealStatus(status: Lead["status"]): boolean {
    return (OPEN_DEAL as readonly string[]).includes(status);
}

export function isClosedDealStatus(status: Lead["status"]): boolean {
    return (CLOSED_DEAL as readonly string[]).includes(status);
}

function assertActive(user: LockedUser | undefined): LockedUser {
    if (!user || user.deletedAt) throw new AccessError("UNAUTHENTICATED");
    return user;
}

async function readLead(tx: Tx, leadId: string): Promise<Lead> {
    const lead = await tx.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new AccessError("NOT_FOUND");
    return lead;
}

// Zamkne User riadky (aktér + priradený volajúci + ďalší) FOR SHARE a potom Lead FOR UPDATE.
// Priradeného volajúceho prečíta bez zámku a pod zámkom overí, že sa nezmenil (§10.1 pravidlo 1 a 3).
export async function lockLeadWithUsers(
    tx: Tx,
    leadId: string,
    userIds: (string | null | undefined)[],
    opts: { expectedRevision?: number } = {},
): Promise<{ lead: Lead; users: Map<string, LockedUser> }> {
    const pre = await tx.lead.findUnique({ where: { id: leadId }, select: { assignedCallerId: true } });
    if (!pre) throw new AccessError("NOT_FOUND");
    const users = await lockUsers(tx, [...userIds, pre.assignedCallerId], "SHARE");
    if (!(await lockLeadRow(tx, leadId))) throw new AccessError("NOT_FOUND");
    const lead = await readLead(tx, leadId);
    if (lead.assignedCallerId !== pre.assignedCallerId) {
        throw new AccessError(opts.expectedRevision !== undefined ? "STALE" : "RETRYABLE");
    }
    if (opts.expectedRevision !== undefined && lead.revision !== opts.expectedRevision) {
        throw new AccessError("STALE");
    }
    return { lead, users };
}

// Fáza volania (mutácia). Zamkne vlastný User riadok FOR SHARE (assignee lock) a Lead riadok.
export async function requireCallLead(
    tx: Tx,
    user: AccessUser,
    leadId: string,
    expectedRevision?: number,
): Promise<{ lead: Lead; actor: LockedUser }> {
    const users = await lockUsers(tx, [user.id], "SHARE");
    const actor = assertActive(users.get(user.id));
    if (!can(actor, "calls.work")) throw new AccessError("FORBIDDEN");
    if (!(await lockLeadRow(tx, leadId))) throw new AccessError("NOT_ASSIGNED");
    const lead = await readLead(tx, leadId);
    const inCallStage =
        lead.deletedAt === null &&
        lead.pipelineEnteredAt === null &&
        (CALL_STAGE as readonly string[]).includes(lead.status) &&
        lead.assignedCallerId === user.id;
    if (!inCallStage) throw new AccessError("NOT_ASSIGNED");
    if (expectedRevision !== undefined && lead.revision !== expectedRevision) throw new AccessError("STALE");
    return { lead, actor };
}

export type ClosedPolicy = "reject" | "reopenRequestOnly" | "allow";

// Mutácia obchodu manažérom ALEBO vlastníkom. Zamkne User riadok aktéra FOR SHARE (deaktivácia čaká / blokuje),
// voliteľne ďalšie User riadky (napr. cieľ zmeny vlastníka), potom Lead.
export async function requireDealWork(
    tx: Tx,
    user: AccessUser,
    leadId: string,
    opts: { expectedRevision?: number; closedPolicy?: ClosedPolicy; lockUserIds?: string[] } = {},
): Promise<{ lead: Lead; actor: LockedUser; users: Map<string, LockedUser>; isManager: boolean }> {
    const { lead, users } = await lockLeadWithUsers(tx, leadId, [user.id, ...(opts.lockUserIds ?? [])]);
    const actor = assertActive(users.get(user.id));
    if (lead.deletedAt !== null || lead.pipelineEnteredAt === null) throw new AccessError("NOT_FOUND");

    const isManager = can(actor, "deals.manage");
    const isOwner = can(actor, "deals.work") && lead.ownerId === actor.id;
    if (!isManager && !isOwner) throw new AccessError("NOT_FOUND");

    const policy = opts.closedPolicy ?? "reject";
    if (policy === "reject" && !isOpenDealStatus(lead.status)) throw new AccessError("DEAL_CLOSED");
    if (policy === "reopenRequestOnly" && !isClosedDealStatus(lead.status)) throw new AccessError("FORBIDDEN");
    if (policy === "allow" && !isManager) throw new AccessError("FORBIDDEN");

    if (opts.expectedRevision !== undefined && lead.revision !== opts.expectedRevision) {
        throw new AccessError("STALE");
    }
    return { lead, actor, users, isManager };
}

// Len manažér (návrhy, tracking, stav, WON, reopen, vlastník, vybavenie požiadaviek). Akýkoľvek stav obchodu.
export async function requireDealManage(
    tx: Tx,
    user: AccessUser,
    leadId: string,
    opts: { expectedRevision?: number; lockUserIds?: string[] } = {},
): Promise<{ lead: Lead; actor: LockedUser; users: Map<string, LockedUser> }> {
    const { lead, users } = await lockLeadWithUsers(tx, leadId, [user.id, ...(opts.lockUserIds ?? [])]);
    const actor = assertActive(users.get(user.id));
    if (!can(actor, "deals.manage")) throw new AccessError("NOT_FOUND");
    if (lead.deletedAt !== null || lead.pipelineEnteredAt === null) throw new AccessError("NOT_FOUND");
    if (opts.expectedRevision !== undefined && lead.revision !== opts.expectedRevision) {
        throw new AccessError("STALE");
    }
    return { lead, actor, users };
}

type Db = Pick<PrismaClient, "lead"> | Tx;

// Načítanie stránky (bez zámku).
export async function requireDealView(db: Db, user: AccessUser, leadId: string): Promise<Lead> {
    const lead = await db.lead.findFirst({
        where: { id: leadId, deletedAt: null, pipelineEnteredAt: { not: null } },
    });
    if (!lead) throw new AccessError("NOT_FOUND");
    const allowed = can(user, "deals.viewAll") || (can(user, "deals.view") && lead.ownerId === user.id);
    if (!allowed) throw new AccessError("NOT_FOUND");
    return lead;
}
