"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarCheck2, ChevronDown, CircleCheckBig, Inbox, ListFilter, Search, UserRoundCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEAL_STATUS_TABS, DEAL_VIEWS, dealsHref, inboxHref, NO_VIEW, type DealFilterParams } from "@/lib/domain/dealFilters";
import type { DealCounts, DealUserOption } from "@/lib/queries/pipeline";
import { cn } from "@/lib/utils";

// Tri úrovne filtrov, rovnaké pre obchodníka aj manažéra (round 2, D-02/D-12):
//   1. kto to rieši (len ak vidím aj cudzie obchody)  2. stav  3. pilulky (úlohy, druh kroku, čo klient dostal)
// Každá pilulka má počet z toho istého predikátu ako jej zoznam (wave 3 §7). Server rozhoduje, čo je v rozsahu;
// tu sa len skladajú odkazy.

const PILL = "rounded-md px-3 py-1.5 text-sm transition-colors";
const PILL_ON = "bg-background font-medium shadow-sm";
const PILL_OFF = "text-muted-foreground hover:text-foreground";

function Pill({ href, active, children, count }: { href: string; active: boolean; children: React.ReactNode; count?: number }) {
    return (
        <Link href={href} className={cn(PILL, active ? PILL_ON : PILL_OFF)}>
            {children}
            {count !== undefined && <span className="tabular-nums"> ({count})</span>}
        </Link>
    );
}

export default function DealFilters({
    params,
    counts,
    owners,
    handoffs,
    showOwner,
    showInbox,
    showWaiting,
    showLegacy,
}: {
    params: DealFilterParams;
    counts: DealCounts;
    owners: DealUserOption[];
    handoffs: DealUserOption[];
    showOwner: boolean;
    showInbox: boolean; // „Pre mňa" – len ten, kto úlohy vybavuje
    showWaiting: boolean; // „Čakám na manažéra"
    showLegacy: boolean; // „Neoverené" – staré obchody na overenie, len manažér
}) {
    const router = useRouter();
    const [search, setSearch] = useState(params.q ?? "");
    const todo = DEAL_VIEWS.filter((v) => v.group === "todo");
    const running = DEAL_VIEWS.filter((v) => v.group === "running");
    const legacy = DEAL_VIEWS.filter((v) => v.group === "legacy");
    const secondaryActive = [...todo, ...running, ...legacy].some((v) => v.key === params.view);
    const count = (key: string) => counts[key as keyof DealCounts];

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

            {/* 3. pracovný rad. Tieto pohľady odpovedajú na „čo mám teraz robiť?", nie na technický druh kroku. */}
            <div className="rounded-xl border bg-card p-2 shadow-sm">
                <div className="px-2 pb-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pracovný rad</p>
                    <p className="text-xs text-muted-foreground">Najprv spracuj sľuby po hovore, potom dnešné termíny.</p>
                </div>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:flex sm:flex-wrap">
                    {/* „Pre mňa" je schránka – odkaz ruší vlastníka, stav, „Od:" aj stránkovanie (W3-R3-10). */}
                    {showInbox && (
                        <Pill href={inboxHref(params)} active={params.view === "inbox"} count={counts.inbox}>
                            <span className="inline-flex items-center gap-1.5"><Inbox className="h-3.5 w-3.5" />Pre mňa</span>
                        </Pill>
                    )}
                    <Pill href={dealsHref(params, { view: "work" })} active={params.view === "work"} count={counts.work}>
                        <span className="inline-flex items-center gap-1.5"><CircleCheckBig className="h-3.5 w-3.5" />Na spracovanie</span>
                    </Pill>
                    <Pill href={dealsHref(params, { view: "today" })} active={params.view === "today"} count={counts.today}>
                        <span className="inline-flex items-center gap-1.5"><CalendarCheck2 className="h-3.5 w-3.5" />Na dnes</span>
                    </Pill>
                    {showWaiting && (
                        <Pill
                            href={dealsHref(params, { view: "waiting_manager" })}
                            active={params.view === "waiting_manager"}
                            count={counts.waiting_manager}
                        >
                            <span className="inline-flex items-center gap-1.5"><UserRoundCheck className="h-3.5 w-3.5" />Čakám na manažéra</span>
                        </Pill>
                    )}
                    <Pill href={dealsHref(params, { view: NO_VIEW })} active={params.view === NO_VIEW} count={counts.all}>
                        <span className="inline-flex items-center gap-1.5"><ListFilter className="h-3.5 w-3.5" />Všetko</span>
                    </Pill>
                </div>
            </div>

            {/* Technické pohľady zostávajú dostupné, ale nesúťažia s hlavným denným workflow. */}
            <details className="group rounded-lg border bg-background" open={secondaryActive || undefined}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
                    <span>Podľa kroku a histórie{secondaryActive ? " · aktívny filter" : ""}</span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-3 border-t p-3">
                    <div>
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Podľa ďalšieho kroku</p>
                        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
                            {todo.map((v) => (
                                <Pill key={v.key} href={dealsHref(params, { view: v.key })} active={params.view === v.key} count={count(v.key)}>
                                    {v.label}
                                </Pill>
                            ))}
                            {running.filter((v) => v.key === "waiting").map((v) => (
                                <Pill key={v.key} href={dealsHref(params, { view: v.key })} active={params.view === v.key} count={count(v.key)}>
                                    {v.label}
                                </Pill>
                            ))}
                        </div>
                    </div>
                    <div>
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Klient už dostal</p>
                        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
                            {running.filter((v) => v.key !== "waiting").map((v) => (
                                <Pill key={v.key} href={dealsHref(params, { view: v.key })} active={params.view === v.key} count={count(v.key)}>
                                    {v.label}
                                </Pill>
                            ))}
                            {showLegacy && legacy.map((v) => (
                                <Pill key={v.key} href={dealsHref(params, { view: v.key })} active={params.view === v.key} count={count(v.key)}>
                                    {v.label}
                                </Pill>
                            ))}
                        </div>
                    </div>
                </div>
            </details>
        </div>
    );
}
