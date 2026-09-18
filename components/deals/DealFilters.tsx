"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { REQUEST_KIND_LABEL } from "@/lib/dictionaries";
import { DEAL_STATUS_TABS, DEAL_VIEWS, dealsHref, NO_VIEW, type DealFilterParams } from "@/lib/domain/dealFilters";
import type { DealUserOption } from "@/lib/queries/deals";
import { cn } from "@/lib/utils";

// Tri úrovne filtrov, rovnaké pre obchodníka aj manažéra (round 2, D-02/D-12):
//   1. kto to rieši (len ak vidím aj cudzie obchody)  2. stav  3. druh ďalšieho kroku + Požiadavky
// Server rozhoduje, čo je v rozsahu; tu sa len skladajú odkazy.

const PILL = "rounded-md px-3 py-1.5 text-sm transition-colors";
const PILL_ON = "bg-background font-medium shadow-sm";
const PILL_OFF = "text-muted-foreground hover:text-foreground";

function Pill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
    return (
        <Link href={href} className={cn(PILL, active ? PILL_ON : PILL_OFF)}>
            {children}
        </Link>
    );
}

export default function DealFilters({
    params,
    counts,
    owners,
    handoffs,
    showOwner,
    showRequests,
}: {
    params: DealFilterParams;
    counts: { today: number; requests: number };
    owners: DealUserOption[];
    handoffs: DealUserOption[];
    showOwner: boolean;
    showRequests: boolean;
}) {
    const router = useRouter();
    const [search, setSearch] = useState(params.q ?? "");
    const todo = DEAL_VIEWS.filter((v) => v.group === "todo");
    const running = DEAL_VIEWS.filter((v) => v.group === "running");

    function go(patch: Partial<DealFilterParams>) {
        router.push(dealsHref(params, patch));
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                {/* 2. stav */}
                <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
                    {DEAL_STATUS_TABS.map((tab) => (
                        <span key={tab.key} className="flex items-center gap-1">
                            {tab.key === "all" && <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />}
                            <Pill href={dealsHref(params, { filter: tab.key })} active={params.filter === tab.key}>
                                {tab.label}
                            </Pill>
                        </span>
                    ))}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    {/* 1. kto to rieši + od koho prišlo */}
                    {showOwner && (
                        <>
                            <Select value={params.owner} onValueChange={(v) => go({ owner: v })}>
                                <SelectTrigger size="sm" className="h-10 w-auto min-w-40 gap-1.5">
                                    <span className="text-muted-foreground">Rieši:</span>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="me">ja</SelectItem>
                                    <SelectItem value="all">všetci</SelectItem>
                                    <SelectItem value="unassigned">nepriradené</SelectItem>
                                    {owners.map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.firstName} {u.lastName}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {handoffs.length > 0 && (
                                <Select
                                    value={params.from ?? "all"}
                                    onValueChange={(v) => go({ from: v === "all" ? undefined : v })}
                                >
                                    <SelectTrigger size="sm" className="h-10 w-auto min-w-40 gap-1.5">
                                        <span className="text-muted-foreground">Od:</span>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">od kohokoľvek</SelectItem>
                                        {handoffs.map((u) => (
                                            <SelectItem key={u.id} value={u.id}>
                                                {u.firstName} {u.lastName}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </>
                    )}

                    <form
                        className="flex w-full items-center gap-2 lg:max-w-xs"
                        onSubmit={(e) => {
                            e.preventDefault();
                            go({ q: search.trim() || undefined });
                        }}
                    >
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Hľadať firmu, web, telefón…"
                                className="h-10 pl-8 pr-8"
                            />
                            {search && (
                                <button
                                    type="button"
                                    aria-label="Vymazať hľadanie"
                                    onClick={() => {
                                        setSearch("");
                                        go({ q: undefined });
                                    }}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                        <Button type="submit" variant="outline" className="h-10 shrink-0">
                            Hľadať
                        </Button>
                    </form>
                </div>
            </div>

            {/* 3. druh ďalšieho kroku */}
            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
                {showRequests && (
                    <>
                        <Pill href={dealsHref(params, { view: "requests" })} active={params.view === "requests"}>
                            Požiadavky ({counts.requests})
                        </Pill>
                        <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
                    </>
                )}
                <Pill href={dealsHref(params, { view: "today" })} active={params.view === "today"}>
                    Na dnes <span className="tabular-nums">({counts.today})</span>
                </Pill>
                <Pill href={dealsHref(params, { view: NO_VIEW })} active={params.view === NO_VIEW}>
                    Všetko
                </Pill>
                <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
                {todo.map((v) => (
                    <Pill key={v.key} href={dealsHref(params, { view: v.key })} active={params.view === v.key}>
                        {v.label}
                    </Pill>
                ))}
                <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
                {running.map((v) => (
                    <Pill key={v.key} href={dealsHref(params, { view: v.key })} active={params.view === v.key}>
                        {v.label}
                    </Pill>
                ))}
            </div>

            {/* druh požiadavky – len v pohľade Požiadavky */}
            {params.view === "requests" && (
                <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-xs text-muted-foreground">Druh:</span>
                    <Pill href={dealsHref(params, { kind: undefined })} active={!params.kind}>
                        všetky
                    </Pill>
                    {(["PRICE", "DESIGN", "EMAIL", "ORDER", "REOPEN", "OTHER"] as const).map((k) => (
                        <Pill key={k} href={dealsHref(params, { kind: k })} active={params.kind === k}>
                            {REQUEST_KIND_LABEL[k]}
                        </Pill>
                    ))}
                </div>
            )}
        </div>
    );
}
