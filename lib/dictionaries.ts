import {
    ActivityCategory,
    ActivitySource,
    ActivityType,
    CallOutcome,
    DealRequestKind,
    DealRequestStatus,
    LeadStatus,
    NextActionKind,
    ProjectType,
    Role,
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
    WANTS_TO_ORDER: "Chcú objednať",
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
    CALLER_ASSIGNED: "Presunuté volanie",
    CALLER_RELEASED: "Uvoľnené do fronty",
    CALL_REVERTED: "Výsledok hovoru vrátený",
    REQUEST_CREATED: "Požiadavka",
    REQUEST_RESOLVED: "Požiadavka vybavená",
    DEAL_REOPENED: "Obchod znovu otvorený",
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
    CLIENTS: "Klienti",
};

export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
    WEBSITE: "Stránka",
    ESHOP: "Eshop",
    CATALOG: "Katalóg",
    WEBAPP: "Webappka",
    PORTFOLIO: "Portfólio",
    OTHER: "Iné",
};

export const ROLE_LABEL: Record<Role, string> = {
    SCOUT: "Pridávač kontaktov",
    SCOUT_LEADER: "Vedúci pridávačov",
    TELESALES: "Marketing (volania)",
    SALES_REP: "Obchodník",
    MANAGER: "Manažér",
    ADMIN: "Admin",
};

// Poradie rolí pre výbery (admin formuláre). Jediné miesto – nová rola sa dopĺňa tu.
export const ROLES: Role[] = ["SCOUT", "SCOUT_LEADER", "TELESALES", "SALES_REP", "MANAGER", "ADMIN"];

// Ručne písané pole nie je typovo vynútené – pri novej hodnote Role enumu spadne hneď pri štarte.
for (const role of Object.values(Role)) {
    if (!ROLES.includes(role)) throw new Error(`ROLES chýba rola ${role}`);
}

export const ROLE_VARIANT: Record<Role, "default" | "secondary" | "outline" | "destructive"> = {
    ADMIN: "destructive",
    MANAGER: "default",
    TELESALES: "secondary",
    SALES_REP: "secondary",
    SCOUT_LEADER: "default",
    SCOUT: "outline",
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

export const REQUEST_KIND_LABEL: Record<DealRequestKind, string> = {
    PRICE: "Cena",
    DESIGN: "Návrh",
    EMAIL: "Email",
    ORDER: "Objednávka",
    REOPEN: "Znovu otvoriť",
    OTHER: "Iné",
};

export const REQUEST_STATUS_LABEL: Record<DealRequestStatus, string> = {
    OPEN: "Otvorená",
    DONE: "Vybavená",
    CANCELLED: "Zamietnutá",
};
