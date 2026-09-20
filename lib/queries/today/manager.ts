import prisma from "@/lib/db";
import type { AccessUser } from "@/lib/access/user";
import type { Role } from "@/app/generated/prisma/enums";
import { businessDaysBetween, businessDayStart, businessTodayStart, isOverdue } from "@/lib/domain/businessTime";
import { TASK_AGE_ALERT_DAYS } from "@/lib/domain/tasks";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { weekStartKey } from "@/lib/queries/today";

// Manažérske bloky na /dashboard (plán §8.3). Len pre deals.viewAll – stránka to overí.

function rolesWith(permission: "deals.receive" | "calls.work"): Role[] {
    return (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes(permission));
}

export async function getManagerToday(viewer: Pick<AccessUser, "id">) {
    const now = new Date();
    const todayStart = businessTodayStart(now);
    const weekStart = businessDayStart(weekStartKey(now));
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000);

    // „Čaká na mňa" = ten istý dopyt ako „Pre mňa" (wave 3 §7): otvorené úlohy pridelené MNE, akýkoľvek vlastník.
    const inboxWhere = {
        status: "OPEN" as const,
        assigneeId: viewer.id,
        lead: { deletedAt: null, pipelineEnteredAt: { not: null } },
    };
    const [tasks, taskCount, reps, unassigned, staleBatches, orphanWork] = await Promise.all([
        // náhľad (najstaršie) + samostatný presný počet pre titulok
        prisma.dealTask.findMany({
            where: inboxWhere,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 10,
            select: {
                id: true,
                type: true,
                contents: true,
                text: true,
                createdAt: true,
                requestedBy: { select: { firstName: true, lastName: true } },
                lead: { select: { id: true, number: true, companyName: true, website: true } },
            },
        }),
        prisma.dealTask.count({ where: inboxWhere }),
        prisma.user.findMany({
            where: { deletedAt: null, role: { in: rolesWith("deals.receive") }, id: { not: viewer.id } },
            select: { id: true, firstName: true, lastName: true },
            orderBy: { firstName: "asc" },
        }),
        prisma.lead.count({
            where: { deletedAt: null, pipelineEnteredAt: { not: null }, ownerId: null, status: { in: ["ACTIVE", "SNOOZED"] } },
        }),
        prisma.lead.groupBy({
            by: ["assignedCallerId"],
            where: {
                deletedAt: null,
                status: "NEW",
                pipelineEnteredAt: null,
                assignedCallerId: { not: null },
                assignedCallerAt: { lt: dayAgo },
                assignedCaller: { deletedAt: null },
            },
            _count: true,
        }),
        prisma.lead.groupBy({
            by: ["assignedCallerId"],
            where: {
                deletedAt: null,
                pipelineEnteredAt: null,
                status: { in: ["NEW", "CALLING", "SNOOZED"] },
                assignedCaller: { deletedAt: { not: null } },
            },
            _count: true,
        }),
    ]);

    const repIds = reps.map((r) => r.id);
    const [openDeals, followUpsToday, newThisWeek, callbacks, lastActivity] = await Promise.all([
        prisma.lead.findMany({
            where: { deletedAt: null, pipelineEnteredAt: { not: null }, status: { in: ["ACTIVE", "SNOOZED"] }, ownerId: { in: repIds } },
            select: {
                ownerId: true,
                nextActionAt: true,
                nextActionHasTime: true,
                nextActionMode: true,
                _count: { select: { tasks: { where: { status: "OPEN" } } } },
            },
        }),
        prisma.activity.groupBy({
            by: ["userId"],
            where: { userId: { in: repIds }, type: "CALL", source: { in: ["CLIENTS", "PIPELINE"] }, createdAt: { gte: todayStart } },
            _count: true,
        }),
        prisma.lead.groupBy({
            by: ["ownerId"],
            where: { deletedAt: null, ownerId: { in: repIds }, pipelineEnteredAt: { gte: weekStart } },
            _count: true,
        }),
        prisma.lead.findMany({
            where: {
                deletedAt: null,
                pipelineEnteredAt: null,
                assignedCallerId: { in: repIds },
                status: "CALLING",
                callbackKind: "SCHEDULED",
                callbackAt: { lte: now },
            },
            select: { assignedCallerId: true, callbackAt: true, callbackHasTime: true },
        }),
        prisma.activity.groupBy({ by: ["userId"], where: { userId: { in: repIds } }, _max: { createdAt: true } }),
    ]);

    const repRows = reps.map((r) => {
        const deals = openDeals.filter((d) => d.ownerId === r.id);
        return {
            id: r.id,
            name: `${r.firstName} ${r.lastName}`.trim(),
            openDeals: deals.length,
            // Zamknutý krok (čaká na úlohu pre manažéra) nie je meškanie obchodníka (§5.3).
            overdue: deals.filter(
                (d) =>
                    d._count.tasks === 0 &&
                    d.nextActionMode === "SCHEDULED" &&
                    d.nextActionAt &&
                    isOverdue(d.nextActionAt, d.nextActionHasTime, now),
            ).length,
            followUpsToday: followUpsToday.find((f) => f.userId === r.id)?._count ?? 0,
            newThisWeek: newThisWeek.find((n) => n.ownerId === r.id)?._count ?? 0,
            callbacksOverdue: callbacks.filter(
                (c) => c.assignedCallerId === r.id && c.callbackAt && isOverdue(c.callbackAt, c.callbackHasTime, now),
            ).length,
            lastActivityAt: lastActivity.find((a) => a.userId === r.id)?._max.createdAt?.toISOString() ?? null,
        };
    });

    const callerIds = [...staleBatches, ...orphanWork].map((g) => g.assignedCallerId).filter((id): id is string => Boolean(id));
    const callerNames = callerIds.length
        ? await prisma.user.findMany({ where: { id: { in: callerIds } }, select: { id: true, firstName: true, lastName: true } })
        : [];
    const nameOf = (id: string | null) => {
        const u = callerNames.find((c) => c.id === id);
        return u ? `${u.firstName} ${u.lastName}`.trim() : "—";
    };

    return {
        tasks: tasks.map((t) => ({
            id: t.id,
            type: t.type,
            contents: t.contents,
            text: t.text,
            createdAt: t.createdAt.toISOString(),
            overdue: businessDaysBetween(t.createdAt, now) >= TASK_AGE_ALERT_DAYS,
            requester: `${t.requestedBy.firstName} ${t.requestedBy.lastName}`.trim(),
            leadId: t.lead.id,
            leadName: `#${t.lead.number} ${t.lead.companyName ?? t.lead.website ?? "—"}`,
        })),
        taskCount,
        oldestTaskOverdue: tasks.length > 0 && businessDaysBetween(tasks[0].createdAt, now) >= TASK_AGE_ALERT_DAYS,
        reps: repRows,
        unassigned,
        callers: {
            staleBatches: staleBatches.map((g) => ({ userId: g.assignedCallerId, name: nameOf(g.assignedCallerId), count: g._count })),
            deactivatedWithWork: orphanWork.map((g) => ({ userId: g.assignedCallerId, name: nameOf(g.assignedCallerId), count: g._count })),
        },
    };
}

export type ManagerToday = Awaited<ReturnType<typeof getManagerToday>>;
