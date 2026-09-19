import { z } from "zod";
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
import { trackedUrl } from "@/lib/domain/designLinks";
import { LAST_TOUCH_TYPES, lastOfferOf, parseOfferMeta, summarizeOffers, type OfferDialogDeal, type OfferRow } from "@/lib/domain/offers";
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
        case "got_pricelist":
            return { offerPricelistAt: { not: null } };
        case "got_price":
            return { offerPriceAt: { not: null } };
        case "got_design":
            return { designs: { some: { deletedAt: null, sentAt: { not: null } } } };
        case "unverified":
            return { hadLegacySends: true, legacySendsReviewedAt: null };
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
    priceNote: string | null;
    offerAboutUsAt: Date | null;
    offerPricelistAt: Date | null;
    offerPriceAt: Date | null;
    hadLegacySends: boolean;
    legacySendsReviewedAt: Date | null;
    quoteSentAt: Date | null;
    aboutUsSentAt: Date | null;
    priceDisclosed: boolean;
    designs: { id: string; label: string | null; targetUrl: string | null; sentAt: Date | null; tracker: { token: string } | null }[];
    designSentAt: Date | null;
    _count: { designs: number };
    owner: { id: string; firstName: string } | null;
    handedOffBy: { firstName: string; lastName: string } | null;
    requests: { id: string; kind: DealRequestKind; createdAt: Date }[];
    activities: { type: ActivityType; outcome: CallOutcome | null; note: string | null; createdAt: Date }[];
};

// „Naposledy" = posledný skutočný kontakt: bez prečiarknutých záznamov, bez ceny povedanej v hovore (tá je súčasťou
// toho hovoru) a bez spätne doplnených starých odoslaní (round 2 §2c 5.3, 5.7).
const LAST_TOUCH_WHERE = {
    type: { in: [...LAST_TOUCH_TYPES] },
    revertedAt: null,
    NOT: [
        { type: "OFFER_SENT" as const, meta: { path: ["channel"], equals: "PHONE" } },
        { type: "OFFER_SENT" as const, meta: { path: ["historical"], equals: true } },
    ],
} satisfies Prisma.ActivityWhereInput;

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
    priceNote: true,
    offerAboutUsAt: true,
    offerPricelistAt: true,
    offerPriceAt: true,
    hadLegacySends: true,
    legacySendsReviewedAt: true,
    quoteSentAt: true,
    aboutUsSentAt: true,
    priceDisclosed: true,
    designSentAt: true,
    _count: { select: { designs: true } }, // aj zmazané – obchod bez jediného návrhu = starý údaj z Lead.designSentAt
    // Návrhy pre dialóg „Čo sme poslali" otváraný priamo zo zoznamu (round 2 §2d) + ikonka „dostali návrh".
    designs: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" as const },
        select: { id: true, label: true, targetUrl: true, sentAt: true, tracker: { select: { token: true } } },
    },
    owner: { select: { id: true, firstName: true } },
    handedOffBy: { select: { firstName: true, lastName: true } },
    requests: { where: { status: "OPEN" as const }, select: { id: true, kind: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
    activities: {
        where: LAST_TOUCH_WHERE,
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
             WHERE a."leadId" = ANY(${ids}) AND a.type IN ('CALL', 'CLIENT_REPLIED') AND a."revertedAt" IS NULL
        )
        SELECT "leadId",
               (COALESCE(min(rn) FILTER (WHERE outcome <> 'NO_ANSWER'), max(rn) + 1) - 1)::bigint AS streak
          FROM calls
         GROUP BY "leadId"`;
    return new Map(rows.map((r) => [r.leadId, Number(r.streak)]));
}

// Posledné odoslanie pre každý obchod na strane (jeden dotaz).
async function lastOffers(ids: string[]): Promise<Map<string, { text: string; at: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.activity.findMany({
        where: { leadId: { in: ids }, type: "OFFER_SENT", revertedAt: null },
        select: { id: true, leadId: true, createdAt: true, revertedAt: true, meta: true },
    });
    const byLead = new Map<string, OfferRow[]>();
    for (const r of rows) {
        const meta = parseOfferMeta(r.meta);
        if (!meta) continue;
        const list = byLead.get(r.leadId) ?? [];
        list.push({ id: r.id, createdAt: r.createdAt, revertedAt: r.revertedAt, meta });
        byLead.set(r.leadId, list);
    }
    const out = new Map<string, { text: string; at: string }>();
    for (const [leadId, list] of byLead) {
        const last = lastOfferOf(list);
        if (last) out.set(leadId, last);
    }
    return out;
}

function toDealRow(lead: DealLead, now: Date, noAnswerStreak = 0, lastOffer: { text: string; at: string } | null = null) {
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
        gotPricelist: lead.offerPricelistAt !== null,
        gotPrice: lead.offerPriceAt !== null,
        hasDesignSent: legacyAwareDesignSentAt(lead) !== null,
        legacyUnreviewed: lead.hadLegacySends && lead.legacySendsReviewedAt === null,
        ownerId: lead.owner?.id ?? null,
        owner: lead.owner?.firstName ?? null,
        handedOffBy: lead.handedOffBy ? `${lead.handedOffBy.firstName} ${lead.handedOffBy.lastName}`.trim() : null,
        openRequests: lead.requests.map((r) => ({ id: r.id, kind: r.kind, createdAt: r.createdAt.toISOString() })),
        lastActivity: last
            ? { type: last.type, outcome: last.outcome, note: last.note, at: last.createdAt.toISOString() }
            : null,
        noAnswerStreak,
        lastOffer,
        dialog: offerDialogOf(lead),
    };
}

export type DealRow = ReturnType<typeof toDealRow>;

// Posledný poslaný návrh; obchod, ktorý nemá ani jeden Design riadok (návrhy spred modelu Design), berie starý
// Lead.designSentAt – inak by sa odoslaný návrh tváril ako „neposlaný".
function legacyAwareDesignSentAt(lead: {
    designs: { sentAt: Date | null }[];
    designSentAt: Date | null;
    _count: { designs: number };
}): Date | null {
    const fromRows = lead.designs.reduce<Date | null>((max, d) => (d.sentAt && (!max || d.sentAt > max) ? d.sentAt : max), null);
    return fromRows ?? (lead._count.designs === 0 ? lead.designSentAt : null);
}

function offerDialogOf(lead: DealLead): OfferDialogDeal {
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    const designSentAt = legacyAwareDesignSentAt(lead);
    return {
        id: lead.id,
        revision: lead.revision,
        owner: lead.owner,
        price: lead.price != null ? Number(lead.price) : null,
        priceNote: lead.priceNote,
        nextActionKind: lead.nextActionKind,
        nextActionAt: iso(lead.nextActionAt),
        offers: {
            offerAboutUsAt: iso(lead.offerAboutUsAt),
            offerPricelistAt: iso(lead.offerPricelistAt),
            offerPriceAt: iso(lead.offerPriceAt),
            designSentAt: iso(designSentAt),
            hadLegacySends: lead.hadLegacySends,
            legacySendsReviewedAt: iso(lead.legacySendsReviewedAt),
            legacy: { quoteSentAt: iso(lead.quoteSentAt), aboutUsSentAt: iso(lead.aboutUsSentAt), priceDisclosed: lead.priceDisclosed },
        },
        designs: lead.designs.map((d) => ({
            id: d.id,
            label: d.label,
            url: d.targetUrl,
            trackedUrl: d.targetUrl && d.tracker?.token ? trackedUrl(d.targetUrl, d.tracker.token) : null,
            sentAt: iso(d.sentAt),
        })),
    };
}

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

    const [leads, streaks, offers] = await Promise.all([
        // Rozsah znova aj tu: obchod presunutý medzi prvým a druhým dotazom sa nezobrazí.
        prisma.lead.findMany({ where: { id: { in: pageIds }, ...DEAL_WHERE, ...scopeWhere(params.scope) }, select: LIST_SELECT }),
        noAnswerStreaks(pageIds),
        lastOffers(pageIds),
    ]);
    const byId = new Map(leads.map((l) => [l.id, l]));
    const now = new Date();
    const rows = pageIds
        .map((id) => byId.get(id))
        .filter((l): l is (typeof leads)[number] => Boolean(l))
        .map((l) => toDealRow(l, now, streaks.get(l.id) ?? 0, offers.get(l.id) ?? null));
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
            _count: { select: { designs: true } },
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
                    targetUrl: true,
                    currentVersion: true,
                    sentAt: true,
                    tracker: {
                        select: {
                            token: true,
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
        if ((a.type !== "CALL" && a.type !== "CLIENT_REPLIED") || a.revertedAt) continue;
        if (a.outcome !== "NO_ANSWER") break;
        noAnswerStreak++;
    }

    // Čo klient dostal: súhrn z platných OFFER_SENT (posledná poslaná cena ako kotva) + staré údaje len ako „?".
    const offerRows: OfferRow[] = [];
    for (const a of lead.activities) {
        if (a.type !== "OFFER_SENT") continue;
        const meta = parseOfferMeta(a.meta);
        if (meta) offerRows.push({ id: a.id, createdAt: a.createdAt, revertedAt: a.revertedAt, meta });
    }
    const offers = summarizeOffers(offerRows);
    // Rovnaké pravidlo ako LAST_TOUCH_WHERE v zozname.
    const lastTouch = lead.activities.find((a) => {
        if (!(LAST_TOUCH_TYPES as readonly string[]).includes(a.type) || a.revertedAt) return false;
        const offer = a.type === "OFFER_SENT" ? parseOfferMeta(a.meta) : null;
        return !offer || (offer.channel !== "PHONE" && !offer.historical);
    });

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
        offers: {
            offerAboutUsAt: lead.offerAboutUsAt?.toISOString() ?? null,
            offerPricelistAt: lead.offerPricelistAt?.toISOString() ?? null,
            offerPriceAt: lead.offerPriceAt?.toISOString() ?? null,
            designSentAt: legacyAwareDesignSentAt(lead)?.toISOString() ?? null,
            hadLegacySends: lead.hadLegacySends,
            legacySendsReviewedAt: lead.legacySendsReviewedAt?.toISOString() ?? null,
            lastPrice: offers.lastPrice,
            // Staré polia – zobrazujú sa len ako „čo tvrdil starý záznam", nikdy ako „áno".
            legacy: {
                quoteSentAt: lead.quoteSentAt?.toISOString() ?? null,
                aboutUsSentAt: lead.aboutUsSentAt?.toISOString() ?? null,
                priceDisclosed: lead.priceDisclosed,
            },
        },
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
        lastOffer: lastOfferOf(offerRows),
        lastTouch: lastTouch
            ? { type: lastTouch.type, outcome: lastTouch.outcome, note: lastTouch.note, at: lastTouch.createdAt.toISOString() }
            : null,
        activities: lead.activities.map((a) => {
            const offer = a.type === "OFFER_SENT" ? parseOfferMeta(a.meta) : null;
            const correction = correctionOf(a.meta);
            return {
                id: a.id,
                type: a.type,
                category: a.category,
                source: a.source,
                outcome: a.outcome,
                note: a.note,
                userId: a.userId,
                userName: a.user.firstName,
                createdAt: a.createdAt.toISOString(),
                revertedAt: a.revertedAt?.toISOString() ?? null,
                correctionReason: correction,
                offer: offer ? { sentOn: offer.sentOn, historical: offer.historical, channel: offer.channel } : null,
            };
        }),
        // Súhrn sledovania návrhu – bez tokenov, URL a IP (spravovanie návrhov má manažér vo vlastnej karte).
        designs: lead.designs.map((d) => {
            const s = summarizeEvents(d.tracker?.events ?? [], d.currentVersion);
            return {
                id: d.id,
                label: d.label,
                url: d.targetUrl,
                // Sledovaný odkaz len pre tlačidlo „Skopírovať odkaz do emailu" – v UI sa nevykresľuje ako klikateľný.
                trackedUrl: d.targetUrl && d.tracker?.token ? trackedUrl(d.targetUrl, d.tracker.token) : null,
                sentAt: d.sentAt?.toISOString() ?? null,
                confidence: s.confidence as Confidence,
                views: s.totalViews,
                lastViewedAt: s.lastViewedAt?.toISOString() ?? null,
            };
        }),
    };
}

// Dôvod opravy prečiarknutého záznamu (meta.correction – lib/domain/offerMutations.ts correctRecord).
const correctionSchema = z.object({ correction: z.object({ reason: z.string() }) });
function correctionOf(meta: unknown): string | null {
    const parsed = correctionSchema.safeParse(meta);
    return parsed.success ? parsed.data.correction.reason : null;
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
