"use client";

import { StickyNote, Info, Phone } from "lucide-react";
import { QueueLead } from "@/lib/queries/calls";
import { fmtAgo } from "@/lib/utils";
import UrgencyLabel from "@/components/shared/UrgencyLabel";

export default function CallRow({
    lead, tone, onOpen, onInfo,
}: {
    lead: QueueLead;
    tone: "urgent" | "retry" | "fresh";
    onOpen: () => void;
    onInfo: () => void;
}) {
    const name = lead.companyName ?? lead.website ?? "—";

    return (
        // Celý row je cursor-pointer. Klik na row = onOpen, okrem pravých buttonov.
        <div
            className="group relative flex cursor-pointer select-none items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
            onClick={onOpen}
            role="button"
            aria-label={`Zaznamenať hovor – ${name}`}
        >
            {/* Číslo – pointer-events-none, klik prebubbluje na row */}
            <div className="pointer-events-none z-10 flex w-6 shrink-0 justify-center">
                <span className="text-[11px] font-medium text-muted-foreground tabular-nums">#{lead.number}</span>
            </div>

            {/* Textová oblasť – pointer-events-none, klik prebubbluje na row */}
            <div className="pointer-events-none z-10 flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{name}</span>
                    {lead.note && <StickyNote className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
                    {lead.attempts > 0 && (
                        <span className="shrink-0 rounded bg-muted px-1.5 text-[11px] font-medium tabular-nums">{lead.attempts}×</span>
                    )}
                </div>

                {tone === "retry" && (lead.callbackNote || lead.lastAttemptAt) && (
                    <span className="truncate text-xs text-muted-foreground">
                        {lead.callbackNote ?? "Nezdvihli"}{lead.lastAttemptAt ? ` · ${fmtAgo(lead.lastAttemptAt)}` : ""}
                    </span>
                )}

                {tone === "urgent" && lead.callbackAt && (
                    <span className="flex min-w-0 items-center gap-1 text-xs">
                        <UrgencyLabel at={lead.callbackAt} hasTime={lead.callbackHasTime} />
                        {lead.callbackNote && (
                            <span className="min-w-0 truncate text-muted-foreground">· {lead.callbackNote}</span>
                        )}
                    </span>
                )}
            </div>

            {/* Pravé akčné buttony – pointer-events-auto, stopPropagation voči row onClick */}
            <div className="z-10 flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                    onClick={onInfo}
                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Detaily"
                >
                    <Info className="h-4 w-4" />
                </button>
                <a
                    href={`tel:${lead.phone?.replace(/\s/g, "")}`}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground tabular-nums hover:opacity-90"
                >
                    <Phone className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{lead.phone ?? "—"}</span>
                </a>
            </div>
        </div>
    );
}
