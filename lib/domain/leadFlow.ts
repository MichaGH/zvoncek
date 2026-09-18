import {
    CallbackKind,
    CallOutcome,
    LeadStatus,
    NextActionKind,
    NextActionMode,
} from "@/app/generated/prisma/enums";
import { businessTodayStart, nextBusinessWorkingDayStart } from "@/lib/domain/businessTime";
import { nextStepOption } from "@/lib/domain/nextStepOptions";

// Prechody stavov – čisté funkcie bez DB. Kontrola prístupu, zámky a revízia sú v akciách.

export const FIRST_CALL_OUTCOMES = [
    "NO_ANSWER",
    "CALL_AGAIN",
    "SNOOZE",
    "NOT_INTERESTED",
    "BAD_NUMBER",
    "WANTS_QUOTE",
    "WANTS_EMAIL",
    "WANTS_DESIGN",
] as const satisfies readonly CallOutcome[];

export type FirstCallOutcome = (typeof FIRST_CALL_OUTCOMES)[number];

export const HANDOFF_OUTCOMES = ["WANTS_QUOTE", "WANTS_EMAIL", "WANTS_DESIGN"] as const;

export function isHandoffOutcome(outcome: CallOutcome): outcome is (typeof HANDOFF_OUTCOMES)[number] {
    return (HANDOFF_OUTCOMES as readonly string[]).includes(outcome);
}

export type NextActionFields = {
    nextActionKind: NextActionKind | null;
    nextActionAt: Date | null;
    nextActionHasTime: boolean;
    nextActionMode: NextActionMode;
    nextActionNote: string | null;
};

const NO_NEXT_ACTION: NextActionFields = {
    nextActionKind: null,
    nextActionAt: null,
    nextActionHasTime: false,
    nextActionMode: "SCHEDULED",
    nextActionNote: null,
};

export type CallStageState = {
    status: LeadStatus;
    callbackKind: CallbackKind | null;
    callbackAt: Date | null;
    callbackHasTime: boolean;
    callbackNote: string | null;
    lostReason: string | null;
    keepsAssignment: boolean;
} & NextActionFields;

// Stav po prvom hovore. `when` = vyriešený Schedule (CALL_AGAIN povinný, SNOOZE deň-only povinný).
// Výsledky fázy volania NEzapisujú nextAction* (staré hodnoty z legacy CALL_AGAIN/SNOOZE sa vymažú).
export function leadStateForOutcome(
    outcome: FirstCallOutcome,
    when: { at: Date; hasTime: boolean } | null,
    callbackNote: string | null,
    now: Date = new Date(),
): CallStageState {
    const cleared = { callbackKind: null, callbackAt: null, callbackHasTime: false, callbackNote: null };
    switch (outcome) {
        case "NO_ANSWER":
            return {
                status: "CALLING",
                callbackKind: "RETRY",
                callbackAt: null,
                callbackHasTime: false,
                callbackNote: callbackNote || null,
                lostReason: null,
                keepsAssignment: true,
                ...NO_NEXT_ACTION,
            };
        case "CALL_AGAIN":
            if (!when) throw new Error("CALL_AGAIN vyžaduje termín");
            return {
                status: "CALLING",
                callbackKind: "SCHEDULED",
                callbackAt: when.at,
                callbackHasTime: when.hasTime,
                callbackNote: callbackNote || null,
                lostReason: null,
                keepsAssignment: true,
                ...NO_NEXT_ACTION,
            };
        case "SNOOZE":
            if (!when || when.hasTime) throw new Error("SNOOZE vyžaduje deň bez času");
            return {
                status: "SNOOZED",
                callbackKind: null,
                callbackAt: when.at,
                callbackHasTime: false,
                callbackNote: callbackNote || null,
                lostReason: null,
                keepsAssignment: true,
                ...NO_NEXT_ACTION,
            };
        case "NOT_INTERESTED":
            return { status: "LOST", ...cleared, lostReason: "Nemajú záujem", keepsAssignment: false, ...NO_NEXT_ACTION };
        case "BAD_NUMBER":
            return {
                status: "UNREACHABLE",
                ...cleared,
                lostReason: "Zlé / nefunkčné číslo",
                keepsAssignment: false,
                ...NO_NEXT_ACTION,
            };
        case "WANTS_QUOTE":
            return {
                status: "ACTIVE",
                ...cleared,
                lostReason: null,
                keepsAssignment: false,
                nextActionKind: "SEND_QUOTE",
                nextActionAt: businessTodayStart(now),
                nextActionHasTime: false,
                nextActionMode: "SCHEDULED",
                nextActionNote: "Poslať cenu",
            };
        case "WANTS_EMAIL":
            return {
                status: "ACTIVE",
                ...cleared,
                lostReason: null,
                keepsAssignment: false,
                nextActionKind: "SEND_EMAIL",
                nextActionAt: businessTodayStart(now),
                nextActionHasTime: false,
                nextActionMode: "SCHEDULED",
                nextActionNote: "Poslať úvodný email (o nás + cenník)",
            };
        case "WANTS_DESIGN":
            return {
                status: "ACTIVE",
                ...cleared,
                lostReason: null,
                keepsAssignment: false,
                nextActionKind: "SEND_DESIGN",
                nextActionAt: businessTodayStart(now),
                nextActionHasTime: false,
                nextActionMode: "IN_PROGRESS",
                nextActionNote: "Vytvoriť a poslať dizajnový návrh",
            };
    }
}

// ── Follow-up na obchode (/dashboard/pipeline) ─────────────────────────────────

export const FOLLOW_UP_OUTCOMES = [
    "POSITIVE",
    "NO_ANSWER",
    "CALL_AGAIN",
    "WANTS_QUOTE",
    "WANTS_DESIGN",
    "WANTS_TO_ORDER",
    "SNOOZE",
    "NOT_INTERESTED",
    "BAD_NUMBER",
] as const satisfies readonly CallOutcome[];

export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

// Kroky, ktoré sa dajú vybrať po hovore. ORDER tu zámerne nie je – objednávku rieši výsledok
// WANTS_TO_ORDER (vytvorí požiadavku), nech existuje jedna cesta, nie dve.
export const FOLLOW_UP_NEXT_KINDS = ["CALL", "WAITING_FOR_CLIENT", "SEND_QUOTE", "SEND_DESIGN", "SEND_EMAIL", "CUSTOM"] as const;
export type FollowUpNextKind = (typeof FOLLOW_UP_NEXT_KINDS)[number];

export type DealFollowUpState = {
    status: LeadStatus;
    closes: boolean; // LOST/UNREACHABLE → closedAt = now + zavrieť požiadavky
    lostReason?: string | null;
    request?: "DESIGN" | "ORDER";
} & NextActionFields;

// Predpoklad: aktuálny stav ACTIVE alebo SNOOZED. Uzavreté obchody sa tu nikdy neotvárajú.
export function dealStateForFollowUp(
    outcome: FollowUpOutcome,
    input: {
        when: { at: Date; hasTime: boolean } | null;
        nextKind?: FollowUpNextKind | null;
        note?: string | null;
        lostReason?: string | null;
    },
    current: { status: LeadStatus },
    now: Date = new Date(),
): DealFollowUpState {
    if (current.status !== "ACTIVE" && current.status !== "SNOOZED") {
        throw new Error("Follow-up je možný len na otvorenom obchode");
    }
    const note = input.note?.trim() || null;
    switch (outcome) {
        case "POSITIVE": {
            const kind = input.nextKind;
            if (!kind) throw new Error("Vyber ďalší krok");
            // Pravidlá dátumu a režimu sú v zdieľanom zozname krokov, takže UI a server nemôžu tvrdiť niečo iné.
            const option = nextStepOption(kind);
            if (option?.date === "required" && !input.when) throw new Error("Tento krok vyžaduje termín");
            const startsToday = option?.date === "today" && !input.when;
            return {
                status: "ACTIVE",
                closes: false,
                nextActionKind: kind,
                nextActionAt: input.when?.at ?? (startsToday ? businessTodayStart(now) : null),
                nextActionHasTime: input.when?.hasTime ?? false,
                nextActionMode: option?.mode ?? "SCHEDULED",
                nextActionNote: note,
            };
        }
        case "NO_ANSWER": {
            // Predvolene „zavolať ďalší pracovný deň"; ak si volajúci vyberie iný krok alebo termín, rešpektuje sa
            // – výsledok hovoru (nedovolal sa) tým ostáva zaznamenaný (round 2, D-05).
            const kind = input.nextKind ?? "CALL";
            const option = nextStepOption(kind);
            const fallback =
                kind === "CALL" ? nextBusinessWorkingDayStart(now) : option?.date === "today" ? businessTodayStart(now) : null;
            return {
                status: current.status,
                closes: false,
                nextActionKind: kind,
                nextActionAt: input.when?.at ?? fallback,
                nextActionHasTime: input.when?.hasTime ?? false,
                nextActionMode: option?.mode ?? "SCHEDULED",
                nextActionNote: note ?? "Nezdvihli – skúsiť znova",
            };
        }
        case "CALL_AGAIN":
            if (!input.when) throw new Error("Dohodnutý hovor vyžaduje termín");
            return {
                status: "ACTIVE",
                closes: false,
                nextActionKind: "CALL",
                nextActionAt: input.when.at,
                nextActionHasTime: input.when.hasTime,
                nextActionMode: "SCHEDULED",
                nextActionNote: note ?? "Dohodnutý hovor",
            };
        case "WANTS_QUOTE":
            return {
                status: "ACTIVE",
                closes: false,
                nextActionKind: "SEND_QUOTE",
                nextActionAt: businessTodayStart(now),
                nextActionHasTime: false,
                nextActionMode: "SCHEDULED",
                nextActionNote: "Poslať cenu",
            };
        case "WANTS_DESIGN":
            return {
                status: "ACTIVE",
                closes: false,
                request: "DESIGN",
                nextActionKind: "SEND_DESIGN",
                nextActionAt: businessTodayStart(now),
                nextActionHasTime: false,
                nextActionMode: "IN_PROGRESS",
                nextActionNote: "Vytvoriť a poslať dizajnový návrh",
            };
        case "WANTS_TO_ORDER":
            // Nečaká sa na klienta, ale na manažéra – vlastný krok ORDER to na zozname aj povie (round 2, B-07).
            return {
                status: "ACTIVE",
                closes: false,
                request: "ORDER",
                nextActionKind: "ORDER",
                nextActionAt: null,
                nextActionHasTime: false,
                nextActionMode: "SCHEDULED",
                nextActionNote: "Čaká na potvrdenie manažéra",
            };
        case "SNOOZE":
            if (!input.when || input.when.hasTime) throw new Error("Odloženie vyžaduje deň");
            return {
                status: "SNOOZED",
                closes: false,
                nextActionKind: "CALL",
                nextActionAt: input.when.at,
                nextActionHasTime: false,
                nextActionMode: "SCHEDULED",
                nextActionNote: note ?? "Znovu osloviť neskôr",
            };
        case "NOT_INTERESTED":
            return {
                status: "LOST",
                closes: true,
                lostReason: input.lostReason?.trim() || "Nemajú záujem",
                ...NO_NEXT_ACTION,
            };
        case "BAD_NUMBER":
            return {
                status: "UNREACHABLE",
                closes: true,
                lostReason: "Zlé / nefunkčné číslo",
                ...NO_NEXT_ACTION,
            };
    }
}
