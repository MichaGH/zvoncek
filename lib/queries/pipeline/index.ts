import prisma from "@/lib/db";
import type {
    ActivityType,
    CallOutcome,
    LeadStatus,
    NextActionKind,
} from "@/app/generated/prisma/enums";

export const PIPELINE_PAGE_SIZE = 50;

type PipelineLead = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    status: LeadStatus;
    nextActionKind: NextActionKind | null;
    nextActionAt: Date | null;
    nextActionNote: string | null;
    price: { toString(): string } | null;
    owner: { firstName: string } | null;
    activities: {
        type: ActivityType;
        outcome: CallOutcome | null;
        note: string | null;
        createdAt: Date;
    }[];
};

function toPipelineRow(lead: PipelineLead) {
    return {
        id: lead.id,
        number: lead.number,
        name: lead.companyName ?? lead.website ?? "—",
        phone: lead.phone,
        status: lead.status,
        nextActionKind: lead.nextActionKind,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        nextActionNote: lead.nextActionNote,
        price: lead.price ? Number(lead.price) : null,
        owner: lead.owner?.firstName ?? null,
        lastActivity: lead.activities[0]
            ? {
                  type: lead.activities[0].type,
                  outcome: lead.activities[0].outcome,
                  note: lead.activities[0].note,
                  at: lead.activities[0].createdAt.toISOString(),
              }
            : null,
    };
}

export type PipelineListRow = ReturnType<typeof toPipelineRow>;

// Simple offset-based pagination. Good enough for current volume.
// TODO: switch to cursor-based ("next 50") if the list grows large.
export async function getPipelineList({
    status,
    query,
    take = PIPELINE_PAGE_SIZE,
}: {
    status?: LeadStatus;
    query?: string;
    take?: number;
}): Promise<{ rows: PipelineListRow[]; hasMore: boolean }> {
    const leads = await prisma.lead.findMany({
        where: {
            ...(status ? { status } : {}),
            ...(query
                ? {
                      OR: [
                          { companyName: { contains: query, mode: "insensitive" } },
                          { website: { contains: query, mode: "insensitive" } },
                          { phone: { contains: query } },
                          { email: { contains: query, mode: "insensitive" } },
                      ],
                  }
                : {}),
        },
        select: {
            id: true,
            number: true,
            companyName: true,
            website: true,
            phone: true,
            status: true,
            nextActionKind: true,
            nextActionAt: true,
            nextActionNote: true,
            price: true,
            owner: { select: { firstName: true } },
            activities: {
                where: { category: "BUSINESS" },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { type: true, outcome: true, note: true, createdAt: true },
            },
        },
        orderBy: { nextActionAt: { sort: "asc", nulls: "last" } },
        take: take + 1,
    });

    const hasMore = leads.length > take;
    const rows = leads.slice(0, take).map(toPipelineRow);
    return { rows, hasMore };
}

export async function getPipelineDetail(id: string) {
    const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
            owner: { select: { id: true, firstName: true, lastName: true } },
            activities: {
                orderBy: { createdAt: "desc" },
                include: { user: { select: { firstName: true } } },
            },
        },
    });
    if (!lead) return null;

    return {
        ...lead,
        price: lead.price ? Number(lead.price) : null,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        quoteSentAt: lead.quoteSentAt?.toISOString() ?? null,
        designSentAt: lead.designSentAt?.toISOString() ?? null,
        aboutUsSentAt: lead.aboutUsSentAt?.toISOString() ?? null,
        createdAt: lead.createdAt.toISOString(),
        updatedAt: lead.updatedAt.toISOString(),
        activities: lead.activities.map((activity) => ({
            id: activity.id,
            type: activity.type,
            category: activity.category,
            source: activity.source,
            outcome: activity.outcome,
            note: activity.note,
            userName: activity.user.firstName,
            createdAt: activity.createdAt.toISOString(),
        })),
    };
}

export type PipelineDetailData = NonNullable<Awaited<ReturnType<typeof getPipelineDetail>>>;
export type PipelineActivity = PipelineDetailData["activities"][number];

export async function getPipelineUsers() {
    return prisma.user.findMany({
        select: { id: true, firstName: true, lastName: true },
        orderBy: { firstName: "asc" },
    });
}

export type PipelineUserOption = Awaited<ReturnType<typeof getPipelineUsers>>[number];
