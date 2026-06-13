import { ActivityType, CallOutcome, LeadStatus } from "@/app/generated/prisma/enums";

export const STATUS_LABEL: Record<LeadStatus, string> = {
    NEW: "Nový",
    CALLING: "Volá sa",
    ACTIVE: "Aktívny",
    SNOOZED: "Spí",
    WON: "Vyhraný",
    LOST: "Stratený",
    UNREACHABLE: "Nedostupný",
};

export const STATUS_VARIANT: Record<
    LeadStatus,
    "default" | "secondary" | "outline" | "destructive"
> = {
    NEW: "outline",
    CALLING: "outline",
    ACTIVE: "default",
    SNOOZED: "secondary",
    WON: "secondary",
    LOST: "destructive",
    UNREACHABLE: "destructive",
};

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
    NO_ANSWER: "Nezdvihli",
    BAD_NUMBER: "Zlé číslo",
    NOT_INTERESTED: "Nemajú záujem",
    CALL_AGAIN: "Zavolať neskôr",
    WANTS_QUOTE: "Chcú cenovú ponuku",
    WANTS_DESIGN: "Chcú návrh",
    WANTS_EMAIL: "Máme napísať",
    SNOOZE: "Ozvať sa neskôr",
    POSITIVE: "Pozitívny posun",
};

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
    CALL: "Hovor",
    QUOTE_SENT: "Poslaná CP",
    DESIGN_SENT: "Poslaný návrh",
    EMAIL_SENT: "Email",
    SMS_SENT: "SMS",
    NOTE: "Poznámka",
};
