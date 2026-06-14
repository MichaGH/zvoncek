import prisma from "@/lib/db";

function startOfDay(d = new Date()) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function endOfDay(d = new Date()) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
}

// Local yyyy-mm-dd key, matching how the calendar buckets days.
export function dateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

export type TodayUrgentItem = {
    id: string;
    number: number;
    name: string;
    phone: string | null;
    kind: "callback" | "pipeline";
    at: string | null;
    note: string | null;
    overdue: boolean;
};

export type TodayBoard = {
    firstName: string | null;
    newCount: number;
    scheduledTodayCount: number;
    overdueCount: number;
    callbackQueueCount: number;
    urgent: TodayUrgentItem[];
    calendar: Record<string, number>;
};

function name(l: { companyName: string | null; website: string | null }) {
    return l.companyName ?? l.website ?? "—";
}

export async function getTodayBoard(userId: string): Promise<TodayBoard> {
    const today0 = startOfDay();
    const today1 = endOfDay();

    // Calendar window: previous month start … +3 months, so month nav has data.
    const windowStart = new Date(today0);
    windowStart.setDate(1);
    windowStart.setMonth(windowStart.getMonth() - 1);
    const windowEnd = new Date(today0);
    windowEnd.setMonth(windowEnd.getMonth() + 3, 0);
    windowEnd.setHours(23, 59, 59, 999);

    const [user, callbacks, pipeline, newCount, callbackQueueCount, planned] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { firstName: true } }),
        // Scheduled callbacks due today or overdue.
        prisma.lead.findMany({
            where: {
                deletedAt: null,
                status: "CALLING",
                callbackKind: "SCHEDULED",
                callbackAt: { lte: today1 },
            },
            select: {
                id: true,
                number: true,
                companyName: true,
                website: true,
                phone: true,
                callbackAt: true,
                callbackNote: true,
            },
            orderBy: { callbackAt: "asc" },
            take: 50,
        }),
        // Pipeline next-actions due today or overdue (open opportunities only).
        prisma.lead.findMany({
            where: {
                deletedAt: null,
                status: { in: ["ACTIVE", "SNOOZED"] },
                nextActionAt: { lte: today1 },
            },
            select: {
                id: true,
                number: true,
                companyName: true,
                website: true,
                phone: true,
                nextActionAt: true,
                nextActionNote: true,
            },
            orderBy: { nextActionAt: "asc" },
            take: 50,
        }),
        prisma.lead.count({ where: { deletedAt: null, status: "NEW" } }),
        prisma.lead.count({ where: { deletedAt: null, status: "CALLING" } }),
        prisma.lead.findMany({
            where: {
                deletedAt: null,
                OR: [
                    { callbackAt: { gte: windowStart, lte: windowEnd } },
                    { nextActionAt: { gte: windowStart, lte: windowEnd } },
                ],
            },
            select: { callbackAt: true, nextActionAt: true },
        }),
    ]);

    const urgent: TodayUrgentItem[] = [
        ...callbacks.map((l) => ({
            id: l.id,
            number: l.number,
            name: name(l),
            phone: l.phone,
            kind: "callback" as const,
            at: l.callbackAt?.toISOString() ?? null,
            note: l.callbackNote,
            overdue: l.callbackAt ? l.callbackAt < today0 : false,
        })),
        ...pipeline.map((l) => ({
            id: l.id,
            number: l.number,
            name: name(l),
            phone: l.phone,
            kind: "pipeline" as const,
            at: l.nextActionAt?.toISOString() ?? null,
            note: l.nextActionNote,
            overdue: l.nextActionAt ? l.nextActionAt < today0 : false,
        })),
    ].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

    const overdueCount = urgent.filter((u) => u.overdue).length;
    const scheduledTodayCount = urgent.length - overdueCount;

    const calendar: Record<string, number> = {};
    for (const l of planned) {
        for (const d of [l.callbackAt, l.nextActionAt]) {
            if (!d) continue;
            const key = dateKey(d);
            calendar[key] = (calendar[key] ?? 0) + 1;
        }
    }

    return {
        firstName: user?.firstName ?? null,
        newCount,
        scheduledTodayCount,
        overdueCount,
        callbackQueueCount,
        urgent,
        calendar,
    };
}
