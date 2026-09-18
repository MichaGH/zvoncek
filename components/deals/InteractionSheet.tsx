"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CallOutcome, DealRequestKind, LeadStatus, NextActionKind } from "@/app/generated/prisma/enums";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionError } from "@/lib/access/errors";
import { createDealRequest, logDealEmailSent, logFollowUp, setDealQuoteSent } from "@/lib/actions/deals";
import { ACTIVITY_LABEL, NEXT_ACTION_LABEL, OUTCOME_LABEL, REQUEST_KIND_LABEL, STATUS_LABEL } from "@/lib/dictionaries";
import { addBusinessCalendarDays, businessDate, businessDayMonth } from "@/lib/domain/businessTime";
import { CLIENT_REPLIES } from "@/lib/domain/clientReplies";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";
import { FOLLOW_UP_NEXT_KINDS, type FollowUpNextKind, type FollowUpOutcome } from "@/lib/domain/leadFlow";
import { NEXT_STEP_OPTIONS } from "@/lib/domain/nextStepOptions";
import type { Schedule } from "@/lib/domain/schedule";

// Akčné okno obchodu (round 2, D-04/D-05/D-11): jedna interakcia = kontakt → čo povedali → ďalší krok.
// Rieši to, že po nastavení ďalšieho kroku už nebolo vidno, či sa vôbec volalo: výsledok hovoru sa zapíše vždy,
// aj keď si používateľ zvolí iný krok než predvolený.
//
// Na telefóne je to drawer, na PC dialóg (ResponsiveSheet). Prvé hovory (telesales) majú vlastnú ponuku –
// tam je zdvihnutie implicitné, preto majú vlastný komponent CallDrawer.

export type InteractionTarget = {
    id: string;
    number: number;
    name: string;
    phone: string | null;
    status: LeadStatus;
    revision: number;
    noAnswerStreak?: number;
    lastActivity: { type: keyof typeof ACTIVITY_LABEL; outcome: CallOutcome | null; note: string | null; at: string } | null;
    openRequests: { id: string; kind: DealRequestKind }[];
};

type Step = "contact" | "reply" | "next" | "snooze" | "lost" | "sent" | "request";
type Contact = "ANSWERED" | "NO_ANSWER" | "REPLIED" | "NONE";

const CONTACT_LABEL: Record<Contact, string> = {
    ANSWERED: "Dovolal/a som sa",
    NO_ANSWER: "Nezdvihli",
    REPLIED: "Odpísali",
    NONE: "Bez kontaktu",
};

const REFRESH_CODES = new Set(["NOT_ASSIGNED", "NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "FORBIDDEN"]);
const REQUEST_KINDS: DealRequestKind[] = ["PRICE", "DESIGN", "EMAIL", "ORDER", "OTHER"];
const REQUEST_NOTE_REQUIRED: DealRequestKind[] = ["ORDER", "DESIGN", "OTHER"];
const REQUEST_PLACEHOLDER: Record<DealRequestKind, string> = {
    PRICE: "Čo treba naceniť?",
    DESIGN: "Čo má návrh obsahovať?",
    EMAIL: "S čím pomôcť v emaili?",
    ORDER: "Čo si objednávajú? (rozsah, doplnky, dohodnutá cena)",
    REOPEN: "Prečo znovu otvoriť?",
    OTHER: "Čo potrebuješ?",
};
const ORDER_CHIPS = ["stránka", "eshop", "katalóg", "admin systém", "EN jazyk"];
const NEXT_STEPS = NEXT_STEP_OPTIONS.filter((o) => (FOLLOW_UP_NEXT_KINDS as readonly string[]).includes(o.kind));

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Natívne polia; na PC otvorí kalendár aj klik do poľa (B-01).
function DateTimeInput({
    date,
    time,
    onDate,
    onTime,
    withTime = true,
}: {
    date: string;
    time: string;
    onDate: (v: string) => void;
    onTime: (v: string) => void;
    withTime?: boolean;
}) {
    const cls = "h-12 rounded-md border px-3 text-[16px] [color-scheme:light_dark]";
    const openPicker = (e: React.MouseEvent<HTMLInputElement>) => e.currentTarget.showPicker?.();
    return (
        <div className="flex gap-2">
            <input type="date" data-vaul-no-drag value={date} onChange={(e) => onDate(e.target.value)} onClick={openPicker} className={`${cls} flex-1`} />
            {withTime && (
                <input type="time" data-vaul-no-drag value={time} onChange={(e) => onTime(e.target.value)} onClick={openPicker} className={`${cls} w-28`} />
            )}
        </div>
    );
}

export default function InteractionSheet({
    target,
    caps,
    onClose,
}: {
    target: InteractionTarget | null;
    caps: DealCapabilities;
    onClose: () => void;
}) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [step, setStep] = useState<Step>("contact");
    const [contact, setContact] = useState<Contact>("ANSWERED");
    const [reply, setReply] = useState<string | null>(null);
    const [kind, setKind] = useState<FollowUpNextKind>("CALL");
    const [date, setDate] = useState("");
    const [time, setTime] = useState("");
    const [note, setNote] = useState("");
    const [reason, setReason] = useState("");
    const [requestKind, setRequestKind] = useState<DealRequestKind>("PRICE");
    const [requestNote, setRequestNote] = useState("");
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);

    if (!target) return null;
    const D = target;
    const closed = D.status === "WON" || D.status === "LOST" || D.status === "UNREACHABLE";
    const detailHref = `/dashboard/pipeline/${D.id}`;
    const stepOption = NEXT_STEPS.find((o) => o.kind === kind);
    const dateMissing = stepOption?.date === "required" && !date;

    function handle(r: { success: true } | ActionError, ok: string, retry?: () => void) {
        if (!("error" in r)) {
            toast.success(ok);
            onClose();
            router.refresh();
            return;
        }
        if (r.code && REFRESH_CODES.has(r.code)) {
            toast.error(r.code === "FORBIDDEN" || r.code === "UNAUTHENTICATED" ? r.error : "Obchod sa medzitým zmenil – obnovujem");
            setIdempotencyKey(newKey());
            onClose();
            router.refresh();
            return;
        }
        toast.error("Nepodarilo sa uložiť", {
            description: r.error,
            ...(retry ? { action: { label: "Skúsiť znova", onClick: retry } } : {}),
        });
    }

    function schedule(): Schedule | null {
        if (!date) return null;
        return time ? { kind: "dayTime", date, time } : { kind: "day", date };
    }

    function send(
        outcome: FollowUpOutcome,
        label: string,
        extra: { schedule?: Schedule | null; nextKind?: FollowUpNextKind; lostReason?: string; reply?: string | null } = {},
    ) {
        const run = () =>
            start(async () => {
                try {
                    const r = await logFollowUp({
                        leadId: D.id,
                        outcome,
                        expectedRevision: D.revision,
                        idempotencyKey,
                        note: note.trim() || null,
                        ...extra,
                    });
                    handle(r, `Zaznamenané: ${label}`, run);
                } catch {
                    toast.error("Chyba siete", { action: { label: "Skúsiť znova", onClick: run } });
                }
            });
        run();
    }

    // Uloženie z obrazovky „ďalší krok": výsledok hovoru sa zachová (nezdvihli ostane nezdvihli).
    function saveNextStep() {
        const outcome: FollowUpOutcome = contact === "NO_ANSWER" ? "NO_ANSWER" : "POSITIVE";
        send(outcome, `${CONTACT_LABEL[contact]} → ${NEXT_ACTION_LABEL[kind]}`, {
            nextKind: kind,
            schedule: schedule(),
            reply,
        });
    }

    function pickReply(key: string) {
        const option = CLIENT_REPLIES.find((r) => r.key === key);
        if (!option) return;
        setReply(key);
        if (option.terminal) {
            send(option.outcome, option.label, { reply: key });
            return;
        }
        if (option.nextKind) setKind(option.nextKind);
        setDate(option.days ? addBusinessCalendarDays(businessDate(new Date()), option.days) : "");
        setTime("");
        setStep("next");
    }

    function request(rk: DealRequestKind, text: string | null) {
        start(async () => {
            const r = await createDealRequest(D.id, rk, text);
            if (!("error" in r) && !r.created) {
                toast.success("Požiadavka už existuje – doplnená poznámka");
                onClose();
                router.refresh();
                return;
            }
            handle(r, "Požiadavka odoslaná manažérovi");
        });
    }

    const big = "h-12 w-full justify-start text-base";
    const canWork = caps.work;
    const noteMissing = REQUEST_NOTE_REQUIRED.includes(requestKind) && !requestNote.trim();

    const description = (
        <span className="space-x-2">
            {D.phone && (
                <a href={`tel:${D.phone.replace(/\s/g, "")}`} className="font-medium text-primary tabular-nums">
                    {D.phone}
                </a>
            )}
            {D.lastActivity && (
                <span>
                    · Naposledy:{" "}
                    {D.lastActivity.outcome ? OUTCOME_LABEL[D.lastActivity.outcome] : ACTIVITY_LABEL[D.lastActivity.type]}{" "}
                    {businessDayMonth(new Date(D.lastActivity.at))}
                    {D.noAnswerStreak && D.noAnswerStreak > 1 ? ` · ${D.noAnswerStreak}. pokus` : ""}
                </span>
            )}
            {D.openRequests.map((r) => (
                <span key={r.id}>· Požiadavka: {REQUEST_KIND_LABEL[r.kind]}</span>
            ))}
        </span>
    );

    return (
        <ResponsiveSheet
            open
            onOpenChange={(o) => !o && onClose()}
            title={
                <>
                    <span className="mr-2 text-sm font-normal text-muted-foreground">#{D.number}</span>
                    {D.name}
                </>
            }
            description={description}
        >
            <div className="mx-auto w-full max-w-md space-y-2 px-4 pb-6 md:max-w-none md:px-0 md:pb-0">
                {closed ? (
                    <>
                        <p className="rounded-lg border bg-muted/30 p-3 text-sm">
                            Obchod je uzavretý ({STATUS_LABEL[D.status]}).{" "}
                            {caps.manage ? "Znovu otvoriť sa dá v detaile." : "Úpravy robí manažér."}
                        </p>
                        {canWork && !caps.manage && (
                            <>
                                <Textarea
                                    data-vaul-no-drag
                                    placeholder="Prečo znovu otvoriť? (nepovinné)"
                                    value={requestNote}
                                    onChange={(e) => setRequestNote(e.target.value)}
                                    className="min-h-[60px] text-base"
                                />
                                <Button className="h-12 w-full" disabled={pending} onClick={() => request("REOPEN", requestNote.trim() || null)}>
                                    Požiadať o znovuotvorenie
                                </Button>
                            </>
                        )}
                        <Button asChild variant="ghost" className="w-full">
                            <Link href={detailHref}>História a detail →</Link>
                        </Button>
                    </>
                ) : (
                    <>
                        {step === "contact" && (
                            <>
                                <p className="px-1 pb-1 text-sm text-muted-foreground">Čo sa stalo?</p>
                                <Button
                                    variant="outline"
                                    className={big}
                                    disabled={pending || !canWork}
                                    onClick={() => {
                                        setContact("ANSWERED");
                                        setStep("reply");
                                    }}
                                >
                                    ✅ Dovolal/a som sa…
                                </Button>
                                <Button
                                    variant="outline"
                                    className={big}
                                    disabled={pending || !canWork}
                                    onClick={() => {
                                        setContact("NO_ANSWER");
                                        setReply(null);
                                        setKind("CALL");
                                        setDate("");
                                        setTime("");
                                        setStep("next");
                                    }}
                                >
                                    📵 Nezdvihli…
                                </Button>
                                <Button
                                    variant="outline"
                                    className={big}
                                    disabled={pending || !canWork}
                                    onClick={() => {
                                        setContact("REPLIED");
                                        setStep("reply");
                                    }}
                                >
                                    ✉️ Odpísali / ozvali sa…
                                </Button>
                                <Button
                                    variant="outline"
                                    className={big}
                                    disabled={pending || !canWork}
                                    onClick={() => {
                                        setContact("NONE");
                                        setReply(null);
                                        setStep("next");
                                    }}
                                >
                                    🗓️ Bez kontaktu – len naplánovať…
                                </Button>
                                <div className="my-2 h-px bg-border" />
                                <Button variant="outline" className={big} disabled={pending || !canWork} onClick={() => setStep("snooze")}>
                                    💤 Ozvať sa o pár mesiacov…
                                </Button>
                                <Button
                                    variant="destructive"
                                    className="h-12 w-full justify-start text-base"
                                    disabled={pending || !canWork}
                                    onClick={() => setStep("lost")}
                                >
                                    ✕ Nemajú záujem…
                                </Button>
                                <div className="my-2 h-px bg-border" />
                                <Button variant="ghost" className="w-full justify-start" disabled={pending || !canWork} onClick={() => setStep("sent")}>
                                    Označiť ako poslané…
                                </Button>
                                {caps.createRequests && (
                                    <Button variant="ghost" className="w-full justify-start" disabled={pending} onClick={() => setStep("request")}>
                                        Požiadať manažéra…
                                    </Button>
                                )}
                                <Button asChild variant="ghost" className="w-full justify-start">
                                    <Link href={detailHref}>Otvoriť detail →</Link>
                                </Button>
                            </>
                        )}

                        {step === "reply" && (
                            <>
                                <p className="px-1 pb-1 text-sm text-muted-foreground">Čo povedali?</p>
                                <div className="grid gap-2 md:grid-cols-2">
                                    {CLIENT_REPLIES.map((r) => (
                                        <Button
                                            key={r.key}
                                            variant="outline"
                                            className="h-12 justify-start text-base"
                                            disabled={pending}
                                            onClick={() => pickReply(r.key)}
                                        >
                                            {r.label}
                                        </Button>
                                    ))}
                                </div>
                                <Button
                                    variant="ghost"
                                    className="w-full justify-start"
                                    disabled={pending}
                                    onClick={() => {
                                        setReply(null);
                                        setStep("next");
                                    }}
                                >
                                    Iné – rovno vybrať ďalší krok…
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step === "next" && (
                            <>
                                <p className="px-1 pb-1 text-sm text-muted-foreground">
                                    {CONTACT_LABEL[contact]}
                                    {reply ? ` · ${CLIENT_REPLIES.find((r) => r.key === reply)?.label}` : ""} → aký je ďalší krok?
                                </p>
                                <div className="grid gap-2 md:grid-cols-2">
                                    {NEXT_STEPS.map((o) => (
                                        <Button
                                            key={o.kind}
                                            variant={kind === o.kind ? "default" : "outline"}
                                            className="h-12 justify-start text-base"
                                            disabled={pending}
                                            onClick={() => setKind(o.kind as FollowUpNextKind)}
                                        >
                                            {NEXT_ACTION_LABEL[o.kind as NextActionKind]}
                                        </Button>
                                    ))}
                                </div>
                                <DateTimeInput date={date} time={time} onDate={setDate} onTime={setTime} />
                                <p className="px-1 text-xs text-muted-foreground">
                                    {stepOption?.hint ??
                                        (stepOption?.date === "today"
                                            ? "Prázdny dátum = dnes."
                                            : "Dátum je nepovinný.")}
                                    {contact === "NO_ANSWER" && !date ? " Prázdny dátum pri „Zavolať“ = nasledujúci pracovný deň." : ""}
                                </p>
                                <Button className="h-12 w-full" disabled={pending || (dateMissing && contact !== "NO_ANSWER")} onClick={saveNextStep}>
                                    {dateMissing && contact !== "NO_ANSWER" ? "Vyber dátum" : "Uložiť"}
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep(contact === "ANSWERED" || contact === "REPLIED" ? "reply" : "contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step === "snooze" && (
                            <>
                                {[2, 4, 6].map((m) => (
                                    <Button
                                        key={m}
                                        variant="outline"
                                        className={big}
                                        disabled={pending}
                                        onClick={() => send("SNOOZE", `O ${m} mesiace`, { schedule: { kind: "monthsFromToday", months: m } })}
                                    >
                                        O {m} {m === 6 ? "mesiacov" : "mesiace"}
                                    </Button>
                                ))}
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <DateTimeInput date={date} time="" onDate={setDate} onTime={() => {}} withTime={false} />
                                    </div>
                                    <Button className="h-12" disabled={pending || !date} onClick={() => send("SNOOZE", "Vlastný termín", { schedule: { kind: "day", date } })}>
                                        OK
                                    </Button>
                                </div>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step === "lost" && (
                            <>
                                <Input data-vaul-no-drag placeholder="Dôvod (nepovinné)" value={reason} onChange={(e) => setReason(e.target.value)} className="text-base" />
                                <Button
                                    variant="destructive"
                                    className="h-12 w-full"
                                    disabled={pending}
                                    onClick={() => send("NOT_INTERESTED", "Nemajú záujem", { lostReason: reason.trim() || undefined })}
                                >
                                    Potvrdiť – nemajú záujem
                                </Button>
                                <Button variant="ghost" className="w-full text-muted-foreground" disabled={pending} onClick={() => send("BAD_NUMBER", "Zlé číslo")}>
                                    Zlé / nefunkčné číslo
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step === "sent" && (
                            <>
                                <Button
                                    variant="outline"
                                    className={big}
                                    disabled={pending}
                                    onClick={() => start(async () => handle(await setDealQuoteSent(D.id, true), "Cenová ponuka označená ako odoslaná"))}
                                >
                                    Cenová ponuka odoslaná
                                </Button>
                                <Button
                                    variant="outline"
                                    className={big}
                                    disabled={pending}
                                    onClick={() => start(async () => handle(await logDealEmailSent(D.id), "Email označený ako odoslaný"))}
                                >
                                    Email „O nás“ odoslaný
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step === "request" && (
                            <>
                                <div className="grid grid-cols-2 gap-2">
                                    {REQUEST_KINDS.map((k) => (
                                        <Button key={k} variant={requestKind === k ? "default" : "outline"} onClick={() => setRequestKind(k)}>
                                            {REQUEST_KIND_LABEL[k]}
                                        </Button>
                                    ))}
                                </div>
                                <Textarea
                                    data-vaul-no-drag
                                    placeholder={REQUEST_PLACEHOLDER[requestKind]}
                                    value={requestNote}
                                    onChange={(e) => setRequestNote(e.target.value)}
                                    className="min-h-[72px] text-base"
                                />
                                {requestKind === "ORDER" && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {ORDER_CHIPS.map((c) => (
                                            <Button
                                                key={c}
                                                size="sm"
                                                variant="outline"
                                                onClick={() => setRequestNote((v) => (v.trim() ? `${v.trim()}, ${c}` : c))}
                                            >
                                                + {c}
                                            </Button>
                                        ))}
                                    </div>
                                )}
                                <Button className="h-12 w-full" disabled={pending || noteMissing} onClick={() => request(requestKind, requestNote.trim() || null)}>
                                    {noteMissing ? "Najprv napíš, o čo ide" : "Odoslať požiadavku"}
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step !== "request" && (
                            <Textarea
                                data-vaul-no-drag
                                placeholder="Poznámka (uloží sa s výsledkom)"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                className="mt-1 min-h-[60px] text-base"
                            />
                        )}
                    </>
                )}
            </div>
        </ResponsiveSheet>
    );
}
