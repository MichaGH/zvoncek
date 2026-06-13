"use client";

import { useOptimistic, useTransition, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { logCall } from "@/lib/actions/calls";
import { getMoreNew } from "@/lib/actions/calls-pagination";
import { CallOutcome } from "@/app/generated/prisma/enums";
import { CallsBoard, QueueLead } from "@/lib/queries/calls";
import CallRow from "./CallRow";
import CallDrawer from "./CallDrawer";
import InfoDrawer from "./InfoDrawer";
import { Button } from "@/components/ui/button";
import { CalendarClock, RotateCcw, Sparkles } from "lucide-react";

export type Done = { outcome: CallOutcome; label: string };
type Opts = { note?: string; callbackNote?: string; when?: string };

export default function CallQueue({ board }: { board: CallsBoard }) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [openLead, setOpenLead] = useState<QueueLead | null>(null);
    const [infoLead, setInfoLead] = useState<QueueLead | null>(null);

    const [extraNew, setExtraNew] = useState<QueueLead[]>([]);
    const [cursor, setCursor] = useState(board.freshNextCursor);
    const [hasMore, setHasMore] = useState(board.freshHasMore);
    const [loadingMore, setLoadingMore] = useState(false);

    const [doneMap, setDone] = useOptimistic(
        {} as Record<string, Done>,
        (cur, u: { id: string; done: Done }) => ({ ...cur, [u.id]: u.done }),
    );

    useEffect(() => {
        const t = setInterval(() => router.refresh(), 60_000);
        return () => clearInterval(t);
    }, [router]);

 

    function handleOutcome(leadId: string, outcome: CallOutcome, label: string, opts?: Opts) {
        setError(null);
        setOpenLead(null);
        startTransition(async () => {
            setDone({ id: leadId, done: { outcome, label } });
            const r = await logCall({ leadId, outcome, ...opts });
            if (r?.error) setError(r.error);
        });
    }

    async function loadMore() {
        if (!cursor) return;
        setLoadingMore(true);
        const res = await getMoreNew(cursor);
        setExtraNew((p) => [...p, ...res.leads]);
        setCursor(res.nextCursor);
        setHasMore(res.hasMore);
        setLoadingMore(false);
    }

    const allNew = [...board.fresh, ...extraNew];
    const rowProps = { doneMap, onOpen: setOpenLead, onInfo: setInfoLead };

    return (
        <>
            {error && (
                <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
                    {error}
                </p>
            )}

            {/* MOBIL: stĺpec / TABLET+: dva stĺpce */}
            <div className="grid gap-6 lg:grid-cols-2">
                {/* ĽAVÝ STĹPEC – práca v behu */}
                <div className="space-y-6">
                    <Group
                        icon={<CalendarClock className="h-4 w-4" />}
                        title="Dohodnuté hovory"
                        hint="majú dohodnutý čas"
                        count={board.scheduled.length}
                        tone="urgent"
                        leads={board.scheduled}
                        empty="Žiadne dohodnuté hovory."
                        {...rowProps}
                    />
                    <Group
                        icon={<RotateCcw className="h-4 w-4" />}
                        title="Skúsiť znova"
                        hint="nedovolané"
                        count={board.retry.length}
                        tone="retry"
                        leads={board.retry}
                        empty="Nič na opakovanie."
                        {...rowProps}
                    />
                </div>

                {/* PRAVÝ STĹPEC – nové */}
                <div className="space-y-6">
                    <Group
                        icon={<Sparkles className="h-4 w-4" />}
                        title="Nové firmy"
                        hint="ešte nevolané"
                        count={allNew.length}
                        countSuffix={hasMore ? "+" : ""}
                        tone="fresh"
                        leads={allNew}
                        empty="Žiadne nové firmy vo fronte."
                        {...rowProps}
                    />
                    {hasMore && (
                        <Button variant="outline" className="w-full" onClick={loadMore} disabled={loadingMore}>
                            {loadingMore ? "Načítavam…" : "Načítať ďalšie"}
                        </Button>
                    )}
                </div>
            </div>

            <CallDrawer lead={openLead} onClose={() => setOpenLead(null)} onOutcome={handleOutcome} />
            <InfoDrawer lead={infoLead} onClose={() => setInfoLead(null)} />
        </>
    );
}

function Group({
    icon, title, hint, count, countSuffix = "", tone, leads, empty, doneMap, onOpen, onInfo,
}: {
    icon: React.ReactNode;
    title: string;
    hint: string;
    count: number;
    countSuffix?: string;
    tone: "urgent" | "retry" | "fresh";
    leads: QueueLead[];
    empty: string;
    doneMap: Record<string, Done>;
    onOpen: (l: QueueLead) => void;
    onInfo: (l: QueueLead) => void;
}) {
    const toneRing = tone === "urgent" ? "text-destructive" : tone === "retry" ? "text-amber-600" : "text-muted-foreground";
    return (
        <section>
            <header className="mb-2.5 flex items-baseline gap-2 ">
                <span className={toneRing}>{icon}</span>
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
                        <CallRow key={l.id} lead={l} tone={tone} done={doneMap[l.id]}
                            onOpen={() => onOpen(l)} onInfo={() => onInfo(l)} />
                    ))}
                </div>
            )}
        </section>
    );
}