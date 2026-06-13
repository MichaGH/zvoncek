import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABEL, STATUS_VARIANT } from "@/lib/dictionaries";
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
            <Table className="w-full table-fixed">
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-12">#</TableHead>
                        <TableHead>Firma</TableHead>
                        <TableHead>Telefón</TableHead>
                        <TableHead>Stav</TableHead>
                        <TableHead>Ďalší krok</TableHead>
                        <TableHead>Posledná aktivita</TableHead>
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
                            <TableRow key={row.id} className="relative">
                                <TableCell className="text-muted-foreground tabular-nums">{row.number}</TableCell>
                                <TableCell className="font-medium">
                                    <Link
                                        href={`/dashboard/pipeline/${row.id}`}
                                        className="after:absolute after:inset-0"
                                    >
                                        {row.name}
                                    </Link>
                                </TableCell>
                                <TableCell className="tabular-nums">{row.phone ?? "—"}</TableCell>
                                <TableCell>
                                    <Badge variant={STATUS_VARIANT[row.status]} className="font-normal">
                                        {STATUS_LABEL[row.status]}
                                    </Badge>
                                </TableCell>
                                <TableCell className={overdue ? "font-medium text-destructive" : ""}>
                                    <span className="tabular-nums">{formatDate(row.nextActionAt)}</span>
                                    {row.nextActionNote && (
                                        <span className="ml-1.5 text-xs text-muted-foreground">
                                            {row.nextActionNote}
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {row.lastActivity ? formatDate(row.lastActivity.at) : "—"}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                    {row.price ? `${row.price} €` : "—"}
                                </TableCell>
                                <TableCell className="text-muted-foreground">{row.owner ?? "—"}</TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}
