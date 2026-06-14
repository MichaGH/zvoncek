import prisma from "@/lib/db";
import type { TrackedLinkKind } from "@/app/generated/prisma/enums";
import { summarizeEvents, type TrackingSummary } from "@/lib/tracking/confidence";

// Minimal resolve for the public ingest endpoint – only what's needed to record an event.
// Never returns lead data (the endpoint is anonymous).
export async function resolveTokenForIngest(token: string) {
    return prisma.trackedLink.findFirst({
        where: { token, revokedAt: null },
        select: {
            id: true,
            currentVersion: true,
            versions: {
                orderBy: { version: "desc" },
                take: 1,
                select: { id: true, version: true },
            },
        },
    });
}

type TrackedLinkSummaryView = Omit<TrackingSummary, "lastViewedAt"> & {
    lastViewedAt: string | null;
};

export type TrackedLinkView = {
    id: string;
    token: string;
    kind: TrackedLinkKind;
    label: string | null;
    targetUrl: string | null;
    currentVersion: number;
    lastMarkedUpdateAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    versions: {
        version: number;
        url: string | null;
        note: string | null;
        markedAt: string;
    }[];
    summary: TrackedLinkSummaryView;
};

export async function getTrackedLinksForLead(
    leadId: string,
): Promise<TrackedLinkView[]> {
    const links = await prisma.trackedLink.findMany({
        where: { leadId },
        orderBy: { createdAt: "asc" },
        include: {
            versions: { orderBy: { version: "desc" } },
            events: {
                select: {
                    type: true,
                    versionAtView: true,
                    botFlag: true,
                    durationMs: true,
                    occurredAt: true,
                },
            },
        },
    });

    return links.map((l) => {
        const summary = summarizeEvents(l.events, l.currentVersion);
        return {
            id: l.id,
            token: l.token,
            kind: l.kind,
            label: l.label,
            targetUrl: l.targetUrl,
            currentVersion: l.currentVersion,
            lastMarkedUpdateAt: l.lastMarkedUpdateAt?.toISOString() ?? null,
            revokedAt: l.revokedAt?.toISOString() ?? null,
            createdAt: l.createdAt.toISOString(),
            versions: l.versions.map((v) => ({
                version: v.version,
                url: v.url,
                note: v.note,
                markedAt: v.markedAt.toISOString(),
            })),
            summary: {
                ...summary,
                lastViewedAt: summary.lastViewedAt?.toISOString() ?? null,
            },
        };
    });
}
