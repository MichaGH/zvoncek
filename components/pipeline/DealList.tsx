"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Euro, Info, Lock, MessageSquare, Paintbrush, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import UrgencyLabel from "@/components/shared/UrgencyLabel";
import AskManagerDialog from "@/components/pipeline/AskManagerDialog";
import InteractionSheet from "@/components/pipeline/InteractionSheet";
import OfferSentDialog from "@/components/pipeline/OfferSentDialog";
import {
    ACTIVITY_LABEL,
    NEXT_ACTION_LABEL,
    OUTCOME_LABEL,
    PROJECT_TYPE_LABEL,
    STATUS_LABEL,
    STATUS_VARIANT,
    TASK_CONTENT_LABEL,
} from "@/lib/dictionaries";
import { businessDayMonth, businessDaysBetween, businessHm, businessInputParts } from "@/lib/domain/businessTime";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";
import type { DealRow } from "@/lib/queries/pipeline";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Jeden zoznam obchodov pre všetky roly (round 2, D-01/D-02/D-03).
//   DESKTOP (`hidden md:block`) – tabuľka:  # | Firma | Typ | [Stav] | Posledný krok | Ďalší krok | Cena | [Rieši] | akcie
//   MOBIL   (`md:hidden`)       – karty (jeden riadok = jedna karta)
// Klik na riadok/kartu = akčné okno („čo sa stalo a čo ďalej"), ikona „i" = detail obchodu.
// Spoločný obsah je v pod-komponentoch nižšie – formátovanie meň TAM, prejaví sa v oboch rozloženiach.
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
    if (!iso) return "—";
    const date = new Date(iso);
    const diff = businessDaysBetween(new Date(), date);
    const hm = businessInputParts(date).time;
    const time = hm !== "00:00" ? ` ${businessHm(date)}` : "";
    if (diff === 0) return `Dnes${time}`;
    if (diff === 1) return `Zajtra${time}`;
    if (diff === -1) return `Včera${time}`;
    return businessDayMonth(date) + time;
}

const NBSP = " ";

function dayWord(n: number) {
    return n === 1 ? "deň" : n >= 2 && n <= 4 ? "dni" : "dní";
}

// Otvorená úloha na riadku (wave 3 §6.1): „⏳ čaká na Michala (2 dni)"; v „Pre mňa" aj čo sa žiada a kto napísal naposledy.
function TaskLine({ row, dense, inbox }: { row: DealRow; dense?: boolean; inbox?: boolean }) {
    if (!row.task) return null;
    const t = row.task;
    const what = t.type === "HANDOVER" ? "Odovzdanie" : t.contents.map((c) => TASK_CONTENT_LABEL[c]).join(" + ");
    return (
        <div className="flex min-w-0 flex-col">
            <span className={cn("text-xs", t.overdue && inbox ? "font-medium text-destructive" : "text-amber-700 dark:text-amber-400", dense && "truncate")}>
                ⏳ {inbox ? `${what} · od ${t.requestedBy}` : `čaká na ${t.assignee}`} ({t.ageDays} {dayWord(t.ageDays)})
            </span>
            {inbox && <span className={cn("text-xs text-muted-foreground", dense && "truncate")}>„{t.text}“</span>}
            {t.lastMessageBy && (
                <span className={cn("flex items-center gap-1 text-xs text-muted-foreground", dense && "truncate")}>
                    <MessageSquare className="h-3 w-3 shrink-0" />
                    Posledná správa: {t.lastMessageBy}
                </span>
            )}
        </div>
    );
}

// Čo klient už dostal (round 2 §2c) – z OFFER_SENT záznamov.
function SentIcons({ row }: { row: DealRow }) {
    if (!row.hasDesignSent && !row.gotPrice && !row.gotPricelist) return null;
    return (
        <div className="flex shrink-0 items-center gap-1">
            {row.gotPricelist && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <BookOpen className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Dostali cenník</TooltipContent>
                </Tooltip>
            )}
            {row.gotPrice && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Euro className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Dostali cenu</TooltipContent>
                </Tooltip>
            )}
            {row.hasDesignSent && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Paintbrush className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Dostali návrh</TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}

function PriceWithEye({ row }: { row: DealRow }) {
    return <span className="tabular-nums">{row.price ? `${row.price} €` : "—"}</span>;
}

// dense = desktop (orezáva text v bunke); inak (mobile) text zalamuje.
function LastActivityContent({ row, dense }: { row: DealRow; dense?: boolean }) {
    if (!row.lastActivity) return <span className="text-muted-foreground">—</span>;
    return (
        <div className="flex min-w-0 flex-col">
            <span className={dense ? "truncate" : ""}>
                <span className="font-medium">{ACTIVITY_LABEL[row.lastActivity.type]}</span>
                {row.lastActivity.outcome && (
                    <span className="ml-1 text-muted-foreground">· {OUTCOME_LABEL[row.lastActivity.outcome]}</span>
                )}
            </span>
            {(row.lastActivity.note || dense) && (
                <span className={cn("text-xs text-muted-foreground", dense && "truncate")}>
                    {row.lastActivity.note || NBSP}
                </span>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
                {formatDate(row.lastActivity.at)}
                {row.noAnswerStreak > 1 ? ` · ${row.noAnswerStreak}. pokus` : ""}
            </span>
            {row.lastOffer && row.lastActivity.type !== "OFFER_SENT" && (
                <span className={cn("text-xs text-muted-foreground", dense && "truncate")}>
                    Odoslané: {row.lastOffer.text} · {formatDate(row.lastOffer.at)}
                </span>
            )}
        </div>
    );
}

function NextActionContent({ row, dense, inbox }: { row: DealRow; dense?: boolean; inbox?: boolean }) {
    const pendingLine = row.pendingText && (
        <span className={cn("text-xs font-medium text-emerald-700 dark:text-emerald-400", dense && "truncate")}>{row.pendingText}</span>
    );
    // Wave 5 (§3.2): varovanie len vtedy, keď krok NEPOKRÝVA, čo klient ešte nedostal – krok si nesie vlastnú
    // urgentnosť sám („dnes", „2 dni po termíne"), druhé varovanie k tomu istému by len šumelo.
    const askLine = row.askWarning && (
        <span className={cn("text-xs font-medium text-amber-700 dark:text-amber-400", dense && "truncate")}>⚠ {row.askWarning}</span>
    );
    if (!row.nextActionKind) {
        return (
            <div className="flex min-w-0 flex-col">
                <span className="text-muted-foreground">
                    {row.locked && <Lock className="mr-1 inline h-3 w-3" />}
                    {row.badge ? <Badge variant="destructive" className="font-normal">{row.badge}</Badge> : "—"}
                </span>
                <TaskLine row={row} dense={dense} inbox={inbox} />
                {askLine}
                {pendingLine}
            </div>
        );
    }
    return (
        <div className="flex min-w-0 flex-col">
            <span className={cn("flex min-w-0 items-center gap-1.5", dense && "truncate")}>
                {row.locked && <Lock className="h-3 w-3 shrink-0 text-amber-600" />}
                {row.stepHeadline ?? NEXT_ACTION_LABEL[row.nextActionKind]}
                {!row.locked && (row.nextActionAt || row.nextActionMode === "IN_PROGRESS") && (
                    <UrgencyLabel at={row.nextActionAt} hasTime={row.nextActionHasTime} mode={row.nextActionMode} />
                )}
            </span>
            {row.locked ? (
                <TaskLine row={row} dense={dense} inbox={inbox} />
            ) : (
                (row.nextActionNote || (dense && !row.pendingText)) && (
                    <span className={cn("text-xs font-normal text-muted-foreground", dense && "truncate")}>
                        {row.nextActionNote || NBSP}
                    </span>
                )
            )}
            {askLine}
            {pendingLine}
        </div>
    );
}

// onOpenSheet sa vykreslí len v tabuľke (klik na riadok nie je fokusovateľný); na mobile je tlačidlom celá karta.
function RowActions({ row, onOpenSheet }: { row: DealRow; onOpenSheet?: () => void }) {
    return (
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
            {row.phone && (
                <a
                    href={`tel:${row.phone.replace(/\s/g, "")}`}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Zavolať ${row.name}`}
                >
                    <Phone className="h-4 w-4" />
                </a>
            )}
            <Link
                href={`/dashboard/pipeline/${row.id}`}
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Detail – ${row.name}`}
                onClick={(e) => e.stopPropagation()}
            >
                <Info className="h-4 w-4" />
            </Link>
            {onOpenSheet && (
                <button
                    type="button"
                    className="sr-only"
                    onClick={onOpenSheet}
                    aria-label={`Zaznamenať krok – ${row.name}`}
                />
            )}
        </div>
    );
}

export default function DealList({
    rows,
    caps,
    showStatus = false,
    showOwner = false,
    inbox = false,
    viewerId,
    resolvers,
}: {
    rows: DealRow[];
    caps: DealCapabilities;
    showStatus?: boolean;
    showOwner?: boolean;
    inbox?: boolean; // „Pre mňa" – riadok ukazuje, čo sa žiada, od koho a ako dlho to čaká
    viewerId: string;
    resolvers: { id: string; firstName: string; lastName: string }[];
}) {
    const router = useRouter();
    const [open, setOpen] = useState<DealRow | null>(null);
    // „Poslali sme ponuku" otvára dialóg priamo tu – bez presmerovania do detailu (round 2 §2d).
    const [offerFor, setOfferFor] = useState<DealRow | null>(null);
    // „Požiadať / Odovzdať manažérovi" z akčného okna – drží sa len id, riadok (aj revízia) sa berie z aktuálnych dát.
    const [askFor, setAskFor] = useState<{ id: string; type: "HELP" | "HANDOVER" } | null>(null);
    const askRow = askFor ? rows.find((r) => r.id === askFor.id) : undefined;

    // Zoznam sa sám obnoví – termíny („dnes", „po termíne") starnú v reálnom čase.
    useEffect(() => {
        const t = setInterval(() => router.refresh(), 60_000);
        return () => clearInterval(t);
    }, [router]);

    const sheet = (
        <>
            <InteractionSheet
                key={open ? `${open.id}-${open.revision}` : "closed"}
                target={
                    open
                        ? {
                              ...open,
                              ownerId: open.ownerId,
                              priceNote: open.dialog.priceNote,
                              task: open.dialog.openTask,
                              pending: open.pending,
                          }
                        : null
                }
                caps={caps}
                viewerId={viewerId}
                onClose={() => setOpen(null)}
                onRecordOffer={() => {
                    setOfferFor(open);
                    setOpen(null);
                }}
                onAsk={(type) => {
                    if (open) setAskFor({ id: open.id, type });
                    setOpen(null);
                }}
            />
            {askFor && askRow && (
                <AskManagerDialog
                    key={`ask-${askRow.id}-${askRow.revision}`}
                    target={{
                        id: askRow.id,
                        revision: askRow.revision,
                        name: askRow.name,
                        status: askRow.status,
                        nextActionKind: askRow.nextActionKind,
                        nextActionNote: askRow.nextActionNote,
                        pending: askRow.pending,
                        outstanding: askRow.outstanding,
                    }}
                    type={askFor.type}
                    resolvers={resolvers}
                    onClose={() => setAskFor(null)}
                />
            )}
            {offerFor && (
                <OfferSentDialog
                    key={`offer-${offerFor.id}-${offerFor.revision}`}
                    deal={offerFor.dialog}
                    viewerId={viewerId}
                    isManager={caps.manage}
                    onClose={() => setOfferFor(null)}
                />
            )}
        </>
    );

    if (rows.length === 0) {
        return (
            <>
                <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                    Žiadne obchody v tomto pohľade.
                </div>
                {sheet}
            </>
        );
    }

    return (
        <TooltipProvider delayDuration={200}>
            {/* ── MOBIL: karty ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-3 md:hidden">
                {rows.map((row) => (
                    <div
                        key={row.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setOpen(row)}
                        onKeyDown={(e) => e.key === "Enter" && setOpen(row)}
                        className="block rounded-xl border bg-card p-4 shadow-sm transition-colors active:bg-muted/50"
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-baseline gap-2">
                                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">#{row.number}</span>
                                <div className="min-w-0">
                                    <div className="truncate font-medium leading-tight">{row.name}</div>
                                    <div className="truncate text-xs text-muted-foreground">{row.phone ?? "—"}</div>
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                                <SentIcons row={row} />
                                {row.projectType && (
                                    <Badge variant="outline" className="font-normal">
                                        {PROJECT_TYPE_LABEL[row.projectType]}
                                    </Badge>
                                )}
                                {showStatus && (
                                    <Badge variant={STATUS_VARIANT[row.status]} className="font-normal">
                                        {STATUS_LABEL[row.status]}
                                    </Badge>
                                )}
                                <RowActions row={row} />
                            </div>
                        </div>

                        <div className="mt-3 space-y-2.5 border-t pt-3">
                            <div>
                                <div className="mb-0.5 text-xs uppercase tracking-wide text-muted-foreground">Ďalší krok</div>
                                <div className="text-sm">
                                    <NextActionContent row={row} inbox={inbox} />
                                </div>
                            </div>
                            <div>
                                <div className="mb-0.5 text-xs uppercase tracking-wide text-muted-foreground">Naposledy</div>
                                <div className="text-sm">
                                    <LastActivityContent row={row} />
                                </div>
                            </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
                            <span className="font-medium">
                                <PriceWithEye row={row} />
                            </span>
                            {(showOwner || inbox) && <span className="truncate text-muted-foreground">· Rieši {row.owner ?? "nikto"}</span>}
                        </div>
                    </div>
                ))}
            </div>

            {/* ── DESKTOP: tabuľka ──────────────────────────────────────────── */}
            <div className="hidden overflow-hidden rounded-lg border md:block">
                <Table className="w-full table-fixed">
                    <colgroup>
                        <col className="w-[4%]" />
                        <col className="w-[24%]" />
                        <col className="w-[8%]" />
                        {showStatus && <col className="w-[9%]" />}
                        <col className="w-[20%]" />
                        <col className="w-[20%]" />
                        <col className="w-[8%]" />
                        {(showOwner || inbox) && <col className="w-[9%]" />}
                        <col className="w-[7%]" />
                    </colgroup>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="pl-4">#</TableHead>
                            <TableHead>Firma</TableHead>
                            <TableHead>Typ</TableHead>
                            {showStatus && <TableHead>Stav</TableHead>}
                            <TableHead>Ďalší krok</TableHead>
                            <TableHead>Naposledy</TableHead>
                            <TableHead className="text-right">Cena</TableHead>
                            {(showOwner || inbox) && <TableHead>Rieši</TableHead>}
                            <TableHead className="text-right pr-4">Akcie</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow
                                key={row.id}
                                className="h-[4.75rem] cursor-pointer hover:bg-muted/50"
                                onClick={() => setOpen(row)}
                            >
                                <TableCell className="pl-4 align-middle text-muted-foreground tabular-nums">
                                    {row.number}
                                </TableCell>
                                <TableCell className="max-w-0 align-middle font-medium">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <div className="min-w-0 flex-1">
                                            <span className="block truncate">{row.name}</span>
                                            <span className="block truncate text-xs font-normal text-muted-foreground">
                                                {row.phone ?? "—"}
                                            </span>
                                        </div>
                                        <SentIcons row={row} />
                                    </div>
                                </TableCell>
                                <TableCell className="align-middle">
                                    {row.projectType ? (
                                        <Badge variant="outline" className="font-normal">
                                            {PROJECT_TYPE_LABEL[row.projectType]}
                                        </Badge>
                                    ) : (
                                        <span className="text-muted-foreground">—</span>
                                    )}
                                </TableCell>
                                {showStatus && (
                                    <TableCell className="align-middle">
                                        <Badge variant={STATUS_VARIANT[row.status]} className="font-normal">
                                            {STATUS_LABEL[row.status]}
                                        </Badge>
                                    </TableCell>
                                )}
                                <TableCell className="max-w-0 align-middle text-sm">
                                    <NextActionContent row={row} dense inbox={inbox} />
                                </TableCell>
                                <TableCell className="max-w-0 align-middle text-sm">
                                    <LastActivityContent row={row} dense />
                                </TableCell>
                                <TableCell className="align-middle text-right">
                                    <div className="flex items-center justify-end">
                                        <PriceWithEye row={row} />
                                    </div>
                                </TableCell>
                                {(showOwner || inbox) && (
                                    <TableCell className="max-w-0 align-middle text-muted-foreground">
                                        <span className="block truncate">{row.owner ?? "—"}</span>
                                    </TableCell>
                                )}
                                <TableCell className="align-middle pr-2">
                                    <div className="flex justify-end">
                                        <RowActions row={row} onOpenSheet={() => setOpen(row)} />
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
            {sheet}
        </TooltipProvider>
    );
}
