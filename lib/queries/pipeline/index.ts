import prisma from "@/lib/db";
import type { LeadStatus } from "@/app/generated/prisma/enums";

export async function getPipelineList({
    status,
    query,
}: {
    status?: LeadStatus;
    query?: string;
}) {
    const leads = await prisma.lead.findMany({
        where: {
            ...(status ? { status } : {}),
            ...(query
                ? {
                      OR: [
                          { companyName: { contains: query, mode: "insensitive" } },
                          { website: { contains: query, mode: "insensitive" } },
                          { phone: { contains: query } },
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
            nextActionAt: true,
            nextActionNote: true,
            price: true,
            owner: { select: { firstName: true } },
            activities: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { type: true, outcome: true, createdAt: true },
            },
        },
        orderBy: { nextActionAt: { sort: "asc", nulls: "last" } },
    });

    return leads.map((lead) => ({
        id: lead.id,
        number: lead.number,
        name: lead.companyName ?? lead.website ?? "—",
        phone: lead.phone,
        status: lead.status,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        nextActionNote: lead.nextActionNote,
        price: lead.price ? Number(lead.price) : null,
        owner: lead.owner?.firstName ?? null,
        lastActivity: lead.activities[0]
            ? {
                  type: lead.activities[0].type,
                  outcome: lead.activities[0].outcome,
                  at: lead.activities[0].createdAt.toISOString(),
              }
            : null,
    }));
}

export type PipelineListRow = Awaited<ReturnType<typeof getPipelineList>>[number];

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
