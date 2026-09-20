"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import type { CallOutcome, DealTaskContent, DealTaskType, LeadStatus, NextActionKind, RequestContent } from "@/app/generated/prisma/enums";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionError } from "@/lib/access/errors";
import { logFollowUp } from "@/lib/actions/pipeline";
import { ACTIVITY_LABEL, NEXT_ACTION_LABEL, OUTCOME_LABEL, STATUS_LABEL, TASK_CONTENT_LABEL } from "@/lib/dictionaries";
import { addBusinessCalendarDays, businessDate, businessDayMonth } from "@/lib/domain/businessTime";
import { CLIENT_REPLIES } from "@/lib/domain/clientReplies";
import { REQUEST_CONTENT_LABEL, REQUEST_CONTENTS } from "@/lib/domain/clientRequests";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";
import { FOLLOW_UP_NEXT_KINDS, type FollowUpNextKind, type FollowUpOutcome } from "@/lib/domain/leadFlow";
import { defaultStepNote, NEXT_STEP_OPTIONS } from "@/lib/domain/nextStepOptions";
import { formatMoney, moneyToString } from "@/lib/domain/offers";
import type { Schedule } from "@/lib/domain/schedule";
import { pendingSummary, requiredStepKinds, type PendingItem } from "@/lib/domain/tasks";

// Akčné okno obchodu (round 2, D-04/D-05/D-11): jedna interakcia = kontakt → čo povedali → ďalší krok.
// Rieši to, že po nastavení ďalšieho kroku už nebolo vidno, či sa vôbec volalo: výsledok hovoru sa zapíše vždy,
// aj keď si používateľ zvolí iný krok než predvolený.
//
// Do histórie ide to, čo sa naozaj stalo (round 2 §2c 9a.3): hovor = CALL, odpísali = CLIENT_REPLIED, SMS = SMS_SENT,
// „bez kontaktu" = len zmena kroku. „Poslali sme ponuku" otvára dialóg „Čo sme poslali" na mieste.
//
// Wave 3: kým čaká úloha pre manažéra, krok je zamknutý – kontakt sa zapíše ako fakt (krok sa nemení); uspať,
// uzavrieť alebo preplánovať sa dá, len ak sa v tom istom uložení úloha zruší (s dôvodom). Dve poznámky (F1):
// „Čo povedali" ide do histórie kontaktu, „Poznámka ku kroku" len do kroku.
//
// Wave 5: „Chcú aj …" zapíše, čo klient v tomto kontakte pýtal – každé zaškrtnutie je nová požiadavka, aj keď to
// isté už raz dostal (§3.5). V hlavičke je vidno, ktorú cenu klient naozaj videl (§3.3), aby sa rep vedel rozhodnúť,
// čo ešte môže povedať.
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
    ownerId: string | null;
    noAnswerStreak?: number;
    price: number | null;
    priceNote?: string | null;
    nextActionKind: NextActionKind | null;
    nextActionNote: string | null;
    lastOffer?: { text: string; at: string } | null;
    lastActivity: { type: keyof typeof ACTIVITY_LABEL; outcome: CallOutcome | null; note: string | null; at: string } | null;
    task: { id: string; type: DealTaskType; contents: DealTaskContent[]; assignee: string } | null;
    pending: PendingItem[];
    // Wave 5: ktorú cenu klient naozaj videl (§3.3) a či videl aspoň cenník.
    clientPrice?: { amount: string; channel: "EMAIL" | "PHONE"; sentOn: string } | null;
    gotPricelist?: boolean;
};

type Step = "contact" | "reply" | "next" | "snooze" | "lost" | "sms";
type Contact = "ANSWERED" | "NO_ANSWER" | "REPLIED" | "SMS" | "NONE";

const CONTACT_LABEL: Record<Contact, string> = {
    ANSWERED: "Dovolal/a som sa",
    NO_ANSWER: "Nezdvihli",
    REPLIED: "Odpísali",
    SMS: "Poslali sme SMS",
    NONE: "Bez kontaktu",
};

// Druh kontaktu pre server – hovor (aj nezdvihli) je CALL.
const CONTACT_KIND: Record<Contact, "CALL" | "REPLIED" | "SMS" | "NONE"> = {
    ANSWERED: "CALL",
    NO_ANSWER: "CALL",
    REPLIED: "REPLIED",
    SMS: "SMS",
    NONE: "NONE",
};

const REFRESH_CODES = new Set([
    "NOT_ASSIGNED",
    "NOT_FOUND",
    "STALE",
    "DEAL_CLOSED",
    "IDEMPOTENCY_CONFLICT",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "STEP_LOCKED",
]);
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

const itemRef = (i: PendingItem) => ({ taskId: i.taskId, kind: i.kind, ...(i.designId ? { designId: i.designId } : {}) });

export default function InteractionSheet({
    target,
    caps,
    viewerId,
    onClose,
    onRecordOffer,
    onAsk,
    replan,
}: {
    target: InteractionTarget | null;
    caps: DealCapabilities;
    viewerId: string;
    onClose: () => void;
    // „Zmeniť krok" v detaile: rovno obrazovka ďalšieho kroku, predvyplnená, ako „bez kontaktu – len naplánovať".
    // `cancel` = „Zrušiť úlohu" – to isté okno, uloženie zruší otvorenú úlohu (dôvod povinný).
    replan?: { kind: FollowUpNextKind; date: string; time: string; note: string; cancel?: boolean };
    // Otvorí dialóg „Čo sme poslali" (zoznam aj detail ho majú po ruke – round 2 §2d).
    onRecordOffer?: () => void;
    // „Požiadať manažéra" / „Odovzdať manažérovi" (wave 3) – otvorí AskManagerDialog.
    onAsk?: (type: "HELP" | "HANDOVER") => void;
}) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [step, setStep] = useState<Step>(replan ? "next" : "contact");
    const [contact, setContact] = useState<Contact>(replan ? "NONE" : "ANSWERED");
    const [reply, setReply] = useState<string | null>(null);
    const [kind, setKind] = useState<FollowUpNextKind>(replan?.kind ?? "CALL");
    const [date, setDate] = useState(replan?.date ?? "");
    const [time, setTime] = useState(replan?.time ?? "");
    const [note, setNote] = useState(""); // „Čo povedali" / text SMS
    const [stepNote, setStepNote] = useState<string | null>(replan ? replan.note : null); // null = predvyplnené
    const [reason, setReason] = useState("");
    const [cancelReason, setCancelReason] = useState("");
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);
    const [toldPrice, setToldPrice] = useState(false);
    const [toldAmount, setToldAmount] = useState(target?.price != null ? String(target.price) : "");
    const [toldNote, setToldNote] = useState<string | null>(null); // null = neupravené (pri tej istej sume ostane rozpis)
    const [asked, setAsked] = useState<RequestContent[]>([]);
    const [overlap, setOverlap] = useState<"KEEP_OPEN" | "CANCEL_TASK" | null>(null);
    const [useReturnedPrice, setUseReturnedPrice] = useState(true);
    const [acknowledge, setAcknowledge] = useState(true);
    const [dropReason, setDropReason] = useState("");

    if (!target) return null;
    const D = target;
    const closed = D.status === "WON" || D.status === "LOST" || D.status === "UNREACHABLE";
    const detailHref = `/dashboard/pipeline/${D.id}`;
    const locked = D.task !== null;
    const isOwner = D.ownerId === viewerId;
    // O vrátených výsledkoch rozhoduje vlastník, na obchode bez vlastníka manažér (§5.2) – server to vynúti.
    // Manažér na cudzom obchode zapíše kontakt, ale nič neberie na vedomie ani neodmieta.
    const decidesResults = isOwner || (D.ownerId === null && caps.manage);
    // Úlohu ruší vlastník (D5); manažér len uzavretím obchodu (§5.2). „Zrušiť + zmeniť" je teda pre vlastníka.
    const canCancelAndChange = locked && isOwner;
    const stepOption = NEXT_STEPS.find((o) => o.kind === kind);
    const toldAmountNumber = toldAmount.trim() === "" ? null : Number(toldAmount.replace(",", "."));
    const toldValid = toldAmountNumber !== null && Number.isFinite(toldAmountNumber) && toldAmountNumber >= 0;
    const priceItem = D.pending.filter((i) => i.kind === "PRICE").at(-1) ?? null; // najnovšia vrátená cena
    const priceTask = locked && D.task?.type === "HELP" && D.task.contents.includes("PRICE");
    // Cena povedaná v hovore – len pri „dovolal/a som sa".
    const phonePrice =
        contact === "ANSWERED" && toldPrice && toldValid && toldAmountNumber !== null
            ? { amount: toldAmountNumber, ...(toldNote !== null ? { note: toldNote.trim() || null } : {}) }
            : undefined;
    // Voľba pri prekryve platí len, kým je povedaná cena zaškrtnutá (R02-2) – po odškrtnutí sa skrytá voľba neposiela.
    const choice = phonePrice && priceTask ? overlap : null;
    // Pri „Zrušiť úlohu" z detailu a keď sa po povedanej cene ruší úloha, ide o zrušenie + zmenu.
    const cancelling = locked && (replan?.cancel === true || contact === "NONE" || step === "snooze" || choice === "CANCEL_TASK");
    const factOnly = locked && !cancelling && step !== "lost";
    const fulfilsPrice =
        phonePrice && priceItem && useReturnedPrice && priceItem.price && moneyToString(phonePrice.amount) === priceItem.price.amount
            ? [{ taskId: priceItem.taskId, kind: "PRICE" as const }]
            : undefined;
    const dateMissing = stepOption?.date === "required" && !date;

    // Vrátené položky: odpoveď / zamietnutie sa predvolene berie na vedomie; neposlaná cena / návrh drží krok „Poslať…"
    // (I10) – iný krok je možný len s „Neposielam" a dôvodom.
    const ackItems = D.pending.filter((i) => i.kind === "OTHER" || i.kind === "DECLINED");
    const sendItems = D.pending.filter((i) => (i.kind === "PRICE" || i.kind === "DESIGN") && !(fulfilsPrice && i === priceItem));
    const required = requiredStepKinds(sendItems);
    const dropsSendItems = !factOnly && step === "next" && required !== null && !required.includes(kind);
    const snoozeDrops = step === "snooze" && sendItems.length > 0;
    const dismiss = (() => {
        if (!decidesResults) return undefined;
        const items = [
            ...(acknowledge ? ackItems.map(itemRef) : []),
            ...(dropsSendItems || snoozeDrops ? sendItems.map(itemRef) : []),
        ];
        if (items.length === 0) return undefined;
        return { items, reason: dropsSendItems || snoozeDrops ? dropReason.trim() || null : null };
    })();
    // Kto nerozhoduje, nemôže zvoliť iný krok než „Poslať…" ani odložiť obchod s neposlaným výsledkom.
    const dropMissing = (dropsSendItems || snoozeDrops) && (!decidesResults || !dropReason.trim());
    const cancelMissing = cancelling && !cancelReason.trim();
    const overlapMissing = priceTask && Boolean(phonePrice) && !choice;

    // Predvyplnená poznámka ku kroku: ten istý krok = jeho poznámka, iný krok = predvolený text druhu.
    const shownStepNote =
        stepNote ??
        (kind === D.nextActionKind && D.nextActionNote
            ? D.nextActionNote
            : contact === "NO_ANSWER" && kind === "CALL"
              ? "Nezdvihli – skúsiť znova"
              : (defaultStepNote(kind) ?? ""));

    function handle(r: { success: true } | ActionError, ok: string, retry?: () => void, after?: () => void) {
        if (!("error" in r)) {
            toast.success(ok);
            onClose();
            router.refresh();
            after?.();
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
        extra: { schedule?: Schedule | null; nextKind?: FollowUpNextKind; lostReason?: string; reply?: string | null; stepNote?: string | null } = {},
    ) {
        const closing = outcome === "NOT_INTERESTED" || outcome === "BAD_NUMBER";
        const fact = locked && !cancelling && !closing;
        const offerHandover = extra.reply === "WANTS_TO_ORDER" && !fact && caps.askManager && isOwner && onAsk;
        const run = () =>
            start(async () => {
                try {
                    const r = await logFollowUp({
                        leadId: D.id,
                        contact: CONTACT_KIND[contact],
                        outcome,
                        expectedRevision: D.revision,
                        idempotencyKey,
                        note: contact === "NONE" ? null : note.trim() || null,
                        ...(phonePrice ? { phonePrice } : {}),
                        ...(phonePrice && fulfilsPrice ? { fulfils: fulfilsPrice } : {}),
                        ...(fact ? { keepLockedStep: true } : {}),
                        ...(choice ? { overlap: choice } : {}),
                        ...(locked && (cancelling || closing) && D.task
                            ? { cancelTask: { taskId: D.task.id, reason: closing ? null : cancelReason.trim() } }
                            : {}),
                        ...(dismiss && !closing ? { dismiss } : {}),
                        // Čo klient v tomto kontakte pýtal – zapíše sa aj pri zamknutom kroku, je to fakt o klientovi.
                        ...(asked.length && !closing && (contact === "ANSWERED" || contact === "REPLIED") ? { asked } : {}),
                        ...(fact ? { reply: extra.reply ?? null } : extra),
                    });
                    handle(r, `Zaznamenané: ${label}`, run, offerHandover ? () => onAsk?.("HANDOVER") : undefined);
                } catch {
                    toast.error("Chyba siete", { action: { label: "Skúsiť znova", onClick: run } });
                }
            });
        run();
    }

    // Uloženie z obrazovky „ďalší krok": výsledok hovoru sa zachová (nezdvihli ostane nezdvihli).
    function saveNextStep() {
        const outcome: FollowUpOutcome =
            contact === "NO_ANSWER" ? "NO_ANSWER" : reply === "WANTS_TO_ORDER" ? "WANTS_TO_ORDER" : "POSITIVE";
        send(outcome, `${CONTACT_LABEL[contact]} → ${NEXT_ACTION_LABEL[kind]}`, {
            nextKind: kind,
            schedule: schedule(),
            reply,
            stepNote: shownStepNote.trim() || null,
        });
    }

    // Zamknutý krok: kontakt sa uloží hneď, bez obrazovky ďalšieho kroku.
    function saveFact(outcome: FollowUpOutcome, label: string, replyKey: string | null = null) {
        send(outcome, `${label} (krok čaká na úlohu)`, { reply: replyKey });
    }

    function pickReply(key: string) {
        const option = CLIENT_REPLIES.find((r) => r.key === key);
        if (!option) return;
        setReply(key);
        // Odpoveď, ktorá JE požiadavkou („Chcú konkrétnu cenu"), sa zapíše ako požiadavka klienta (§3.5).
        const withAsks = option.asks ? [...new Set([...asked, ...option.asks])] : asked;
        if (option.asks) setAsked(withAsks);
        if (factOnly) {
            saveFact(option.outcome, option.label, key);
            return;
        }
        if (option.terminal) {
            send(option.outcome, option.label, { reply: key });
            return;
        }
        // Povedaná cena sa zvyčajne potvrdzuje emailom – predvolený krok „Poslať cenu" dnes.
        if (phonePrice) setKind("SEND_QUOTE");
        else if (option.nextKind) setKind(option.nextKind);
        setStepNote(null);
        setDate(!phonePrice && option.days ? addBusinessCalendarDays(businessDate(new Date()), option.days) : "");
        setTime("");
        setStep("next");
    }

    const big = "h-12 w-full justify-start text-base";
    const canWork = caps.work;
    const taskLabel = D.task
        ? D.task.type === "HANDOVER"
            ? "odovzdanie klienta"
            : D.task.contents.map((c) => TASK_CONTENT_LABEL[c].toLowerCase()).join(" + ")
        : "";

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
            {D.lastOffer && D.lastActivity?.type !== "OFFER_SENT" && (
                <span>
                    · Odoslané: {D.lastOffer.text} {businessDayMonth(new Date(D.lastOffer.at))}
                </span>
            )}
            {D.pending.length > 0 && <span>· {pendingSummary(D.pending)}</span>}
            {/* §3.3: cena, ktorú klient naozaj videl, vs. dnešná cena obchodu – rozhoduje, čo sa dá ešte povedať. */}
            <span className="block">
                {D.clientPrice ? (
                    <>
                        Klient videl {formatMoney(D.clientPrice.amount)}
                        {D.clientPrice.channel === "PHONE" ? " (telefonicky)" : ""} {businessDayMonth(new Date(D.clientPrice.sentOn))}
                        {D.price != null && moneyToString(D.price) !== D.clientPrice.amount
                            ? ` · aktuálna ${formatMoney(D.price)} ešte neodišla`
                            : ""}
                    </>
                ) : D.gotPricelist ? (
                    "Videl len cenník"
                ) : (
                    "Klient cenu ešte nevidel"
                )}
            </span>
        </span>
    );

    const cancelBox = cancelling && D.task && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p>
                Týmto zrušíš úlohu pre {D.task.assignee} ({taskLabel}) – ako tvoje rozhodnutie, bez schválenia.
            </p>
            <Input
                data-vaul-no-drag
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Prečo (napr. klient sa rozhodol inak)"
                className="text-[16px]"
            />
        </div>
    );

    const ackBox = decidesResults && ackItems.length > 0 && (
        <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
            <Checkbox data-vaul-no-drag checked={acknowledge} onCheckedChange={(v) => setAcknowledge(v === true)} />
            <span>
                Beriem na vedomie:{" "}
                {ackItems.map((i) => `${i.kind === "DECLINED" ? "zamietnutie" : "odpoveď"} od ${i.by?.firstName ?? "manažéra"}${i.text ? ` („${i.text}“)` : ""}`).join(" · ")}
            </span>
        </label>
    );

    const dropBox = (dropsSendItems || snoozeDrops) && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p>
                Ešte neposlané: {sendItems.map((i) => i.label).join(", ")}.{" "}
                {decidesResults
                    ? "Iný krok než „Poslať…“ znamená, že sa to neposiela."
                    : "Či sa to pošle, rozhoduje vlastník obchodu – krok ostáva „Poslať…“."}
            </p>
            {decidesResults && (
            <Input
                data-vaul-no-drag
                value={dropReason}
                onChange={(e) => setDropReason(e.target.value)}
                placeholder="Neposielam, lebo… (napr. klient už nechce)"
                className="text-[16px]"
            />
            )}
        </div>
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
                            {caps.manage ? "Znovu otvoriť sa dá v detaile." : "Úpravy robí manažér – ak ho treba znovu otvoriť, povedz mu."}
                        </p>
                        <Button asChild variant="ghost" className="w-full">
                            <Link href={detailHref}>História a detail →</Link>
                        </Button>
                    </>
                ) : (
                    <>
                        {locked && D.task && step === "contact" && (
                            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                                <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                                <span>
                                    Krok čaká na úlohu pre {D.task.assignee} ({taskLabel}). Kontakt sa zapíše, krok sa nezmení.
                                </span>
                            </p>
                        )}

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
                                        if (locked) {
                                            setStep("sms");
                                            return;
                                        }
                                        setKind("CALL");
                                        setStepNote(null);
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
                                {(!locked || canCancelAndChange) && (
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
                                        🗓️ Bez kontaktu – len naplánovať{locked ? " (zruší úlohu)" : ""}…
                                    </Button>
                                )}
                                <div className="my-2 h-px bg-border" />
                                {onRecordOffer && (
                                    <Button variant="outline" className={big} disabled={pending || !canWork} onClick={onRecordOffer}>
                                        📨 Poslali sme ponuku…
                                    </Button>
                                )}
                                <Button
                                    variant="outline"
                                    className={big}
                                    disabled={pending || !canWork}
                                    onClick={() => {
                                        setContact("SMS");
                                        setReply(null);
                                        if (locked) setStep("sms");
                                        else setStep("next");
                                    }}
                                >
                                    💬 Poslali sme SMS…
                                </Button>
                                <div className="my-2 h-px bg-border" />
                                {(!locked || canCancelAndChange) && (
                                    <Button
                                        variant="outline"
                                        className={big}
                                        disabled={pending || !canWork}
                                        onClick={() => {
                                            setContact("ANSWERED");
                                            setStep("snooze");
                                        }}
                                    >
                                        💤 Ozvať sa o pár mesiacov{locked ? " (zruší úlohu)" : ""}…
                                    </Button>
                                )}
                                <Button
                                    variant="destructive"
                                    className="h-12 w-full justify-start text-base"
                                    disabled={pending || !canWork}
                                    onClick={() => {
                                        setContact("ANSWERED");
                                        setStep("lost");
                                    }}
                                >
                                    ✕ Nemajú záujem…
                                </Button>
                                <div className="my-2 h-px bg-border" />
                                {caps.askManager && isOwner && !locked && onAsk && (
                                    <Button variant="ghost" className="w-full justify-start" disabled={pending} onClick={() => onAsk("HELP")}>
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
                                {contact === "ANSWERED" && (
                                    <div className="space-y-2 rounded-lg border p-3">
                                        <label className="flex items-center gap-3 text-sm">
                                            <Checkbox data-vaul-no-drag checked={toldPrice} onCheckedChange={(v) => setToldPrice(v === true)} />
                                            <span>
                                                Povedal/a som cenu
                                                {toldPrice && D.price != null && toldAmount === String(D.price) ? ` ${formatMoney(D.price)}` : ""}
                                            </span>
                                        </label>
                                        {toldPrice && (
                                            <>
                                                <Input
                                                    data-vaul-no-drag
                                                    inputMode="decimal"
                                                    placeholder="Aká suma zaznela (€)"
                                                    value={toldAmount}
                                                    onChange={(e) => setToldAmount(e.target.value)}
                                                    className="text-[16px]"
                                                />
                                                <Textarea
                                                    data-vaul-no-drag
                                                    placeholder="Rozpis, ak zaznel (nepovinné)"
                                                    value={toldNote ?? (D.price != null && toldAmount === String(D.price) ? (D.priceNote ?? "") : "")}
                                                    onChange={(e) => setToldNote(e.target.value)}
                                                    className="min-h-[52px] text-[16px]"
                                                />
                                                {priceItem?.price && phonePrice && moneyToString(phonePrice.amount) === priceItem.price.amount && (
                                                    <label className="flex items-center gap-3 text-sm">
                                                        <Checkbox
                                                            data-vaul-no-drag
                                                            checked={useReturnedPrice}
                                                            onCheckedChange={(v) => setUseReturnedPrice(v === true)}
                                                        />
                                                        Je to cena od {priceItem.by?.firstName ?? "manažéra"} ({formatMoney(priceItem.price.amount)})
                                                    </label>
                                                )}
                                                {priceTask && (
                                                    <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
                                                        <p>{D.task?.assignee} práve robí cenu. Čo s úlohou?</p>
                                                        <label className="flex items-center gap-2">
                                                            <input type="radio" checked={overlap === "KEEP_OPEN"} onChange={() => setOverlap("KEEP_OPEN")} />
                                                            Úloha ostáva otvorená
                                                        </label>
                                                        {canCancelAndChange && (
                                                            <label className="flex items-center gap-2">
                                                                <input
                                                                    type="radio"
                                                                    checked={overlap === "CANCEL_TASK"}
                                                                    onChange={() => setOverlap("CANCEL_TASK")}
                                                                />
                                                                Už to netreba – zrušiť úlohu
                                                            </label>
                                                        )}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                )}
                                {/* Wave 5 (§3.5): „Chcú aj …" – druhé prianie už nekončí v poznámke. */}
                                <div className="space-y-1.5 rounded-lg border p-3">
                                    <p className="text-sm text-muted-foreground">Chcú aj… (nepovinné)</p>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                                        {REQUEST_CONTENTS.map((content) => (
                                            <label key={content} className="flex items-center gap-2 text-sm">
                                                <Checkbox
                                                    data-vaul-no-drag
                                                    checked={asked.includes(content)}
                                                    onCheckedChange={(v) =>
                                                        setAsked((cur) => (v === true ? [...cur, content] : cur.filter((c) => c !== content)))
                                                    }
                                                />
                                                {REQUEST_CONTENT_LABEL[content]}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                {cancelBox}
                                <p className="px-1 pb-1 text-sm text-muted-foreground">Čo povedali?</p>
                                <div className="grid gap-2 md:grid-cols-2">
                                    {CLIENT_REPLIES.map((r) => (
                                        <Button
                                            key={r.key}
                                            variant="outline"
                                            className="h-12 justify-start text-base"
                                            disabled={pending || (toldPrice && !toldValid) || overlapMissing || (cancelling && cancelMissing)}
                                            onClick={() => pickReply(r.key)}
                                        >
                                            {r.label}
                                        </Button>
                                    ))}
                                </div>
                                {factOnly && ackBox}
                                <Button
                                    variant="ghost"
                                    className="w-full justify-start"
                                    disabled={pending || overlapMissing || (toldPrice && !toldValid)}
                                    onClick={() => {
                                        setReply(null);
                                        if (factOnly) saveFact("POSITIVE", CONTACT_LABEL[contact]);
                                        else setStep("next");
                                    }}
                                >
                                    {factOnly ? "Iné – len zapísať kontakt" : "Iné – rovno vybrať ďalší krok…"}
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step === "sms" && (
                            <>
                                <p className="px-1 pb-1 text-sm text-muted-foreground">
                                    {CONTACT_LABEL[contact]} – zapíše sa kontakt, krok ostáva zamknutý.
                                </p>
                                {ackBox}
                                <Button
                                    className="h-12 w-full"
                                    disabled={pending || (contact === "SMS" && !note.trim())}
                                    onClick={() => saveFact(contact === "NO_ANSWER" ? "NO_ANSWER" : "POSITIVE", CONTACT_LABEL[contact])}
                                >
                                    {contact === "SMS" && !note.trim() ? "Napíš text SMS" : "Uložiť"}
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step === "next" && (
                            <>
                                {cancelBox}
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
                                            onClick={() => {
                                                setKind(o.kind as FollowUpNextKind);
                                                setStepNote(null);
                                            }}
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
                                <Input
                                    data-vaul-no-drag
                                    value={shownStepNote}
                                    onChange={(e) => setStepNote(e.target.value)}
                                    placeholder="Poznámka ku kroku"
                                    className="text-[16px]"
                                />
                                {ackBox}
                                {dropBox}
                                <Button
                                    className="h-12 w-full"
                                    disabled={pending || (dateMissing && contact !== "NO_ANSWER") || dropMissing || cancelMissing}
                                    onClick={saveNextStep}
                                >
                                    {dateMissing && contact !== "NO_ANSWER"
                                        ? "Vyber dátum"
                                        : cancelMissing
                                          ? "Napíš, prečo rušíš úlohu"
                                          : dropMissing
                                            ? decidesResults
                                                ? "Napíš, prečo sa neposiela"
                                                : "Rozhoduje vlastník – nechaj „Poslať…“"
                                            : "Uložiť"}
                                </Button>
                                {!replan && (
                                    <Button
                                        variant="ghost"
                                        className="w-full"
                                        onClick={() => setStep(contact === "ANSWERED" || contact === "REPLIED" ? "reply" : "contact")}
                                    >
                                        ← Späť
                                    </Button>
                                )}
                            </>
                        )}

                        {step === "snooze" && (
                            <>
                                {cancelBox}
                                {dropBox}
                                {[2, 4, 6].map((m) => (
                                    <Button
                                        key={m}
                                        variant="outline"
                                        className={big}
                                        disabled={pending || cancelMissing || dropMissing}
                                        onClick={() => send("SNOOZE", `O ${m} mesiace`, { schedule: { kind: "monthsFromToday", months: m } })}
                                    >
                                        O {m} {m === 6 ? "mesiacov" : "mesiace"}
                                    </Button>
                                ))}
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <DateTimeInput date={date} time="" onDate={setDate} onTime={() => {}} withTime={false} />
                                    </div>
                                    <Button
                                        className="h-12"
                                        disabled={pending || !date || cancelMissing || dropMissing}
                                        onClick={() => send("SNOOZE", "Vlastný termín", { schedule: { kind: "day", date } })}
                                    >
                                        OK
                                    </Button>
                                </div>
                                {ackBox}
                                <Button variant="ghost" className="w-full" onClick={() => setStep("contact")}>
                                    ← Späť
                                </Button>
                            </>
                        )}

                        {step === "lost" && (
                            <>
                                {locked && D.task && (
                                    <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                                        Zruší sa aj úloha pre {D.task.assignee} ({taskLabel}) – obchod uzavretý.
                                    </p>
                                )}
                                {D.pending.length > 0 && (
                                    <p className="text-xs text-muted-foreground">Neposlané výsledky sa zapíšu ako neposielané („obchod uzavretý“).</p>
                                )}
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

                        {contact !== "NONE" && step !== "contact" && (
                            <Textarea
                                data-vaul-no-drag
                                placeholder={contact === "SMS" ? "Text SMS" : "Čo povedali (do histórie kontaktu)"}
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
