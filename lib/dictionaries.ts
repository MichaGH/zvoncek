import {
    ActivityCategory,
    ActivitySource,
    ActivityType,
    CallOutcome,
    LeadStatus,
    NextActionKind,
} from "@/app/generated/prisma/enums";

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
    NEXT_ACTION_SET: "Ďalší krok nastavený",
    NEXT_ACTION_CHANGED: "Ďalší krok zmenený",
    NEXT_ACTION_CLEARED: "Ďalší krok vymazaný",
    CONTACT_UPDATED: "Kontakt upravený",
    STATUS_CHANGED: "Stav zmenený",
    OWNER_CHANGED: "Vlastník zmenený",
    OUTCOME_CORRECTED: "Výsledok hovoru opravený",
};

export const ACTIVITY_CATEGORY_LABEL: Record<ActivityCategory, string> = {
    BUSINESS: "Obchodná história",
    PLANNING: "Plánovanie",
    AUDIT: "Interné úpravy",
};

export const ACTIVITY_SOURCE_LABEL: Record<ActivitySource, string> = {
    CALL_QUEUE: "Volania",
    PIPELINE: "Pipeline",
    CONTACTS: "Kontakty",
    ADMIN: "Administrácia",
};

export const NEXT_ACTION_LABEL: Record<NextActionKind, string> = {
    CALL: "Zavolať",
    SEND_QUOTE: "Poslať cenovú ponuku",
    SEND_DESIGN: "Poslať návrh",
    SEND_EMAIL: "Poslať email",
    WAITING_FOR_CLIENT: "Čakáme na klienta",
    CUSTOM: "Vlastný krok",
};
