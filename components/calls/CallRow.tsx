"use client";

import { Badge } from "@/components/ui/badge";
import { Phone, StickyNote, Clock, Info } from "lucide-react";
import { QueueLead } from "@/lib/queries/calls";

function fmtScheduled(iso: string | null) {
    if (!iso) return null;
    const d = new Date(iso);
    const now = new Date();
    const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (d <= now) return "teraz";
    if (d.toDateString() === now.toDateString()) return `dnes ${time}`;
    const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
    if (d.toDateString() === tmr.toDateString()) return `zajtra ${time}`;
    return `${d.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric" })} ${time}`;
}

function fmtAgo(iso: string | null) {
    if (!iso) return null;
    const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);
    if (h < 1) return "pred chvíľou";
    if (h < 24) return `pred ${h} h`;
    return `pred ${Math.floor(h / 24)} dňami`;
}

export default function CallRow({
    lead, tone, onOpen, onInfo,
}: {
    lead: QueueLead;
    tone: "urgent" | "retry" | "fresh";
    onOpen: () => void;
    onInfo: () => void;
}) {
    const name = lead.companyName ?? lead.website ?? "—";
    const scheduled = fmtScheduled(lead.callbackAt);
    const overdue = lead.callbackAt && new Date(lead.callbackAt) <= new Date();

    return (
        <div className="group relative flex cursor-pointer select-none items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40">
            {/* prekrytie = hlavný klik (záznam hovoru) */}
            <button className="absolute inset-0 z-0" aria-label={`Zaznamenať hovor – ${name}`} onClick={onOpen} />

            <div className="z-10 flex w-6 shrink-0 justify-center">
                <span className="text-[11px] font-medium text-muted-foreground tabular-nums">#{lead.number}</span>
            </div>

            {/* min-w-0 je KĽÚČOVÉ – bez neho truncate nefunguje */}
            <div className="z-10 flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{name}</span>
                    {lead.note && <StickyNote className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
                    {lead.attempts > 0 && (
                        <span className="shrink-0 rounded bg-muted px-1.5 text-[11px] font-medium tabular-nums">{lead.attempts}×</span>
                    )}
                </div>

                {/* RETRY kontext */}
                {tone === "retry" && (lead.callbackNote || lead.lastAttemptAt) && (
                    <span className="truncate text-xs text-muted-foreground">
                        {lead.callbackNote ?? "Nezdvihli"}{lead.lastAttemptAt ? ` · ${fmtAgo(lead.lastAttemptAt)}` : ""}
                    </span>
                )}

                {/* SCHEDULED kontext – čas má shrink-0+nowrap, poznámka truncate */}
                {tone === "urgent" && scheduled && (
                    <span className={`flex min-w-0 items-center gap-1 text-xs ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                        <Clock className="h-3 w-3 shrink-0" />
                        <span className="shrink-0 whitespace-nowrap">{scheduled}</span>
                        {lead.callbackNote && <span className="min-w-0 truncate font-normal">· {lead.callbackNote}</span>}
                    </span>
                )}
            </div>

            <div className="z-10 flex shrink-0 items-center gap-1">
                <button
                    onClick={onInfo}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Detaily"
                >
                    <Info className="h-4 w-4" />
                </button>
                <a
                    href={`tel:${lead.phone?.replace(/\s/g, "")}`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground tabular-nums hover:opacity-90"
                >
                    <Phone className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{lead.phone ?? "—"}</span>
                </a>
            </div>
        </div>
    );
}