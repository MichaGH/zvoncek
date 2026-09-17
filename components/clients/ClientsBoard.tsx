"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import UrgencyLabel from "@/components/shared/UrgencyLabel";
import ClientDrawer from "@/components/clients/ClientDrawer";
import { ACTIVITY_LABEL, CONFIDENCE_LABEL, NEXT_ACTION_LABEL, OUTCOME_LABEL, REQUEST_KIND_LABEL } from "@/lib/dictionaries";
import { CLIENT_SECTION_LABEL, CLIENT_SECTIONS, type ClientSection } from "@/lib/domain/clientSections";
import { businessDayMonth } from "@/lib/domain/businessTime";
import type { ClientRow } from "@/lib/queries/clients";
import { cn } from "@/lib/utils";

type Board =
    | { mode: "board"; sections: Record<(typeof CLIENT_SECTIONS)[number], ClientRow[]> }
    | { mode: "search"; results: ClientRow[] };

// „Moji klienti" – sekcie kariet (ako /dashboard/calls), bez tabuliek a stavových záložiek.
export default function ClientsBoard({ board, canWork }: { board: Board; canWork: boolean }) {
    const router = useRouter();
    const [open, setOpen] = useState<ClientRow | null>(null);
    const [closedExpanded, setClosedExpanded] = useState(false);

    useEffect(() => {
        const t = setInterval(() => router.refresh(), 60_000);
        return () => clearInterval(t);
    }, [router]);

    const drawer = (
        <ClientDrawer key={open ? `${open.id}-${open.revision}` : "closed"} deal={open} canWork={canWork} onClose={() => setOpen(null)} />
    );

    if (board.mode === "search") {
        return (
            <>
                {board.results.length === 0 ? (
                    <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">Nič sa nenašlo.</p>
                ) : (
                    <div className="divide-y overflow-hidden rounded-xl border bg-card">
                        {board.results.map((row) => (
                            <ClientCard key={row.id} row={row} onOpen={() => setOpen(row)} showSection />
                        ))}
                    </div>
                )}
                {drawer}
            </>
        );
    }

    const { sections } = board;
    const overdue = sections.TODAY.filter((r) => r.overdue).length;

    return (
        <>
            {/* Čipy – klik posunie na sekciu */}
            <div className="mb-6 flex flex-wrap gap-2">
                {CLIENT_SECTIONS.map((s) => (
                    <a
                        key={s}
                        href={`#sec-${s}`}
                        className={cn(
                            "rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted",
                            s === "TODAY" && sections.TODAY.length > 0 && "border-destructive/50 text-destructive",
                        )}
                    >
                        {CLIENT_SECTION_LABEL[s]} <span className="font-medium tabular-nums">{sections[s].length}</span>
                        {s === "TODAY" && overdue > 0 && <span className="ml-1 text-xs">({overdue} po termíne)</span>}
                    </a>
                ))}
            </div>

            <div className="space-y-8">
                {CLIENT_SECTIONS.map((s) => {
                    const rows = sections[s];
                    const collapsible = s === "CLOSED_RECENT";
                    const expanded = !collapsible || closedExpanded;
                    return (
                        <section key={s} id={`sec-${s}`} className="scroll-mt-20">
                            <header
                                className={cn("mb-2.5 flex items-baseline gap-2", collapsible && "cursor-pointer select-none")}
                                onClick={collapsible ? () => setClosedExpanded((v) => !v) : undefined}
                            >
                                {collapsible &&
                                    (expanded ? <ChevronDown className="h-4 w-4 self-center" /> : <ChevronRight className="h-4 w-4 self-center" />)}
                                <h2 className="text-sm font-semibold tracking-tight">{CLIENT_SECTION_LABEL[s]}</h2>
                                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">{rows.length}</span>
                            </header>
                            {expanded &&
                                (rows.length === 0 ? (
                                    <p className="rounded-xl border border-dashed py-6 text-center text-sm text-muted-foreground">Nič tu nie je.</p>
                                ) : (
                                    <div className="divide-y overflow-hidden rounded-xl border bg-card">
                                        {rows.map((row) => (
                                            <ClientCard key={row.id} row={row} onOpen={() => setOpen(row)} />
                                        ))}
                                    </div>
                                ))}
                        </section>
                    );
                })}
            </div>
            {drawer}
        </>
    );
}

function ClientCard({ row, onOpen, showSection = false }: { row: ClientRow; onOpen: () => void; showSection?: boolean }) {
    const section = row.section as ClientSection;
    return (
        <div
            className="flex cursor-pointer items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/40"
            onClick={onOpen}
            role="button"
            aria-label={`Otvoriť – ${row.name}`}
        >
            <span className="w-8 shrink-0 pt-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">#{row.number}</span>
            <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{row.name}</span>
                    {showSection && <Badge variant="outline">{CLIENT_SECTION_LABEL[section]}</Badge>}
                    {row.badge && <Badge variant="destructive">{row.badge}</Badge>}
                </div>
                {row.nextActionKind && (
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Ďalší krok:</span>
                        <span className="font-medium">{row.nextActionNote ?? NEXT_ACTION_LABEL[row.nextActionKind]}</span>
                        {(row.nextActionAt || row.nextActionMode === "IN_PROGRESS") && (
                            <UrgencyLabel at={row.nextActionAt} hasTime={row.nextActionHasTime} mode={row.nextActionMode} />
                        )}
                    </div>
                )}
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {row.lastActivity && (
                        <span className="truncate">
                            Posledný krok: {row.lastActivity.outcome ? OUTCOME_LABEL[row.lastActivity.outcome] : ACTIVITY_LABEL[row.lastActivity.type]}{" "}
                            {businessDayMonth(new Date(row.lastActivity.at))}
                        </span>
                    )}
                    {row.price != null && <span>· {row.price.toLocaleString("sk-SK")} €</span>}
                    {row.tracking && row.tracking.confidence !== "none" && (
                        <Badge variant="secondary" className="font-normal">
                            {CONFIDENCE_LABEL[row.tracking.confidence]} {row.tracking.views}×
                        </Badge>
                    )}
                    {row.openRequests.map((r) => (
                        <Badge key={r.id} variant="outline" className="font-normal">
                            Požiadavka: {REQUEST_KIND_LABEL[r.kind]}
                        </Badge>
                    ))}
                    {row.closedAt && <span>· uzavreté {businessDayMonth(new Date(row.closedAt))}</span>}
                </div>
            </div>
            {row.phone && (
                <a
                    href={`tel:${row.phone.replace(/\s/g, "")}`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Zavolať ${row.name}`}
                >
                    <Phone className="h-4 w-4" />
                </a>
            )}
        </div>
    );
}
