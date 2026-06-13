import prisma from "@/lib/db";

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

const SELECT = {
    id: true,
    number: true,
    companyName: true,
    website: true,
    phone: true,
    note: true,
    callbackKind: true,
    callbackAt: true,
    callbackNote: true,
    activities: {
        where: { type: "CALL" as const },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "desc" as const },
    },
} as const;

type RawLead = Awaited<ReturnType<typeof fetchOne>>;
async function fetchOne() {
    return prisma.lead.findFirstOrThrow({ select: SELECT });
}

function map(l: {
    id: string; number: number; companyName: string | null; website: string | null;
    phone: string | null; note: string | null; callbackAt: Date | null; callbackNote: string | null;
    activities: { id: string; createdAt: Date }[];
}) {
    return {
        id: l.id,
        number: l.number,
        companyName: l.companyName,
        website: l.website,
        phone: l.phone,
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
        // Dohodnuté hovory – majú presný čas
        prisma.lead.findMany({
            where: { status: "CALLING", callbackKind: "SCHEDULED" },
            select: SELECT,
            orderBy: { callbackAt: "asc" },
        }),
        // Skúsiť znova – nedovolané, bez času, najdlhšie nevolané hore
        prisma.lead.findMany({
            where: { status: "CALLING", callbackKind: "RETRY" },
            select: SELECT,
            orderBy: { updatedAt: "asc" },
        }),
        // Nové – paginované cez cursor
        prisma.lead.findMany({
            where: { status: "NEW" },
            select: SELECT,
            orderBy: { createdAt: "asc" }, // staré hore, nové pribúdajú dole
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

// pre „načítať ďalšie" – vráti len ďalšiu stránku nových
export async function getMoreNew(cursor: string) {
    "use server";
    const board = await getCallsBoard(cursor);
    return { leads: board.fresh, hasMore: board.freshHasMore, nextCursor: board.freshNextCursor };
}