import type { TrackedEventType } from "@/app/generated/prisma/enums";

export type Confidence = "none" | "weak" | "medium" | "high" | "very_high";

export type EventLite = {
    type: TrackedEventType;
    versionAtView: number;
    botFlag: boolean;
    durationMs: number | null;
    occurredAt: Date;
};

export type TrackingSummary = {
    confidence: Confidence;
    viewedAfterUpdate: boolean;
    lastViewedAt: Date | null;
    totalViews: number;
    engagedViews: number;
};

// ~8s of active time counts as real engagement (filters quick scanner hits).
const ENGAGED_MS = 8000;

// Derived on read – never stored. See docs/tracking-system-plan.md for the tiers.
export function summarizeEvents(
    events: EventLite[],
    currentVersion: number,
): TrackingSummary {
    const human = events.filter((e) => !e.botFlag);
    const engaged = human.filter(
        (e) => e.type === "ENGAGED_VIEW" || (e.durationMs ?? 0) >= ENGAGED_MS,
    );
    const lastViewedAt = events.reduce<Date | null>(
        (max, e) => (!max || e.occurredAt > max ? e.occurredAt : max),
        null,
    );
    const viewedAfterUpdate = engaged.some((e) => e.versionAtView >= currentVersion);
    const engagedDays = new Set(engaged.map((e) => e.occurredAt.toDateString()));

    let confidence: Confidence;
    if (events.length === 0) confidence = "none";
    else if (human.length === 0) confidence = "weak"; // all bot/scanner
    else if (engaged.length === 0) confidence = "medium"; // human page view, no engagement
    else if (engagedDays.size >= 2 || (viewedAfterUpdate && currentVersion > 1))
        confidence = "very_high";
    else confidence = "high";

    return {
        confidence,
        viewedAfterUpdate,
        lastViewedAt,
        totalViews: events.length,
        engagedViews: engaged.length,
    };
}
