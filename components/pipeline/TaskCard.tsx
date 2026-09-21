"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    ArrowRightLeft,
    CircleX,
    Euro,
    Handshake,
    Hourglass,
    Lock,
    MessageSquare,
    Palette,
    Plus,
    SendHorizontal,
} from "lucide-react";
import type { DealTaskContent } from "@/app/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { ActionError } from "@/lib/access/errors";
import {
    addTaskParts,
    declineHandover,
    dismissResults,
    reassignTask,
    resolveTaskParts,
    taskMessage,
    withdrawTaskParts,
} from "@/lib/actions/pipeline";
import { ACTIVITY_LABEL, NEXT_ACTION_LABEL, TASK_CONTENT_LABEL, TASK_STATUS_LABEL, TASK_TYPE_LABEL } from "@/lib/dictionaries";
import { BUSINESS_TZ, businessDayMonth } from "@/lib/domain/businessTime";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";
import { formatMoney } from "@/lib/domain/offers";
import { partMarkLabel, TASK_AGE_ALERT_DAYS, TASK_CONTENTS, type PartItemView, type PartView, type PendingItem } from "@/lib/domain/tasks";
import type { DealDetailData, DealTaskView } from "@/lib/queries/pipeline";
import { cn } from "@/lib/utils";

// Karta úlohy na detaile obchodu (wave 3 §7, wave 4 §2.9):
// 1. otvorená úloha – čo sa žiada PO ČASTIACH (cena / návrh / iné), vlákno správ, akcie (vlastník: pridať časť,
//    stiahnuť časť, zrušiť úlohu; manažér: hotovo, toto nerobím, presunúť);
// 2. „Od manažéra" – vrátené a ešte neposlané výsledky; každý sa rozhoduje zvlášť („Poslať klientovi…" /
//    „Neposielam" / „Beriem na vedomie"). Manažér ich vidí ako „čaká, kým to obchodník pošle";
// 3. história úloh zbalená, tiež po častiach.
// Tlačidlá sú len pomôcka – každý príkaz si právo overí sám pod zámkom Lead riadku.

type Person = { id: string; firstName: string; lastName: string };
const REFRESH_CODES = new Set(["NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "STEP_LOCKED"]);
const CLIENT_WANTS_YOU = "Klient chce riešiť detaily priamo s tebou";
const CONTENT_ICON: Record<DealTaskContent, typeof Euro> = { PRICE: Euro, DESIGN: Palette, OTHER: MessageSquare };

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fmt(iso: string) {
    return new Date(iso).toLocaleString("sk-SK", { timeZone: BUSINESS_TZ, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

function days(n: number) {
    return n === 1 ? "1 deň" : n >= 2 && n <= 4 ? `${n} dni` : `${n} dní`;
}

export function taskTitle(t: Pick<DealTaskView, "type" | "contents">) {
    return t.type === "HANDOVER" ? TASK_TYPE_LABEL.HANDOVER : t.contents.map((c) => TASK_CONTENT_LABEL[c]).join(" + ");
}

function TaskIcon({ task, className }: { task: Pick<DealTaskView, "type" | "contents">; className?: string }) {
    const Icon = task.type === "HANDOVER" ? Handshake : CONTENT_ICON[task.contents[0] ?? "OTHER"];
    return <Icon className={className} />;
}

function SectionLabel({ children }: { children: ReactNode }) {
    return <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;
}

// Značka časti: ○ robí sa · ◆ pripravené · ✓ poslané · ⊘ neposiela sa · ✗ nerobí sa · – stiahnuté. „Pripravené" a „poslané" sú
// zámerne rôzne znaky (wave 5 §3.7) a vedome neposlaná položka nikdy nedostane ✓ (R02-2).
const PART_GLYPH: Record<PartView["mark"], string> = {
    MAKING: "○",
    PREPARED: "◆",
    PARTLY_SENT: "✓",
    SENT: "✓",
    DISMISSED: "⊘",
    DECLINED: "✗",
    WITHDRAWN: "–",
};
const PART_TONE: Record<PartView["mark"], string> = {
    MAKING: "text-muted-foreground",
    PREPARED: "text-amber-600 dark:text-amber-400",
    PARTLY_SENT: "text-emerald-600 dark:text-emerald-400",
    SENT: "text-emerald-600 dark:text-emerald-400",
    DISMISSED: "text-muted-foreground",
    DECLINED: "text-destructive",
    WITHDRAWN: "text-muted-foreground",
};

function itemLine(i: PartItemView): string {
    const d = i.disposition;
    if (d.state === "SENT") return `poslané klientovi ${businessDayMonth(new Date(d.at))}`;
    if (d.state === "DISMISSED") return `neposlané${d.reason ? `: „${d.reason}“` : ""}`;
    return "čaká na odoslanie";
}

function PartRow({ part, actions }: { part: PartView; actions?: ReactNode }) {
    // Položky sa rozpíšu, až keď je o čom hovoriť: viac návrhov, alebo sa niečo vedome neposlalo (Q12).
    const detail = part.items.length > 1 || part.dismissedCount > 0;
    return (
        <li className="space-y-1.5 p-3">
            <div className="flex items-start gap-3">
                <span className={cn("mt-0.5 w-4 shrink-0 text-center", PART_TONE[part.mark])}>{PART_GLYPH[part.mark]}</span>
                <div className="min-w-0 flex-1">
                    <p>
                        <span className="font-medium">{TASK_CONTENT_LABEL[part.kind]}</span>
                        <span className="ml-2 text-muted-foreground">{partMarkLabel(part)}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {part.resolvedBy ? `${part.resolvedBy.firstName} · ` : ""}
                        {part.resolvedAt ? businessDayMonth(new Date(part.resolvedAt)) : `zadané ${businessDayMonth(new Date(part.addedAt))}`}
                    </p>
                    {/* R02-1: odpoveď na otázku / konzultáciu ostáva viditeľná, kým ju obchodník používa v kontakte s klientom. */}
                    {part.kind === "OTHER" &&
                        part.items.map((i) =>
                            i.text ? (
                                <p key={`answer:${i.kind}`} className="mt-1 whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 text-sm">
                                    {i.text}
                                </p>
                            ) : null,
                        )}
                    {detail && (
                        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                            {part.items.map((i) => (
                                <li key={`${i.kind}:${i.designId ?? i.part ?? ""}`}>
                                    {i.label} — {itemLine(i)}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {actions}
            </div>
        </li>
    );
}

export default function TaskCard({
    lead,
    caps,
    viewerId,
    resolvers,
    onAsk,
    onCancel,
    onFinish,
    onTakeover,
    onSend,
}: {
    lead: DealDetailData;
    caps: DealCapabilities;
    viewerId: string;
    resolvers: Person[];
    onAsk: (type: "HELP" | "HANDOVER") => void;
    onCancel: () => void;
    onFinish: (task: DealTaskView, send: boolean) => void;
    onTakeover: () => void;
    // „Poslať klientovi…" – otvorí „Poslali sme ponuku" s predvyplnenými vrátenými výsledkami.
    onSend?: () => void;
}) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [message, setMessage] = useState("");
    const [msgKey, setMsgKey] = useState(newKey);
    const [resolving, setResolving] = useState<DealTaskContent | "ALL" | "HANDOVER" | null>(null);
    const [resolveReason, setResolveReason] = useState("");
    const [reassigning, setReassigning] = useState(false);
    const [reassignTo, setReassignTo] = useState("");
    const [adding, setAdding] = useState(false);
    const [addKinds, setAddKinds] = useState<DealTaskContent[]>([]);
    const [addMessage, setAddMessage] = useState("");
    const [dismissing, setDismissing] = useState<string | null>(null);
    const [dismissReason, setDismissReason] = useState("");
    const [actionKey, setActionKey] = useState(newKey);

    const open = lead.tasks.find((t) => t.status === "OPEN") ?? null;
    const closed = lead.tasks.filter((t) => t.status !== "OPEN");
    const isOwner = lead.owner?.id === viewerId;
    const isOpenDeal = lead.status === "ACTIVE" || lead.status === "SNOOZED";
    // Rozhoduje vlastník; na obchode bez vlastníka manažér (§5.2).
    const decides = isOpenDeal && caps.work && (isOwner || (lead.owner === null && caps.manage));
    const canAsk = caps.askManager && isOwner && isOpenDeal && !open;
    const canWrite = caps.work && (isOwner || caps.manage);
    const reassignTargets = open ? resolvers.filter((r) => r.id !== open.assignee.id && r.id !== lead.owner?.id) : [];
    const sendable = lead.pending.some((i) => i.kind === "PRICE" || i.kind === "DESIGN");
    const openParts = open?.parts.filter((p) => p.status === "REQUESTED") ?? [];
    // Druh sa dá (znova) vyžiadať, kým nie je v hre: dodaný ani zamietnutý sa v tej istej úlohe už nepýta (§2.3).
    const addable = open
        ? TASK_CONTENTS.filter((k) => {
              const part = open.parts.find((p) => p.kind === k);
              return !part || part.status === "WITHDRAWN";
          })
        : [];

    if (!open && lead.pending.length === 0 && closed.length === 0 && !canAsk) return null;

    function handle(r: { success: true } | ActionError, ok: string, onDone?: () => void) {
        if (!("error" in r)) {
            toast.success(ok);
            setActionKey(newKey());
            onDone?.();
            router.refresh();
            return;
        }
        toast.error(r.error);
        if (r.code && REFRESH_CODES.has(r.code)) {
            setActionKey(newKey());
            router.refresh();
        }
    }

    function sendMessage(text: string) {
        if (!open || !text.trim()) return;
        start(async () => {
            const r = await taskMessage({ taskId: open.id, expectedRevision: lead.revision, idempotencyKey: msgKey, text: text.trim() });
            // Pri chybe ostáva napísaný text v poli (obnoví sa len obsah stránky).
            if (!("error" in r)) setMessage("");
            if (!("error" in r) || (r.code && REFRESH_CODES.has(r.code))) setMsgKey(newKey());
            handle(r, "Správa odoslaná");
        });
    }

    // Manažér: „Toto nerobím" pre jednu časť, „Zamietnuť" pre všetko, čo ešte má.
    function decline(kinds: DealTaskContent[], reason: string) {
        if (!open) return;
        start(async () => {
            const r = await resolveTaskParts({
                taskId: open.id,
                expectedRevision: lead.revision,
                idempotencyKey: actionKey,
                parts: kinds.map((kind) => ({ kind, op: "DECLINE" as const, reason })),
            });
            handle(r, kinds.length === openParts.length ? "Zamietnuté – krok je odomknutý" : "Zapísané – zvyšok úlohy beží ďalej", () => {
                setResolving(null);
                setResolveReason("");
            });
        });
    }

    // Manažér neprijme odovzdanie klienta – klient ostáva u obchodníka a krok sa odomkne.
    function refuseHandover(reason: string) {
        if (!open) return;
        start(async () => {
            const r = await declineHandover({ taskId: open.id, expectedRevision: lead.revision, idempotencyKey: actionKey, reason });
            handle(r, "Odovzdanie neprijaté – krok je odomknutý", () => {
                setResolving(null);
                setResolveReason("");
            });
        });
    }

    // Vlastník: „Už netreba" pre jednu časť, „Zrušiť úlohu" pre všetko, čo sa ešte robí.
    function withdraw(kinds: DealTaskContent[], reason: string) {
        if (!open) return;
        start(async () => {
            const r = await withdrawTaskParts({ taskId: open.id, expectedRevision: lead.revision, idempotencyKey: actionKey, kinds, reason });
            handle(r, kinds.length === openParts.length ? "Úloha zrušená" : "Stiahnuté – zvyšok úlohy beží ďalej", () => {
                setResolving(null);
                setResolveReason("");
            });
        });
    }

    function addParts() {
        if (!open || addKinds.length === 0 || !addMessage.trim()) return;
        start(async () => {
            const r = await addTaskParts({
                taskId: open.id,
                expectedRevision: lead.revision,
                idempotencyKey: actionKey,
                kinds: addKinds,
                message: addMessage.trim(),
            });
            handle(r, "Pridané k úlohe", () => {
                setAdding(false);
                setAddKinds([]);
                setAddMessage("");
            });
        });
    }

    function dismiss(item: PendingItem, reason: string | null) {
        start(async () => {
            const r = await dismissResults({
                leadId: lead.id,
                expectedRevision: lead.revision,
                idempotencyKey: actionKey,
                taskId: item.taskId,
                items: [{ kind: item.kind, ...(item.designId ? { designId: item.designId } : {}), ...(item.part ? { part: item.part } : {}) }],
                reason,
            });
            handle(r, item.kind === "PRICE" || item.kind === "DESIGN" ? "Zapísané – neposiela sa" : "Zobraté na vedomie", () => {
                setDismissing(null);
                setDismissReason("");
            });
        });
    }

    const itemKeyOf = (i: PendingItem) => `${i.taskId}:${i.kind}:${i.designId ?? i.part ?? ""}`;
    const thread = open ? open.events.filter((e) => e.type !== "TASK_CREATED") : [];
    const resolveIsMine = caps.resolver && !isOwner;

    return (
        <Card className={open ? "border-amber-500/60" : undefined}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                    {open && <Lock className="h-4 w-4 text-amber-600" />}
                    Úloha pre manažéra
                </CardTitle>
                {open ? (
                    <Badge variant="outline" className="border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                        <Hourglass className="mr-1 h-3 w-3" />
                        čaká na manažéra · {open.assignee.firstName}
                    </Badge>
                ) : (
                    canAsk && (
                        <div className="flex flex-wrap gap-2">
                            <Button size="sm" onClick={() => onAsk("HELP")}>
                                Požiadať manažéra…
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => onAsk("HANDOVER")}>
                                Odovzdať manažérovi…
                            </Button>
                        </div>
                    )
                )}
            </CardHeader>
            <CardContent className="space-y-5 text-sm">
                {open && (
                    <div className="overflow-hidden rounded-lg border">
                        {/* Čo sa žiada */}
                        <div className="space-y-3 p-4">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="flex items-center gap-1.5 font-medium">
                                    <TaskIcon task={open} className="h-4 w-4 text-muted-foreground" />
                                    {taskTitle(open)}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {open.requestedBy.firstName} → {open.assignee.firstName} · {businessDayMonth(new Date(open.createdAt))} ·{" "}
                                    <span className={cn(open.ageDays >= TASK_AGE_ALERT_DAYS && "font-medium text-destructive")}>
                                        {open.ageDays === 0 ? "zadané dnes" : `čaká ${days(open.ageDays)}`}
                                    </span>
                                </span>
                            </div>
                            <p className="whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2">{open.text}</p>
                            <p className="flex items-start gap-2 text-xs text-muted-foreground">
                                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>
                                    {lead.nextActionKind ? (
                                        <>
                                            Po vybavení: <span className="font-medium text-foreground">{NEXT_ACTION_LABEL[lead.nextActionKind]}</span>.{" "}
                                        </>
                                    ) : null}
                                    Dovtedy je krok zamknutý; kontakty s klientom sa zapisujú ďalej.
                                </span>
                            </p>
                        </div>

                        {/* Časti úlohy – každá má vlastný osud (§2.3) */}
                        {open.parts.length > 0 && (
                            <ul className="divide-y border-t">
                                {open.parts.map((part) => (
                                    <PartRow
                                        key={part.kind}
                                        part={part}
                                        actions={
                                            part.status === "REQUESTED" && (resolveIsMine || isOwner) && resolving !== part.kind ? (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-8 shrink-0 text-muted-foreground"
                                                    onClick={() => {
                                                        setResolving(part.kind);
                                                        setResolveReason("");
                                                    }}
                                                >
                                                    {resolveIsMine ? "Toto nerobím…" : "Už netreba…"}
                                                </Button>
                                            ) : undefined
                                        }
                                    />
                                ))}
                            </ul>
                        )}

                        {resolving && (
                            <div className="flex flex-col gap-2 border-t bg-muted/20 p-3 sm:flex-row">
                                <Input
                                    autoFocus
                                    value={resolveReason}
                                    maxLength={500}
                                    onChange={(e) => setResolveReason(e.target.value)}
                                    placeholder={resolving === "HANDOVER" || resolveIsMine ? "Dôvod (uvidí obchodník)" : "Prečo to už netreba"}
                                />
                                <Button
                                    size="sm"
                                    variant="destructive"
                                    className="h-9"
                                    disabled={pending || !resolveReason.trim()}
                                    onClick={() => {
                                        if (resolving === "HANDOVER") return refuseHandover(resolveReason.trim());
                                        const kinds = resolving === "ALL" ? openParts.map((p) => p.kind) : [resolving];
                                        if (resolveIsMine) decline(kinds, resolveReason.trim());
                                        else withdraw(kinds, resolveReason.trim());
                                    }}
                                >
                                    {resolving === "HANDOVER" ? "Nepreberám" : resolving === "ALL" ? (resolveIsMine ? "Zamietnuť všetko" : "Zrušiť úlohu") : "Potvrdiť"}
                                </Button>
                                <Button size="sm" variant="ghost" className="h-9" onClick={() => setResolving(null)}>
                                    Späť
                                </Button>
                            </div>
                        )}

                        {/* Vlákno správ */}
                        {(thread.length > 0 || canWrite) && (
                            <div className="space-y-3 border-t bg-muted/20 p-4">
                                {thread.length > 0 && (
                                    <ul className="space-y-2.5">
                                        {thread.map((e) => (
                                            <li key={e.id} className={cn("flex", e.userId === viewerId ? "justify-end" : "justify-start")}>
                                                <div
                                                    className={cn(
                                                        "max-w-[85%] rounded-lg px-3 py-2",
                                                        e.userId === viewerId ? "bg-primary/10" : "border bg-background",
                                                    )}
                                                >
                                                    <p className="text-xs text-muted-foreground">
                                                        <span className="font-medium text-foreground">{e.userName}</span>
                                                        {e.type !== "TASK_MESSAGE" && ` · ${ACTIVITY_LABEL[e.type]}`} · {fmt(e.createdAt)}
                                                    </p>
                                                    <p className="whitespace-pre-wrap">{e.note}</p>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {canWrite && (
                                    <div className="space-y-1.5">
                                        <form
                                            className="flex gap-2"
                                            onSubmit={(e) => {
                                                e.preventDefault();
                                                sendMessage(message);
                                            }}
                                        >
                                            <Input
                                                value={message}
                                                maxLength={2000}
                                                onChange={(e) => setMessage(e.target.value)}
                                                placeholder="Napíš správu…"
                                                className="bg-background"
                                            />
                                            <Button type="submit" size="icon" variant="outline" disabled={pending || !message.trim()} aria-label="Odoslať správu">
                                                <SendHorizontal className="h-4 w-4" />
                                            </Button>
                                        </form>
                                        <p className="text-xs text-muted-foreground">
                                            Interná správa k úlohe – nie je to kontakt s klientom.
                                            {isOwner && (
                                                <button
                                                    type="button"
                                                    className="ml-2 underline-offset-2 hover:text-foreground hover:underline"
                                                    onClick={() => setMessage(CLIENT_WANTS_YOU)}
                                                >
                                                    + {CLIENT_WANTS_YOU}
                                                </button>
                                            )}
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Pridanie časti – vlastník si počas behu uvedomí, že treba aj niečo ďalšie (§2.1 bod 9) */}
                        {adding && (
                            <div className="space-y-3 border-t p-4">
                                <p className="text-xs text-muted-foreground">Pribudne k tej istej úlohe – {open.assignee.firstName} uvidí, prečo.</p>
                                <div className="flex flex-wrap gap-3">
                                    {addable.map((k) => (
                                        <label key={k} className="flex items-center gap-2 text-sm">
                                            <Checkbox
                                                checked={addKinds.includes(k)}
                                                onCheckedChange={(v) => setAddKinds((ids) => (v === true ? [...ids, k] : ids.filter((x) => x !== k)))}
                                            />
                                            {TASK_CONTENT_LABEL[k]}
                                        </label>
                                    ))}
                                </div>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                    <Input
                                        autoFocus
                                        value={addMessage}
                                        maxLength={2000}
                                        onChange={(e) => setAddMessage(e.target.value)}
                                        placeholder="Napíš, čo pribudlo (napr. klient volal, chce aj návrh)"
                                    />
                                    <Button size="sm" className="h-9" disabled={pending || addKinds.length === 0 || !addMessage.trim()} onClick={addParts}>
                                        Pridať
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-9" onClick={() => setAdding(false)}>
                                        Späť
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/* Akcie */}
                        {(caps.resolver || (isOwner && caps.askManager)) && !resolving && !adding && (
                            <div className="space-y-3 border-t p-4">
                                {!reassigning && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        {caps.resolver && open.type === "HELP" && openParts.length > 0 && (
                                            <>
                                                <Button size="sm" onClick={() => onFinish(open, false)}>
                                                    Hotovo…
                                                </Button>
                                                {openParts.some((p) => p.kind === "PRICE" || p.kind === "DESIGN") && (
                                                    <Button size="sm" variant="outline" onClick={() => onFinish(open, true)}>
                                                        Poslal som to sám…
                                                    </Button>
                                                )}
                                            </>
                                        )}
                                        {caps.resolver && open.type === "HANDOVER" && (
                                            <Button size="sm" onClick={onTakeover}>
                                                Preberám klienta…
                                            </Button>
                                        )}
                                        {caps.resolver && reassignTargets.length > 0 && (
                                            <Button size="sm" variant="ghost" onClick={() => setReassigning(true)}>
                                                <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
                                                Presunúť…
                                            </Button>
                                        )}
                                        {resolveIsMine && open.type === "HANDOVER" && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="text-destructive hover:text-destructive"
                                                onClick={() => {
                                                    setResolving("HANDOVER");
                                                    setResolveReason("");
                                                }}
                                            >
                                                Nie, pokračuj ty…
                                            </Button>
                                        )}
                                        {resolveIsMine && open.type === "HELP" && openParts.length > 1 && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="text-destructive hover:text-destructive"
                                                onClick={() => {
                                                    setResolving("ALL");
                                                    setResolveReason("");
                                                }}
                                            >
                                                Zamietnuť všetko…
                                            </Button>
                                        )}
                                        {isOwner && caps.askManager && addable.length > 0 && (
                                            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                                                <Plus className="mr-1.5 h-3.5 w-3.5" />
                                                Pridať
                                            </Button>
                                        )}
                                        {isOwner && caps.askManager && (
                                            <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
                                                Zrušiť úlohu…
                                            </Button>
                                        )}
                                    </div>
                                )}

                                {caps.resolver && reassigning && (
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                        <select
                                            autoFocus
                                            value={reassignTo}
                                            onChange={(e) => setReassignTo(e.target.value)}
                                            className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
                                        >
                                            <option value="">— presunúť na manažéra —</option>
                                            {reassignTargets.map((r) => (
                                                <option key={r.id} value={r.id}>
                                                    {r.firstName} {r.lastName}
                                                </option>
                                            ))}
                                        </select>
                                        <Button
                                            size="sm"
                                            className="h-9"
                                            disabled={pending || !reassignTo}
                                            onClick={() =>
                                                start(async () => {
                                                    const r = await reassignTask({
                                                        taskId: open.id,
                                                        expectedRevision: lead.revision,
                                                        idempotencyKey: actionKey,
                                                        assigneeId: reassignTo,
                                                    });
                                                    handle(r, "Úloha presunutá", () => {
                                                        setReassignTo("");
                                                        setReassigning(false);
                                                    });
                                                })
                                            }
                                        >
                                            Presunúť
                                        </Button>
                                        <Button size="sm" variant="ghost" className="h-9" onClick={() => setReassigning(false)}>
                                            Späť
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {lead.pending.length > 0 && (
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <SectionLabel>{decides ? "Od manažéra – ešte neposlané klientovi" : "Vrátené obchodníkovi – ešte neposlané klientovi"}</SectionLabel>
                            {decides && sendable && onSend && (
                                <Button size="sm" onClick={onSend}>
                                    <SendHorizontal className="mr-1.5 h-3.5 w-3.5" />
                                    Poslať klientovi…
                                </Button>
                            )}
                        </div>
                        <ul className="divide-y rounded-lg border">
                            {lead.pending.map((item) => {
                                const k = itemKeyOf(item);
                                const needsReason = item.kind === "PRICE" || item.kind === "DESIGN";
                                const Icon = item.kind === "PRICE" ? Euro : item.kind === "DESIGN" ? Palette : item.kind === "DECLINED" ? CircleX : MessageSquare;
                                return (
                                    <li key={k} className="space-y-2 p-3">
                                        <div className="flex items-start gap-3">
                                            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", item.kind === "DECLINED" ? "text-destructive" : "text-muted-foreground")} />
                                            <div className="min-w-0 flex-1 space-y-1">
                                                <p>
                                                    <span className="font-medium">
                                                        {item.kind === "PRICE" && item.price
                                                            ? `Cena ${formatMoney(item.price.amount)}`
                                                            : item.kind === "DESIGN"
                                                              ? `Návrh ${item.design?.label ?? ""}`.trim()
                                                              : item.kind === "DECLINED"
                                                                ? `Manažér nerobí: ${item.part ? TASK_CONTENT_LABEL[item.part].toLowerCase() : "úlohu"}`
                                                                : "Odpoveď manažéra"}
                                                    </span>
                                                    <span className="ml-2 text-xs text-muted-foreground">
                                                        {item.by?.firstName ?? "manažér"}
                                                        {item.closedAt ? ` · ${businessDayMonth(new Date(item.closedAt))}` : ""}
                                                    </span>
                                                </p>
                                                {item.price?.note && <p className="whitespace-pre-wrap text-muted-foreground">{item.price.note}</p>}
                                                {item.text && <p className="whitespace-pre-wrap">„{item.text}“</p>}
                                            </div>
                                            {decides && dismissing !== k && (
                                                <div className="flex shrink-0 gap-1">
                                                    {needsReason ? (
                                                        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={() => setDismissing(k)}>
                                                            Neposielam…
                                                        </Button>
                                                    ) : (
                                                        <Button size="sm" variant="outline" className="h-8" disabled={pending} onClick={() => dismiss(item, null)}>
                                                            Beriem na vedomie
                                                        </Button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        {decides && dismissing === k && (
                                            <div className="flex flex-col gap-2 pl-7 sm:flex-row">
                                                <Input
                                                    autoFocus
                                                    value={dismissReason}
                                                    maxLength={500}
                                                    onChange={(e) => setDismissReason(e.target.value)}
                                                    placeholder="Prečo sa neposiela (napr. klient už nechce)"
                                                />
                                                <Button
                                                    size="sm"
                                                    variant="destructive"
                                                    className="h-9"
                                                    disabled={pending || !dismissReason.trim()}
                                                    onClick={() => dismiss(item, dismissReason.trim())}
                                                >
                                                    Neposielam
                                                </Button>
                                                <Button size="sm" variant="ghost" className="h-9" onClick={() => setDismissing(null)}>
                                                    Späť
                                                </Button>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                        {decides && sendable && (
                            <p className="text-xs text-muted-foreground">Kým cenu / návrh nepošleš alebo neodmietneš, krok ostáva „Poslať…“.</p>
                        )}
                    </div>
                )}

                {closed.length > 0 && (
                    <details className="group rounded-lg border">
                        <summary className="cursor-pointer list-none px-3 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
                            <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
                            História úloh ({closed.length})
                        </summary>
                        <ul className="divide-y border-t">
                            {closed.map((t) => (
                                <li key={t.id} className="space-y-1 p-3">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                        <span className="flex items-center gap-1.5 font-medium">
                                            <TaskIcon task={t} className="h-3.5 w-3.5 text-muted-foreground" />
                                            {taskTitle(t)}
                                        </span>
                                        <Badge variant={t.status === "DONE" ? "secondary" : "outline"} className="font-normal">
                                            {TASK_STATUS_LABEL[t.status]}
                                        </Badge>
                                        <span className="text-xs text-muted-foreground">
                                            {t.requestedBy.firstName} → {t.assignee.firstName} · {businessDayMonth(new Date(t.createdAt))}
                                            {t.closedAt ? ` – ${businessDayMonth(new Date(t.closedAt))}` : ""}
                                            {t.closedBy ? ` (${t.closedBy.firstName})` : ""}
                                        </span>
                                    </div>
                                    <p className="whitespace-pre-wrap text-muted-foreground">{t.text}</p>
                                    {t.parts.length > 0 && (
                                        <ul className="divide-y rounded-md border">
                                            {t.parts.map((part) => (
                                                <PartRow key={part.kind} part={part} />
                                            ))}
                                        </ul>
                                    )}
                                    {t.closeReason && <p className="text-muted-foreground">Dôvod: {t.closeReason}</p>}
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
            </CardContent>
        </Card>
    );
}
