import prisma from "@/lib/db";
import type { AccessUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";

// userId === null → história všetkých (len s callHistory.viewAll, vynútené na stránke).
export async function getCallHistory(viewer: AccessUser, userId: string | null) {
    const activities = await prisma.activity.findMany({
        where: {
            type: "CALL",
            category: "BUSINESS",
            source: "CALL_QUEUE",
            ...(userId ? { userId } : {}),
        },
        select: {
            id: true,
            userId: true,
            outcome: true,
            note: true,
            createdAt: true,
            leadRevision: true,
            revertedAt: true,
            lead: {
                select: {
                    id: true,
                    number: true,
                    companyName: true,
                    website: true,
                    phone: true,
                    email: true,
                    status: true,
                    revision: true,
                    deletedAt: true,
                    ownerId: true,
                    assignedCallerId: true,
                    pipelineEnteredAt: true,
                    activities: {
                        where: { type: "CALL", revertedAt: null },
                        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                        take: 1,
                        select: { id: true },
                    },
                },
            },
            user: {
                select: { id: true, firstName: true, lastName: true },
            },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
    });

    const isManager = can(viewer, "pipeline.manage");
    const canRevertOwn = can(viewer, "callHistory.revert");

    return activities.map((activity) => {
        const l = activity.lead;
        const isDeal = l.pipelineEnteredAt !== null;
        // Server všetko overí znova; toto len rozhoduje, či ukázať tlačidlo.
        const canRevert =
            !activity.revertedAt &&
            l.deletedAt === null &&
            l.activities[0]?.id === activity.id &&
            activity.leadRevision !== null &&
            activity.leadRevision === l.revision &&
            (isManager || (canRevertOwn && activity.userId === viewer.id));
        const canEdit =
            l.deletedAt === null &&
            (isManager ||
                (l.assignedCallerId === viewer.id &&
                    !isDeal &&
                    ["NEW", "CALLING", "SNOOZED"].includes(l.status)));
        const leadHref = !isDeal
            ? null
            : can(viewer, "pipeline.view")
              ? `/dashboard/pipeline/${l.id}`
              : can(viewer, "clients.view") && l.ownerId === viewer.id
                ? `/dashboard/clients/${l.id}`
                : null;
        return {
            id: activity.id,
            outcome: activity.outcome,
            note: activity.note,
            createdAt: activity.createdAt.toISOString(),
            reverted: Boolean(activity.revertedAt),
            canRevert,
            canEdit,
            lead: {
                id: l.id,
                number: l.number,
                companyName: l.companyName,
                website: l.website,
                phone: l.phone,
                email: l.email,
                revision: l.revision,
                href: leadHref,
            },
            user: activity.user,
        };
    });
}

export type CallHistoryRow = Awaited<ReturnType<typeof getCallHistory>>[number];

// Len používatelia, ktorí niekedy volali z fronty.
export async function getCallHistoryUsers() {
    return prisma.user.findMany({
        where: { activities: { some: { type: "CALL", source: "CALL_QUEUE" } } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
}
