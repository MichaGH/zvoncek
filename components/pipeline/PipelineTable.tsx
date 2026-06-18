"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, FileText, Mail, Paintbrush } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
    ACTIVITY_LABEL,
    NEXT_ACTION_LABEL,
    OUTCOME_LABEL,
    PROJECT_TYPE_LABEL,
    STATUS_LABEL,
    STATUS_VARIANT,
} from "@/lib/dictionaries";
import type { PipelineListRow } from "@/lib/queries/pipeline";
import UrgencyLabel from "@/components/shared/UrgencyLabel";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// POZOR: PipelineTable má DVE rozloženia z jedného `rows`:
//   1) DESKTOP (`hidden md:block`) – klasická <table> s pevnými stĺpcami
//   2) MOBILE  (`md:hidden`)       – zoznam kariet (každý riadok = jedna karta)
//
// Spoločný obsah (farby, ikony, labely, urgentnosť) je vyčlenený do zdieľaných
// pod-komponentov nižšie: SentIcons, PriceWithEye, LastActivityContent,
// NextActionContent (+ UrgencyLabel). Formátovacie/farebné zmeny rob TAM –
// prejavia sa v oboch rozloženiach naraz.
// Ak meníš ŠTRUKTÚRU (poradie stĺpcov, čo sa kde zobrazuje), musíš to upraviť
// v OBOCH rozloženiach samostatne (desktop tabuľka aj mobilná karta).
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
    if (!iso) return "—";
    const date = new Date(iso);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const that = new Date(date);
    that.setHours(0, 0, 0, 0);
    const diff = (that.getTime() - today.getTime()) / 86_400_000;
    const time =
        date.getHours() || date.getMinutes()
            ? ` ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`
            : "";
    if (diff === 0) return `Dnes${time}`;
    if (diff === 1) return `Zajtra${time}`;
    if (diff === -1) return `Včera${time}`;
    return date.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric" }) + time;
}

const NBSP = " ";

// ── Zdieľané content komponenty (používa desktop aj mobile) ──────────────────

function SentIcons({ row }: { row: PipelineListRow }) {
    if (!row.hasDesignSent && !row.quoteSentAt && !row.aboutUsSentAt) return null;
    return (
        <div className="flex shrink-0 items-center gap-1">
            {row.hasDesignSent && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Paintbrush className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Návrh odoslaný</TooltipContent>
                </Tooltip>
            )}
            {row.quoteSentAt && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <FileText className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Cenová ponuka odoslaná</TooltipContent>
                </Tooltip>
            )}
            {row.aboutUsSentAt && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Mail className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Email o nás odoslaný</TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}

function PriceWithEye({ row }: { row: PipelineListRow }) {
    return (
        <div className="flex items-center gap-1">
            {row.priceDisclosed && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Klient pozná cenu</TooltipContent>
                </Tooltip>
            )}
            <span className="tabular-nums">{row.price ? `${row.price} €` : "—"}</span>
        </div>
    );
}

// dense = desktop (orezáva text v bunke); inak (mobile) text zalamuje.
function LastActivityContent({ row, dense }: { row: PipelineListRow; dense?: boolean }) {
    if (!row.lastActivity) return <span className="text-muted-foreground">—</span>;
    return (
        <div className="flex min-w-0 flex-col">
            <span className={dense ? "truncate" : ""}>
                <span className="font-medium">{ACTIVITY_LABEL[row.lastActivity.type]}</span>
                {row.lastActivity.outcome && (
                    <span className="ml-1 text-muted-foreground">
                        · {OUTCOME_LABEL[row.lastActivity.outcome]}
                    </span>
                )}
            </span>
            {(row.lastActivity.note || dense) && (
                <span className={cn("text-xs text-muted-foreground", dense && "truncate")}>
                    {row.lastActivity.note || NBSP}
                </span>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
                {formatDate(row.lastActivity.at)}
            </span>
        </div>
    );
}

function NextActionContent({ row, dense }: { row: PipelineListRow; dense?: boolean }) {
    if (!row.nextActionKind) return <span className="text-muted-foreground">—</span>;
    return (
        <div className="flex min-w-0 flex-col">
            <span className={cn("flex min-w-0 items-center gap-1.5", dense && "truncate")}>
                {NEXT_ACTION_LABEL[row.nextActionKind]}
                {(row.nextActionAt || row.nextActionMode === "IN_PROGRESS") && (
                    <UrgencyLabel
                        at={row.nextActionAt}
                        hasTime={row.nextActionHasTime}
                        mode={row.nextActionMode}
                    />
                )}
            </span>
            {(row.nextActionNote || dense) && (
                <span className={cn("text-xs font-normal text-muted-foreground", dense && "truncate")}>
                    {row.nextActionNote || NBSP}
                </span>
            )}
        </div>
    );
}

export default function PipelineTable({
    rows,
    showStatus = false,
}: {
    rows: PipelineListRow[];
    showStatus?: boolean;
}) {
    const router = useRouter();

    if (rows.length === 0) {
        return (
            <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                Žiadne príležitosti v tomto pohľade.
            </div>
        );
    }

    return (
        <TooltipProvider delayDuration={200}>
            {/* ── MOBILE: karty (md:hidden) ─────────────────────────────────── */}
            <div className="flex flex-col gap-3 md:hidden">
                {rows.map((row) => (
                    <Link
                        key={row.id}
                        href={`/dashboard/pipeline/${row.id}`}
                        className="block rounded-xl border bg-card p-4 shadow-sm transition-colors active:bg-muted/50"
                    >
                        {/* Hlavička: #číslo · (názov / telefón) | ikonky + typ + stav */}
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-baseline gap-2">
                                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                    #{row.number}
                                </span>
                                <div className="min-w-0">
                                    <div className="truncate font-medium leading-tight">{row.name}</div>
                                    <div className="truncate text-xs text-muted-foreground">
                                        {row.phone ?? "—"}
                                    </div>
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
                            </div>
                        </div>

                        {/* Kroky – label nad obsahom, rovnomerné medzery */}
                        <div className="mt-3 space-y-2.5 border-t pt-3">
                            <div>
                                <div className="mb-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                                    Posledný krok
                                </div>
                                <div className="text-sm">
                                    <LastActivityContent row={row} />
                                </div>
                            </div>
                            <div>
                                <div className="mb-0.5 text-xs uppercase tracking-wide text-muted-foreground">
                                    Ďalší krok
                                </div>
                                <div className="text-sm">
                                    <NextActionContent row={row} />
                                </div>
                            </div>
                        </div>

                        {/* Päta: cena + rieši (kompaktne, naľavo) */}
                        <div className="mt-3 flex items-center gap-2 border-t pt-3 text-sm">
                            <span className="font-medium">
                                <PriceWithEye row={row} />
                            </span>
                            <span className="truncate text-muted-foreground">
                                · Rieši {row.owner ?? "nikto"}
                            </span>
                        </div>
                    </Link>
                ))}
            </div>

            {/* ── DESKTOP: tabuľka (hidden md:block) ────────────────────────── */}
            <div className="hidden overflow-hidden rounded-lg border md:block">
                <Table className="w-full table-fixed">
                    <colgroup>
                        <col className="w-[4%]" />
                        <col className={showStatus ? "w-[24%]" : "w-[28%]"} />
                        <col className="w-[8%]" />
                        {showStatus && <col className="w-[9%]" />}
                        <col className={showStatus ? "w-[19%]" : "w-[21%]"} />
                        <col className={showStatus ? "w-[19%]" : "w-[21%]"} />
                        <col className="w-[8%]" />
                        <col className={showStatus ? "w-[9%]" : "w-[10%]"} />
                    </colgroup>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="pl-4">#</TableHead>
                            <TableHead>Firma</TableHead>
                            <TableHead>Typ</TableHead>
                            {showStatus && <TableHead>Stav</TableHead>}
                            <TableHead>Posledný krok</TableHead>
                            <TableHead>Ďalší krok</TableHead>
                            <TableHead className="text-right">Cena</TableHead>
                            <TableHead>Rieši</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => {
                            const href = `/dashboard/pipeline/${row.id}`;
                            return (
                                <TableRow
                                    key={row.id}
                                    className="h-[4.75rem] cursor-pointer hover:bg-muted/50"
                                    onClick={() => router.push(href)}
                                >
                                    <TableCell className="pl-4 align-middle text-muted-foreground tabular-nums">
                                        {row.number}
                                    </TableCell>
                                    <TableCell className="max-w-0 align-middle font-medium">
                                        <Link
                                            href={href}
                                            className="flex min-w-0 items-center gap-2"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            <div className="min-w-0 flex-1">
                                                <span className="block truncate">{row.name}</span>
                                                <span className="block truncate text-xs font-normal text-muted-foreground">
                                                    {row.phone ?? "—"}
                                                </span>
                                            </div>
                                            <SentIcons row={row} />
                                        </Link>
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
                                        <LastActivityContent row={row} dense />
                                    </TableCell>
                                    <TableCell className="max-w-0 align-middle text-sm">
                                        <NextActionContent row={row} dense />
                                    </TableCell>
                                    <TableCell className="align-middle text-right">
                                        <div className="flex items-center justify-end">
                                            <PriceWithEye row={row} />
                                        </div>
                                    </TableCell>
                                    <TableCell className="max-w-0 truncate align-middle text-muted-foreground">
                                        {row.owner ?? "—"}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </TooltipProvider>
    );
}
