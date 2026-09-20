"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    ArrowLeft,
    BadgeEuro,
    CalendarClock,
    Check,
    ChevronRight,
    CircleEllipsis,
    Clock3,
    EyeOff,
    FileText,
    Handshake,
    Info,
    Lock,
    Mail,
    MailWarning,
    MessageCircle,
    MessageSquare,
    Moon,
    PackageCheck,
    Palette,
    PanelsTopLeft,
    Phone,
    PhoneMissed,
    ReceiptText,
    RefreshCw,
    ScanSearch,
    Send,
    type LucideIcon,
} from "lucide-react";
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
import { CLIENT_REPLIES, FOLLOW_UP_REPLIES } from "@/lib/domain/clientReplies";
import { REQUEST_CONTENT_LABEL, REQUEST_CONTENTS, stepKindForOutstanding } from "@/lib/domain/clientRequests";
import { cn } from "@/lib/utils";
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
    outstanding?: RequestContent[]; // čo je nevybavené – z toho vyplýva predvolený krok (§6.8)
    // Wave 5: ktorú cenu klient naozaj videl (§3.3) a či videl aspoň cenník.
    clientPrice?: { amount: string; channel: "EMAIL" | "PHONE"; sentOn: string } | null;
    gotPricelist?: boolean;
};

type Step = "contact" | "reply" | "wants" | "next" | "snooze" | "lost" | "sms";
type ReplyChoice = "WANTS" | "OTHER" | string;

// Karta výberu – rovnaký vizuálny jazyk ako „Požiadať manažéra": ikona, jeden jasný názov, krátke vysvetlenie a
// viditeľný stav výberu. Na telefóne je karta horizontálna a ľahko trafiteľná palcom; na PC sa skladajú po dve.
const CARD =
    "group flex min-h-[72px] w-full items-start gap-3 rounded-xl border bg-background px-3.5 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CARD_ON = "border-primary/70 bg-primary/[0.06] text-foreground shadow-sm ring-1 ring-primary/20";
const CARD_OFF = "hover:border-primary/30 hover:bg-muted/50";

function OptionCard({
    label,
    hint,
    icon: Icon,
    on = false,
    disabled,
    onClick,
    role,
}: {
    label: string;
    hint?: string | null;
    icon?: LucideIcon;
    on?: boolean;
    disabled?: boolean;
    onClick: () => void;
    role?: "radio" | "checkbox";
}) {
    return (
        <button
            type="button"
            data-vaul-no-drag
            {...(role ? { role, "aria-checked": on } : {})}
            disabled={disabled}
            onClick={onClick}
            className={cn(CARD, on ? CARD_ON : CARD_OFF, disabled && "pointer-events-none opacity-50")}
        >
            {Icon && (
                <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", on ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground")}>
                    <Icon className="h-4.5 w-4.5" />
                </span>
            )}
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-5">{label}</span>
                {hint && <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">{hint}</span>}
            </span>
            {role && (
                <span
                    aria-hidden
                    className={cn(
                        "mt-1 flex h-5 w-5 shrink-0 items-center justify-center border transition-colors",
                        role === "radio" ? "rounded-full" : "rounded-md",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30 bg-background",
                    )}
                >
                    {on && <Check className="h-3.5 w-3.5" />}
                </span>
            )}
        </button>
    );
}

function SectionLabel({ children }: { children: ReactNode }) {
    return <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;
}

function InfoPanel({ icon: Icon = Info, children, tone = "neutral" }: { icon?: LucideIcon; children: ReactNode; tone?: "neutral" | "warning" }) {
    return (
        <div
            className={cn(
                "flex items-start gap-3 rounded-xl p-3 text-sm",
                tone === "warning" ? "border border-amber-500/35 bg-amber-500/10" : "bg-muted/55",
            )}
        >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone === "warning" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")} />
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

const REQUEST_CARD: Record<RequestContent, { icon: LucideIcon; hint: string }> = {
    INFO: { icon: PanelsTopLeft, hint: "Kto sme a ukážky našej práce" },
    PRICELIST: { icon: ReceiptText, hint: "Všeobecný prehľad cien" },
    PRICE: { icon: BadgeEuro, hint: "Cena pripravená pre tohto klienta" },
    DESIGN: { icon: Palette, hint: "Grafický návrh webu" },
    REVIEW: { icon: ScanSearch, hint: "Čo sa dá zlepšiť na ich webe" },
};

const REPLY_ICON: Record<string, LucideIcon> = {
    NOT_LOOKED_YET: EyeOff,
    WANTS_CHANGES: RefreshCw,
    RESEND: MailWarning,
    WILL_CONTACT_US: Clock3,
    DECIDING: CalendarClock,
    PRICE_HIGH: BadgeEuro,
    WANTS_TO_ORDER: Handshake,
};

const NEXT_ICON: Record<FollowUpNextKind, LucideIcon> = {
    CALL: Phone,
    WAITING_FOR_CLIENT: Clock3,
    SEND_QUOTE: BadgeEuro,
    SEND_DESIGN: Palette,
    SEND_EMAIL: Mail,
    CUSTOM: CircleEllipsis,
};

function nextStepCopy(kind: FollowUpNextKind, reply: string | null): { label: string; hint: string } {
    if (kind === "SEND_DESIGN" && reply === "WANTS_CHANGES") {
        return { label: "Poslať upravený návrh", hint: "Po úpravách ho pošli klientovi znova" };
    }
    const hints: Record<FollowUpNextKind, string> = {
        CALL: "Vyber deň ďalšieho hovoru",
        WAITING_FOR_CLIENT: "Nastav deň, keď skontroluješ, či sa ozvali",
        SEND_QUOTE: "Odoslať konkrétnu cenu klientovi",
        SEND_DESIGN: "Návrh je rozpracovaný, čas sa počíta od začiatku",
        SEND_EMAIL: "Odoslať info, cenník alebo rozbor webu",
        CUSTOM: "Napíš vlastný ďalší krok",
    };
    return { label: NEXT_ACTION_LABEL[kind], hint: hints[kind] };
}
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
    const [replyChoice, setReplyChoice] = useState<ReplyChoice | null>(null);
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
    const [askedDraft, setAskedDraft] = useState<RequestContent[]>([]);
    const [allSteps, setAllSteps] = useState(false);
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
    // Čo bude nevybavené po tejto odpovedi → z toho vyplýva predvolený krok (§6.8); „Poslať …" sa už nevyberá ručne.
    const wantedKind = stepKindForOutstanding([...(D.outstanding ?? []), ...asked]) as FollowUpNextKind | null;
    const replyOption = CLIENT_REPLIES.find((r) => r.key === reply);
    const allowedKinds: FollowUpNextKind[] = allSteps
        ? [...FOLLOW_UP_NEXT_KINDS]
        : asked.length
          ? ([...new Set([wantedKind, "CALL", "WAITING_FOR_CLIENT", "CUSTOM"])].filter(Boolean) as FollowUpNextKind[])
          : phonePrice
            ? ["SEND_QUOTE", "CALL", "WAITING_FOR_CLIENT", "CUSTOM"]
          : (replyOption?.nextKinds ?? [...FOLLOW_UP_NEXT_KINDS]);
    const shownSteps = allowedKinds
        .map((k) => NEXT_STEPS.find((o) => o.kind === k))
        .filter((o): o is (typeof NEXT_STEPS)[number] => Boolean(o));

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
    // Nič sa neuloží, kým nie je vybraná voľba pri prekryve / dôvod zrušenia – karty sú dovtedy neaktívne.
    const blockedHere = (toldPrice && !toldValid) || Boolean(overlapMissing) || cancelMissing;

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
        askedForContact: RequestContent[] = asked,
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
                        ...(askedForContact.length && !closing && (contact === "ANSWERED" || contact === "REPLIED")
                            ? { asked: askedForContact }
                            : {}),
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
    function saveFact(outcome: FollowUpOutcome, label: string, replyKey: string | null = null, askedForContact: RequestContent[] = asked) {
        send(outcome, `${label} (krok čaká na úlohu)`, { reply: replyKey }, askedForContact);
    }

    function continueWithReply(key: string) {
        const option = CLIENT_REPLIES.find((r) => r.key === key);
        if (!option) return;
        setReply(key);
        setAllSteps(false);
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

    function chooseReply(choice: ReplyChoice) {
        setReplyChoice(choice);
        setAllSteps(false);
        if (choice === "WANTS") {
            setReply(null);
            return;
        }
        setAsked([]);
        setAskedDraft([]);
        setReply(choice === "OTHER" ? null : choice);
    }

    function continueReply() {
        if (replyChoice === "WANTS") {
            setAskedDraft(asked);
            setStep("wants");
            return;
        }
        if (replyChoice === "OTHER") {
            if (factOnly) saveFact("POSITIVE", CONTACT_LABEL[contact]);
            else {
                if (phonePrice) setKind("SEND_QUOTE");
                setStepNote(null);
                setDate("");
                setTime("");
                setStep("next");
            }
            return;
        }
        if (replyChoice) {
            continueWithReply(replyChoice);
            return;
        }
        // Cena môže byť jediný výsledok hovoru. Predtým po jej vyplnení nebolo kam pokračovať (F4).
        if (phonePrice) {
            setReply(null);
            if (factOnly) saveFact("POSITIVE", "Povedaná cena");
            else {
                setKind("SEND_QUOTE");
                setStepNote(null);
                setDate("");
                setTime("");
                setStep("next");
            }
        }
    }

    function backToContact() {
        setReply(null);
        setReplyChoice(null);
        setAsked([]);
        setAskedDraft([]);
        setToldPrice(false);
        setOverlap(null);
        setCancelReason("");
        setAllSteps(false);
        setStep("contact");
    }

    function startContact(nextContact: Contact, nextStep: Step) {
        setContact(nextContact);
        setReply(null);
        setReplyChoice(null);
        setAsked([]);
        setAskedDraft([]);
        setToldPrice(false);
        setOverlap(null);
        setCancelReason("");
        setAllSteps(false);
        setStep(nextStep);
    }

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
                            <div className="space-y-5">
                                <div className="space-y-2">
                                    <SectionLabel>Kontakt s klientom</SectionLabel>
                                    <div className="grid gap-2 md:grid-cols-2">
                                        <OptionCard
                                            label="Dovolal/a som sa"
                                            hint="Hovor prebehol – zapíš, čo povedali"
                                            icon={Phone}
                                            disabled={pending || !canWork}
                                            onClick={() => startContact("ANSWERED", "reply")}
                                        />
                                        <OptionCard
                                            label="Nezdvihli"
                                            hint="Zaznamenať pokus a naplánovať ďalší"
                                            icon={PhoneMissed}
                                            disabled={pending || !canWork}
                                            onClick={() => {
                                                startContact("NO_ANSWER", locked ? "sms" : "next");
                                                if (!locked) {
                                                    setKind("CALL");
                                                    setStepNote(null);
                                                    setDate("");
                                                    setTime("");
                                                }
                                            }}
                                        />
                                        <OptionCard
                                            label="Odpísali / ozvali sa"
                                            hint="Správa, email alebo spätný kontakt"
                                            icon={MessageCircle}
                                            disabled={pending || !canWork}
                                            onClick={() => startContact("REPLIED", "reply")}
                                        />
                                        <OptionCard
                                            label="Poslali sme SMS"
                                            hint="Uložiť text správy a ďalší krok"
                                            icon={MessageSquare}
                                            disabled={pending || !canWork}
                                            onClick={() => startContact("SMS", locked ? "sms" : "next")}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <SectionLabel>Odoslanie a plán</SectionLabel>
                                    <div className="grid gap-2 md:grid-cols-2">
                                        {onRecordOffer && (
                                            <OptionCard
                                                label="Poslali sme ponuku"
                                                hint="Zaznamenať, čo klient dostal"
                                                icon={Send}
                                                disabled={pending || !canWork}
                                                onClick={onRecordOffer}
                                            />
                                        )}
                                        {(!locked || canCancelAndChange) && (
                                            <OptionCard
                                                label="Iba zmeniť ďalší krok"
                                                hint={locked ? "Bez kontaktu – zruší otvorenú úlohu" : "Bez nového kontaktu s klientom"}
                                                icon={CalendarClock}
                                                disabled={pending || !canWork}
                                                onClick={() => startContact("NONE", "next")}
                                            />
                                        )}
                                        {(!locked || canCancelAndChange) && (
                                            <OptionCard
                                                label="Ozvať sa o pár mesiacov"
                                                hint={locked ? "Odloží obchod a zruší otvorenú úlohu" : "Odložiť obchod na neskôr"}
                                                icon={Moon}
                                                disabled={pending || !canWork}
                                                onClick={() => startContact("ANSWERED", "snooze")}
                                            />
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Button
                                        variant="destructive"
                                        className="h-11 w-full justify-start gap-2"
                                        disabled={pending || !canWork}
                                        onClick={() => startContact("ANSWERED", "lost")}
                                    >
                                        <span className="text-base">×</span>
                                        Nemajú záujem / zlé číslo…
                                    </Button>
                                </div>

                                <div className="rounded-xl bg-muted/45 p-2">
                                    {caps.askManager && isOwner && !locked && onAsk && (
                                        <Button variant="ghost" className="h-10 w-full justify-between" disabled={pending} onClick={() => onAsk("HELP")}>
                                            <span className="flex items-center gap-2"><Handshake className="h-4 w-4" />Požiadať manažéra</span>
                                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                        </Button>
                                    )}
                                    <Button asChild variant="ghost" className="h-10 w-full justify-between">
                                        <Link href={detailHref}>
                                            <span className="flex items-center gap-2"><FileText className="h-4 w-4" />Otvoriť detail</span>
                                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                        </Link>
                                    </Button>
                                </div>
                            </div>
                        )}

                        {step === "reply" && (
                            <div className="space-y-5">
                                <div className="space-y-2">
                                    <SectionLabel>Čo povedali</SectionLabel>
                                    <div className="grid gap-2 md:grid-cols-2" role="radiogroup" aria-label="Čo povedali">
                                        <OptionCard
                                            label="Chcú niečo poslať"
                                            hint={
                                                asked.length
                                                    ? asked.map((c) => REQUEST_CONTENT_LABEL[c]).join(" · ")
                                                    : "Info, cenník, cenu, návrh alebo rozbor"
                                            }
                                            icon={PackageCheck}
                                            role="radio"
                                            on={replyChoice === "WANTS"}
                                            disabled={pending || blockedHere}
                                            onClick={() => chooseReply("WANTS")}
                                        />
                                        {FOLLOW_UP_REPLIES.map((r) => (
                                            <OptionCard
                                                key={r.key}
                                                label={r.label}
                                                icon={REPLY_ICON[r.key] ?? MessageCircle}
                                                role="radio"
                                                on={replyChoice === r.key}
                                                disabled={pending || blockedHere}
                                                onClick={() => chooseReply(r.key)}
                                            />
                                        ))}
                                        <OptionCard
                                            label="Iná odpoveď"
                                            hint="Zapíšem poznámku a zvolím ďalší krok"
                                            icon={CircleEllipsis}
                                            role="radio"
                                            on={replyChoice === "OTHER"}
                                            disabled={pending || blockedHere}
                                            onClick={() => chooseReply("OTHER")}
                                        />
                                    </div>
                                </div>

                                {contact === "ANSWERED" && (
                                    <div className="space-y-3 rounded-xl bg-muted/55 p-3">
                                        <SectionLabel>Cena v hovore</SectionLabel>
                                        <OptionCard
                                            label="Povedal/a som konkrétnu cenu"
                                            hint="Zapíše sa, že klient túto sumu už pozná"
                                            icon={BadgeEuro}
                                            role="checkbox"
                                            on={toldPrice}
                                            disabled={pending}
                                            onClick={() => setToldPrice((v) => !v)}
                                        />
                                        {toldPrice && (
                                            <div className="space-y-2">
                                                <Input
                                                    data-vaul-no-drag
                                                    inputMode="decimal"
                                                    placeholder="Aká suma zaznela (€)"
                                                    value={toldAmount}
                                                    onChange={(e) => setToldAmount(e.target.value)}
                                                    className="h-11 bg-background text-[16px]"
                                                />
                                                <Textarea
                                                    data-vaul-no-drag
                                                    placeholder="Rozpis ceny, ak zaznel (nepovinné)"
                                                    value={toldNote ?? (D.price != null && toldAmount === String(D.price) ? (D.priceNote ?? "") : "")}
                                                    onChange={(e) => setToldNote(e.target.value)}
                                                    className="min-h-[64px] bg-background text-[16px]"
                                                />
                                                {!toldValid && <p className="text-xs text-destructive">Zadaj platnú sumu.</p>}
                                                {priceItem?.price && phonePrice && moneyToString(phonePrice.amount) === priceItem.price.amount && (
                                                    <label className="flex items-center gap-3 rounded-lg bg-background p-3 text-sm">
                                                        <Checkbox
                                                            data-vaul-no-drag
                                                            checked={useReturnedPrice}
                                                            onCheckedChange={(v) => setUseReturnedPrice(v === true)}
                                                        />
                                                        Je to cena od {priceItem.by?.firstName ?? "manažéra"} ({formatMoney(priceItem.price.amount)})
                                                    </label>
                                                )}
                                                {priceTask && (
                                                    <InfoPanel icon={Lock} tone="warning">
                                                        <p className="font-medium">{D.task?.assignee} práve pripravuje cenu.</p>
                                                        <div className="mt-2 space-y-2">
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
                                                                    Už ju netreba – zrušiť úlohu
                                                                </label>
                                                            )}
                                                        </div>
                                                    </InfoPanel>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {cancelBox}

                                <div className="space-y-2">
                                    <SectionLabel>Poznámka z kontaktu</SectionLabel>
                                    <Textarea
                                        data-vaul-no-drag
                                        placeholder="Dôležité detaily z rozhovoru (nepovinné)"
                                        value={note}
                                        onChange={(e) => setNote(e.target.value)}
                                        className="min-h-[72px] text-[16px] md:text-sm"
                                    />
                                </div>

                                {factOnly && ackBox}

                                <div className="space-y-2">
                                    <Button
                                        className="h-12 w-full text-base"
                                        disabled={pending || blockedHere || (!replyChoice && !phonePrice)}
                                        onClick={continueReply}
                                    >
                                        {pending
                                            ? "Ukladám…"
                                            : replyChoice === "WANTS"
                                              ? "Vybrať, čo chcú"
                                              : factOnly
                                                ? "Uložiť kontakt"
                                                : "Pokračovať"}
                                        {!pending && <ChevronRight className="ml-1 h-4 w-4" />}
                                    </Button>
                                    {!replyChoice && !phonePrice && (
                                        <p className="text-center text-xs text-muted-foreground">Vyber odpoveď alebo zapíš povedanú cenu.</p>
                                    )}
                                    <Button variant="ghost" className="w-full" onClick={backToContact}>
                                        <ArrowLeft className="mr-2 h-4 w-4" /> Späť
                                    </Button>
                                </div>
                            </div>
                        )}

                        {/* Wave 5: čo klient chce – prepínateľné karty a jedno „Pokračovať". Predtým to boli
                            zaškrtávacie políčka bez potvrdenia, takže sa nedalo pokračovať (Michal, 2026-09-20). */}
                        {step === "wants" && (
                            <div className="space-y-5">
                                <div className="space-y-2">
                                    <SectionLabel>Čo chcú poslať</SectionLabel>
                                    <InfoPanel icon={PackageCheck}>Môžeš vybrať viac možností. Ďalší krok sa z nich predvyplní automaticky.</InfoPanel>
                                    <div className="grid gap-2 md:grid-cols-2">
                                        {REQUEST_CONTENTS.map((content) => (
                                            <OptionCard
                                                key={content}
                                                label={REQUEST_CONTENT_LABEL[content]}
                                                hint={REQUEST_CARD[content].hint}
                                                icon={REQUEST_CARD[content].icon}
                                                role="checkbox"
                                                on={askedDraft.includes(content)}
                                                disabled={pending}
                                                onClick={() =>
                                                    setAskedDraft((cur) => (cur.includes(content) ? cur.filter((c) => c !== content) : [...cur, content]))
                                                }
                                            />
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <SectionLabel>Poznámka z kontaktu</SectionLabel>
                                    <Textarea
                                        data-vaul-no-drag
                                        placeholder="Dôležité detaily z rozhovoru (nepovinné)"
                                        value={note}
                                        onChange={(e) => setNote(e.target.value)}
                                        className="min-h-[72px] text-[16px] md:text-sm"
                                    />
                                </div>

                                {factOnly && ackBox}

                                <div className="space-y-2">
                                    <Button
                                        className="h-12 w-full text-base"
                                        disabled={pending || askedDraft.length === 0}
                                        onClick={() => {
                                            if (askedDraft.length === 0) return;
                                            const confirmed = [...askedDraft];
                                            setAsked(confirmed);
                                            setReply(null);
                                            setReplyChoice("WANTS");
                                            if (factOnly) {
                                                saveFact(
                                                    "POSITIVE",
                                                    `Chcú ${confirmed.map((c) => REQUEST_CONTENT_LABEL[c].toLowerCase()).join(" + ")}`,
                                                    null,
                                                    confirmed,
                                                );
                                                return;
                                            }
                                            const nextWanted = stepKindForOutstanding([...(D.outstanding ?? []), ...confirmed]);
                                            setKind((nextWanted as FollowUpNextKind | null) ?? "CALL");
                                            setStepNote(null);
                                            setDate("");
                                            setTime("");
                                            setStep("next");
                                        }}
                                    >
                                        {askedDraft.length === 0 ? "Vyber, čo chcú" : factOnly ? "Pokračovať k uloženiu" : "Pokračovať"}
                                        <ChevronRight className="ml-1 h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className="w-full"
                                        onClick={() => {
                                            setAskedDraft(asked);
                                            setStep("reply");
                                        }}
                                    >
                                        <ArrowLeft className="mr-2 h-4 w-4" /> Späť
                                    </Button>
                                </div>
                            </div>
                        )}

                        {step === "sms" && (
                            <div className="space-y-5">
                                <InfoPanel icon={Lock} tone="warning">
                                    <p className="font-medium">Krok zostáva zamknutý.</p>
                                    <p className="mt-0.5 text-xs text-muted-foreground">Zapíše sa iba kontakt; úloha pre manažéra pokračuje.</p>
                                </InfoPanel>
                                {contact === "SMS" && (
                                    <div className="space-y-2">
                                        <SectionLabel>Text SMS</SectionLabel>
                                        <Textarea
                                            data-vaul-no-drag
                                            placeholder="Čo sme klientovi poslali"
                                            value={note}
                                            onChange={(e) => setNote(e.target.value)}
                                            className="min-h-[88px] text-[16px] md:text-sm"
                                        />
                                    </div>
                                )}
                                {contact === "NO_ANSWER" && (
                                    <div className="space-y-2">
                                        <SectionLabel>Poznámka k pokusu</SectionLabel>
                                        <Textarea
                                            data-vaul-no-drag
                                            placeholder="Nepovinné"
                                            value={note}
                                            onChange={(e) => setNote(e.target.value)}
                                            className="min-h-[72px] text-[16px] md:text-sm"
                                        />
                                    </div>
                                )}
                                {ackBox}
                                <div className="space-y-2">
                                    <Button
                                        className="h-12 w-full text-base"
                                        disabled={pending || (contact === "SMS" && !note.trim())}
                                        onClick={() => saveFact(contact === "NO_ANSWER" ? "NO_ANSWER" : "POSITIVE", CONTACT_LABEL[contact])}
                                    >
                                        {pending ? "Ukladám…" : contact === "SMS" && !note.trim() ? "Napíš text SMS" : "Uložiť kontakt"}
                                    </Button>
                                    <Button variant="ghost" className="w-full" onClick={backToContact}>
                                        <ArrowLeft className="mr-2 h-4 w-4" /> Späť
                                    </Button>
                                </div>
                            </div>
                        )}

                        {step === "next" && (
                            <div className="space-y-5">
                                {cancelBox}

                                {!replan && (
                                    <InfoPanel icon={Check}>
                                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Zaznamenáme</p>
                                        <p className="mt-1 font-medium">
                                            {CONTACT_LABEL[contact]}
                                            {reply ? ` · ${CLIENT_REPLIES.find((r) => r.key === reply)?.label}` : ""}
                                            {asked.length ? ` · chcú ${asked.map((c) => REQUEST_CONTENT_LABEL[c].toLowerCase()).join(" + ")}` : ""}
                                            {phonePrice ? ` · cena ${formatMoney(phonePrice.amount)}` : ""}
                                        </p>
                                    </InfoPanel>
                                )}

                                <div className="space-y-2">
                                    <SectionLabel>Čo bude ďalej</SectionLabel>
                                    <div className="grid gap-2 md:grid-cols-2" role="radiogroup" aria-label="Ďalší krok">
                                        {shownSteps.map((o) => {
                                            const copy = nextStepCopy(o.kind as FollowUpNextKind, reply);
                                            return (
                                                <OptionCard
                                                    key={o.kind}
                                                    role="radio"
                                                    label={copy.label}
                                                    hint={copy.hint}
                                                    icon={NEXT_ICON[o.kind as FollowUpNextKind]}
                                                    on={kind === o.kind}
                                                    disabled={pending}
                                                    onClick={() => {
                                                        setKind(o.kind as FollowUpNextKind);
                                                        setStepNote(null);
                                                    }}
                                                />
                                            );
                                        })}
                                    </div>
                                    {shownSteps.length < NEXT_STEPS.length && !allSteps && (
                                        <Button variant="ghost" className="w-full justify-start" onClick={() => setAllSteps(true)}>
                                            <CircleEllipsis className="mr-2 h-4 w-4" /> Zobraziť iný krok
                                        </Button>
                                    )}
                                </div>

                                <div className="space-y-3 rounded-xl bg-muted/55 p-3">
                                    <SectionLabel>Termín a poznámka ku kroku</SectionLabel>
                                    <DateTimeInput date={date} time={time} onDate={setDate} onTime={setTime} />
                                    <p className="text-xs text-muted-foreground">
                                        {stepOption?.date === "required"
                                            ? "Vyber deň. Čas môže zostať prázdny."
                                            : stepOption?.date === "today"
                                              ? "Prázdny dátum znamená dnes."
                                              : "Dátum je nepovinný – slúži ako deň kontroly."}
                                        {contact === "NO_ANSWER" && !date ? " Bez dátumu sa ďalší pokus naplánuje na nasledujúci pracovný deň." : ""}
                                    </p>
                                    <Input
                                        data-vaul-no-drag
                                        value={shownStepNote}
                                        onChange={(e) => setStepNote(e.target.value)}
                                        placeholder="Poznámka ku kroku"
                                        className="h-11 bg-background text-[16px] md:text-sm"
                                    />
                                </div>

                                {(contact === "SMS" || contact === "NO_ANSWER") && (
                                    <div className="space-y-2">
                                        <SectionLabel>{contact === "SMS" ? "Text SMS" : "Poznámka k pokusu"}</SectionLabel>
                                        <Textarea
                                            data-vaul-no-drag
                                            placeholder={contact === "SMS" ? "Čo sme klientovi poslali" : "Čo sa stalo (nepovinné)"}
                                            value={note}
                                            onChange={(e) => setNote(e.target.value)}
                                            className="min-h-[72px] text-[16px] md:text-sm"
                                        />
                                    </div>
                                )}

                                {ackBox}
                                {dropBox}

                                <div className="space-y-2">
                                    <Button
                                        className="h-12 w-full text-base"
                                        disabled={
                                            pending ||
                                            (dateMissing && contact !== "NO_ANSWER") ||
                                            (contact === "SMS" && !note.trim()) ||
                                            dropMissing ||
                                            cancelMissing
                                        }
                                        onClick={saveNextStep}
                                    >
                                        {dateMissing && contact !== "NO_ANSWER"
                                            ? "Vyber dátum"
                                            : contact === "SMS" && !note.trim()
                                              ? "Napíš text SMS"
                                              : cancelMissing
                                                ? "Napíš, prečo rušíš úlohu"
                                                : dropMissing
                                                  ? decidesResults
                                                      ? "Napíš, prečo sa neposiela"
                                                      : "Rozhoduje vlastník – nechaj „Poslať…“"
                                                  : pending
                                                    ? "Ukladám…"
                                                    : "Uložiť kontakt a krok"}
                                    </Button>
                                    {!replan && (
                                        <Button
                                            variant="ghost"
                                            className="w-full"
                                            onClick={() => {
                                                if (contact === "ANSWERED" || contact === "REPLIED") {
                                                    if (replyChoice === "WANTS") {
                                                        setAskedDraft(asked);
                                                        setStep("wants");
                                                    } else setStep("reply");
                                                } else setStep("contact");
                                            }}
                                        >
                                            <ArrowLeft className="mr-2 h-4 w-4" /> Späť
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )}

                        {step === "snooze" && (
                            <div className="space-y-5">
                                {cancelBox}
                                {dropBox}
                                <div className="space-y-2">
                                    <SectionLabel>Kedy sa ozvať</SectionLabel>
                                    <div className="grid grid-cols-3 gap-2">
                                        {[2, 4, 6].map((m) => (
                                            <Button
                                                key={m}
                                                variant="outline"
                                                className="h-12"
                                                disabled={pending || cancelMissing || dropMissing}
                                                onClick={() => send("SNOOZE", `O ${m} mesiace`, { schedule: { kind: "monthsFromToday", months: m } })}
                                            >
                                                {m} {m === 6 ? "mesiacov" : "mesiace"}
                                            </Button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-3 rounded-xl bg-muted/55 p-3">
                                    <SectionLabel>Vlastný termín</SectionLabel>
                                    <div className="flex gap-2">
                                        <div className="flex-1">
                                            <DateTimeInput date={date} time="" onDate={setDate} onTime={() => {}} withTime={false} />
                                        </div>
                                        <Button
                                            className="h-12 px-5"
                                            disabled={pending || !date || cancelMissing || dropMissing}
                                            onClick={() => send("SNOOZE", "Vlastný termín", { schedule: { kind: "day", date } })}
                                        >
                                            Odložiť
                                        </Button>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <SectionLabel>Poznámka z kontaktu</SectionLabel>
                                    <Textarea
                                        data-vaul-no-drag
                                        placeholder="Prečo sa ozvať neskôr (nepovinné)"
                                        value={note}
                                        onChange={(e) => setNote(e.target.value)}
                                        className="min-h-[72px] text-[16px] md:text-sm"
                                    />
                                </div>
                                {ackBox}
                                <Button variant="ghost" className="w-full" onClick={backToContact}>
                                    <ArrowLeft className="mr-2 h-4 w-4" /> Späť
                                </Button>
                            </div>
                        )}

                        {step === "lost" && (
                            <div className="space-y-5">
                                {locked && D.task && (
                                    <InfoPanel icon={Lock} tone="warning">
                                        Zruší sa aj úloha pre {D.task.assignee} ({taskLabel}), pretože obchod bude uzavretý.
                                    </InfoPanel>
                                )}
                                {D.pending.length > 0 && (
                                    <InfoPanel>Vrátené výsledky, ktoré sa neposlali klientovi, sa uzavrú spolu s obchodom.</InfoPanel>
                                )}
                                <div className="space-y-2">
                                    <SectionLabel>Dôvod</SectionLabel>
                                    <Input
                                        data-vaul-no-drag
                                        placeholder="Napr. už majú dodávateľa (nepovinné)"
                                        value={reason}
                                        onChange={(e) => setReason(e.target.value)}
                                        className="h-11 text-[16px] md:text-sm"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Button
                                        variant="destructive"
                                        className="h-12 w-full text-base"
                                        disabled={pending}
                                        onClick={() => send("NOT_INTERESTED", "Nemajú záujem", { lostReason: reason.trim() || undefined })}
                                    >
                                        {pending ? "Ukladám…" : "Potvrdiť – nemajú záujem"}
                                    </Button>
                                    <Button variant="outline" className="h-11 w-full" disabled={pending} onClick={() => send("BAD_NUMBER", "Zlé číslo")}> 
                                        Zlé / nefunkčné číslo
                                    </Button>
                                    <Button variant="ghost" className="w-full" onClick={backToContact}> 
                                        <ArrowLeft className="mr-2 h-4 w-4" /> Späť
                                    </Button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </ResponsiveSheet>
    );
}
