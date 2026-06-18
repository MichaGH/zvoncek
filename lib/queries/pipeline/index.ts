import prisma from "@/lib/db";
import { nextActionSort } from "@/lib/overdue";
import type {
    ActivityType,
    CallOutcome,
    LeadStatus,
    NextActionKind,
    NextActionMode,
    ProjectType,
} from "@/app/generated/prisma/enums";

export const PIPELINE_PAGE_SIZE = 50;

// Sekundárne pohľady v pipeline (param `view`). Sú to "šošovky" nad stavom ACTIVE,
// nie striktné rozdelenie – jeden lead môže vyhovovať viacerým. Each = Prisma where.
export const PIPELINE_VIEWS = [
    { key: "call", label: "Volať", group: "todo" },
    { key: "quote", label: "Poslať CP", group: "todo" },
    { key: "email", label: "Poslať email", group: "todo" },
    { key: "design", label: "Návrh v procese", group: "todo" },
    { key: "quote_sent", label: "Odoslaná CP", group: "running" },
    { key: "design_sent", label: "Odoslaný návrh", group: "running" },
] as const;

export type PipelineViewKey = (typeof PIPELINE_VIEWS)[number]["key"];

function pipelineViewWhere(view?: string) {
    switch (view) {
        case "call":
            return { nextActionKind: "CALL" as const };
        case "quote":
            return { nextActionKind: "SEND_QUOTE" as const };
        case "email":
            return { nextActionKind: "SEND_EMAIL" as const };
        case "design":
            return { nextActionMode: "IN_PROGRESS" as const };
        case "quote_sent":
            return { quoteSentAt: { not: null } };
        case "design_sent":
            return { designs: { some: { deletedAt: null, sentAt: { not: null } } } };
        default:
            return {};
    }
}

type PipelineLead = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    status: LeadStatus;
    projectType: ProjectType | null;
    nextActionKind: NextActionKind | null;
    nextActionAt: Date | null;
    nextActionHasTime: boolean;
    nextActionMode: NextActionMode;
    nextActionNote: string | null;
    price: { toString(): string } | null;
    priceDisclosed: boolean;
    quoteSentAt: Date | null;
    aboutUsSentAt: Date | null;
    designs: { id: string }[];
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
        projectType: lead.projectType,
        nextActionKind: lead.nextActionKind,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        nextActionHasTime: lead.nextActionHasTime,
        nextActionMode: lead.nextActionMode,
        nextActionNote: lead.nextActionNote,
        price: lead.price ? Number(lead.price) : null,
        priceDisclosed: lead.priceDisclosed,
        quoteSentAt: lead.quoteSentAt?.toISOString() ?? null,
        aboutUsSentAt: lead.aboutUsSentAt?.toISOString() ?? null,
        hasDesignSent: lead.designs.length > 0,
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
    view,
    take = PIPELINE_PAGE_SIZE,
}: {
    status?: LeadStatus;
    query?: string;
    view?: string;
    take?: number;
}): Promise<{ rows: PipelineListRow[]; hasMore: boolean }> {
    const leads = await prisma.lead.findMany({
        where: {
            ...(status ? { status } : {}),
            ...pipelineViewWhere(view),
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
            projectType: true,
            nextActionKind: true,
            nextActionAt: true,
            nextActionHasTime: true,
            nextActionMode: true,
            nextActionNote: true,
            price: true,
            priceDisclosed: true,
            quoteSentAt: true,
            aboutUsSentAt: true,
            designs: {
                where: { deletedAt: null, sentAt: { not: null } },
                select: { id: true },
                take: 1,
            },
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

    // Kategorické zoradenie: urgentné → rozpracované (návrhy) → budúce → čaká sa → žiadne.
    // (DB radí len podľa nextActionAt; urgentnosť/mód sa rátajú v JS.)
    const now = new Date();
    rows.sort((a, b) => {
        const ra = nextActionSort(a.nextActionMode, a.nextActionKind, a.nextActionAt, a.nextActionHasTime, now);
        const rb = nextActionSort(b.nextActionMode, b.nextActionKind, b.nextActionAt, b.nextActionHasTime, now);
        if (ra.rank !== rb.rank) return ra.rank - rb.rank;
        return ra.tie - rb.tie;
    });

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
