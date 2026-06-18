"use client";

import { Clock, Hourglass, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { urgencyOf, fmtCallback, fmtProgress, URGENCY_TEXT, PROGRESS_TEXT } from "@/lib/overdue";

// Jednotné zobrazenie ďalšieho kroku.
// mode = "SCHEDULED": termín s urgentnosťou (future/soon/due/late) – /calls aj pipeline.
// mode = "IN_PROGRESS": rozpracované, modré „trvá X dní" (počíta sa od `at`).
export default function UrgencyLabel({
    at,
    hasTime,
    mode = "SCHEDULED",
    className,
}: {
    at: string | null;
    hasTime: boolean;
    mode?: "SCHEDULED" | "IN_PROGRESS";
    className?: string;
}) {
    if (mode === "IN_PROGRESS") {
        const label = fmtProgress(at);
        if (!label) return null;
        return (
            <span className={cn("inline-flex min-w-0 items-center gap-1", PROGRESS_TEXT, className)}>
                <Hourglass className="h-3 w-3 shrink-0" />
                <span className="truncate tabular-nums">{label}</span>
            </span>
        );
    }

    if (!at) return null;
    const urgency = urgencyOf(at, hasTime);
    const label = fmtCallback(at, hasTime, urgency);
    if (!label) return null;

    return (
        <span className={cn("inline-flex min-w-0 items-center gap-1", URGENCY_TEXT[urgency], className)}>
            {urgency === "late" ? (
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 motion-safe:animate-pulse" />
            ) : (
                <Clock className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate tabular-nums">{label}</span>
        </span>
    );
}
