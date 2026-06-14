import prisma from "@/lib/db";

export async function getCallHistory(userId: string) {
    const activities = await prisma.activity.findMany({
        where: {
            type: "CALL",
            category: "BUSINESS",
            source: "CALL_QUEUE",
            userId,
        },
        select: {
            id: true,
            outcome: true,
            note: true,
            createdAt: true,
            lead: {
                select: {
                    id: true,
                    number: true,
                    companyName: true,
                    website: true,
                    phone: true,
                },
            },
            user: {
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                },
            },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
    });

    return activities.map((activity) => ({
        ...activity,
        createdAt: activity.createdAt.toISOString(),
    }));
}

export type CallHistoryRow = Awaited<ReturnType<typeof getCallHistory>>[number];

export async function getCallHistoryUsers() {
    return prisma.user.findMany({
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
}
