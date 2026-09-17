import prisma from "@/lib/db";
import type { Role } from "@/app/generated/prisma/enums";
import { isOverdue } from "@/lib/domain/businessTime";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

// Prehľad práce volajúcich pre /dashboard/calls/assignments. Deaktivovaní používatelia prví.
export async function getAssignmentsOverview() {
    const now = new Date();
    const work = await prisma.lead.groupBy({
        by: ["assignedCallerId", "status", "callbackKind"],
        where: { deletedAt: null, pipelineEnteredAt: null, assignedCallerId: { not: null }, status: { in: ["NEW", "CALLING", "SNOOZED"] } },
        _count: true,
    });
    const scheduled = await prisma.lead.findMany({
        where: { deletedAt: null, pipelineEnteredAt: null, assignedCallerId: { not: null }, status: "CALLING", callbackKind: "SCHEDULED", callbackAt: { lte: now } },
        select: { assignedCallerId: true, callbackAt: true, callbackHasTime: true },
    });
    const oldestBatch = await prisma.lead.groupBy({
        by: ["assignedCallerId"],
        where: { deletedAt: null, pipelineEnteredAt: null, assignedCallerId: { not: null }, status: "NEW" },
        _min: { assignedCallerAt: true },
    });

    const callerRoles = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes("calls.work"));
    const ids = [...new Set(work.map((w) => w.assignedCallerId!))];
    const users = await prisma.user.findMany({
        where: { OR: [{ id: { in: ids } }, { deletedAt: null, role: { in: callerRoles } }] },
        select: { id: true, firstName: true, lastName: true, role: true, deletedAt: true },
    });

    const rows = users
        .map((u) => {
            const mine = work.filter((w) => w.assignedCallerId === u.id);
            const count = (status: string, kind?: string | null) =>
                mine.filter((w) => w.status === status && (kind === undefined || w.callbackKind === kind)).reduce((s, w) => s + w._count, 0);
            return {
                id: u.id,
                name: `${u.firstName} ${u.lastName}`.trim(),
                deactivated: u.deletedAt !== null,
                canWork: u.deletedAt === null && callerRoles.includes(u.role),
                batch: count("NEW"),
                retry: count("CALLING", "RETRY"),
                scheduled: count("CALLING", "SCHEDULED"),
                scheduledOverdue: scheduled.filter(
                    (s) => s.assignedCallerId === u.id && s.callbackAt && isOverdue(s.callbackAt, s.callbackHasTime, now),
                ).length,
                snoozed: count("SNOOZED"),
                batchSince: oldestBatch.find((b) => b.assignedCallerId === u.id)?._min.assignedCallerAt?.toISOString() ?? null,
            };
        })
        .filter((r) => r.canWork || r.batch + r.retry + r.scheduled + r.snoozed > 0)
        .sort((a, b) => Number(b.deactivated) - Number(a.deactivated) || a.name.localeCompare(b.name, "sk"));

    return { rows, targets: rows.filter((r) => r.canWork).map((r) => ({ id: r.id, name: r.name })) };
}

export type AssignmentRow = Awaited<ReturnType<typeof getAssignmentsOverview>>["rows"][number];
