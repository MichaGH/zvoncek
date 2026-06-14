import prisma from "@/lib/db";
import type { CallOutcome, LeadStatus } from "@/app/generated/prisma/enums";
import { CallOutcome as CallOutcomeEnum, LeadStatus as LeadStatusEnum } from "@/app/generated/prisma/enums";
import type { DateRange } from "@/lib/stats/range";

// Stats queries live here so pages stay thin. All time-bound metrics take a
// resolved DateRange; only marketing-call metrics are implemented for now, but
// the shapes are designed to extend to pipeline/revenue stats later.

function rangeFilter(range: DateRange): { gte?: Date; lt?: Date } | undefined {
    if (!range.from && !range.to) return undefined;
    return {
        ...(range.from ? { gte: range.from } : {}),
        ...(range.to ? { lt: range.to } : {}),
    };
}

function emptyOutcomeMap(): Record<CallOutcome, number> {
    return Object.fromEntries(
        Object.values(CallOutcomeEnum).map((o) => [o, 0]),
    ) as Record<CallOutcome, number>;
}

function emptyStatusMap(): Record<LeadStatus, number> {
    return Object.fromEntries(
        Object.values(LeadStatusEnum).map((s) => [s, 0]),
    ) as Record<LeadStatus, number>;
}

// ── Marketing call stats ──────────────────────────────────────────────

export type CallStats = {
    totalCalls: number;
    reached: number;
    reachRate: number; // 0–100, share of calls where someone actually answered
    interested: number; // wants quote/design/email or positive
    notInterested: number;
    byOutcome: Record<CallOutcome, number>;
};

export async function getCallStats({
    range,
    userId,
}: {
    range: DateRange;
    userId?: string;
}): Promise<CallStats> {
    const createdAt = rangeFilter(range);
    const where = {
        type: "CALL" as const,
        source: "CALL_QUEUE" as const,
        ...(userId ? { userId } : {}),
        ...(createdAt ? { createdAt } : {}),
    };

    const [total, grouped] = await Promise.all([
        prisma.activity.count({ where }),
        prisma.activity.groupBy({ by: ["outcome"], where, _count: true }),
    ]);

    const byOutcome = emptyOutcomeMap();
    for (const g of grouped) {
        if (g.outcome) byOutcome[g.outcome] = g._count;
    }

    const reached = total - byOutcome.NO_ANSWER - byOutcome.BAD_NUMBER;
    const interested =
        byOutcome.WANTS_QUOTE + byOutcome.WANTS_DESIGN + byOutcome.WANTS_EMAIL + byOutcome.POSITIVE;

    return {
        totalCalls: total,
        reached,
        reachRate: total > 0 ? Math.round((reached / total) * 100) : 0,
        interested,
        notInterested: byOutcome.NOT_INTERESTED,
        byOutcome,
    };
}

export type UserCallStat = {
    userId: string;
    name: string;
    calls: number;
    reached: number;
    interested: number;
    notInterested: number;
};

export async function getCallStatsByUser({
    range,
}: {
    range: DateRange;
}): Promise<UserCallStat[]> {
    const createdAt = rangeFilter(range);
    const where = {
        type: "CALL" as const,
        source: "CALL_QUEUE" as const,
        ...(createdAt ? { createdAt } : {}),
    };

    const grouped = await prisma.activity.groupBy({
        by: ["userId", "outcome"],
        where,
        _count: true,
    });

    const perUser = new Map<string, UserCallStat>();
    for (const row of grouped) {
        const entry =
            perUser.get(row.userId) ??
            { userId: row.userId, name: row.userId, calls: 0, reached: 0, interested: 0, notInterested: 0 };
        entry.calls += row._count;
        if (row.outcome && row.outcome !== "NO_ANSWER" && row.outcome !== "BAD_NUMBER") {
            entry.reached += row._count;
        }
        if (
            row.outcome === "WANTS_QUOTE" ||
            row.outcome === "WANTS_DESIGN" ||
            row.outcome === "WANTS_EMAIL" ||
            row.outcome === "POSITIVE"
        ) {
            entry.interested += row._count;
        }
        if (row.outcome === "NOT_INTERESTED") entry.notInterested += row._count;
        perUser.set(row.userId, entry);
    }

    if (perUser.size === 0) return [];

    const users = await prisma.user.findMany({
        where: { id: { in: [...perUser.keys()] } },
        select: { id: true, firstName: true, lastName: true },
    });
    for (const user of users) {
        const entry = perUser.get(user.id);
        if (entry) entry.name = `${user.firstName} ${user.lastName}`.trim();
    }

    return [...perUser.values()].sort((a, b) => b.calls - a.calls);
}

// ── Contact pool stats (lead database) ────────────────────────────────

export type ContactPoolStats = {
    total: number;
    byStatus: Record<LeadStatus, number>;
    uncalled: number; // status NEW = never called
    unassignedUncalled: number; // NEW with no owner — the shared backlog
    assignedUncalled: { userId: string; name: string; count: number }[];
    wonValue: number;
};

export async function getContactPoolStats(): Promise<ContactPoolStats> {
    const [byStatusRaw, total, wonAgg, byOwnerRaw, unassignedUncalled] = await Promise.all([
        prisma.lead.groupBy({ by: ["status"], where: { deletedAt: null }, _count: true }),
        prisma.lead.count({ where: { deletedAt: null } }),
        prisma.lead.aggregate({
            where: { status: "WON", deletedAt: null },
            _sum: { price: true },
        }),
        // future-proof: uncalled leads already assigned to a caller
        prisma.lead.groupBy({
            by: ["ownerId"],
            where: { deletedAt: null, status: "NEW", ownerId: { not: null } },
            _count: true,
        }),
        prisma.lead.count({ where: { deletedAt: null, status: "NEW", ownerId: null } }),
    ]);

    const byStatus = emptyStatusMap();
    for (const row of byStatusRaw) byStatus[row.status] = row._count;

    const ownerIds = byOwnerRaw.map((r) => r.ownerId).filter((id): id is string => Boolean(id));
    const owners = ownerIds.length
        ? await prisma.user.findMany({
              where: { id: { in: ownerIds } },
              select: { id: true, firstName: true, lastName: true },
          })
        : [];
    const ownerName = new Map(owners.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

    const assignedUncalled = byOwnerRaw
        .filter((r) => r.ownerId)
        .map((r) => ({
            userId: r.ownerId as string,
            name: ownerName.get(r.ownerId as string) ?? "—",
            count: r._count,
        }))
        .sort((a, b) => b.count - a.count);

    return {
        total,
        byStatus,
        uncalled: byStatus.NEW,
        unassignedUncalled,
        assignedUncalled,
        wonValue: wonAgg._sum.price ? Number(wonAgg._sum.price) : 0,
    };
}

// ── Contacts added (data-entry productivity) ──────────────────────────

export type ContactsAddedStats = {
    total: number;
    perUser: { userId: string; name: string; count: number }[];
};

export async function getContactsAddedStats({
    range,
    userId,
}: {
    range: DateRange;
    userId?: string;
}): Promise<ContactsAddedStats> {
    const createdAt = rangeFilter(range);
    const where = {
        deletedAt: null,
        createdById: userId ? userId : { not: null },
        ...(createdAt ? { createdAt } : {}),
    };

    const [total, grouped] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.groupBy({ by: ["createdById"], where, _count: true }),
    ]);

    const ids = grouped
        .map((g) => g.createdById)
        .filter((id): id is string => Boolean(id));
    const users = ids.length
        ? await prisma.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, firstName: true, lastName: true },
          })
        : [];
    const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

    const perUser = grouped
        .filter((g) => g.createdById)
        .map((g) => ({
            userId: g.createdById as string,
            name: nameById.get(g.createdById as string) ?? "—",
            count: g._count,
        }))
        .sort((a, b) => b.count - a.count);

    return { total, perUser };
}

export async function getStatsUsers() {
    return prisma.user.findMany({
        select: { id: true, firstName: true, lastName: true },
        orderBy: { firstName: "asc" },
    });
}

export type StatsUserOption = Awaited<ReturnType<typeof getStatsUsers>>[number];
