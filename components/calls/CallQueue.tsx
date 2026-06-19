"use client";

import { useOptimistic, useTransition, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { logCall } from "@/lib/actions/calls";
import { getMoreNew } from "@/lib/actions/calls/calls-pagination";
import { CallOutcome } from "@/app/generated/prisma/enums";
import { CallsBoard, QueueLead } from "@/lib/queries/calls";

import CallRow from "./CallRow";
import CallDrawer from "./CallDrawer";
import InfoDrawer from "./InfoDrawer";
import { Button } from "@/components/ui/button";
import { CalendarClock, Clock, RotateCcw, Sparkles } from "lucide-react";

type Opts = { note?: string; callbackNote?: string; when?: string; hasTime?: boolean; email?: string };
type RemoveAction = { type: "remove"; leadId: string };

export default function CallQueue({ board }: { board: CallsBoard }) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const [openLead, setOpenLead] = useState<QueueLead | null>(null);
    const [infoLead, setInfoLead] = useState<QueueLead | null>(null);

    // paginácia "nových"
    const [extraNew, setExtraNew] = useState<QueueLead[]>([]);
    const [cursor, setCursor] = useState(board.freshNextCursor);
    const [hasMore, setHasMore] = useState(board.freshHasMore);
    const [loadingMore, setLoadingMore] = useState(false);

    // optimistic board – základ je server board + dotiahnuté nové
    const baseBoard: CallsBoard = { ...board, fresh: [...board.fresh, ...extraNew] };

    const [optimisticBoard, applyOptimistic] = useOptimistic(
        baseBoard,
        (current, action: RemoveAction) => ({
            ...current,
            scheduled: current.scheduled.filter((l) => l.id !== action.leadId),
            retry: current.retry.filter((l) => l.id !== action.leadId),
            snoozed: current.snoozed.filter((l) => l.id !== action.leadId),
            fresh: current.fresh.filter((l) => l.id !== action.leadId),
        }),
    );

    useEffect(() => {
        const t = setInterval(() => router.refresh(), 60_000);
        return () => clearInterval(t);
    }, [router]);

    function handleOutcome(leadId: string, outcome: CallOutcome, label: string, opts?: Opts) {
        setOpenLead(null);

        startTransition(async () => {
            applyOptimistic({ type: "remove", leadId }); // riadok zmizne hneď
            const r = await logCall({ leadId, outcome, ...opts });

            if (r?.error) {
                toast.error("Nepodarilo sa uložiť", {
                    description: r.error,
                    action: { label: "Skúsiť znova", onClick: () => handleOutcome(leadId, outcome, label, opts) },
                });
                router.refresh(); // zosúladiť s realitou (riadok sa vráti)
                return;
            }

            // úspech – undo toast (5 s)
            toast.success(`Zaznamenané: ${label}`, {
                action: { label: "Vrátiť späť", onClick: () => router.refresh() },
                duration: 5000,
            });
        });
    }

    async function loadMore() {
        if (!cursor) return;
        setLoadingMore(true);
        try {
            const res = await getMoreNew(cursor);
            setExtraNew((p) => [...p, ...res.leads]);
            setCursor(res.nextCursor);
            setHasMore(res.hasMore);
        } catch {
            toast.error("Nepodarilo sa načítať ďalšie firmy.");
        }
        setLoadingMore(false);
    }

    const rowProps = { onOpen: setOpenLead, onInfo: setInfoLead };
    const allNew = optimisticBoard.fresh;

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
                        count={optimisticBoard.retry.length} tone="retry"
                        leads={optimisticBoard.retry} empty="Nič na opakovanie." {...rowProps}
                    />
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
                        title="Nové firmy" hint="ešte nevolané"
                        count={allNew.length} countSuffix={hasMore ? "+" : ""} tone="fresh"
                        leads={allNew} empty="Žiadne nové firmy vo fronte." {...rowProps}
                    />
                    {hasMore && (
                        <Button variant="outline" className="w-full" onClick={loadMore} disabled={loadingMore}>
                            {loadingMore ? "Načítavam…" : "Načítať ďalšie"}
                        </Button>
                    )}
                </div>
            </div>

            <CallDrawer
                key={openLead?.id ?? "closed"}
                lead={openLead}
                onClose={() => setOpenLead(null)}
                onOutcome={handleOutcome}
            />
            <InfoDrawer key={infoLead?.id ?? "closed"} lead={infoLead} onClose={() => setInfoLead(null)} />
        </>
    );
}

function Group({
    icon, title, hint, count, countSuffix = "", tone, leads, empty, onOpen, onInfo,
}: {
    icon: React.ReactNode; title: string; hint: string; count: number; countSuffix?: string;
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
                    {count}{countSuffix}
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
