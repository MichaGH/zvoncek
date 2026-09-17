"use client";

import { useOptimistic, useTransition, useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { getMoreRetries, logCall } from "@/lib/actions/calls";
import { claimBatch } from "@/lib/actions/calls/claims";
import type { CallsBoard, QueueLead } from "@/lib/queries/calls";
import type { Schedule } from "@/lib/domain/schedule";
import type { FirstCallOutcome } from "@/lib/domain/leadFlow";
import { CLAIM_BATCH_SIZE } from "@/lib/domain/callAssignment";

import CallRow from "./CallRow";
import CallDrawer from "./CallDrawer";
import InfoDrawer from "./InfoDrawer";
import { Button } from "@/components/ui/button";
import { CalendarClock, Clock, RotateCcw, Sparkles } from "lucide-react";

export type OutcomeOpts = { note?: string; callbackNote?: string; schedule?: Schedule; email?: string };
type RemoveAction = { type: "remove"; leadId: string };

// Kódy, pri ktorých nemá zmysel skúšať znova – kontakt sa zmenil, stránka sa obnoví.
const REFRESH_CODES = new Set(["NOT_ASSIGNED", "NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "FORBIDDEN"]);

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function CallQueue({
    board,
    recipientPreview,
    canClaim,
}: {
    board: CallsBoard;
    recipientPreview: string | null;
    canClaim: boolean;
}) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const [claiming, startClaim] = useTransition();
    const [openLead, setOpenLead] = useState<QueueLead | null>(null);
    const [infoLead, setInfoLead] = useState<QueueLead | null>(null);
    // Idempotency kľúč pre otvorený drawer (lead id → kľúč). Nový po úspechu alebo po chybe bez opakovania.
    const keys = useRef(new Map<string, string>());

    // stránkovanie „Skúsiť znova"
    const [extraRetry, setExtraRetry] = useState<QueueLead[]>([]);
    const [cursor, setCursor] = useState(board.retryNextCursor);
    const [loadingMore, setLoadingMore] = useState(false);
    const [boardVersion, setBoardVersion] = useState(board);
    if (boardVersion !== board) {
        // nový server board (refresh) → zahodiť dotiahnuté strany
        setBoardVersion(board);
        setExtraRetry([]);
        setCursor(board.retryNextCursor);
    }

    const seen = new Set(board.retry.map((l) => l.id));
    const baseBoard: CallsBoard = { ...board, retry: [...board.retry, ...extraRetry.filter((l) => !seen.has(l.id))] };

    const [optimisticBoard, applyOptimistic] = useOptimistic(baseBoard, (current, action: RemoveAction) => ({
        ...current,
        scheduled: current.scheduled.filter((l) => l.id !== action.leadId),
        retry: current.retry.filter((l) => l.id !== action.leadId),
        snoozed: current.snoozed.filter((l) => l.id !== action.leadId),
        fresh: current.fresh.filter((l) => l.id !== action.leadId),
    }));

    useEffect(() => {
        const t = setInterval(() => router.refresh(), 60_000);
        return () => clearInterval(t);
    }, [router]);

    function openDrawer(lead: QueueLead) {
        if (!keys.current.has(lead.id)) keys.current.set(lead.id, newKey());
        setOpenLead(lead);
    }

    function handleOutcome(lead: QueueLead, outcome: FirstCallOutcome, label: string, opts: OutcomeOpts, key?: string) {
        setOpenLead(null);
        const idempotencyKey = key ?? keys.current.get(lead.id) ?? newKey();
        keys.current.set(lead.id, idempotencyKey);

        startTransition(async () => {
            applyOptimistic({ type: "remove", leadId: lead.id });
            let r: Awaited<ReturnType<typeof logCall>>;
            try {
                r = await logCall({ leadId: lead.id, outcome, expectedRevision: lead.revision, idempotencyKey, ...opts });
            } catch {
                toast.error("Nepodarilo sa uložiť", {
                    description: "Chyba siete.",
                    action: { label: "Skúsiť znova", onClick: () => handleOutcome(lead, outcome, label, opts, idempotencyKey) },
                });
                router.refresh();
                return;
            }

            if ("error" in r) {
                if (r.code && REFRESH_CODES.has(r.code)) {
                    keys.current.delete(lead.id);
                    toast.error(r.code === "FORBIDDEN" || r.code === "UNAUTHENTICATED" ? r.error : "Kontakt sa medzitým zmenil – obnovujem");
                } else {
                    // RETRYABLE / neznáma chyba: ten istý kľúč aj očakávaná revízia.
                    toast.error("Nepodarilo sa uložiť", {
                        description: r.error,
                        action: { label: "Skúsiť znova", onClick: () => handleOutcome(lead, outcome, label, opts, idempotencyKey) },
                    });
                }
                router.refresh();
                return;
            }

            keys.current.delete(lead.id);
            if ("recipient" in r) {
                toast.success(
                    r.recipient ? `Odovzdané: ${r.recipient.name}` : "Odovzdané – nepriradené (priradí manažér)",
                    { duration: 5000 },
                );
            } else {
                toast.success(`Zaznamenané: ${label}`, { duration: 4000 });
            }
        });
    }

    function claim() {
        startClaim(async () => {
            const r = await claimBatch();
            if ("error" in r) toast.error(r.error);
            else if (r.reason === "BATCH_NOT_EMPTY") toast.error("Najprv dovolaj aktuálnu dávku.");
            else if (r.claimed === 0) toast.message("Spoločná fronta je prázdna.");
            else toast.success(`Pridané do tvojej dávky: ${r.claimed}`);
            router.refresh();
        });
    }

    async function loadMore() {
        if (!cursor) return;
        setLoadingMore(true);
        try {
            const res = await getMoreRetries(cursor);
            setExtraRetry((p) => [...p, ...res.leads]);
            setCursor(res.nextCursor);
        } catch {
            toast.error("Nepodarilo sa načítať ďalšie.");
        }
        setLoadingMore(false);
    }

    const rowProps = { onOpen: openDrawer, onInfo: setInfoLead };
    const batch = optimisticBoard.fresh;
    const showClaim = canClaim && board.batchCount === 0 && batch.length === 0 && board.poolCount > 0;

    return (
        <>
            <div className="grid gap-6 lg:grid-cols-2">
                {/* ĽAVÝ STĹPEC */}
                <div className="min-w-0 space-y-6">
                    <Group
                        icon={<CalendarClock className="h-4 w-4" />}
                        title="Dohodnuté hovory" hint="majú dohodnutý čas"
                        count={optimisticBoard.scheduled.length} tone="urgent"
                        leads={optimisticBoard.scheduled} empty="Žiadne dohodnuté hovory." {...rowProps}
                    />
                    <Group
                        icon={<RotateCcw className="h-4 w-4" />}
                        title="Skúsiť znova" hint="nedovolané"
                        count={Math.max(0, board.retryTotal - (baseBoard.retry.length - optimisticBoard.retry.length))}
                        tone="retry"
                        leads={optimisticBoard.retry} empty="Nič na opakovanie." {...rowProps}
                    />
                    {cursor && (
                        <Button variant="outline" className="w-full" onClick={loadMore} disabled={loadingMore}>
                            {loadingMore ? "Načítavam…" : "Načítať ďalšie"}
                        </Button>
                    )}
                    <Group
                        icon={<Clock className="h-4 w-4" />}
                        title="Spiace" hint="ozvať sa neskôr (zvýraznené = dozreté)"
                        count={optimisticBoard.snoozed.length} tone="urgent"
                        leads={optimisticBoard.snoozed} empty="Žiadne spiace kontakty." {...rowProps}
                    />
                </div>

                {/* PRAVÝ STĹPEC */}
                <div className="min-w-0 space-y-6">
                    <Group
                        icon={<Sparkles className="h-4 w-4" />}
                        title="Nové firmy" hint="tvoja dávka – ešte nevolané"
                        count={batch.length} tone="fresh"
                        leads={batch}
                        empty={board.poolCount > 0 ? "Dávka je prázdna." : "Spoločná fronta je prázdna."}
                        {...rowProps}
                    />
                    {showClaim && (
                        <Button className="w-full" onClick={claim} disabled={claiming}>
                            {claiming ? "Beriem…" : `Zobrať ďalších ${Math.min(CLAIM_BATCH_SIZE, board.poolCount)}`}
                        </Button>
                    )}
                </div>
            </div>

            <CallDrawer
                key={openLead?.id ?? "closed"}
                lead={openLead}
                recipientPreview={recipientPreview}
                onClose={() => setOpenLead(null)}
                onOutcome={handleOutcome}
            />
            <InfoDrawer key={infoLead?.id ?? "closed"} lead={infoLead} onClose={() => setInfoLead(null)} />
        </>
    );
}

function Group({
    icon, title, hint, count, tone, leads, empty, onOpen, onInfo,
}: {
    icon: React.ReactNode; title: string; hint: string; count: number;
    tone: "urgent" | "retry" | "fresh"; leads: QueueLead[]; empty: string;
    onOpen: (l: QueueLead) => void; onInfo: (l: QueueLead) => void;
}) {
    const toneColor = tone === "urgent" ? "text-destructive" : tone === "retry" ? "text-amber-600" : "text-muted-foreground";
    return (
        <section>
            <header className="mb-2.5 flex items-baseline gap-2">
                <span className={toneColor}>{icon}</span>
                <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
                <span className="text-xs text-muted-foreground">{hint}</span>
                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">
                    {count}
                </span>
            </header>
            {leads.length === 0 ? (
                <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">{empty}</p>
            ) : (
                <div className="divide-y overflow-hidden rounded-xl border bg-card">
                    {leads.map((l) => (
                        <CallRow key={l.id} lead={l} tone={tone} onOpen={() => onOpen(l)} onInfo={() => onInfo(l)} />
                    ))}
                </div>
            )}
        </section>
    );
}
