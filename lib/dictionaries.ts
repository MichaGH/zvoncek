import {
    ActivityCategory,
    ActivitySource,
    ActivityType,
    CallOutcome,
    LeadStatus,
    NextActionKind,
    TrackedLinkKind,
} from "@/app/generated/prisma/enums";
import type { Confidence } from "@/lib/tracking/confidence";

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
    // Unreachable is a dead-number state, not a lost deal — keep it visually distinct from LOST.
    UNREACHABLE: "outline",
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
    TRACKER_ATTACHED: "Tracker pripojený",
    TRACKER_UPDATED: "Dizajn aktualizovaný",
    TRACKER_OPENED: "Klient otvoril",
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

export const TRACKED_LINK_KIND_LABEL: Record<TrackedLinkKind, string> = {
    DESIGN: "Dizajn",
    QUOTE: "Cenová ponuka",
    OTHER: "Iné",
};

// Tracking confidence – "signál, nie dôkaz". Pozri docs/tracking-system-plan.md.
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
    none: "Neotvorené",
    weak: "Slabý signál",
    medium: "Pravdepodobne otvorené",
    high: "Otvorené",
    very_high: "Otvorené · silný signál",
};

export const CONFIDENCE_VARIANT: Record<
    Confidence,
    "default" | "secondary" | "outline" | "destructive"
> = {
    none: "outline",
    weak: "outline",
    medium: "secondary",
    high: "default",
    very_high: "default",
};

export const NEXT_ACTION_LABEL: Record<NextActionKind, string> = {
    CALL: "Zavolať",
    SEND_QUOTE: "Poslať cenovú ponuku",
    SEND_DESIGN: "Poslať návrh",
    SEND_EMAIL: "Poslať email",
    WAITING_FOR_CLIENT: "Čakáme na klienta",
    CUSTOM: "Vlastný krok",
};
