import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { LeadStatus, ActivityType, CallOutcome } from "@/app/generated/prisma/enums";

type Row = {
    id: string;
    number: number;
    name: string;
    phone: string | null;
    status: LeadStatus;
    nextActionAt: string | null;
    nextActionNote: string | null;
    price: number | null;
    owner: string | null;
    lastActivity: { type: ActivityType; outcome: CallOutcome | null; at: string } | null;
};

const STATUS_LABEL: Record<LeadStatus, string> = {
    NEW: "Nový",
    ACTIVE: "Aktívny",
    SNOOZED: "Spí",
    WON: "Vyhraný",
    LOST: "Stratený",
};

const STATUS_VARIANT: Record<LeadStatus, "default" | "secondary" | "outline" | "destructive"> = {
    NEW: "outline",
    ACTIVE: "default",
    SNOOZED: "secondary",
    WON: "secondary",
    LOST: "destructive",
};

function fmtDate(iso: string | null) {
    if (!iso) return "—";
    const d = new Date(iso);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = (that.getTime() - today.getTime()) / 86_400_000;
    const time = d.getHours() || d.getMinutes()
        ? ` ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`
        : "";
    if (diff === 0) return `Dnes${time}`;
    if (diff === 1) return `Zajtra${time}`;
    if (diff === -1) return `Včera${time}`;
    return d.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric" }) + time;
}

export default function LeadsTable({ rows }: { rows: Row[] }) {
    if (rows.length === 0) {
        return (
            <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                Žiadne leady v tomto pohľade.
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
                    {rows.map((r) => {
                        const overdue =
                            r.nextActionAt && new Date(r.nextActionAt) < new Date() && (r.status === "ACTIVE" || r.status === "NEW");
                        return (
                            <TableRow key={r.id} className="relative">
                                <TableCell className="text-muted-foreground tabular-nums">{r.number}</TableCell>
                                <TableCell className="font-medium">
                                    <Link href={`/dashboard/leads/${r.id}`} className="after:absolute after:inset-0">
                                        {r.name}
                                    </Link>
                                </TableCell>
                                <TableCell className="tabular-nums">{r.phone ?? "—"}</TableCell>
                                <TableCell>
                                    <Badge variant={STATUS_VARIANT[r.status]} className="font-normal">
                                        {STATUS_LABEL[r.status]}
                                    </Badge>
                                </TableCell>
                                <TableCell className={overdue ? "font-medium text-destructive" : ""}>
                                    <span className="tabular-nums">{fmtDate(r.nextActionAt)}</span>
                                    {r.nextActionNote && (
                                        <span className="ml-1.5 text-xs text-muted-foreground">{r.nextActionNote}</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {r.lastActivity ? fmtDate(r.lastActivity.at) : "—"}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                    {r.price ? `${r.price} €` : "—"}
                                </TableCell>
                                <TableCell className="text-muted-foreground">{r.owner ?? "—"}</TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}