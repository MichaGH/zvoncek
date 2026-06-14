import prisma from "@/lib/db";
import type { TrackedEventType } from "@/app/generated/prisma/enums";
import { summarizeEvents, type TrackingSummary } from "@/lib/tracking/confidence";

// Ingest: nájde tracker podľa tokenu + jeho návrh a aktuálnu verziu — JEDEN indexovaný dotaz.
export async function resolveTrackerToken(token: string) {
    return prisma.tracker.findUnique({
        where: { token },
        select: {
            id: true,
            design: {
                select: {
                    currentVersion: true,
                    deletedAt: true,
                    versions: {
                        orderBy: { version: "desc" },
                        take: 1,
                        select: { id: true, version: true },
                    },
                },
            },
        },
    });
}

type TrackedLinkSummaryView = Omit<TrackingSummary, "lastViewedAt"> & {
    lastViewedAt: string | null;
};

export type TrackedEventRow = {
    id: string;
    type: TrackedEventType;
    versionAtView: number;
    durationMs: number | null;
    uaShort: string | null;
    ip: string | null;
    botFlag: boolean;
    occurredAt: string;
};

export type DesignView = {
    id: string;
    label: string | null;
    targetUrl: string | null;
    repoUrl: string | null;
    isLive: boolean;
    currentVersion: number;
    sentAt: string | null;
    createdAt: string;
    token: string | null;
    versions: {
        version: number;
        url: string | null;
        note: string | null;
        markedAt: string;
    }[];
    summary: TrackedLinkSummaryView;
    events: TrackedEventRow[];
};

export async function getDesignsForLead(leadId: string): Promise<DesignView[]> {
    const designs = await prisma.design.findMany({
        where: { leadId, deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: {
            versions: { orderBy: { version: "desc" } },
            tracker: {
                select: {
                    token: true,
                    events: {
                        orderBy: { occurredAt: "desc" },
                        select: {
                            id: true,
                            type: true,
                            versionAtView: true,
                            durationMs: true,
                            uaShort: true,
                            ip: true,
                            botFlag: true,
                            occurredAt: true,
                        },
                    },
                },
            },
        },
    });

    return designs.map((d) => {
        const events = d.tracker?.events ?? [];
        const summary = summarizeEvents(events, d.currentVersion);
        return {
            id: d.id,
            label: d.label,
            targetUrl: d.targetUrl,
            repoUrl: d.repoUrl,
            isLive: d.isLive,
            currentVersion: d.currentVersion,
            sentAt: d.sentAt?.toISOString() ?? null,
            createdAt: d.createdAt.toISOString(),
            token: d.tracker?.token ?? null,
            versions: d.versions.map((v) => ({
                version: v.version,
                url: v.url,
                note: v.note,
                markedAt: v.markedAt.toISOString(),
            })),
            summary: {
                ...summary,
                lastViewedAt: summary.lastViewedAt?.toISOString() ?? null,
            },
            events: events.map((e) => ({
                id: e.id,
                type: e.type,
                versionAtView: e.versionAtView,
                durationMs: e.durationMs,
                uaShort: e.uaShort,
                ip: e.ip,
                botFlag: e.botFlag,
                occurredAt: e.occurredAt.toISOString(),
            })),
        };
    });
}
