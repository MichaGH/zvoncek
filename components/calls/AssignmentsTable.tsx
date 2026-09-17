"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { releaseBatch, transferCallWork } from "@/lib/actions/calls/assignments";
import type { CallWorkKind } from "@/lib/commands/assignments";
import type { AssignmentRow } from "@/lib/queries/calls/assignments";
import { fmtAgo } from "@/lib/utils";

const KIND_LABEL: Record<CallWorkKind, string> = {
    NEW: "Nové (dávka)",
    RETRY: "Skúsiť znova",
    SCHEDULED: "Dohodnuté",
    SNOOZED: "Spiace",
};

const selectCls = "h-8 rounded-md border border-input bg-background px-2 text-sm";

// Tabuľka „kto čo drží" + presuny. Deaktivovaní sú hore; ich prácu treba presunúť ručne.
export default function AssignmentsTable({ rows, targets }: { rows: AssignmentRow[]; targets: { id: string; name: string }[] }) {
    if (rows.length === 0) {
        return <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">Nikto nedrží prácu volania.</p>;
    }
    return (
        <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[860px]">
                <TableHeader>
                    <TableRow>
                        <TableHead>Volajúci</TableHead>
                        <TableHead className="text-right">Nové (dávka)</TableHead>
                        <TableHead className="text-right">Skúsiť znova</TableHead>
                        <TableHead className="text-right">Dohodnuté (po termíne)</TableHead>
                        <TableHead className="text-right">Spiace</TableHead>
                        <TableHead>Akcie</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => (
                        <AssignmentRowView key={row.id} row={row} targets={targets.filter((t) => t.id !== row.id)} />
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function AssignmentRowView({ row, targets }: { row: AssignmentRow; targets: { id: string; name: string }[] }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [kind, setKind] = useState<CallWorkKind>(row.retry > 0 ? "RETRY" : "NEW");
    const [to, setTo] = useState("");
    const [limit, setLimit] = useState("");

    function report(r: { moved: number } | { error: string }, verb: string) {
        if ("error" in r) toast.error(r.error);
        else toast.success(`${verb}: ${r.moved}`);
        router.refresh();
    }

    return (
        <TableRow className={row.deactivated ? "bg-destructive/5" : undefined}>
            <TableCell className="font-medium">
                {row.name}
                {row.deactivated && (
                    <Badge variant="destructive" className="ml-2">
                        Deaktivovaný
                    </Badge>
                )}
            </TableCell>
            <TableCell className="text-right tabular-nums">
                {row.batch}
                {row.batch > 0 && row.batchSince && <span className="block text-xs text-muted-foreground">{fmtAgo(row.batchSince)}</span>}
            </TableCell>
            <TableCell className="text-right tabular-nums">{row.retry}</TableCell>
            <TableCell className="text-right tabular-nums">
                {row.scheduled}
                {row.scheduledOverdue > 0 && <span className="ml-1 text-destructive">({row.scheduledOverdue})</span>}
            </TableCell>
            <TableCell className="text-right tabular-nums">{row.snoozed}</TableCell>
            <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                    {row.batch > 0 && (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                                if (!window.confirm(`Uvoľniť ${row.batch} nových kontaktov od ${row.name} do spoločnej fronty?`)) return;
                                start(async () => report(await releaseBatch(row.id), "Uvoľnené do fronty"));
                            }}
                        >
                            Uvoľniť dávku
                        </Button>
                    )}
                    <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as CallWorkKind)}>
                        {(Object.keys(KIND_LABEL) as CallWorkKind[]).map((k) => (
                            <option key={k} value={k}>
                                {KIND_LABEL[k]}
                            </option>
                        ))}
                    </select>
                    <Input
                        type="number"
                        min={1}
                        placeholder="všetky"
                        value={limit}
                        onChange={(e) => setLimit(e.target.value)}
                        className="h-8 w-24"
                        title="Koľko najstarších presunúť (prázdne = všetky)"
                    />
                    <select className={selectCls} value={to} onChange={(e) => setTo(e.target.value)}>
                        <option value="">→ komu</option>
                        {targets.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.name}
                            </option>
                        ))}
                    </select>
                    <Button
                        size="sm"
                        disabled={pending || !to}
                        onClick={() =>
                            start(async () =>
                                report(
                                    await transferCallWork({
                                        fromUserId: row.id,
                                        toUserId: to,
                                        kind,
                                        limit: limit.trim() ? Number(limit) : null,
                                    }),
                                    "Presunuté",
                                ),
                            )
                        }
                    >
                        Presunúť
                    </Button>
                </div>
            </TableCell>
        </TableRow>
    );
}
