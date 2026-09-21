"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    BadgeEuro,
    CalendarCheck2,
    CircleCheckBig,
    Clock3,
    Inbox,
    ListFilter,
    Mail,
    Palette,
    Phone,
    Search,
    SlidersHorizontal,
    UserRoundCheck,
    X,
    type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    DEAL_STATUS_TABS,
    DEAL_STEPS,
    DEAL_VIEWS,
    dealsHref,
    inboxHref,
    NO_VIEW,
    statusHasQueues,
    viewAllowsStep,
    type DealFilterParams,
    type DealStepKey,
} from "@/lib/domain/dealFilters";
import type { DealCounts, DealStepCounts, DealUserOption } from "@/lib/queries/pipeline";
import { cn } from "@/lib/utils";

// Hore stav, pod ním dve úrovne, ktoré sa skladajú (lib/domain/dealFilters.ts):
//   0. stav        – nenápadný prepínač: Aktívne · Spiace · Vyhraté · Stratené · Nedostupné · Všetky
//   1. rad práce   – (len pri „Aktívne") veľké pilulky: Čakám na manažéra | Na spracovanie · Na dnes · Všetko (+ „Pre mňa")
//   2. druh kroku  – čipy pod nimi: Volať · Poslať cenu · … Zužujú ten rad, v ktorom som („Na dnes → Volať")
// Každý počet je z toho istého predikátu ako zoznam za ním (wave 3 §7). Server rozhoduje, čo je v rozsahu;
// tu sa len skladajú odkazy.

const STEP_ICON: Record<DealStepKey, LucideIcon> = {
    call: Phone,
    quote: BadgeEuro,
    design: Palette,
    email: Mail,
    waiting: Clock3,
};

function Count({ value, on }: { value: number; on: boolean }) {
    return (
        <span
            className={cn(
                "min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums leading-none",
                on ? "bg-primary-foreground/20 text-primary-foreground" : "bg-background text-muted-foreground",
            )}
        >
            {value}
        </span>
    );
}

// Veľká pilulka radu práce – ikona, názov, počet. Aktívna je plná farba, aby bolo na prvý pohľad jasné, kde som.
function QueuePill({ href, active, icon: Icon, count, children }: { href: string; active: boolean; icon: LucideIcon; count: number; children: ReactNode }) {
    return (
        <Link
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors",
                active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-background hover:text-foreground",
            )}
        >
            <Icon className="h-4 w-4" />
            <span className="whitespace-nowrap">{children}</span>
            <Count value={count} on={active} />
        </Link>
    );
}

// Čip druhu kroku (úroveň 2).
function Chip({ href, active, icon: Icon, count, children }: { href: string; active: boolean; icon?: LucideIcon; count?: number; children: ReactNode }) {
    return (
        <Link
            href={href}
            aria-current={active ? "true" : undefined}
            className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                active
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:border-primary/40 hover:text-foreground",
                count === 0 && !active && "opacity-55",
            )}
        >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            <span className="whitespace-nowrap">{children}</span>
            {count !== undefined && <span className="tabular-nums text-xs opacity-80">{count}</span>}
        </Link>
    );
}

// Riadok s menovkou vľavo; na telefóne sa posúva do strany (bez zalamovania), na PC sa zalomí.
function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-center gap-3">
            {label && <span className="w-11 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>}
            <div className="-mr-4 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1 pr-4 sm:mr-0 sm:flex-wrap sm:overflow-visible sm:pb-0 sm:pr-0">{children}</div>
        </div>
    );
}

export default function DealFilters({
    params,
    counts,
    stepCounts,
    owners,
    handoffs,
    showOwner,
    showInbox,
    showWaiting,
    showLegacy,
}: {
    params: DealFilterParams; // `view` je tu už vždy konkrétny rad (server vyriešil „auto")
    counts: DealCounts;
    stepCounts: DealStepCounts;
    owners: DealUserOption[];
    handoffs: DealUserOption[];
    showOwner: boolean;
    showInbox: boolean; // „Pre mňa" – len ten, kto úlohy vybavuje
    showWaiting: boolean; // „Čakám na manažéra"
    showLegacy: boolean; // „Neoverené" – staré obchody na overenie, len manažér
}) {
    const router = useRouter();
    const [search, setSearch] = useState(params.q ?? "");
    const extras = DEAL_VIEWS.filter((v) => v.group === "running" || (v.group === "legacy" && showLegacy));
    const extraActive = extras.some((v) => v.key === params.view);
    const count = (key: string) => counts[key as keyof DealCounts];

    function go(patch: Partial<DealFilterParams>) {
        router.push(dealsHref(params, patch));
    }

    const queues = statusHasQueues(params.filter);
    const showSteps = queues && viewAllowsStep(params.view) && !extraActive;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                {/* 0. stav – nenápadne hore; rady a kroky nižšie existujú len pri „Aktívne" */}
                <div className="flex flex-wrap items-center gap-1 self-start rounded-lg bg-muted p-1">
                    {DEAL_STATUS_TABS.map((tab) => (
                        <span key={tab.key} className="flex items-center gap-1">
                            {tab.key === "all" && <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />}
                            <Link
                                href={dealsHref(params, { filter: tab.key })}
                                aria-current={params.filter === tab.key ? "true" : undefined}
                                className={cn(
                                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                                    params.filter === tab.key ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {tab.label}
                            </Link>
                        </span>
                    ))}
                </div>

                {/* Kto to rieši + hľadanie */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
                            <Select value={params.from ?? "all"} onValueChange={(v) => go({ from: v === "all" ? undefined : v })}>
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

            {/* 1. rad práce – len pri „Aktívne" */}
            {queues && (
            <nav aria-label="Rad práce" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <div className="flex w-max items-center gap-1 rounded-xl bg-muted p-1 sm:w-auto sm:flex-wrap">
                    {/* „Pre mňa" je schránka – odkaz ruší vlastníka, stav, „Od:" aj stránkovanie (W3-R3-10). */}
                    {showInbox && (
                        <QueuePill href={inboxHref(params)} active={params.view === "inbox"} icon={Inbox} count={counts.inbox}>
                            Pre mňa
                        </QueuePill>
                    )}
                    {showWaiting && (
                        <QueuePill
                            href={dealsHref(params, { view: "waiting_manager" })}
                            active={params.view === "waiting_manager"}
                            icon={UserRoundCheck}
                            count={counts.waiting_manager}
                        >
                            Čakám na manažéra
                        </QueuePill>
                    )}
                    {(showInbox || showWaiting) && <span className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden />}
                    <QueuePill href={dealsHref(params, { view: "work" })} active={params.view === "work"} icon={CircleCheckBig} count={counts.work}>
                        Na spracovanie
                    </QueuePill>
                    <QueuePill href={dealsHref(params, { view: "today" })} active={params.view === "today"} icon={CalendarCheck2} count={counts.today}>
                        Na dnes
                    </QueuePill>
                    <QueuePill href={dealsHref(params, { view: NO_VIEW })} active={params.view === NO_VIEW} icon={ListFilter} count={counts.all}>
                        Všetko
                    </QueuePill>
                </div>
            </nav>
            )}

            {/* 2. druh kroku – zužuje ten rad, v ktorom som */}
            {showSteps && (
                <Row label="Krok">
                    <Chip href={dealsHref(params, { step: undefined })} active={!params.step} count={stepCounts.all}>
                        Všetky
                    </Chip>
                    {DEAL_STEPS.map((s) => (
                        <Chip
                            key={s.key}
                            href={dealsHref(params, { step: s.key })}
                            active={params.step === s.key}
                            icon={STEP_ICON[s.key]}
                            count={stepCounts[s.key]}
                        >
                            {s.label}
                        </Chip>
                    ))}
                </Row>
            )}

            {/* Čo klient už dostal (a neoverené staré obchody) – zriedkavé, preto schované, kým sa nepoužijú. */}
            {queues && extras.length > 0 && (
                <details className="group" open={extraActive || undefined}>
                    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                        Klient už dostal{showLegacy ? " · Neoverené" : ""}
                        {extraActive && <span className="text-primary"> · aktívny filter</span>}
                    </summary>
                    <div className="mt-2">
                        <Row label="">
                            {extras.map((v) => (
                                <Chip key={v.key} href={dealsHref(params, { view: v.key })} active={params.view === v.key} count={count(v.key)}>
                                    {v.label}
                                </Chip>
                            ))}
                        </Row>
                    </div>
                </details>
            )}
        </div>
    );
}
