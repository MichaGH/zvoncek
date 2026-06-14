import prisma from "@/lib/db";

const SELECT = {
    id: true,
    number: true,
    companyName: true,
    website: true,
    phone: true,
    email: true,
    note: true,
    callbackKind: true,
    callbackAt: true,
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
    phone: string | null; email: string | null; note: string | null;
    callbackAt: Date | null; callbackNote: string | null;
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
        callbackAt: l.callbackAt?.toISOString() ?? null,
        callbackNote: l.callbackNote,
        attempts: l.activities.length,
        lastAttemptAt: l.activities[0]?.createdAt.toISOString() ?? null,
    };
}

const NEW_PAGE = 50;

export async function getCallsBoard(newCursor?: string) {
    const [scheduled, retry, fresh] = await Promise.all([
        prisma.lead.findMany({
            where: { status: "CALLING", callbackKind: "SCHEDULED", deletedAt: null },
            select: SELECT,
            orderBy: { callbackAt: "asc" },
        }),
        prisma.lead.findMany({
            where: { status: "CALLING", callbackKind: "RETRY", deletedAt: null },
            select: SELECT,
            orderBy: { updatedAt: "asc" },
        }),
        prisma.lead.findMany({
            where: { status: "NEW", deletedAt: null },
            select: SELECT,
            orderBy: { createdAt: "asc" },
            take: NEW_PAGE + 1,
            ...(newCursor ? { cursor: { id: newCursor }, skip: 1 } : {}),
        }),
    ]);

    const hasMore = fresh.length > NEW_PAGE;
    const freshPage = hasMore ? fresh.slice(0, NEW_PAGE) : fresh;

    return {
        scheduled: scheduled.map(map),
        retry: retry.map(map),
        fresh: freshPage.map(map),
        freshHasMore: hasMore,
        freshNextCursor: hasMore ? freshPage[freshPage.length - 1].id : null,
    };
}

export type CallsBoard = Awaited<ReturnType<typeof getCallsBoard>>;
export type QueueLead = CallsBoard["scheduled"][number];
