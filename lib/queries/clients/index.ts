import prisma from "@/lib/db";
import { can } from "@/lib/permissions";
import type { Prisma } from "@/app/generated/prisma/client";
import type { AccessUser } from "@/lib/access/user";
import {
    clientSection,
    CLIENT_SECTIONS,
    isDealOverdue,
    recentClosedLimit,
    type ClientSection,
} from "@/lib/domain/clientSections";
import { summarizeEvents, type Confidence } from "@/lib/tracking/confidence";

// „Moji klienti" – vždy len obchody, ktoré vlastní prihlásený používateľ (ownerId = user.id, nikdy z URL).

export const ARCHIVE_PAGE = 50;
export const SEARCH_PAGE = 50;

function ownDeals(user: Pick<AccessUser, "id">): Prisma.LeadWhereInput {
    return { deletedAt: null, pipelineEnteredAt: { not: null }, ownerId: user.id };
}

const SELECT = {
    id: true,
    number: true,
    companyName: true,
    website: true,
    phone: true,
    email: true,
    status: true,
    revision: true,
    nextActionKind: true,
    nextActionAt: true,
    nextActionHasTime: true,
    nextActionMode: true,
    nextActionNote: true,
    closedAt: true,
    price: true,
    quoteSentAt: true,
    aboutUsSentAt: true,
    lostReason: true,
    note: true,
    requests: { where: { status: "OPEN" as const }, select: { id: true, kind: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
    activities: {
        where: { category: "BUSINESS" as const },
        orderBy: { createdAt: "desc" as const },
        take: 1,
        select: { type: true, outcome: true, note: true, createdAt: true },
    },
    designs: {
        where: { deletedAt: null },
        select: {
            currentVersion: true,
            sentAt: true,
            tracker: { select: { events: { select: { type: true, versionAtView: true, botFlag: true, durationMs: true, occurredAt: true } } } },
        },
    },
} satisfies Prisma.LeadSelect;

type Row = Prisma.LeadGetPayload<{ select: typeof SELECT }>;

const CONFIDENCE_RANK: Record<Confidence, number> = { none: 0, weak: 1, medium: 2, high: 3, very_high: 4 };

function toClientRow(l: Row, now: Date) {
    const cls = clientSection(
        {
            status: l.status,
            nextActionKind: l.nextActionKind,
            nextActionAt: l.nextActionAt,
            nextActionHasTime: l.nextActionHasTime,
            nextActionMode: l.nextActionMode,
            closedAt: l.closedAt,
            openRequestCount: l.requests.length,
        },
        now,
    );
    // Len súhrn trackingu – žiadne tokeny, URL ani IP.
    let tracking: { confidence: Confidence; views: number; lastViewedAt: string | null } | null = null;
    for (const d of l.designs) {
        if (!d.sentAt) continue;
        const s = summarizeEvents(d.tracker?.events ?? [], d.currentVersion);
        if (!tracking || CONFIDENCE_RANK[s.confidence] > CONFIDENCE_RANK[tracking.confidence]) {
            tracking = { confidence: s.confidence, views: s.totalViews, lastViewedAt: s.lastViewedAt?.toISOString() ?? null };
        }
    }
    const last = l.activities[0];
    return {
        id: l.id,
        number: l.number,
        name: l.companyName ?? l.website ?? "—",
        phone: l.phone,
        email: l.email,
        note: l.note,
        status: l.status,
        revision: l.revision,
        section: cls.section,
        badge: cls.badge ?? null,
        overdue: isDealOverdue(l, now),
        nextActionKind: l.nextActionKind,
        nextActionAt: l.nextActionAt?.toISOString() ?? null,
        nextActionHasTime: l.nextActionHasTime,
        nextActionMode: l.nextActionMode,
        nextActionNote: l.nextActionNote,
        closedAt: l.closedAt?.toISOString() ?? null,
        lostReason: l.lostReason,
        price: l.price != null ? Number(l.price) : null,
        quoteSentAt: l.quoteSentAt?.toISOString() ?? null,
        aboutUsSentAt: l.aboutUsSentAt?.toISOString() ?? null,
        openRequests: l.requests.map((r) => ({ id: r.id, kind: r.kind, createdAt: r.createdAt.toISOString() })),
        lastActivity: last ? { type: last.type, outcome: last.outcome, note: last.note, at: last.createdAt.toISOString() } : null,
        tracking,
    };
}

export type ClientRow = ReturnType<typeof toClientRow>;

function sortSection(section: ClientSection, rows: ClientRow[]) {
    const at = (r: ClientRow) => (r.nextActionAt ? new Date(r.nextActionAt).getTime() : Number.POSITIVE_INFINITY);
    switch (section) {
        case "TODAY":
            // po termíne prvé, potom podľa termínu, bez dátumu posledné
            return rows.sort((a, b) => Number(b.overdue) - Number(a.overdue) || at(a) - at(b));
        case "WAITING_ON_US":
            return rows.sort((a, b) => (a.openRequests[0]?.createdAt ?? "").localeCompare(b.openRequests[0]?.createdAt ?? ""));
        case "CLOSED_RECENT":
        case "ARCHIVED":
            return rows.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
        default:
            return rows.sort((a, b) => at(a) - at(b));
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

export async function getClientsBoard(user: Pick<AccessUser, "id">, opts: { q?: string; take?: number } = {}) {
    const now = new Date();
    const q = opts.q?.trim();
    if (q) {
        // Hľadanie cez všetky vlastné obchody (otvorené, nedávne, archív) – plochý zoznam so sekciou, stránkované.
        const take = opts.take && opts.take > 0 ? opts.take : SEARCH_PAGE;
        const rows = await prisma.lead.findMany({
            where: { ...ownDeals(user), ...searchWhere(q) },
            select: SELECT,
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take: take + 1,
        });
        return {
            mode: "search" as const,
            results: rows.slice(0, take).map((r) => toClientRow(r, now)),
            hasMore: rows.length > take,
        };
    }

    const limit = recentClosedLimit(now);
    const rows = await prisma.lead.findMany({
        where: {
            ...ownDeals(user),
            OR: [
                { status: { in: ["ACTIVE", "SNOOZED"] } },
                { status: { in: ["WON", "LOST", "UNREACHABLE"] }, closedAt: { gte: limit } },
            ],
        },
        select: SELECT,
    });
    const mapped = rows.map((r) => toClientRow(r, now));
    const sections = Object.fromEntries(
        CLIENT_SECTIONS.map((s) => [s, sortSection(s, mapped.filter((r) => r.section === s))]),
    ) as Record<(typeof CLIENT_SECTIONS)[number], ClientRow[]>;
    const open = mapped.filter((r) => r.status === "ACTIVE" || r.status === "SNOOZED").length;
    return {
        mode: "board" as const,
        sections,
        counts: {
            open,
            today: sections.TODAY.length,
            overdue: sections.TODAY.filter((r) => r.overdue).length,
        },
    };
}

// Archív: uzavreté obchody staršie ako 90 dní (alebo bez closedAt), stránkované, s hľadaním.
export async function getClientsArchive(user: Pick<AccessUser, "id">, opts: { q?: string; take?: number } = {}) {
    const now = new Date();
    const take = opts.take && opts.take > 0 ? opts.take : ARCHIVE_PAGE;
    const q = opts.q?.trim();
    const rows = await prisma.lead.findMany({
        where: {
            ...ownDeals(user),
            status: { in: ["WON", "LOST", "UNREACHABLE"] },
            OR: [{ closedAt: { lt: recentClosedLimit(now) } }, { closedAt: null }],
            ...(q ? { AND: [searchWhere(q)] } : {}),
        },
        select: SELECT,
        orderBy: [{ closedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
        take: take + 1,
    });
    return { rows: rows.slice(0, take).map((r) => toClientRow(r, now)), hasMore: rows.length > take };
}

// Detail obchodu. Rozsah je priamo v dotaze (nie len v predchádzajúcom requireDealView): bez pipeline.view len
// vlastný obchod – presun medzi kontrolou a načítaním teda nevráti detail bývalému vlastníkovi.
export async function getClientDetail(id: string, viewer: Pick<AccessUser, "id" | "role">) {
    const lead = await prisma.lead.findFirst({
        where: {
            id,
            deletedAt: null,
            pipelineEnteredAt: { not: null },
            ...(can(viewer, "pipeline.view") ? {} : { ownerId: viewer.id }),
        },
        select: {
            ...SELECT,
            priceNote: true,
            priceDisclosed: true,
            designSentAt: true,
            requests: {
                orderBy: [{ status: "asc" }, { createdAt: "desc" }],
                select: {
                    id: true,
                    kind: true,
                    status: true,
                    note: true,
                    resolutionNote: true,
                    createdAt: true,
                    resolvedAt: true,
                    createdById: true,
                    createdBy: { select: { firstName: true, lastName: true } },
                    resolvedBy: { select: { firstName: true, lastName: true } },
                },
            },
            activities: {
                where: { category: "BUSINESS" },
                orderBy: { createdAt: "desc" },
                select: { id: true, type: true, outcome: true, note: true, createdAt: true, source: true, user: { select: { firstName: true } } },
            },
            designs: {
                where: { deletedAt: null },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    label: true,
                    currentVersion: true,
                    sentAt: true,
                    tracker: { select: { events: { select: { type: true, versionAtView: true, botFlag: true, durationMs: true, occurredAt: true } } } },
                },
            },
        },
    });
    if (!lead) return null;
    const now = new Date();
    const openRequestCount = lead.requests.filter((r) => r.status === "OPEN").length;
    const cls = clientSection({ ...lead, openRequestCount }, now);
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
        nextActionKind: lead.nextActionKind,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        nextActionHasTime: lead.nextActionHasTime,
        nextActionMode: lead.nextActionMode,
        nextActionNote: lead.nextActionNote,
        closedAt: lead.closedAt?.toISOString() ?? null,
        lostReason: lead.lostReason,
        price: lead.price != null ? Number(lead.price) : null,
        priceNote: lead.priceNote,
        priceDisclosed: lead.priceDisclosed,
        quoteSentAt: lead.quoteSentAt?.toISOString() ?? null,
        aboutUsSentAt: lead.aboutUsSentAt?.toISOString() ?? null,
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
            outcome: a.outcome,
            note: a.note,
            source: a.source,
            userName: a.user.firstName,
            createdAt: a.createdAt.toISOString(),
        })),
        designs: lead.designs.map((d) => {
            const s = summarizeEvents(d.tracker?.events ?? [], d.currentVersion);
            return {
                id: d.id,
                label: d.label,
                sentAt: d.sentAt?.toISOString() ?? null,
                confidence: s.confidence,
                views: s.totalViews,
                lastViewedAt: s.lastViewedAt?.toISOString() ?? null,
            };
        }),
    };
}

export type ClientDetailData = NonNullable<Awaited<ReturnType<typeof getClientDetail>>>;
