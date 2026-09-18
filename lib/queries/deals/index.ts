import prisma from "@/lib/db";
import { Prisma } from "@/app/generated/prisma/client";
import type { AccessUser } from "@/lib/access/user";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";
import { clientSection, isDealOverdue } from "@/lib/domain/clientSections";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";
import {
    dealScope,
    ownerFilterWhere,
    scopeWhere,
    type DealScope,
    type OwnerFilter,
} from "@/lib/domain/dealScope";
import { isDealView, viewIgnoresStatus } from "@/lib/domain/dealFilters";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { summarizeEvents, type Confidence } from "@/lib/tracking/confidence";
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

// Jediný read model obrazovky obchodov (/dashboard/pipeline) pre všetky roly. Rozsah je VŽDY v dotaze
// (scopeWhere), nikdy len v UI; `owner` je filter v rámci rozsahu. Zoradenie a stránka sa počítajú v SQL
// nad celou filtrovanou množinou (nie až po orezaní strany).

export const DEAL_PAGE_SIZE = 50;

export { DEAL_VIEWS, isDealView, viewIgnoresStatus } from "@/lib/domain/dealFilters";
export type { DealViewKey } from "@/lib/domain/dealFilters";

// Obchod = lead s pozitívnym prvým hovorom (pipelineEnteredAt). Nikdy surové kontakty ani zmazané.
export const DEAL_WHERE = { deletedAt: null, pipelineEnteredAt: { not: null } } satisfies Prisma.LeadWhereInput;

const OPEN_STATUSES = ["ACTIVE", "SNOOZED"] as const;

function viewWhere(view?: string): Prisma.LeadWhereInput {
    switch (view) {
        case "today":
            return { status: { in: [...OPEN_STATUSES] } }; // presné pravidlo dopĺňa TODAY_SQL v SQL časti
        case "call":
            return { nextActionKind: "CALL" };
        case "quote":
            return { nextActionKind: "SEND_QUOTE" };
        case "email":
            return { nextActionKind: "SEND_EMAIL" };
        case "design":
            return { nextActionMode: "IN_PROGRESS" };
        case "waiting":
            return { nextActionKind: "WAITING_FOR_CLIENT" };
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

function searchWhere(q: string): Prisma.LeadWhereInput {
    return {
        OR: [
            { companyName: { contains: q, mode: "insensitive" } },
            { website: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { email: { contains: q, mode: "insensitive" } },
        ],
    };
}

// Rozsah používateľa. Tímová vetva si dotiahne členov tímu; „own"/„all" nepotrebujú dotaz.
export async function getDealScope(viewer: Pick<AccessUser, "id" | "role" | "teamId">): Promise<DealScope> {
    const shallow = dealScope(viewer);
    if (shallow.kind !== "team") return shallow;
    const members = await prisma.user.findMany({
        where: { teamId: shallow.teamId, deletedAt: null },
        select: { id: true },
    });
    return dealScope(viewer, members.map((m) => m.id));
}

// ── SQL fragmenty ────────────────────────────────────────────────────────────

// Zrkadlo nextActionSort (lib/overdue.ts): 0 urgentné (po termíne / dnes / do 30 min), 1 rozpracované,
// 2 budúce, 3 krok bez dátumu, 4 žiadny krok. Deň-only porovnáva obchodný dátum v Europe/Bratislava.
const DEAL_RANK_SQL = Prisma.sql`CASE
    WHEN l."nextActionKind" IS NULL THEN 4
    WHEN l."nextActionMode" = 'IN_PROGRESS' THEN 1
    WHEN l."nextActionAt" IS NULL THEN 3
    WHEN l."nextActionHasTime" AND l."nextActionAt" > (now() AT TIME ZONE 'UTC') + interval '30 minutes' THEN 2
    WHEN NOT l."nextActionHasTime"
         AND ((l."nextActionAt" AT TIME ZONE 'UTC') AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date
             > (now() AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date THEN 2
    ELSE 0
END`;

// Zrkadlo isDueByBusinessDay: s časom = okamih padne do dnešného obchodného dňa; deň-only = dátum <= dnes.
const DUE_SQL = Prisma.sql`(
    CASE WHEN l."nextActionHasTime"
        THEN l."nextActionAt" < (((date_trunc('day', now() AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}') + interval '1 day')
             AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}') AT TIME ZONE 'UTC')
        ELSE ((l."nextActionAt" AT TIME ZONE 'UTC') AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date
             <= (now() AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date
    END)`;

// Zrkadlo clientSection() pre sekciu TODAY (pozri check-client-sections.ts a paritný test v check-concurrency.ts):
// otvorený obchod bez otvorenej požiadavky, ktorý treba riešiť dnes – vrátane „bez kroku", „bez termínu" a „zobudený".
const TODAY_SQL = Prisma.sql`(
    l."status" IN ('ACTIVE','SNOOZED')
    AND NOT EXISTS (SELECT 1 FROM "DealRequest" r WHERE r."leadId" = l.id AND r.status = 'OPEN')
    AND (
        (l."status" = 'SNOOZED' AND (l."nextActionAt" IS NULL OR ${DUE_SQL}))
        OR (l."status" = 'ACTIVE' AND (
                l."nextActionKind" IS NULL
                OR (l."nextActionMode" <> 'IN_PROGRESS' AND (
                        (l."nextActionKind" = 'WAITING_FOR_CLIENT' AND l."nextActionAt" IS NOT NULL AND ${DUE_SQL})
                        OR (l."nextActionKind" <> 'WAITING_FOR_CLIENT'
                            AND (l."nextActionAt" IS NULL OR ${DUE_SQL}))
                   ))
           ))
    ))`;

// ── Zoznam ───────────────────────────────────────────────────────────────────

type DealLead = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    status: LeadStatus;
    revision: number;
    projectType: ProjectType | null;
    nextActionKind: NextActionKind | null;
    nextActionAt: Date | null;
    nextActionHasTime: boolean;
    nextActionMode: NextActionMode;
    nextActionNote: string | null;
    closedAt: Date | null;
    price: { toString(): string } | null;
    priceDisclosed: boolean;
    quoteSentAt: Date | null;
    aboutUsSentAt: Date | null;
    designs: { id: string }[];
    owner: { id: string; firstName: string } | null;
    handedOffBy: { firstName: string; lastName: string } | null;
    requests: { id: string; kind: DealRequestKind; createdAt: Date }[];
    activities: { type: ActivityType; outcome: CallOutcome | null; note: string | null; createdAt: Date }[];
};

const LIST_SELECT = {
    id: true,
    number: true,
    companyName: true,
    website: true,
    phone: true,
    status: true,
    revision: true,
    projectType: true,
    nextActionKind: true,
    nextActionAt: true,
    nextActionHasTime: true,
    nextActionMode: true,
    nextActionNote: true,
    closedAt: true,
    price: true,
    priceDisclosed: true,
    quoteSentAt: true,
    aboutUsSentAt: true,
    designs: { where: { deletedAt: null, sentAt: { not: null } }, select: { id: true }, take: 1 },
    owner: { select: { id: true, firstName: true } },
    handedOffBy: { select: { firstName: true, lastName: true } },
    requests: { where: { status: "OPEN" as const }, select: { id: true, kind: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
    activities: {
        where: { category: "BUSINESS" as const },
        orderBy: { createdAt: "desc" as const },
        take: 1,
        select: { type: true, outcome: true, note: true, createdAt: true },
    },
} satisfies Prisma.LeadSelect;

// Koľko hovorov po sebe (od najnovšieho) skončilo „nezdvihli". Zobrazuje sa ako „3. pokus" –
// bez toho nie je z riadku vidno, že sa už dvakrát volalo (round 2, D-05).
async function noAnswerStreaks(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.$queryRaw<{ leadId: string; streak: bigint }[]>`
        WITH calls AS (
            SELECT a."leadId",
                   a.outcome,
                   row_number() OVER (PARTITION BY a."leadId" ORDER BY a."createdAt" DESC) AS rn
              FROM "Activity" a
             WHERE a."leadId" = ANY(${ids}) AND a.type = 'CALL' AND a."revertedAt" IS NULL
        )
        SELECT "leadId",
               (COALESCE(min(rn) FILTER (WHERE outcome <> 'NO_ANSWER'), max(rn) + 1) - 1)::bigint AS streak
          FROM calls
         GROUP BY "leadId"`;
    return new Map(rows.map((r) => [r.leadId, Number(r.streak)]));
}

function toDealRow(lead: DealLead, now: Date, noAnswerStreak = 0) {
    const cls = clientSection(
        {
            status: lead.status,
            nextActionKind: lead.nextActionKind,
            nextActionAt: lead.nextActionAt,
            nextActionHasTime: lead.nextActionHasTime,
            nextActionMode: lead.nextActionMode,
            closedAt: lead.closedAt,
            openRequestCount: lead.requests.length,
        },
        now,
    );
    const last = lead.activities[0];
    return {
        id: lead.id,
        number: lead.number,
        name: lead.companyName ?? lead.website ?? "—",
        phone: lead.phone,
        status: lead.status,
        revision: lead.revision,
        projectType: lead.projectType,
        section: cls.section,
        badge: cls.badge ?? null,
        overdue: isDealOverdue(lead, now),
        nextActionKind: lead.nextActionKind,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        nextActionHasTime: lead.nextActionHasTime,
        nextActionMode: lead.nextActionMode,
        nextActionNote: lead.nextActionNote,
        closedAt: lead.closedAt?.toISOString() ?? null,
        price: lead.price ? Number(lead.price) : null,
        priceDisclosed: lead.priceDisclosed,
        quoteSentAt: lead.quoteSentAt?.toISOString() ?? null,
        aboutUsSentAt: lead.aboutUsSentAt?.toISOString() ?? null,
        hasDesignSent: lead.designs.length > 0,
        ownerId: lead.owner?.id ?? null,
        owner: lead.owner?.firstName ?? null,
        handedOffBy: lead.handedOffBy ? `${lead.handedOffBy.firstName} ${lead.handedOffBy.lastName}`.trim() : null,
        openRequests: lead.requests.map((r) => ({ id: r.id, kind: r.kind, createdAt: r.createdAt.toISOString() })),
        lastActivity: last
            ? { type: last.type, outcome: last.outcome, note: last.note, at: last.createdAt.toISOString() }
            : null,
        noAnswerStreak,
    };
}

export type DealRow = ReturnType<typeof toDealRow>;

export type DealListParams = {
    scope: DealScope;
    owner: OwnerFilter;
    status?: LeadStatus;
    query?: string;
    view?: string;
    handedOffBy?: string;
    requestKind?: DealRequestKind;
    take?: number;
};

function baseWhere(params: Pick<DealListParams, "scope" | "owner" | "handedOffBy" | "query">): Prisma.LeadWhereInput {
    const q = params.query?.trim();
    return {
        ...DEAL_WHERE,
        ...scopeWhere(params.scope),
        ...ownerFilterWhere(params.owner),
        ...(params.handedOffBy ? { handedOffById: params.handedOffBy } : {}),
        ...(q ? searchWhere(q) : {}),
    };
}

export async function getDealList(params: DealListParams): Promise<{ rows: DealRow[]; hasMore: boolean }> {
    const take = params.take && params.take > 0 ? params.take : DEAL_PAGE_SIZE;
    const view = isDealView(params.view) ? params.view : undefined;
    const isRequests = view === "requests";
    const isToday = view === "today";
    const where: Prisma.LeadWhereInput = {
        ...baseWhere(params),
        ...(params.status && !viewIgnoresStatus(view) ? { status: params.status } : {}),
        ...viewWhere(view),
        ...(isRequests && params.requestKind
            ? { requests: { some: { status: "OPEN", kind: params.requestKind } } }
            : {}),
    };

    const matching = await prisma.lead.findMany({ where, select: { id: true } });
    const ids = matching.map((m) => m.id);
    if (ids.length === 0) return { rows: [], hasMore: false };

    // Filtre ostávajú v Prisma (len id), poradie + stránka v SQL nad celou množinou.
    const todayFilter = isToday ? Prisma.sql`AND ${TODAY_SQL}` : Prisma.empty;
    const ordered = isRequests
        ? await prisma.$queryRaw<{ id: string }[]>`
            SELECT l.id FROM "Lead" l
             WHERE l.id = ANY(${ids})
             ORDER BY (SELECT min(r."createdAt") FROM "DealRequest" r WHERE r."leadId" = l.id AND r.status = 'OPEN') ASC NULLS LAST, l.id
             LIMIT ${take + 1}`
        : await prisma.$queryRaw<{ id: string }[]>`
            SELECT l.id FROM "Lead" l
             WHERE l.id = ANY(${ids}) ${todayFilter}
             ORDER BY ${DEAL_RANK_SQL}, l."nextActionAt" ASC NULLS LAST, l.id
             LIMIT ${take + 1}`;
    const hasMore = ordered.length > take;
    const pageIds = ordered.slice(0, take).map((o) => o.id);
    if (pageIds.length === 0) return { rows: [], hasMore: false };

    const [leads, streaks] = await Promise.all([
        prisma.lead.findMany({ where: { id: { in: pageIds } }, select: LIST_SELECT }),
        noAnswerStreaks(pageIds),
    ]);
    const byId = new Map(leads.map((l) => [l.id, l]));
    const now = new Date();
    const rows = pageIds
        .map((id) => byId.get(id))
        .filter((l): l is (typeof leads)[number] => Boolean(l))
        .map((l) => toDealRow(l, now, streaks.get(l.id) ?? 0));
    return { rows, hasMore };
}

// Počty do pilulek – rovnaký rozsah a filter vlastníka ako zoznam, takže číslo sedí s tým, čo klik ukáže.
export async function getDealCounts(params: Pick<DealListParams, "scope" | "owner" | "handedOffBy">) {
    const base = baseWhere(params);
    const [requests, openIds, unassignedOpen] = await Promise.all([
        prisma.lead.count({ where: { ...base, requests: { some: { status: "OPEN" } } } }),
        prisma.lead.findMany({ where: { ...base, status: { in: [...OPEN_STATUSES] } }, select: { id: true } }),
        params.scope.kind === "all"
            ? prisma.lead.count({ where: { ...DEAL_WHERE, ownerId: null, status: { in: [...OPEN_STATUSES] } } })
            : Promise.resolve(0),
    ]);
    const ids = openIds.map((o) => o.id);
    const today = ids.length
        ? Number(
              (
                  await prisma.$queryRaw<{ count: bigint }[]>`
                    SELECT count(*)::bigint AS count FROM "Lead" l WHERE l.id = ANY(${ids}) AND ${TODAY_SQL}`
              )[0]?.count ?? 0,
          )
        : 0;
    return { today, requests, unassignedOpen, open: ids.length };
}

// ── Detail ───────────────────────────────────────────────────────────────────

export async function getDealDetail(
    id: string,
    scope: DealScope,
    caps: Pick<DealCapabilities, "manage">,
) {
    const lead = await prisma.lead.findFirst({
        where: { id, ...DEAL_WHERE, ...scopeWhere(scope) },
        include: {
            owner: { select: { id: true, firstName: true, lastName: true } },
            handedOffBy: { select: { firstName: true, lastName: true } },
            activities: {
                // Obchodník vidí obchodné kroky; audit (zmeny vlastníka, priradenia) je manažérska vec.
                where: caps.manage ? {} : { category: "BUSINESS" },
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
            designs: {
                where: { deletedAt: null },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    label: true,
                    currentVersion: true,
                    sentAt: true,
                    tracker: {
                        select: {
                            events: {
                                select: { type: true, versionAtView: true, botFlag: true, durationMs: true, occurredAt: true },
                            },
                        },
                    },
                },
            },
        },
    });
    if (!lead) return null;
    const now = new Date();
    const openRequestCount = lead.requests.filter((r) => r.status === "OPEN").length;
    const cls = clientSection({ ...lead, openRequestCount }, now);
    let noAnswerStreak = 0;
    for (const a of lead.activities) {
        if (a.type !== "CALL" || a.revertedAt) continue;
        if (a.outcome !== "NO_ANSWER") break;
        noAnswerStreak++;
    }

    return {
        id: lead.id,
        number: lead.number,
        name: lead.companyName ?? lead.website ?? "—",
        companyName: lead.companyName,
        website: lead.website,
        phone: lead.phone,
        email: lead.email,
        note: lead.note,
        status: lead.status,
        revision: lead.revision,
        section: cls.section,
        badge: cls.badge ?? null,
        noAnswerStreak,
        projectType: lead.projectType,
        nextActionKind: lead.nextActionKind,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        nextActionHasTime: lead.nextActionHasTime,
        nextActionMode: lead.nextActionMode,
        nextActionNote: lead.nextActionNote,
        price: lead.price != null ? Number(lead.price) : null,
        priceNote: lead.priceNote,
        priceDisclosed: lead.priceDisclosed,
        quoteSentAt: lead.quoteSentAt?.toISOString() ?? null,
        designSentAt: lead.designSentAt?.toISOString() ?? null,
        aboutUsSentAt: lead.aboutUsSentAt?.toISOString() ?? null,
        lostReason: lead.lostReason,
        closedAt: lead.closedAt?.toISOString() ?? null,
        pipelineEnteredAt: lead.pipelineEnteredAt?.toISOString() ?? null,
        createdAt: lead.createdAt.toISOString(),
        owner: lead.owner,
        handedOffBy: lead.handedOffBy,
        requests: lead.requests.map((r) => ({
            id: r.id,
            kind: r.kind,
            status: r.status,
            note: r.note,
            resolutionNote: r.resolutionNote,
            createdAt: r.createdAt.toISOString(),
            resolvedAt: r.resolvedAt?.toISOString() ?? null,
            createdById: r.createdById,
            createdBy: `${r.createdBy.firstName} ${r.createdBy.lastName}`.trim(),
            resolvedBy: r.resolvedBy ? `${r.resolvedBy.firstName} ${r.resolvedBy.lastName}`.trim() : null,
        })),
        activities: lead.activities.map((a) => ({
            id: a.id,
            type: a.type,
            category: a.category,
            source: a.source,
            outcome: a.outcome,
            note: a.note,
            userName: a.user.firstName,
            createdAt: a.createdAt.toISOString(),
        })),
        // Súhrn sledovania návrhu – bez tokenov, URL a IP (spravovanie návrhov má manažér vo vlastnej karte).
        designs: lead.designs.map((d) => {
            const s = summarizeEvents(d.tracker?.events ?? [], d.currentVersion);
            return {
                id: d.id,
                label: d.label,
                sentAt: d.sentAt?.toISOString() ?? null,
                confidence: s.confidence as Confidence,
                views: s.totalViews,
                lastViewedAt: s.lastViewedAt?.toISOString() ?? null,
            };
        }),
    };
}

export type DealDetailData = NonNullable<Awaited<ReturnType<typeof getDealDetail>>>;
export type DealActivityView = DealDetailData["activities"][number];
export type DealRequestView = DealDetailData["requests"][number];

// ── Číselníky pre filtre ─────────────────────────────────────────────────────

// Kandidáti na vlastníka (a zároveň hodnoty filtra vlastníka v rámci rozsahu).
export async function getDealOwnerOptions(scope?: DealScope) {
    const roles = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes("deals.receive"));
    const users = await prisma.user.findMany({
        where: {
            deletedAt: null,
            role: { in: roles },
            ...(scope?.kind === "team" ? { id: { in: scope.userIds } } : {}),
        },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
    return scope?.kind === "own" ? users.filter((u) => u.id === scope.userId) : users;
}

export type DealUserOption = Awaited<ReturnType<typeof getDealOwnerOptions>>[number];

// Ľudia, ktorých pozitívne hovory vytvorili obchody – filter „od koho to prišlo".
export async function getHandoffOptions(scope: DealScope) {
    return prisma.user.findMany({
        where: { handedOffLeads: { some: { ...DEAL_WHERE, ...scopeWhere(scope) } } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
}
