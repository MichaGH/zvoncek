import prisma from "@/lib/db";

// userId === null → história všetkých (len pre managerov/adminov, vynútené na stránke).
export async function getCallHistory(userId: string | null) {
    const activities = await prisma.activity.findMany({
        where: {
            type: "CALL",
            category: "BUSINESS",
            source: "CALL_QUEUE",
            ...(userId ? { userId } : {}),
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
                    email: true,
                    status: true,
                    price: true,
                    quoteSentAt: true,
                    designSentAt: true,
                    aboutUsSentAt: true,
                    ownerId: true,
                    designs: { where: { deletedAt: null }, select: { id: true }, take: 1 },
                },
            },
            user: {
                select: { id: true, firstName: true, lastName: true },
            },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
    });

    return activities.map((activity) => {
        const l = activity.lead;
        // „Zamknuté" = kontaktu sa už dotkol manažér → marketing ho nesmie vrátiť/editnuť.
        const locked = Boolean(
            l.price != null ||
                l.quoteSentAt ||
                l.designSentAt ||
                l.aboutUsSentAt ||
                l.ownerId ||
                l.status === "WON" ||
                l.designs.length > 0,
        );
        return {
            id: activity.id,
            outcome: activity.outcome,
            note: activity.note,
            createdAt: activity.createdAt.toISOString(),
            lead: {
                id: l.id,
                number: l.number,
                companyName: l.companyName,
                website: l.website,
                phone: l.phone,
                email: l.email,
                locked,
            },
            user: activity.user,
        };
    });
}

export type CallHistoryRow = Awaited<ReturnType<typeof getCallHistory>>[number];

export async function getCallHistoryUsers() {
    return prisma.user.findMany({
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
}
