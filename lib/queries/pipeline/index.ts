import prisma from "@/lib/db";
import { Prisma } from "@/app/generated/prisma/client";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import type {
    ActivityType,
    CallOutcome,
    DealRequestKind,
    LeadStatus,
    NextActionKind,
    NextActionMode,
    ProjectType,
    Role,
} from "@/app/generated/prisma/enums";

export const PIPELINE_PAGE_SIZE = 50;

// Obchod = lead s pozitívnym prvým hovorom (pipelineEnteredAt). Pipeline nikdy neukáže surové kontakty ani zmazané.
export const DEAL_WHERE = { deletedAt: null, pipelineEnteredAt: { not: null } } satisfies Prisma.LeadWhereInput;

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

export type PipelineViewKey = (typeof PIPELINE_VIEWS)[number]["key"] | "requests";

function pipelineViewWhere(view?: string): Prisma.LeadWhereInput {
    switch (view) {
        case "call":
            return { nextActionKind: "CALL" };
        case "quote":
            return { nextActionKind: "SEND_QUOTE" };
        case "email":
            return { nextActionKind: "SEND_EMAIL" };
        case "design":
            return { nextActionMode: "IN_PROGRESS" };
        case "quote_sent":
            return { quoteSentAt: { not: null } };
        case "design_sent":
            return { designs: { some: { deletedAt: null, sentAt: { not: null } } } };
        case "requests":
            return { requests: { some: { status: "OPEN" } } };
        default:
            return {};
    }
}

// owner: all (predvolené) | me | unassigned | <userId>
export function ownerWhere(owner: string | undefined, viewerId: string): Prisma.LeadWhereInput {
    if (!owner || owner === "all") return {};
    if (owner === "me") return { ownerId: viewerId };
    if (owner === "unassigned") return { ownerId: null };
    return { ownerId: owner };
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
    requests: { kind: DealRequestKind; createdAt: Date }[];
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
        openRequests: lead.requests.map((r) => ({ kind: r.kind, createdAt: r.createdAt.toISOString() })),
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

// Stránkovanie limitom (Načítať ďalších). Poradie sa počíta v DB nad celou filtrovanou množinou.
export async function getPipelineList({
    status,
    query,
    view,
    owner,
    viewerId,
    take = PIPELINE_PAGE_SIZE,
}: {
    status?: LeadStatus;
    query?: string;
    view?: string;
    owner?: string;
    viewerId: string;
    take?: number;
}): Promise<{ rows: PipelineListRow[]; hasMore: boolean }> {
    const isRequests = view === "requests";
    const where: Prisma.LeadWhereInput = {
        ...DEAL_WHERE,
        ...(status && !isRequests ? { status } : {}),
        ...pipelineViewWhere(view),
        ...ownerWhere(owner, viewerId),
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
    };

    // Zoradenie + LIMIT v databáze nad CELOU filtrovanou množinou (nie až po orezaní strany):
    // filtre ostávajú v Prisma (len id), poradie a stránka v SQL, detaily len pre riadky strany.
    const matching = await prisma.lead.findMany({ where, select: { id: true } });
    const ids = matching.map((m) => m.id);
    if (ids.length === 0) return { rows: [], hasMore: false };
    const ordered = isRequests
        ? await prisma.$queryRaw<{ id: string }[]>`
            SELECT l.id FROM "Lead" l
             WHERE l.id = ANY(${ids})
             ORDER BY (SELECT min(r."createdAt") FROM "DealRequest" r WHERE r."leadId" = l.id AND r.status = 'OPEN') ASC NULLS LAST, l.id
             LIMIT ${take + 1}`
        : await prisma.$queryRaw<{ id: string }[]>`
            SELECT l.id FROM "Lead" l
             WHERE l.id = ANY(${ids})
             ORDER BY ${PIPELINE_RANK_SQL}, l."nextActionAt" ASC NULLS LAST, l.id
             LIMIT ${take + 1}`;
    const hasMore = ordered.length > take;
    const pageIds = ordered.slice(0, take).map((o) => o.id);

    const leads = await prisma.lead.findMany({
        where: { id: { in: pageIds } },
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
            requests: { where: { status: "OPEN" }, select: { kind: true, createdAt: true }, orderBy: { createdAt: "asc" } },
            activities: {
                where: { category: "BUSINESS" },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { type: true, outcome: true, note: true, createdAt: true },
            },
        },
    });
    const byId = new Map(leads.map((l) => [l.id, l]));
    const rows = pageIds.map((id) => byId.get(id)).filter((l): l is (typeof leads)[number] => Boolean(l)).map(toPipelineRow);
    return { rows, hasMore };
}

// SQL zrkadlo nextActionSort (lib/overdue.ts): 0 urgentné (po termíne / dnes / do 30 min), 1 rozpracované,
// 2 budúce, 3 krok bez dátumu, 4 žiadny krok. Deň-only porovnáva obchodný dátum v Europe/Bratislava.
const PIPELINE_RANK_SQL = Prisma.sql`CASE
    WHEN l."nextActionKind" IS NULL THEN 4
    WHEN l."nextActionMode" = 'IN_PROGRESS' THEN 1
    WHEN l."nextActionAt" IS NULL THEN 3
    WHEN l."nextActionHasTime" AND l."nextActionAt" > (now() AT TIME ZONE 'UTC') + interval '30 minutes' THEN 2
    WHEN NOT l."nextActionHasTime"
         AND ((l."nextActionAt" AT TIME ZONE 'UTC') AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date
             > (now() AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date THEN 2
    ELSE 0
END`;

// Počty pre hlavičku pipeline: nepriradené otvorené obchody (banner), deals s otvorenou požiadavkou (záložka).
export async function getPipelineCounts() {
    const [unassignedOpen, requestDeals] = await Promise.all([
        prisma.lead.count({ where: { ...DEAL_WHERE, ownerId: null, status: { in: ["ACTIVE", "SNOOZED"] } } }),
        prisma.lead.count({ where: { ...DEAL_WHERE, requests: { some: { status: "OPEN" } } } }),
    ]);
    return { unassignedOpen, requestDeals };
}

export async function getPipelineDetail(id: string) {
    const lead = await prisma.lead.findFirst({
        where: { id, ...DEAL_WHERE },
        include: {
            owner: { select: { id: true, firstName: true, lastName: true } },
            handedOffBy: { select: { firstName: true, lastName: true } },
            activities: {
                orderBy: { createdAt: "desc" },
                include: { user: { select: { firstName: true } } },
            },
            requests: {
                orderBy: [{ status: "asc" }, { createdAt: "asc" }],
                include: {
                    createdBy: { select: { firstName: true, lastName: true } },
                    resolvedBy: { select: { firstName: true, lastName: true } },
                },
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
        pipelineEnteredAt: lead.pipelineEnteredAt?.toISOString() ?? null,
        closedAt: lead.closedAt?.toISOString() ?? null,
        callbackAt: lead.callbackAt?.toISOString() ?? null,
        assignedCallerAt: lead.assignedCallerAt?.toISOString() ?? null,
        deletedAt: null,
        lockedAt: null,
        createdAt: lead.createdAt.toISOString(),
        updatedAt: lead.updatedAt.toISOString(),
        requests: lead.requests.map((r) => ({
            id: r.id,
            kind: r.kind,
            status: r.status,
            note: r.note,
            resolutionNote: r.resolutionNote,
            createdAt: r.createdAt.toISOString(),
            resolvedAt: r.resolvedAt?.toISOString() ?? null,
            createdBy: `${r.createdBy.firstName} ${r.createdBy.lastName}`.trim(),
            createdById: r.createdById,
            resolvedBy: r.resolvedBy ? `${r.resolvedBy.firstName} ${r.resolvedBy.lastName}`.trim() : null,
        })),
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
export type DealRequestView = PipelineDetailData["requests"][number];

// Kandidáti na vlastníka: aktívni používatelia s rolou, ktorá má deals.receive (nahrádza getPipelineUsers).
export async function getDealOwnerOptions() {
    const roles = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes("deals.receive"));
    return prisma.user.findMany({
        where: { deletedAt: null, role: { in: roles } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
}

export type PipelineUserOption = Awaited<ReturnType<typeof getDealOwnerOptions>>[number];
