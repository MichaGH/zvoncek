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
    Lock,
    Mail,
    MailWarning,
    MessageCircle,
    MessageSquare,
    Moon,
    PackageCheck,
    Palette,
    Phone,
    PhoneMissed,
    RefreshCw,
    Send,
    type LucideIcon,
} from "lucide-react";
import type { CallOutcome, DealTaskContent, DealTaskType, LeadStatus, NextActionKind, RequestContent } from "@/app/generated/prisma/enums";
import { InfoPanel, OptionCard, RequestContentPicker, type Tone } from "@/components/shared/OptionCard";
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
import { isSystemStep, REQUEST_CONTENT_LABEL, stepKindForOutstanding } from "@/lib/domain/clientRequests";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";
import { type FollowUpNextKind, type FollowUpOutcome } from "@/lib/domain/leadFlow";
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
    task: { id: string; type: DealTaskType; contents: DealTaskContent[]; openKinds: DealTaskContent[]; assignee: string } | null;
    pending: PendingItem[];
    outstanding?: RequestContent[]; // čo je nevybavené – z toho vyplýva predvolený krok (§6.8)
    // Otvorené požiadavky klienta po riadkoch: odloženie / uzavretie ich stiahne presne menovanými id (R01-3).
    openRequests?: { id: string; content: RequestContent }[];
    stepHeadline?: string | null; // „Poslať návrh + cenu + cenník" – skutočný nadpis kroku, keď je odvodený z nevybaveného
    // Wave 5: ktorú cenu klient naozaj videl (§3.3) a či videl aspoň cenník.
    clientPrice?: { amount: string; channel: "EMAIL" | "PHONE"; via?: "SMS"; sentOn: string } | null;
    gotPricelist?: boolean;
};

// wave-5-workflow.md §2: „price" je vlastná otázka (Q1), nie zaškrtávacie políčko vopchané medzi odpovede.
type Step = "contact" | "price" | "reply" | "wants" | "next" | "snooze" | "lost" | "sms";
type ReplyChoice = "WANTS" | "OTHER" | string;

function SectionLabel({ children }: { children: ReactNode }) {
    return <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;
}

const REPLY_CARD: Record<string, { icon: LucideIcon; tone: Tone }> = {
    NOT_LOOKED_YET: { icon: EyeOff, tone: "slate" },
    WANTS_CHANGES: { icon: RefreshCw, tone: "violet" },
    RESEND: { icon: MailWarning, tone: "orange" },
    WILL_CONTACT_US: { icon: Clock3, tone: "teal" },
    DECIDING: { icon: CalendarClock, tone: "blue" },
    PRICE_HIGH: { icon: BadgeEuro, tone: "orange" },
    WANTS_TO_ORDER: { icon: Handshake, tone: "green" },
};

const NEXT_CARD: Record<FollowUpNextKind, { icon: LucideIcon; tone: Tone }> = {
    CALL: { icon: Phone, tone: "blue" },
    WAITING_FOR_CLIENT: { icon: Clock3, tone: "teal" },
    SEND_QUOTE: { icon: BadgeEuro, tone: "green" },
    SEND_DESIGN: { icon: Palette, tone: "violet" },
    SEND_EMAIL: { icon: Mail, tone: "blue" },
    CUSTOM: { icon: CircleEllipsis, tone: "slate" },
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
// „Poslať …" sa NEVYBERÁ – vyplýva z toho, čo klient ešte nedostal (wave-5-workflow.md §1). Naplánovať sa dá len
// hovor, čakanie na klienta alebo vlastný krok.
const PLANNABLE_KINDS: FollowUpNextKind[] = ["CALL", "WAITING_FOR_CLIENT", "CUSTOM"];
const NEXT_STEPS = NEXT_STEP_OPTIONS.filter((o) => PLANNABLE_KINDS.includes(o.kind as FollowUpNextKind));

// Termíny, ktoré sa v hovoroch opakujú. Obchodné kalendárne dni – to isté, čo používajú predvoľby odpovedí.
const DATE_PRESETS: { label: string; days: number }[] = [
    { label: "Zajtra", days: 1 },
    { label: "O 3 dni", days: 3 },
    { label: "O týždeň", days: 7 },
    { label: "O 2 týždne", days: 14 },
];

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
    const [overlap, setOverlap] = useState<"KEEP_OPEN" | "WITHDRAW_PARTS" | null>(null);
    const [useReturnedPrice, setUseReturnedPrice] = useState(true);
    const [acknowledge, setAcknowledge] = useState(true);
    const [dropReason, setDropReason] = useState("");
    // „Požiadať manažéra" ako ďalší krok (dnes) – po uložení sa hneď otvorí dialóg žiadosti.
    const [managerStep, setManagerStep] = useState(false);
    // Po „Poslali sme SMS": krok ostáva, aký bol (SMS je kontakt, nie rozhodnutie o ďalšom kroku).
    const [keepCurrent, setKeepCurrent] = useState(false);

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
    // Wave 4 (§2.8): prekrýva sa len to, čo manažér EŠTE ROBÍ – dodanú cenu už obchodník pokojne povie.
    const priceTask = locked && D.task?.type === "HELP" && D.task.openKinds.includes("PRICE");
    // Cena povedaná v hovore – len pri „dovolal/a som sa".
    const phonePrice =
        (contact === "ANSWERED" || contact === "SMS") && toldPrice && toldValid && toldAmountNumber !== null
            ? { amount: toldAmountNumber, ...(toldNote !== null ? { note: toldNote.trim() || null } : {}) }
            : undefined;
    // Voľba pri prekryve platí len, kým je povedaná cena zaškrtnutá (R02-2) – po odškrtnutí sa skrytá voľba neposiela.
    const choice = phonePrice && priceTask ? overlap : null;
    // Stiahnutie ceny z úlohy zatvorí len vtedy, keď je cena jediná robiaca sa časť; inak zvyšok úlohy beží ďalej a krok
    // ostáva zamknutý (zapíše sa len kontakt a cena) – také stiahnutie teda NIE JE „zrušiť + zmeniť".
    const withdrawing = locked && choice === "WITHDRAW_PARTS";
    const withdrawClosesTask = withdrawing && (D.task?.openKinds.every((k) => k === "PRICE") ?? false);
    // Pri „Zrušiť úlohu" z detailu a keď sa po povedanej cene ruší celá úloha, ide o zrušenie + zmenu.
    const cancelling = locked && (replan?.cancel === true || contact === "NONE" || step === "snooze" || withdrawClosesTask);
    const factOnly = locked && !cancelling && step !== "lost";
    const fulfilsPrice =
        phonePrice && priceItem && useReturnedPrice && priceItem.price && moneyToString(phonePrice.amount) === priceItem.price.amount
            ? [{ taskId: priceItem.taskId, kind: "PRICE" as const }]
            : undefined;
    // R02-4: SMS s cenou dokončuje aj systémový krok „Poslať …" – ten sa nedá „ponechať" (ostal by krok na poslanie ceny,
    // ktorá už odišla), takže voľba sa neponúka a ďalší krok si rep zvolí sám. Naplánovaný hovor / čakanie / vlastný
    // krok SMS nemení, tie sa ponechať dajú vždy.
    const keepOffered = contact === "SMS" && D.nextActionKind !== null && !(phonePrice && isSystemStep(D.nextActionKind));
    const keepStepNow = keepCurrent && keepOffered && step === "next";
    const dateMissing = !keepStepNow && stepOption?.date === "required" && !date;
    const replyOption = CLIENT_REPLIES.find((r) => r.key === reply);
    // Nikdy tu nie je „Poslať …" – to určuje nevybavená práca, nie výber (wave-5-workflow.md §1, §3).
    const allowedKinds: FollowUpNextKind[] = (
        allSteps ? PLANNABLE_KINDS : (replyOption?.nextKinds ?? PLANNABLE_KINDS)
    ).filter((k) => PLANNABLE_KINDS.includes(k));
    const shownSteps = allowedKinds
        .map((k) => NEXT_STEPS.find((o) => o.kind === k))
        .filter((o): o is (typeof NEXT_STEPS)[number] => Boolean(o));

    // Vrátené položky: odpoveď / zamietnutie sa predvolene berie na vedomie; neposlaná cena / návrh drží krok „Poslať…"
    // (I10) – iný krok je možný len s „Neposielam" a dôvodom.
    const ackItems = D.pending.filter((i) => i.kind === "OTHER" || i.kind === "DECLINED");
    const sendItems = D.pending.filter((i) => (i.kind === "PRICE" || i.kind === "DESIGN") && !(fulfilsPrice && i === priceItem));
    const required = requiredStepKinds(sendItems);
    const dropsSendItems = !factOnly && !keepStepNow && step === "next" && required !== null && !required.includes(kind);
    const snoozeDrops = step === "snooze" && sendItems.length > 0;
    // R01-3: odloženie obchodu s nevybavenými požiadavkami klienta = rozhodnutie, že sa neposielajú (s dôvodom). Uzavretie
    // rieši obrazovka „lost" vlastným poľom dôvodu.
    const openRequests = D.openRequests ?? [];
    const withdrawsAsks = step === "snooze" && openRequests.length > 0;
    const unsentAskLabels = [...new Set(openRequests.map((r) => REQUEST_CONTENT_LABEL[r.content].toLowerCase()))];
    const withdrawPayload = (why: string) => (openRequests.length ? { withdraw: { ids: openRequests.map((r) => r.id), reason: why } } : {});
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
    const dropMissing = ((dropsSendItems || snoozeDrops) && !decidesResults) || ((dropsSendItems || snoozeDrops || withdrawsAsks) && !dropReason.trim());
    const cancelMissing = (cancelling || withdrawing) && !cancelReason.trim();
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
        extra: {
            schedule?: Schedule | null;
            nextKind?: FollowUpNextKind;
            lostReason?: string;
            reply?: string | null;
            stepNote?: string | null;
            stepFromRequests?: boolean;
            keepStep?: boolean;
            withdraw?: { ids: string[]; reason: string };
        } = {},
        askedForContact: RequestContent[] = asked,
    ) {
        const closing = outcome === "NOT_INTERESTED" || outcome === "BAD_NUMBER";
        const fact = locked && !cancelling && !closing;
        const offerHandover = extra.reply === "WANTS_TO_ORDER" && !fact && caps.askManager && isOwner && onAsk;
        const askAfter = managerStep && !fact && !closing && caps.askManager && isOwner && onAsk;
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
                        // Prekryv s povedanou cenou stiahne len ČASŤ „cena"; zvyšok úlohy beží ďalej (§2.8).
                        ...(choice === "WITHDRAW_PARTS" && D.task
                            ? { withdrawParts: { taskId: D.task.id, kinds: ["PRICE" as const], reason: cancelReason.trim() } }
                            : {}),
                        // Zrušenie CELEJ úlohy (odloženie, uzavretie, „zrušiť + zmeniť") ostáva samostatným vstupom.
                        ...(locked && (cancelling || closing) && D.task && choice !== "WITHDRAW_PARTS"
                            ? { cancelTask: { taskId: D.task.id, reason: closing ? null : cancelReason.trim() } }
                            : {}),
                        ...(dismiss && !closing ? { dismiss } : {}),
                        // Čo klient v tomto kontakte pýtal – zapíše sa aj pri zamknutom kroku, je to fakt o klientovi.
                        ...(askedForContact.length && !closing && (contact === "ANSWERED" || contact === "REPLIED")
                            ? { asked: askedForContact }
                            : {}),
                        ...(fact ? { reply: extra.reply ?? null } : extra),
                    });
                    handle(r, `Zaznamenané: ${label}`, run, offerHandover ? () => onAsk?.("HANDOVER") : askAfter ? () => onAsk?.("HELP") : undefined);
                } catch {
                    toast.error("Chyba siete", { action: { label: "Skúsiť znova", onClick: run } });
                }
            });
        run();
    }

    // Uloženie z obrazovky „ďalší krok": výsledok hovoru sa zachová (nezdvihli ostane nezdvihli).
    function saveNextStep() {
        if (keepStepNow) {
            send("POSITIVE", "SMS – krok ostáva", { keepStep: true });
            return;
        }
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
            saveFact(option.outcome, option.label, key, option.asks ?? asked);
            return;
        }
        // Odpoveď, ktorá si krok určí sama (chcú zmeny = prepracovaný návrh), sa uloží hneď – žiadna druhá otázka.
        if (option.terminal || option.decidesStep) {
            const wanted = stepKindForOutstanding([...(D.outstanding ?? []), ...(option.asks ?? [])]);
            send(option.outcome, option.label, { reply: key, nextKind: (wanted as FollowUpNextKind | null) ?? "CALL" }, option.asks ?? asked);
            return;
        }
        // Odpoveď, ktorá sama JE požiadavkou (chcú zmeny = prepracovaný návrh), ju zapíše aj cez obrazovku kroku.
        if (option.asks?.length) setAsked(option.asks);
        // „Požiadať manažéra" je predvolený krok dnes pri odpovediach, kde sa rep bez manažéra zvyčajne neobíde.
        if (option.managerStep && canAskManager) {
            setManagerStep(true);
            setKind("CUSTOM");
            setStepNote("Požiadať manažéra");
            setDate(businessDate(new Date()));
            setTime("");
            setStep("next");
            return;
        }
        setManagerStep(false);
        if (option.nextKind) setKind(option.nextKind);
        setStepNote(null);
        setDate(!phonePrice && option.days ? addBusinessCalendarDays(businessDate(new Date()), option.days) : "");
        setTime("");
        setStep("next");
    }

    // Jedna otázka, jedna odpoveď, jeden klik (wave-5-workflow.md §2). Žiadne medzistavy, ktoré sa dali kombinovať.
    function chooseReply(choice: ReplyChoice) {
        setReplyChoice(choice);
        setAllSteps(false);
        if (choice === "WANTS") {
            setReply(null);
            setAskedDraft(asked);
            setStep("wants");
            return;
        }
        setAsked([]);
        setAskedDraft([]);
        setReply(choice === "OTHER" ? null : choice);
        if (choice === "OTHER") {
            if (factOnly) saveFact("POSITIVE", CONTACT_LABEL[contact]);
            else {
                setKind("CALL");
                setStepNote(null);
                setDate("");
                setTime("");
                setStep("next");
            }
            return;
        }
        continueWithReply(choice);
    }

    function backToContact() {
        setManagerStep(false);
        setKeepCurrent(false);
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
        setManagerStep(false);
        setKeepCurrent(false);
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
    const canAskManager = Boolean(caps.askManager && isOwner && onAsk && !locked);
    const taskLabel = D.task
        ? D.task.type === "HANDOVER"
            ? "odovzdanie klienta"
            : D.task.openKinds.map((c) => TASK_CONTENT_LABEL[c].toLowerCase()).join(" + ")
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
                        {D.clientPrice.channel === "PHONE" ? (D.clientPrice.via === "SMS" ? " (SMS)" : " (telefonicky)") : ""} {businessDayMonth(new Date(D.clientPrice.sentOn))}
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

    const cancelBox = (cancelling || withdrawing) && D.task && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p>
                {withdrawing && !withdrawClosesTask
                    ? `Týmto stiahneš z úlohy pre ${D.task.assignee} len cenu – zvyšok beží ďalej.`
                    : `Týmto zrušíš úlohu pre ${D.task.assignee} (${taskLabel}) – ako tvoje rozhodnutie, bez schválenia.`}
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

    const dropBox = (dropsSendItems || snoozeDrops || withdrawsAsks) && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {withdrawsAsks && (
                <p>
                    Klient chcel: {unsentAskLabels.join(", ")}. Odložením sa to nepošle a stiahne sa to z „Chceli“.
                </p>
            )}
            {(dropsSendItems || snoozeDrops) && (
                <p>
                    Ešte neposlané: {sendItems.map((i) => i.label).join(", ")}.{" "}
                    {decidesResults
                        ? "Iný krok než „Poslať…“ znamená, že sa to neposiela."
                        : "Či sa to pošle, rozhoduje vlastník obchodu – krok ostáva „Poslať…“."}
                </p>
            )}
            {(decidesResults || withdrawsAsks) && (
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
                                            tone="blue"
                                            disabled={pending || !canWork}
                                            onClick={() => startContact("ANSWERED", locked ? "reply" : "price")}
                                        />
                                        <OptionCard
                                            label="Nezdvihli"
                                            hint="Zaznamenať pokus a naplánovať ďalší"
                                            icon={PhoneMissed}
                                            tone="slate"
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
                                            tone="blue"
                                            disabled={pending || !canWork}
                                            onClick={() => startContact("REPLIED", "reply")}
                                        />
                                        <OptionCard
                                            label="Poslali sme SMS"
                                            hint="Uložiť text správy a ďalší krok"
                                            icon={MessageSquare}
                                            tone="teal"
                                            disabled={pending || !canWork}
                                            onClick={() => startContact("SMS", "price")}
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
                                                tone="green"
                                                disabled={pending || !canWork}
                                                onClick={onRecordOffer}
                                            />
                                        )}
                                        {(!locked || canCancelAndChange) && (
                                            <OptionCard
                                                label="Iba zmeniť ďalší krok"
                                                hint={locked ? "Bez kontaktu – zruší otvorenú úlohu" : "Bez nového kontaktu s klientom"}
                                                icon={CalendarClock}
                                                tone="slate"
                                                disabled={pending || !canWork}
                                                onClick={() => startContact("NONE", "next")}
                                            />
                                        )}
                                        {(!locked || canCancelAndChange) && (
                                            <OptionCard
                                                label="Ozvať sa o pár mesiacov"
                                                hint={locked ? "Odloží obchod a zruší otvorenú úlohu" : "Odložiť obchod na neskôr"}
                                                icon={Moon}
                                                tone="violet"
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
                                            tone="blue"
                                            role="radio"
                                            on={replyChoice === "WANTS"}
                                            disabled={pending || blockedHere}
                                            onClick={() => chooseReply("WANTS")}
                                        />
                                        {FOLLOW_UP_REPLIES.map((r) => (
                                            <OptionCard
                                                key={r.key}
                                                label={r.label}
                                                icon={REPLY_CARD[r.key]?.icon ?? MessageCircle}
                                                tone={REPLY_CARD[r.key]?.tone ?? "neutral"}
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

                                <Button
                                    variant="ghost"
                                    className="w-full"
                                    onClick={() => (contact === "ANSWERED" ? setStep("price") : backToContact())}
                                >
                                    <ArrowLeft className="mr-2 h-4 w-4" /> Späť
                                </Button>
                            </div>
                        )}

                        {/* Wave 5: čo klient chce – prepínateľné karty a jedno „Pokračovať". Predtým to boli
                            zaškrtávacie políčka bez potvrdenia, takže sa nedalo pokračovať (Michal, 2026-09-20). */}
                        {/* Q1 – povedali sme cenu? Vlastná obrazovka, jedným klikom sa dá preskočiť. */}
                        {step === "price" && (
                            <div className="space-y-5">
                                <div className="space-y-2">
                                    <SectionLabel>{contact === "SMS" ? "Bola v SMS cena?" : "Povedali ste cenu?"}</SectionLabel>
                                <div className="space-y-3 rounded-xl bg-muted/55 p-3">
                                        <OptionCard
                                            label={contact === "SMS" ? "V SMS bola konkrétna cena" : "Povedal/a som konkrétnu cenu"}
                                            hint="Zapíše sa, že klient túto sumu už pozná"
                                            icon={BadgeEuro}
                                            tone="green"
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
                                                                Nech ju dorobí
                                                            </label>
                                                            {canCancelAndChange && (
                                                                <label className="flex items-center gap-2">
                                                                    <input
                                                                        type="radio"
                                                                        checked={overlap === "WITHDRAW_PARTS"}
                                                                        onChange={() => setOverlap("WITHDRAW_PARTS")}
                                                                    />
                                                                    Už ju netreba – stiahnuť cenu
                                                                    {(D.task?.openKinds.length ?? 0) > 1 ? " (zvyšok úlohy beží ďalej)" : ""}
                                                                </label>
                                                            )}
                                                        </div>
                                                    </InfoPanel>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Button
                                        className="h-12 w-full text-base"
                                        disabled={pending || (toldPrice && !toldValid) || Boolean(overlapMissing)}
                                        onClick={() => {
                                            if (contact !== "SMS") return setStep("reply");
                                            if (locked) return setStep("sms");
                                            // Predvolené len pri zámerne naplánovanom kroku; systémový „Poslať …" ostáva na výber.
                                            setKeepCurrent(D.nextActionKind !== null && !isSystemStep(D.nextActionKind) && !toldPrice);
                                            setKind("CALL");
                                            setStepNote(null);
                                            setDate("");
                                            setTime("");
                                            setStep("next");
                                        }}
                                    >
                                        {toldPrice ? "Pokračovať s cenou" : contact === "SMS" ? "Bez ceny – pokračovať" : "Cenu sme nepovedali – pokračovať"}
                                        <ChevronRight className="ml-1 h-4 w-4" />
                                    </Button>
                                    <Button variant="ghost" className="w-full" onClick={backToContact}>
                                        <ArrowLeft className="mr-2 h-4 w-4" /> Späť
                                    </Button>
                                </div>
                            </div>
                        )}

                        {step === "wants" && (
                            <div className="space-y-5">
                                <div className="space-y-2">
                                    <SectionLabel>Čo chcú poslať</SectionLabel>
                                    <RequestContentPicker
                                        value={askedDraft}
                                        disabled={pending}
                                        onToggle={(content) =>
                                            setAskedDraft((cur) => (cur.includes(content) ? cur.filter((c) => c !== content) : [...cur, content]))
                                        }
                                    />
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
                                            // wave-5-workflow.md §2b: povedať ČO chcú už krok určilo – server ho odvodí z toho, čo
                                            // ostane nevybavené PO zápise (R01-2). Telefonická cena z tohto hovoru spĺňa každú
                                            // otvorenú požiadavku na cenu, okrem vrátenej ceny od manažéra, ktorá sa nepoužila.
                                            const remaining = new Set<RequestContent>([...(D.outstanding ?? []), ...confirmed]);
                                            const preparedPriceStays = D.pending.some((i) => i.kind === "PRICE") && !fulfilsPrice;
                                            if (phonePrice && !preparedPriceStays) remaining.delete("PRICE");
                                            if (remaining.size === 0) {
                                                // Všetko, čo pýtali, už povedaná cena pokryla – nezostáva nič na poslanie, takže krok
                                                // si vyberá používateľ (Q3): zavolať, čakať alebo vlastný krok.
                                                setKind("CALL");
                                                setStepNote(null);
                                                setDate("");
                                                setTime("");
                                                setStep("next");
                                                return;
                                            }
                                            send(
                                                "POSITIVE",
                                                `Chcú ${confirmed.map((c) => REQUEST_CONTENT_LABEL[c].toLowerCase()).join(" + ")}`,
                                                { stepFromRequests: true, reply: null },
                                                confirmed,
                                            );
                                        }}
                                    >
                                        {askedDraft.length === 0 ? "Vyber, čo chcú" : pending ? "Ukladám…" : "Uložiť"}
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
                                        {keepOffered && D.nextActionKind && (
                                            <OptionCard
                                                role="radio"
                                                label="Ponechať aktuálny krok"
                                                hint={D.stepHeadline ?? D.nextActionNote ?? NEXT_ACTION_LABEL[D.nextActionKind]}
                                                icon={Lock}
                                                tone="slate"
                                                on={keepCurrent}
                                                disabled={pending}
                                                onClick={() => setKeepCurrent(true)}
                                            />
                                        )}
                                        {replyOption?.managerStep && canAskManager && (
                                            <OptionCard
                                                role="radio"
                                                label="Požiadať manažéra"
                                                hint="Krok na dnes – hneď otvorí žiadosť"
                                                icon={Handshake}
                                                tone="green"
                                                on={managerStep}
                                                disabled={pending}
                                                onClick={() => {
                                                    setKeepCurrent(false);
                                                    setManagerStep(true);
                                                    setKind("CUSTOM");
                                                    setStepNote("Požiadať manažéra");
                                                    setDate(businessDate(new Date()));
                                                    setTime("");
                                                }}
                                            />
                                        )}
                                        {shownSteps.map((o) => {
                                            const copy = nextStepCopy(o.kind as FollowUpNextKind, reply);
                                            return (
                                                <OptionCard
                                                    key={o.kind}
                                                    role="radio"
                                                    label={copy.label}
                                                    hint={copy.hint}
                                                    icon={NEXT_CARD[o.kind as FollowUpNextKind].icon}
                                                    tone={NEXT_CARD[o.kind as FollowUpNextKind].tone}
                                                    on={kind === o.kind && !managerStep && !keepStepNow}
                                                    disabled={pending}
                                                    onClick={() => {
                                                        if (managerStep) setDate("");
                                                        setManagerStep(false);
                                                        setKeepCurrent(false);
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

                                {!keepStepNow && (
                                <div className="space-y-3 rounded-xl bg-muted/55 p-3">
                                    <SectionLabel>Termín a poznámka ku kroku</SectionLabel>
                                    {/* Najčastejšie termíny jedným klikom – ručný dátum ostáva pod nimi. */}
                                    <div className="flex flex-wrap gap-2">
                                        {DATE_PRESETS.map((preset) => {
                                            const value = addBusinessCalendarDays(businessDate(new Date()), preset.days);
                                            return (
                                                <Button
                                                    key={preset.label}
                                                    type="button"
                                                    size="sm"
                                                    variant={date === value ? "default" : "outline"}
                                                    className="h-9 rounded-full px-3.5"
                                                    disabled={pending}
                                                    onClick={() => setDate(date === value ? "" : value)}
                                                >
                                                    {preset.label}
                                                </Button>
                                            );
                                        })}
                                    </div>
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
                                )}

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
                                                  ? decidesResults || !(dropsSendItems || snoozeDrops)
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
                                                onClick={() =>
                                                    send("SNOOZE", `O ${m} mesiace`, {
                                                        schedule: { kind: "monthsFromToday", months: m },
                                                        ...withdrawPayload(dropReason.trim()),
                                                    })
                                                }
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
                                            onClick={() =>
                                                send("SNOOZE", "Vlastný termín", { schedule: { kind: "day", date }, ...withdrawPayload(dropReason.trim()) })
                                            }
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
                                {openRequests.length > 0 && (
                                    <InfoPanel icon={PackageCheck} tone="warning">
                                        Klient chcel: {unsentAskLabels.join(", ")}. Uzavretím sa to nepošle – dôvod je povinný.
                                    </InfoPanel>
                                )}
                                <div className="space-y-2">
                                    <SectionLabel>Dôvod</SectionLabel>
                                    <Input
                                        data-vaul-no-drag
                                        placeholder={openRequests.length ? "Napr. už majú dodávateľa" : "Napr. už majú dodávateľa (nepovinné)"}
                                        value={reason}
                                        onChange={(e) => setReason(e.target.value)}
                                        className="h-11 text-[16px] md:text-sm"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Button
                                        variant="destructive"
                                        className="h-12 w-full text-base"
                                        disabled={pending || (openRequests.length > 0 && !reason.trim())}
                                        onClick={() =>
                                            send("NOT_INTERESTED", "Nemajú záujem", {
                                                lostReason: reason.trim() || undefined,
                                                ...withdrawPayload(reason.trim()),
                                            })
                                        }
                                    >
                                        {pending ? "Ukladám…" : openRequests.length > 0 && !reason.trim() ? "Napíš dôvod" : "Potvrdiť – nemajú záujem"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        className="h-11 w-full"
                                        disabled={pending}
                                        onClick={() => send("BAD_NUMBER", "Zlé číslo", withdrawPayload(reason.trim() || "zlé číslo"))}
                                    >
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
