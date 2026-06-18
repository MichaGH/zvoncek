"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, FileText, Mail, Paintbrush } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
        <div className="overflow-hidden rounded-lg border">
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
                                        {(row.hasDesignSent || row.quoteSentAt || row.aboutUsSentAt) && (
                                            <TooltipProvider delayDuration={200}>
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
                                            </TooltipProvider>
                                        )}
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
                                    {row.lastActivity ? (
                                        <div className="flex min-w-0 flex-col">
                                            <span className="truncate">
                                                <span className="font-medium">
                                                    {ACTIVITY_LABEL[row.lastActivity.type]}
                                                </span>
                                                {row.lastActivity.outcome && (
                                                    <span className="ml-1 text-muted-foreground">
                                                        · {OUTCOME_LABEL[row.lastActivity.outcome]}
                                                    </span>
                                                )}
                                            </span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                {row.lastActivity.note || NBSP}
                                            </span>
                                            <span className="text-xs text-muted-foreground tabular-nums">
                                                {formatDate(row.lastActivity.at)}
                                            </span>
                                        </div>
                                    ) : (
                                        <span className="text-muted-foreground">—</span>
                                    )}
                                </TableCell>
                                <TableCell className="max-w-0 align-middle text-sm">
                                    {row.nextActionKind ? (
                                        <div className="flex min-w-0 flex-col">
                                            <span className="flex min-w-0 items-center gap-1.5 truncate">
                                                {NEXT_ACTION_LABEL[row.nextActionKind]}
                                                {(row.nextActionAt || row.nextActionMode === "IN_PROGRESS") && (
                                                    <UrgencyLabel
                                                        at={row.nextActionAt}
                                                        hasTime={row.nextActionHasTime}
                                                        mode={row.nextActionMode}
                                                    />
                                                )}
                                            </span>
                                            <span className="truncate text-xs font-normal text-muted-foreground">
                                                {row.nextActionNote || NBSP}
                                            </span>
                                        </div>
                                    ) : (
                                        <span className="text-muted-foreground">—</span>
                                    )}
                                </TableCell>
                                <TableCell className="align-middle">
                                    <div className="flex items-center justify-end gap-1">
                                        {row.priceDisclosed && (
                                            <TooltipProvider delayDuration={200}>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
                                                    </TooltipTrigger>
                                                    <TooltipContent>Klient pozná cenu</TooltipContent>
                                                </Tooltip>
                                            </TooltipProvider>
                                        )}
                                        <span className="tabular-nums">
                                            {row.price ? `${row.price} €` : "—"}
                                        </span>
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
    );
}
