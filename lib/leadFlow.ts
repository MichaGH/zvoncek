import { CallOutcome, LeadStatus, CallbackKind } from "@/app/generated/prisma/enums";

export type LeadFlowData = {
    status: LeadStatus;
    callbackKind: CallbackKind | null;
    callbackAt?: Date | null;
    callbackNote?: string | null;
    nextActionAt?: Date | null;
    nextActionNote?: string | null;
    lostReason?: string | null;
};

// Čo daný výsledok hovoru znamená pre lead.
// `when` = dátum z drawera (callbackAt alebo nextActionAt podľa outcome)
// `callbackNote` = voliteľná poznámka od D
export function leadStateForOutcome(
    outcome: CallOutcome,
    when?: Date | null,
    callbackNote?: string | null,
): LeadFlowData {
    switch (outcome) {
        case "NO_ANSWER":
            return { status: "CALLING", callbackKind: "RETRY", callbackAt: null, callbackNote: callbackNote || null };
        case "CALL_AGAIN":
            return { status: "CALLING", callbackKind: "SCHEDULED", callbackAt: when ?? null, callbackNote: callbackNote || null };
        case "BAD_NUMBER":
            return { status: "UNREACHABLE", callbackKind: null, callbackAt: null, lostReason: "Zlé / nefunkčné číslo" };
        case "NOT_INTERESTED":
            return { status: "LOST", callbackKind: null, callbackAt: null, lostReason: "Nemajú záujem" };
        case "WANTS_QUOTE":
            return { status: "ACTIVE", callbackKind: null, callbackAt: null, nextActionAt: new Date(), nextActionNote: "Poslať cenovú ponuku" };
        case "WANTS_DESIGN":
            return { status: "ACTIVE", callbackKind: null, callbackAt: null, nextActionAt: new Date(), nextActionNote: "Vytvoriť a poslať dizajnový návrh" };
        case "WANTS_EMAIL":
            return { status: "ACTIVE", callbackKind: null, callbackAt: null, nextActionAt: new Date(), nextActionNote: "Napísať im email" };
        case "SNOOZE":
            return { status: "SNOOZED", callbackKind: null, callbackAt: null, nextActionAt: when ?? null, nextActionNote: "Znovu osloviť (chceli o pár mesiacov)" };
        case "POSITIVE":
            return { status: "ACTIVE", callbackKind: null, callbackAt: null };
    }
}

// ktorá sekcia /calls lead "opúšťa" pri danom outcome – pre optimistic odobratie
export function leavesCallsBoard(outcome: CallOutcome): boolean {
    // pri NO_ANSWER a CALL_AGAIN ostáva v CALLING (presunie sa do inej sekcie),
    // ostatné board opúšťajú úplne. Pre optimistic to nepotrebujeme rozlišovať –
    // vždy ho odoberieme zo zdrojovej sekcie, refetch ho prípadne vráti inde.
    return true;
}