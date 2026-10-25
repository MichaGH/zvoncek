"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Recycle, TriangleAlert } from "lucide-react";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pickRecycleFirst, recycleLeads } from "@/lib/actions/recycling";
import type { RecycleSkip } from "@/lib/commands/recycling";
import { formatBusinessDateTime } from "@/lib/domain/businessTime";
import { REQUEST_SHORT_LABEL } from "@/lib/domain/clientRequests";
import {
    RECYCLE_BUCKET_LABEL,
    RECYCLE_MAX_ITEMS,
    RECYCLE_PAGE_SIZE,
    RECYCLE_SKIP_LABEL,
    recycleHref,
    recycleSelection,
    summarizeRecycleSelection,
    type RecycleBucket,
    type RecycleParams,
    type RecycleSelection,
} from "@/lib/domain/recycling";
import { OUTCOME_LABEL, STATUS_LABEL } from "@/lib/dictionaries";
import type { RecycleRow } from "@/lib/queries/recycling";

function phaseLabel(bucket: RecycleBucket) {
    return bucket.startsWith("deal_") ? "Obchod" : "Volanie";
}

function lastResult(row: RecycleRow) {
    if (row.isDeal) return [STATUS_LABEL[row.status], row.lostReason].filter(Boolean).join(" – ");
    return row.lastOutcome ? OUTCOME_LABEL[row.lastOutcome] : "—";
}

function gotText(row: RecycleRow) {
    const got = [row.got.info && "info", row.got.price && "cena", row.got.design && "návrh"].filter(Boolean).join(" · ");
    const asked = row.openAsks.length ? `chceli ${row.openAsks.map((c) => REQUEST_SHORT_LABEL[c]).join(" + ")}` : "";
    return [got && `dostali ${got}`, asked].filter(Boolean).join(" · ") || "—";
}

export default function RecyclePanel({ params, total, rows, now }: { params: RecycleParams; total: number; rows: RecycleRow[]; now: number }) {
    const router = useRouter();
    const [selected, setSelected] = useState<Map<string, RecycleSelection>>(new Map());
    const [pickN, setPickN] = useState("100");
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [skipped, setSkipped] = useState<RecycleSkip[]>([]);
    const [busy, startBusy] = useTransition();

    const pageIds = rows.map((r) => r.id);
    const allOnPage = rows.length > 0 && pageIds.every((id) => selected.has(id));
    const pages = Math.max(1, Math.ceil(total / RECYCLE_PAGE_SIZE));

    const summary = useMemo(() => summarizeRecycleSelection(selected.values(), now), [selected, now]);
    const byBucket = summary.buckets;
    const countOf = (b: RecycleBucket) => byBucket.find((x) => x.bucket === b)?.n ?? 0;

    function toggle(row: RecycleRow, on: boolean) {
        setSelected((prev) => {
            const next = new Map(prev);
            if (on) next.set(row.id, recycleSelection(row));
            else next.delete(row.id);
            return next;
        });
    }

    function togglePage(on: boolean) {
        setSelected((prev) => {
            const next = new Map(prev);
            for (const row of rows) {
                if (on) next.set(row.id, recycleSelection(row));
                else next.delete(row.id);
            }
            return next;
        });
    }

    function pickFirst() {
        const n = Math.floor(Number(pickN));
        if (!Number.isFinite(n) || n < 1) return;
        const query = Object.fromEntries(new URL(recycleHref(params), "http://local").searchParams);
        startBusy(async () => {
            const r = await pickRecycleFirst(query, Math.min(n, RECYCLE_MAX_ITEMS));
            if ("error" in r) {
                toast.error(r.error);
                return;
            }
            setSelected(new Map(r.items.map((i) => [i.leadId, i])));
        });
    }

    function run() {
        const items = [...selected.entries()].map(([leadId, p]) => ({ leadId, expectedRevision: p.expectedRevision }));
        startBusy(async () => {
            const r = await recycleLeads({ items });
            if ("error" in r) {
                toast.error(r.error, r.code === "RETRYABLE" ? { action: { label: "Skúsiť znova", onClick: run } } : undefined);
                router.refresh();
                return;
            }
            setConfirmOpen(false);
            setSelected(new Map());
            setSkipped(r.skipped);
            toast.success(`Recyklované: ${r.recycled}${r.skipped.length ? ` · preskočené: ${r.skipped.length}` : ""}`);
            router.refresh();
        });
    }

    return (
        <div className="space-y-3">
            {skipped.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                    <div className="mb-1 font-medium">Preskočené ({skipped.length})</div>
                    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                        {skipped.map((s) => (
                            <li key={s.leadId}>
                                {s.number !== null ? `#${s.number}` : "?"} – {RECYCLE_SKIP_LABEL[s.reason]}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-2 backdrop-blur">
                <span className="px-1 text-sm">
                    Nájdené: <span className="font-semibold tabular-nums">{total}</span>
                    {" · "}vybrané: <span className="font-semibold tabular-nums">{selected.size}</span>
                </span>
                <div className="flex items-center gap-1.5">
                    <Input
                        value={pickN}
                        onChange={(e) => setPickN(e.target.value.replace(/\D/g, ""))}
                        inputMode="numeric"
                        className="h-8 w-20"
                        aria-label="Počet"
                    />
                    <Button size="sm" variant="outline" onClick={pickFirst} disabled={busy || total === 0}>
                        Vybrať prvých {Math.min(Number(pickN) || 0, RECYCLE_MAX_ITEMS)}
                    </Button>
                </div>
                {selected.size > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())} disabled={busy}>
                        Zrušiť výber
                    </Button>
                )}
                <div className="ml-auto">
                    <Button
                        size="sm"
                        onClick={() => setConfirmOpen(true)}
                        disabled={busy || selected.size === 0 || selected.size > RECYCLE_MAX_ITEMS}
                    >
                        <Recycle className="mr-1.5 h-4 w-4" />
                        Recyklovať…
                    </Button>
                </div>
                {byBucket.length > 0 && (
                    <p className="w-full px-1 text-xs text-muted-foreground">
                        {byBucket.map(({ bucket, n }) => `${phaseLabel(bucket)} – ${RECYCLE_BUCKET_LABEL[bucket]}: ${n}`).join(" · ")}
                    </p>
                )}
                {selected.size > RECYCLE_MAX_ITEMS && (
                    <p className="w-full px-1 text-xs text-destructive">Naraz najviac {RECYCLE_MAX_ITEMS} kontaktov.</p>
                )}
            </div>

            <div className="overflow-x-auto rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-8">
                                <Checkbox
                                    checked={allOnPage}
                                    onCheckedChange={(v) => togglePage(v === true)}
                                    aria-label="Vybrať celú stranu"
                                    disabled={busy || rows.length === 0}
                                />
                            </TableHead>
                            <TableHead>#</TableHead>
                            <TableHead>Firma</TableHead>
                            <TableHead>Telefón</TableHead>
                            <TableHead>Stav</TableHead>
                            <TableHead>Kto to mal</TableHead>
                            <TableHead>Posledný výsledok</TableHead>
                            <TableHead>Posledný kontakt</TableHead>
                            <TableHead className="text-right">Nezdvihli</TableHead>
                            <TableHead>Dostali / chceli</TableHead>
                            <TableHead>Kolo</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                                    Nič nezodpovedá filtrom.
                                </TableCell>
                            </TableRow>
                        )}
                        {rows.map((row) => (
                            <TableRow key={row.id} data-state={selected.has(row.id) ? "selected" : undefined}>
                                <TableCell>
                                    <Checkbox
                                        checked={selected.has(row.id)}
                                        disabled={busy}
                                        onCheckedChange={(v) => toggle(row, v === true)}
                                        aria-label={`Vybrať #${row.number}`}
                                    />
                                </TableCell>
                                <TableCell className="tabular-nums text-muted-foreground">
                                    {row.isDeal ? (
                                        <Link href={`/dashboard/pipeline/${row.id}`} className="hover:underline">
                                            #{row.number}
                                        </Link>
                                    ) : (
                                        `#${row.number}`
                                    )}
                                </TableCell>
                                <TableCell className="max-w-56">
                                    <div className="truncate font-medium">{row.companyName || row.website || "—"}</div>
                                    {row.companyName && row.website && (
                                        <div className="truncate text-xs text-muted-foreground">{row.website}</div>
                                    )}
                                </TableCell>
                                <TableCell className="whitespace-nowrap tabular-nums">{row.phone || "—"}</TableCell>
                                <TableCell className="whitespace-nowrap">
                                    <span className="text-xs text-muted-foreground">{phaseLabel(row.bucket)} · </span>
                                    {RECYCLE_BUCKET_LABEL[row.bucket]}
                                    {row.bucket === "call_unreachable" && (
                                        <TriangleAlert className="ml-1 inline h-3.5 w-3.5 text-amber-600" aria-label="zlé číslo" />
                                    )}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">{row.holderName ?? "—"}</TableCell>
                                <TableCell className="max-w-48 truncate">{lastResult(row)}</TableCell>
                                <TableCell className="whitespace-nowrap tabular-nums">
                                    {formatBusinessDateTime(new Date(row.lastAt), false)}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{row.tries || ""}</TableCell>
                                <TableCell className="max-w-48 truncate text-xs text-muted-foreground">{gotText(row)}</TableCell>
                                <TableCell>
                                    {row.round > 1 ? <Badge variant="secondary">{row.round}. kolo</Badge> : <span className="text-muted-foreground">1</span>}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            {pages > 1 && (
                <div className="flex items-center justify-end gap-2 text-sm">
                    <Button asChild size="sm" variant="outline" disabled={params.page <= 1}>
                        <Link href={recycleHref(params, { page: Math.max(1, params.page - 1) })} aria-disabled={params.page <= 1}>
                            <ChevronLeft className="h-4 w-4" />
                        </Link>
                    </Button>
                    <span className="tabular-nums text-muted-foreground">
                        {params.page} / {pages}
                    </span>
                    <Button asChild size="sm" variant="outline" disabled={params.page >= pages}>
                        <Link href={recycleHref(params, { page: Math.min(pages, params.page + 1) })} aria-disabled={params.page >= pages}>
                            <ChevronRight className="h-4 w-4" />
                        </Link>
                    </Button>
                </div>
            )}

            <ResponsiveSheet
                open={confirmOpen}
                onOpenChange={(open) => !busy && setConfirmOpen(open)}
                title={`Recyklovať ${selected.size} ${selected.size === 1 ? "kontakt" : selected.size < 5 ? "kontakty" : "kontaktov"}?`}
                description="Stanú sa novými kontaktmi (ďalšie kolo) v spoločnej fronte. Doterajšia história sa archivuje, nič sa nemaže."
            >
                <div className="space-y-4 px-4 pb-4 md:px-0 md:pb-0">
                    <div>
                        <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Výber</div>
                        <ul className="space-y-1 text-sm">
                            {byBucket.map(({ bucket, n }) => (
                                <li key={bucket} className="flex justify-between">
                                    <span>
                                        {phaseLabel(bucket)} – {RECYCLE_BUCKET_LABEL[bucket]}
                                    </span>
                                    <span className="tabular-nums">{n}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                    {(countOf("call_unreachable") > 0 || summary.owners.length > 0 || summary.asks.length > 0 || summary.recent > 0 || countOf("call_scheduled") > 0) && (
                        <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                            {countOf("call_unreachable") > 0 && <li>⚠ {countOf("call_unreachable")} so zlým číslom – volajúci dostane to isté číslo.</li>}
                            {summary.owners.map((owner) => (
                                <li key={owner.id ?? "none"}>⚠ {owner.name}: aktívne {owner.active}, spiace {owner.snoozed} – zmiznú z pipeline vlastníka.</li>
                            ))}
                            {summary.asks.map(({ content, n }) => (
                                <li key={content}>⚠ Chceli {REQUEST_SHORT_LABEL[content]}: {n}×. Otvorené požiadavky sa presunú do archívu.</li>
                            ))}
                            {summary.recent > 0 && <li>⚠ Nedávny kontakt alebo pridanie (posledných 30 dní): {summary.recent}×.</li>}
                            {countOf("call_scheduled") > 0 && <li>⚠ {countOf("call_scheduled")} dohodnutých volaní – termín sa stratí.</li>}
                        </ul>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
                            Zrušiť
                        </Button>
                        <Button onClick={run} disabled={busy || selected.size === 0}>
                            <Recycle className="mr-1.5 h-4 w-4" />
                            Recyklovať {selected.size}
                        </Button>
                    </div>
                </div>
            </ResponsiveSheet>
        </div>
    );
}
