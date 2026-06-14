import prisma from "@/lib/db";

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function daysAgo(n: number) { const x = startOfDay(); x.setDate(x.getDate() - n); return x; }

export async function getStats(fromDays = 30) {
    const from = daysAgo(fromDays);

    const [calls, byOutcome, byStatus, wonValue, callsByUser] = await Promise.all([
        // počet hovorov za obdobie
        prisma.activity.count({
            where: { type: "CALL", source: "CALL_QUEUE", createdAt: { gte: from } },
        }),

        // rozdelenie podľa výsledku – z toho miera dovolania, lievik
        prisma.activity.groupBy({
            by: ["outcome"],
            where: { type: "CALL", source: "CALL_QUEUE", createdAt: { gte: from } },
            _count: true,
        }),

        // koľko leadov je v ktorom statuse práve teraz
        prisma.lead.groupBy({
            by: ["status"],
            where: { deletedAt: null },
            _count: true,
        }),

        // hodnota vyhratej pipeline
        prisma.lead.aggregate({
            where: { status: "WON", deletedAt: null },
            _sum: { price: true },
        }),

        // výkon per člen (kто koľko volal)
        prisma.activity.groupBy({
            by: ["userId"],
            where: { type: "CALL", source: "CALL_QUEUE", createdAt: { gte: from } },
            _count: true,
        }),
    ]);

    const outcomeMap = Object.fromEntries(byOutcome.map((o) => [o.outcome ?? "—", o._count]));
    const reached = (outcomeMap.WANTS_DESIGN ?? 0) + (outcomeMap.WANTS_QUOTE ?? 0) +
                    (outcomeMap.WANTS_EMAIL ?? 0) + (outcomeMap.NOT_INTERESTED ?? 0) +
                    (outcomeMap.CALL_AGAIN ?? 0) + (outcomeMap.SNOOZE ?? 0);
    const noAnswer = outcomeMap.NO_ANSWER ?? 0;

    return {
        periodDays: fromDays,
        totalCalls: calls,
        reachRate: calls > 0 ? Math.round((reached / (reached + noAnswer)) * 100) : 0,
        interested: (outcomeMap.WANTS_DESIGN ?? 0) + (outcomeMap.WANTS_QUOTE ?? 0) + (outcomeMap.WANTS_EMAIL ?? 0),
        notInterested: outcomeMap.NOT_INTERESTED ?? 0,
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
        wonValue: wonValue._sum.price ? Number(wonValue._sum.price) : 0,
        callsByUser, // [{ userId, _count }]
        byOutcome: outcomeMap,
    };
}
