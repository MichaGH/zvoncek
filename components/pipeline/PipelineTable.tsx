import Link from "next/link";
import { Badge } from "@/components/ui/badge";
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

const NBSP = " ";

export default function PipelineTable({ rows }: { rows: PipelineListRow[] }) {
    if (rows.length === 0) {
        return (
            <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                Žiadne príležitosti v tomto pohľade.
            </div>
        );
    }

    return (
        <div className="overflow-x-auto rounded-lg border">
            <Table className="w-full min-w-[900px]">
                <colgroup>
                    <col className="w-10" />
                    <col />
                    <col className="w-24" />
                    <col className="w-24" />
                    <col className="w-52" />
                    <col className="w-52" />
                    <col className="w-20" />
                    <col className="w-24" />
                </colgroup>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-4">#</TableHead>
                        <TableHead>Firma</TableHead>
                        <TableHead>Typ</TableHead>
                        <TableHead>Stav</TableHead>
                        <TableHead>Posledný krok</TableHead>
                        <TableHead>Ďalší krok</TableHead>
                        <TableHead className="text-right">Cena</TableHead>
                        <TableHead>Rieši</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => {
                        const overdue =
                            row.nextActionAt &&
                            new Date(row.nextActionAt) < new Date() &&
                            (row.status === "ACTIVE" || row.status === "NEW");
                        return (
                            <TableRow key={row.id} className="relative h-[4.75rem]">
                                <TableCell className="pl-4 align-middle text-muted-foreground tabular-nums">
                                    {row.number}
                                </TableCell>
                                <TableCell className="align-middle font-medium">
                                    <Link
                                        href={`/dashboard/pipeline/${row.id}`}
                                        className="block after:absolute after:inset-0"
                                    >
                                        <span className="block truncate">{row.name}</span>
                                        <span className="block truncate text-xs font-normal text-muted-foreground">
                                            {row.phone ?? "—"}
                                        </span>
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
                                <TableCell className="align-middle">
                                    <Badge variant={STATUS_VARIANT[row.status]} className="font-normal">
                                        {STATUS_LABEL[row.status]}
                                    </Badge>
                                </TableCell>
                                <TableCell className="align-middle text-sm">
                                    {row.lastActivity ? (
                                        <div className="flex flex-col">
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
                                <TableCell
                                    className={`align-middle text-sm ${overdue ? "font-medium text-destructive" : ""}`}
                                >
                                    {row.nextActionKind ? (
                                        <div className="flex flex-col">
                                            <span className="truncate">
                                                {NEXT_ACTION_LABEL[row.nextActionKind]}
                                                <span className="ml-1.5 tabular-nums">
                                                    · {formatDate(row.nextActionAt)}
                                                </span>
                                            </span>
                                            <span className="truncate text-xs font-normal text-muted-foreground">
                                                {row.nextActionNote || NBSP}
                                            </span>
                                        </div>
                                    ) : (
                                        <span className="text-muted-foreground">—</span>
                                    )}
                                </TableCell>
                                <TableCell className="align-middle text-right tabular-nums">
                                    {row.price ? `${row.price} €` : "—"}
                                </TableCell>
                                <TableCell className="align-middle truncate text-muted-foreground">
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
