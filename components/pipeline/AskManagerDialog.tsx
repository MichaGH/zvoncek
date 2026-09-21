"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Euro, Lock, MessageSquare, Palette } from "lucide-react";
import type { DealTaskContent, DealTaskType, LeadStatus, NextActionKind, RequestContent } from "@/app/generated/prisma/enums";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { askManager } from "@/lib/actions/pipeline";
import { NEXT_ACTION_LABEL, TASK_CONTENT_LABEL } from "@/lib/dictionaries";
import { defaultStepNote } from "@/lib/domain/nextStepOptions";
import { choosableStepKinds, requiredStepKinds, stepAfterTask, TASK_TEXT_MAX, type PendingItem } from "@/lib/domain/tasks";
import type { FollowUpNextKind } from "@/lib/domain/leadFlow";
import { cn } from "@/lib/utils";

// „Požiadať manažéra" (HELP) a „Odovzdať manažérovi" (HANDOVER) – wave 3 §6.1, §6.8; wave 4 §2.9.
// - Obsah je viacnásobná voľba (cena · návrh · iné, ľubovoľná kombinácia): jedna úloha, jedna ČASŤ na druh.
//   Manažér ich dodáva po jednej – naraz sa to ani nedá (§2.1 bod 6).
// - Krok po vybavení sa nevyberá: cena → „Poslať cenu", návrh → „Poslať návrh", iné → ostáva aktuálny (dá sa zmeniť).
//   Kým úloha beží, krok je zamknutý; keď manažér dodá, krok sa odomkne na dnes.
// - Správa je len pre manažéra k tejto úlohe – nemení poznámku klienta ani poznámku ku kroku.
// - Manažér je predvolený (vedúci tímu / naposledy oslovený); „Zmeniť" ukáže výber.

export type AskTarget = {
    id: string;
    revision: number;
    name: string;
    status: LeadStatus;
    nextActionKind: NextActionKind | null;
    nextActionNote: string | null;
    pending: PendingItem[];
    // Wave 5 (§3.6): čo je nevybavené – predvolí cenu / návrh a drží krok rovnaký ako na serveri (§6.8).
    outstanding: RequestContent[];
};

type Person = { id: string; firstName: string; lastName: string; mine?: boolean };

const REFRESH_CODES = new Set(["NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "STEP_LOCKED"]);
const HANDOVER_CHIPS = ["stránka", "eshop", "katalóg", "admin systém", "EN jazyk", "technické detaily"];

// Cena aj návrh naraz (bez poradia), „Iné" – otvorená otázka (wave-4-proposal.md §2.3).
// Rovnaký farebný jazyk ako v akčnom okne (components/pipeline/InteractionSheet.tsx): zelená = peniaze,
// fialová = návrh, sivá = neutrálne. Farbu nesie len ikona, nie celá karta.
const CONTENT_TONE: Record<DealTaskContent, string> = {
    PRICE: "bg-emerald-600 text-white",
    DESIGN: "bg-violet-500 text-white",
    OTHER: "bg-slate-500 text-white dark:bg-slate-600",
};

const CONTENT_OPTIONS: { value: DealTaskContent; icon: typeof Euro; hint: string; placeholder: string }[] = [
    { value: "PRICE", icon: Euro, hint: "nacenenie", placeholder: "napr. e-shop, cca 200 produktov, SK + EN, termín do konca mesiaca" },
    { value: "DESIGN", icon: Palette, hint: "grafický návrh", placeholder: "napr. štýl ako ich súčasný web, logo pošlú mailom, 3 podstránky" },
    { value: "OTHER", icon: MessageSquare, hint: "otázka, rada", placeholder: "Na čo sa potrebuješ opýtať?" },
];

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function initials(p: Person) {
    return `${p.firstName.charAt(0)}${p.lastName.charAt(0)}`.toUpperCase();
}

function SectionLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
    return (
        <label htmlFor={htmlFor} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {children}
        </label>
    );
}

export default function AskManagerDialog({
    target,
    type,
    resolvers,
    onClose,
}: {
    target: AskTarget;
    type: DealTaskType;
    resolvers: Person[];
    onClose: () => void;
}) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const help = type === "HELP";
    const preferred = resolvers.find((r) => r.mine) ?? (resolvers.length === 1 ? resolvers[0] : null);

    // Predvolí sa to, čo klient pýta a ešte nedostal; inak (rep si to pýta sám) sa berie aktuálny krok.
    const [contents, setContents] = useState<DealTaskContent[]>(() => {
        const asked: DealTaskContent[] = [
            ...(target.outstanding.includes("DESIGN") ? (["DESIGN"] as const) : []),
            ...(target.outstanding.includes("PRICE") ? (["PRICE"] as const) : []),
        ];
        if (asked.length) return asked;
        if (target.nextActionKind === "SEND_DESIGN") return ["DESIGN"];
        if (target.nextActionKind === "SEND_QUOTE") return ["PRICE"];
        return [];
    });
    const [text, setText] = useState("");
    const [assigneeId, setAssigneeId] = useState(preferred?.id ?? "");
    const [pickAssignee, setPickAssignee] = useState(!preferred);
    // Len pri „Iné": obchodník zmenil krok (null = ostáva odvodený).
    const [changeStep, setChangeStep] = useState(false);
    const [kind, setKind] = useState<FollowUpNextKind | null>(null);
    const [stepNote, setStepNote] = useState<string | null>(null);
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);

    const current = { kind: target.nextActionKind, note: target.nextActionNote };
    const auto = contents.length ? stepAfterTask(contents, current, target.pending, defaultStepNote, target.outstanding) : null;
    const choosable = choosableStepKinds(target.pending);
    const customStep = Boolean(auto && !auto.fixed && changeStep && kind);
    const stepKind = customStep ? kind! : (auto?.kind ?? null);
    const stepNoteValue = customStep ? (stepNote ?? (kind === current.kind ? current.note : defaultStepNote(kind)) ?? "") : (auto?.note ?? "");
    const narrowed = requiredStepKinds(target.pending) !== null;
    const assignee = resolvers.find((r) => r.id === assigneeId) ?? null;
    const option = CONTENT_OPTIONS.find((o) => contents.includes(o.value));

    const missing = help && contents.length === 0
        ? "Vyber, čo potrebuješ"
        : !text.trim()
          ? help
              ? "Napíš správu pre manažéra"
              : "Napíš, prečo odovzdávaš"
          : !assignee
            ? "Vyber manažéra"
            : null;

    function save() {
        if (missing || !assignee) return;
        start(async () => {
            const r = await askManager({
                leadId: target.id,
                expectedRevision: target.revision,
                idempotencyKey,
                type,
                contents: help ? contents : [],
                text: text.trim(),
                assigneeId: assignee.id,
                // Krok posiela len zmena pri „Iné"; inak ho server odvodí rovnakým pravidlom.
                ...(help && customStep ? { step: { kind: kind!, note: stepNoteValue.trim() || null } } : {}),
            });
            if (!("error" in r)) {
                toast.success(help ? `Odoslané – ${assignee.firstName}` : `Odovzdané – ${assignee.firstName}`);
                onClose();
                router.refresh();
                return;
            }
            toast.error(r.error);
            if (r.code && REFRESH_CODES.has(r.code)) {
                setIdempotencyKey(newKey());
                onClose();
                router.refresh();
            }
        });
    }

    return (
        <ResponsiveSheet
            open
            onOpenChange={(o) => !o && onClose()}
            title={help ? "Požiadať manažéra" : "Odovzdať manažérovi"}
            description={target.name}
            contentClassName="sm:max-w-lg"
        >
            <div className="mx-auto w-full max-w-md space-y-5 px-4 pb-6 md:max-w-none md:px-0 md:pb-0">
                {help && (
                    <div className="space-y-2">
                        <SectionLabel>Čo potrebuješ</SectionLabel>
                        <div role="group" aria-label="Čo potrebuješ" className="grid grid-cols-3 gap-2">
                            {CONTENT_OPTIONS.map((o) => {
                                const on = contents.includes(o.value);
                                const Icon = o.icon;
                                return (
                                    <button
                                        key={o.value}
                                        type="button"
                                        role="checkbox"
                                        aria-checked={on}
                                        data-vaul-no-drag
                                        onClick={() => {
                                            setContents((v) => (on ? v.filter((c) => c !== o.value) : [...v, o.value]));
                                            setChangeStep(false);
                                            setKind(null);
                                            setStepNote(null);
                                        }}
                                        className={cn(
                                            "flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-sm transition-colors",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            on ? "border-primary bg-primary/5 font-medium text-foreground ring-1 ring-primary" : "hover:bg-muted/60",
                                        )}
                                    >
                                        <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg", CONTENT_TONE[o.value])}>
                                            <Icon className="h-[18px] w-[18px]" />
                                        </span>
                                        {TASK_CONTENT_LABEL[o.value]}
                                        <span className="text-[11px] font-normal text-muted-foreground">{o.hint}</span>
                                    </button>
                                );
                            })}
                        </div>
                        {contents.length > 1 && (
                            <p className="text-xs text-muted-foreground">
                                Jedna úloha, {contents.length} časti – {assignee?.firstName ?? "manažér"} ich môže odovzdať po jednej.
                            </p>
                        )}
                    </div>
                )}

                <div className="space-y-2">
                    <SectionLabel htmlFor="ask-text">{help ? "Správa pre manažéra" : "Čo chcú / prečo odovzdávaš"}</SectionLabel>
                    <Textarea
                        id="ask-text"
                        data-vaul-no-drag
                        value={text}
                        maxLength={TASK_TEXT_MAX}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={
                            help
                                ? (option?.placeholder ?? "Čo presne potrebuješ?")
                                : "napr. chce riešiť technické detaily, objednávajú eshop + EN jazyk"
                        }
                        className="min-h-[96px] text-[16px] md:text-sm"
                    />
                    {!help && (
                        <div className="flex flex-wrap gap-1.5">
                            {HANDOVER_CHIPS.map((c) => (
                                <Button
                                    key={c}
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-7 rounded-full px-3 text-xs"
                                    onClick={() => setText((v) => (v.trim() ? `${v.trim()}, ${c}` : c))}
                                >
                                    + {c}
                                </Button>
                            ))}
                        </div>
                    )}
                    <p className="text-xs text-muted-foreground">Vidí ju manažér pri úlohe. Poznámku klienta nemení.</p>
                </div>

                <div className="space-y-2">
                    <SectionLabel htmlFor="ask-assignee">Manažér</SectionLabel>
                    {!pickAssignee && assignee ? (
                        <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                                {initials(assignee)}
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                    {assignee.firstName} {assignee.lastName}
                                </p>
                                {assignee.mine && <p className="text-xs text-muted-foreground">tvoj manažér</p>}
                            </div>
                            {resolvers.length > 1 && (
                                <Button type="button" size="sm" variant="ghost" onClick={() => setPickAssignee(true)}>
                                    Zmeniť
                                </Button>
                            )}
                        </div>
                    ) : (
                        <select
                            id="ask-assignee"
                            data-vaul-no-drag
                            value={assigneeId}
                            onChange={(e) => setAssigneeId(e.target.value)}
                            className="h-11 w-full rounded-md border bg-background px-3 text-[16px] md:text-sm"
                        >
                            {!assignee && <option value="">— vyber manažéra —</option>}
                            {resolvers.map((r) => (
                                <option key={r.id} value={r.id}>
                                    {r.firstName} {r.lastName}
                                    {r.mine ? " (tvoj manažér)" : ""}
                                </option>
                            ))}
                        </select>
                    )}
                </div>

                {help ? (
                    auto && (
                        <div className="space-y-3 rounded-lg bg-muted/50 p-3">
                            <div className="flex items-start gap-3">
                                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1 text-sm">
                                    <p className="text-muted-foreground">Keď {assignee?.firstName ?? "manažér"} dodá, tvoj krok bude</p>
                                    <p className="font-medium">
                                        {NEXT_ACTION_LABEL[stepKind!]}
                                        {!customStep && stepNoteValue && stepNoteValue !== NEXT_ACTION_LABEL[stepKind!] && (
                                            <span className="font-normal text-muted-foreground"> · {stepNoteValue}</span>
                                        )}
                                    </p>
                                </div>
                                {!auto.fixed && !changeStep && choosable.length > 1 && (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => {
                                            setChangeStep(true);
                                            setKind(auto.kind);
                                        }}
                                    >
                                        Zmeniť
                                    </Button>
                                )}
                            </div>
                            {customStep && (
                                <div className="space-y-2 pl-7">
                                    <div className="flex flex-wrap gap-1.5">
                                        {choosable.map((k) => (
                                            <Button
                                                key={k}
                                                type="button"
                                                size="sm"
                                                variant={kind === k ? "default" : "outline"}
                                                className="h-8"
                                                onClick={() => {
                                                    setKind(k);
                                                    setStepNote(null);
                                                }}
                                            >
                                                {NEXT_ACTION_LABEL[k]}
                                            </Button>
                                        ))}
                                    </div>
                                    <Input
                                        data-vaul-no-drag
                                        value={stepNoteValue}
                                        maxLength={1000}
                                        onChange={(e) => setStepNote(e.target.value)}
                                        placeholder="Poznámka ku kroku (nepovinné)"
                                        className="text-[16px] md:text-sm"
                                    />
                                </div>
                            )}
                            {narrowed && (
                                <p className="pl-7 text-xs text-muted-foreground">
                                    Ešte neposlané:{" "}
                                    {target.pending
                                        .filter((i) => i.kind === "PRICE" || i.kind === "DESIGN")
                                        .map((i) => i.label)
                                        .join(", ")}{" "}
                                    – krok ostáva „Poslať…“.
                                </p>
                            )}
                            <p className="flex items-start gap-2 border-t pt-3 text-xs text-muted-foreground">
                                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                Dovtedy je krok zamknutý a obchod čaká v „Čakám na manažéra“. Kontakty s klientom zapisuješ ďalej.
                            </p>
                        </div>
                    )
                ) : (
                    <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        Tvoj krok{target.nextActionKind ? ` „${NEXT_ACTION_LABEL[target.nextActionKind]}“` : ""} ostáva a je zamknutý, kým manažér
                        nerozhodne. Ak klienta prevezme, obchod prejde k nemu a u teba ostane v Histórii.
                    </p>
                )}
                {target.status === "SNOOZED" && <p className="text-xs text-muted-foreground">Odložený obchod sa odoslaním zobudí.</p>}

                <div className="space-y-2">
                    <Button className="h-12 w-full text-base" disabled={pending || Boolean(missing)} onClick={save}>
                        {pending ? "Odosielam…" : help ? `Odoslať${assignee ? ` – ${assignee.firstName}` : ""}` : `Odovzdať${assignee ? ` – ${assignee.firstName}` : ""}`}
                    </Button>
                    {missing && <p className="text-center text-xs text-muted-foreground">{missing}</p>}
                </div>
            </div>
        </ResponsiveSheet>
    );
}
