import {
    CallbackKind,
    CallOutcome,
    LeadStatus,
    NextActionKind,
    NextActionMode,
} from "@/app/generated/prisma/enums";

export type LeadFlowData = {
    status: LeadStatus;
    callbackKind: CallbackKind | null;
    callbackAt?: Date | null;
    callbackHasTime?: boolean;
    callbackNote?: string | null;
    nextActionKind?: NextActionKind | null;
    nextActionAt?: Date | null;
    nextActionHasTime?: boolean;
    nextActionMode?: NextActionMode;
    nextActionNote?: string | null;
    lostReason?: string | null;
};

export function leadStateForOutcome(
    outcome: CallOutcome,
    when?: Date | null,
    callbackNote?: string | null,
    hasTime: boolean = false,
): LeadFlowData {
    switch (outcome) {
        case "NO_ANSWER":
            return {
                status: "CALLING",
                callbackKind: "RETRY",
                callbackAt: null,
                callbackNote: callbackNote || null,
                nextActionKind: null,
                nextActionAt: null,
                nextActionNote: null,
            };
        case "CALL_AGAIN":
            return {
                status: "CALLING",
                callbackKind: "SCHEDULED",
                callbackAt: when ?? null,
                callbackHasTime: hasTime,
                callbackNote: callbackNote || null,
                nextActionKind: "CALL",
                nextActionAt: when ?? null,
                nextActionHasTime: hasTime,
                nextActionMode: "SCHEDULED",
                nextActionNote: callbackNote || "Dohodnutý spätný hovor",
            };
        case "BAD_NUMBER":
            return {
                status: "UNREACHABLE",
                callbackKind: null,
                callbackAt: null,
                nextActionKind: null,
                nextActionAt: null,
                nextActionNote: null,
                lostReason: "Zlé / nefunkčné číslo",
            };
        case "NOT_INTERESTED":
            return {
                status: "LOST",
                callbackKind: null,
                callbackAt: null,
                nextActionKind: null,
                nextActionAt: null,
                nextActionNote: null,
                lostReason: "Nemajú záujem",
            };
        case "WANTS_QUOTE":
            return {
                status: "ACTIVE",
                callbackKind: null,
                callbackAt: null,
                nextActionKind: "SEND_QUOTE",
                nextActionAt: new Date(), // dnes – deň bez presného času → svieti "dnes"
                nextActionHasTime: false,
                nextActionMode: "SCHEDULED",
                nextActionNote: "Poslať cenovú ponuku",
            };
        case "WANTS_DESIGN":
            return {
                status: "ACTIVE",
                callbackKind: null,
                callbackAt: null,
                nextActionKind: "SEND_DESIGN",
                nextActionAt: new Date(), // dátum vyžiadania – ráta sa „trvá X dní"
                nextActionHasTime: false,
                nextActionMode: "IN_PROGRESS", // rozpracované, nie termín → modré, nie červené
                nextActionNote: "Vytvoriť a poslať dizajnový návrh",
            };
        case "WANTS_EMAIL":
            return {
                status: "ACTIVE",
                callbackKind: null,
                callbackAt: null,
                nextActionKind: "SEND_EMAIL",
                nextActionAt: new Date(),
                nextActionHasTime: false,
                nextActionMode: "SCHEDULED",
                nextActionNote: "Napísať email / poslať informácie o nás",
            };
        case "SNOOZE":
            return {
                status: "SNOOZED",
                callbackKind: null,
                callbackAt: when ?? null, // dátum „ozvať sa" – aby sa dal snoozed vynoriť v calls
                callbackHasTime: false, // snooze je vždy len deň, nikdy presný čas
                callbackNote: callbackNote || null,
                nextActionKind: "CALL",
                nextActionAt: when ?? null,
                nextActionHasTime: false,
                nextActionMode: "SCHEDULED",
                nextActionNote: callbackNote || "Znovu osloviť neskôr",
            };
        case "POSITIVE":
            return { status: "ACTIVE", callbackKind: null, callbackAt: null };
    }
}

export function hasNextAction(data: LeadFlowData): boolean {
    return Boolean(data.nextActionKind || data.nextActionAt || data.nextActionNote);
}

export function leavesCallsBoard(): boolean {
    return true;
}
