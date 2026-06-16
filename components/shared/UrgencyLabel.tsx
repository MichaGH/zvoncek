"use client";

import { Clock, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { urgencyOf, fmtCallback, URGENCY_TEXT } from "@/lib/overdue";

// Jednotné zobrazenie naplánovaného termínu s farbou + ikonou podľa urgentnosti.
// Používa /calls (callbackAt) aj pipeline (nextActionAt).
export default function UrgencyLabel({
    at,
    hasTime,
    className,
}: {
    at: string | null;
    hasTime: boolean;
    className?: string;
}) {
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
