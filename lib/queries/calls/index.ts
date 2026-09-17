import prisma from "@/lib/db";
import type { Prisma } from "@/app/generated/prisma/client";
import type { AccessUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";

const SELECT = {
    id: true,
    number: true,
    companyName: true,
    website: true,
    phone: true,
    email: true,
    note: true,
    revision: true,
    callbackKind: true,
    callbackAt: true,
    callbackHasTime: true,
    callbackNote: true,
    activities: {
        where: {
            type: "CALL" as const,
            category: "BUSINESS" as const,
            source: "CALL_QUEUE" as const,
        },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "desc" as const },
    },
} as const;

function map(l: {
    id: string; number: number; companyName: string | null; website: string | null;
    phone: string | null; email: string | null; note: string | null; revision: number;
    callbackAt: Date | null; callbackHasTime: boolean; callbackNote: string | null;
    activities: { id: string; createdAt: Date }[];
}) {
    return {
        id: l.id,
        number: l.number,
        companyName: l.companyName,
        website: l.website,
        phone: l.phone,
        email: l.email,
        note: l.note,
        revision: l.revision,
        callbackAt: l.callbackAt?.toISOString() ?? null,
        callbackHasTime: l.callbackHasTime,
        callbackNote: l.callbackNote,
        attempts: l.activities.length,
        lastAttemptAt: l.activities[0]?.createdAt.toISOString() ?? null,
    };
}

export const RETRY_PAGE = 50;

// Spoločná fronta: nikdy nevolané NEW, ktoré nikto nedrží (§4.2). NOT EXISTS je obranná druhá poistka.
export const POOL_WHERE = {
    deletedAt: null,
    status: "NEW",
    pipelineEnteredAt: null,
    assignedCallerId: null,
    activities: { none: { type: "CALL" } },
} satisfies Prisma.LeadWhereInput;

export async function getPoolCount(): Promise<number> {
    return prisma.lead.count({ where: POOL_WHERE });
}

// Práca volajúceho (fáza volania, priradené jemu).
export function callWorkWhere(userId: string) {
    return { deletedAt: null, pipelineEnteredAt: null, assignedCallerId: userId } satisfies Prisma.LeadWhereInput;
}

async function getRetryPage(userId: string, cursor?: string) {
    const rows = await prisma.lead.findMany({
        where: { ...callWorkWhere(userId), status: "CALLING", callbackKind: "RETRY" },
        select: SELECT,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: RETRY_PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > RETRY_PAGE;
    const page = hasMore ? rows.slice(0, RETRY_PAGE) : rows;
    return { leads: page.map(map), nextCursor: hasMore ? page[page.length - 1].id : null };
}

export async function getMoreRetriesFor(userId: string, cursor: string) {
    return getRetryPage(userId, cursor);
}

// Osobná tabuľa volajúceho (§4.4). Nikdy nenárokuje – len číta.
export async function getCallsBoard(user: Pick<AccessUser, "id">) {
    const mine = callWorkWhere(user.id);
    const [scheduled, retryPage, retryTotal, snoozed, fresh, poolCount] = await Promise.all([
        prisma.lead.findMany({
            where: { ...mine, status: "CALLING", callbackKind: "SCHEDULED" },
            select: SELECT,
            orderBy: { callbackAt: "asc" },
        }),
        getRetryPage(user.id),
        prisma.lead.count({ where: { ...mine, status: "CALLING", callbackKind: "RETRY" } }),
        prisma.lead.findMany({
            where: { ...mine, status: "SNOOZED" },
            select: SELECT,
            orderBy: { callbackAt: "asc" },
        }),
        prisma.lead.findMany({
            where: { ...mine, status: "NEW" },
            select: SELECT,
            orderBy: { createdAt: "asc" },
        }),
        getPoolCount(),
    ]);

    return {
        scheduled: scheduled.map(map),
        retry: retryPage.leads,
        retryTotal,
        retryNextCursor: retryPage.nextCursor,
        snoozed: snoozed.map(map),
        fresh: fresh.map(map),
        batchCount: fresh.length,
        poolCount,
    };
}

export type CallsBoard = Awaited<ReturnType<typeof getCallsBoard>>;
export type QueueLead = CallsBoard["scheduled"][number];

// Náhľad príjemcu handoffu (len informácia; skutočného príjemcu vráti logCall).
export async function getHandoffRecipient(user: AccessUser): Promise<{ id: string; name: string } | null> {
    if (can(user, "deals.receive")) return { id: user.id, name: `${user.firstName} ${user.lastName}`.trim() };
    if (!user.teamId) return null;
    const team = await prisma.team.findUnique({
        where: { id: user.teamId },
        select: { leader: { select: { id: true, role: true, firstName: true, lastName: true, deletedAt: true } } },
    });
    const leader = team?.leader;
    if (!leader || leader.deletedAt || !can(leader, "deals.receive")) return null;
    return { id: leader.id, name: `${leader.firstName} ${leader.lastName}`.trim() };
}
