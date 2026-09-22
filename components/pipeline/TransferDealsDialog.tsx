"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { transferDeals } from "@/lib/actions/pipeline";
import type { DealUserOption } from "@/lib/queries/pipeline";

type Person = { id: string; firstName: string; lastName: string };
type DealStatusKey = "ACTIVE" | "SNOOZED" | "WON" | "LOST" | "UNREACHABLE";

const STATUS_OPTIONS: { key: DealStatusKey; label: string }[] = [
    { key: "ACTIVE", label: "Aktívne" },
    { key: "SNOOZED", label: "Spiace" },
    { key: "WON", label: "Vyhraté" },
    { key: "LOST", label: "Stratené" },
    { key: "UNREACHABLE", label: "Nedostupné" },
];

const selectCls = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// „Presunúť obchody" (§5.5): napr. všetky otvorené obchody z Timeiných hovorov, Michal → nový obchodník.
// Wave 3 (§6.10): každý obchod ide cez spoločný prechod vlastníka – úloha u obchodníka ostáva (prípadne ide inému
// manažérovi), u manažéra skončí. Jedno odoslanie = jedno operationId; po chybe „Skúsiť znova" pokračuje tým istým.
export default function TransferDealsDialog({
    owners,
    callers,
    resolvers,
}: {
    owners: DealUserOption[];
    callers: Person[];
    resolvers: Person[];
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [from, setFrom] = useState("");
    const [handedOffBy, setHandedOffBy] = useState("");
    const [to, setTo] = useState("");
    const [taskAssignee, setTaskAssignee] = useState("");
    const [statuses, setStatuses] = useState<DealStatusKey[]>(["ACTIVE", "SNOOZED"]);
    const [operationId, setOperationId] = useState(newKey);
    const [pending, start] = useTransition();

    function submit() {
        if (!from || !to) return;
        const run = () =>
            start(async () => {
                const r = await transferDeals({
                    operationId,
                    fromOwnerId: from === "unassigned" ? null : from,
                    handedOffById: handedOffBy || null,
                    toOwnerId: to,
                    taskAssigneeId: taskAssignee || null,
                    statuses,
                });
                if ("error" in r) {
                    toast.error(r.error, r.code === "RETRYABLE" ? { action: { label: "Skúsiť znova", onClick: run } } : undefined);
                    if (r.code === "IDEMPOTENCY_CONFLICT") setOperationId(newKey());
                } else {
                    toast.success(`Presunuté: ${r.moved}${r.skipped ? ` · nepresunuté (práve sa upravujú): ${r.skipped}` : ""}`);
                    setOperationId(newKey());
                    setOpen(false);
                }
                router.refresh();
            });
        run();
    }

    if (!open) {
        return (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <ArrowRightLeft className="mr-1.5 h-4 w-4" />
                Presunúť obchody
            </Button>
        );
    }

    return (
        <Card className="w-full">
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Presunúť obchody</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">Od (vlastník)</Label>
                    <select
                        className={selectCls}
                        value={from}
                        onChange={(e) => {
                            setFrom(e.target.value);
                            setOperationId(newKey());
                        }}
                    >
                        <option value="">— vyber —</option>
                        <option value="unassigned">nepriradené</option>
                        {owners.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.firstName} {u.lastName}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">Komu</Label>
                    <select
                        className={selectCls}
                        value={to}
                        onChange={(e) => {
                            setTo(e.target.value);
                            setOperationId(newKey());
                        }}
                    >
                        <option value="">— vyber —</option>
                        {owners.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.firstName} {u.lastName}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">Z hovorov (nepovinné)</Label>
                    <select
                        className={selectCls}
                        value={handedOffBy}
                        onChange={(e) => {
                            setHandedOffBy(e.target.value);
                            setOperationId(newKey());
                        }}
                    >
                        <option value="">ktokoľvek</option>
                        {callers.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.firstName} {u.lastName}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">Otvorené úlohy u nového obchodníka pôjdu</Label>
                    <select
                        className={selectCls}
                        value={taskAssignee}
                        onChange={(e) => {
                            setTaskAssignee(e.target.value);
                            setOperationId(newKey());
                        }}
                    >
                        <option value="">doterajšiemu manažérovi</option>
                        {resolvers.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.firstName} {u.lastName}
                            </option>
                        ))}
                    </select>
                    <p className="text-xs text-muted-foreground">Presun na manažéra úlohy ukončí (odovzdanie sa prijme).</p>
                </div>
                <div className="grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">Stavy</Label>
                    <div className="flex flex-wrap gap-3">
                        {STATUS_OPTIONS.map((s) => (
                            <label key={s.key} className="flex items-center gap-1.5 text-sm">
                                <Checkbox
                                    checked={statuses.includes(s.key)}
                                    onCheckedChange={(v) => {
                                        setStatuses((cur) => (v === true ? [...cur, s.key] : cur.filter((x) => x !== s.key)));
                                        setOperationId(newKey());
                                    }}
                                />
                                {s.label}
                            </label>
                        ))}
                    </div>
                </div>
                <div className="flex gap-2 sm:col-span-2">
                    <Button size="sm" onClick={submit} disabled={pending || !from || !to || statuses.length === 0}>
                        {pending ? "Presúvam…" : "Presunúť"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                        Zrušiť
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
