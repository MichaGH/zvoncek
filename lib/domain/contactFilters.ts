// Kontakty – pohľad a filter kola v URL (feature 02 §15). Čisté, bezpečné aj pre klienta.
// Pridané = pôvodný zoznam (podľa pridania); Na volanie = spoločná fronta v poradí, v akom ju dostane volajúci.

export const CONTACT_VIEWS = ["added", "pool"] as const;
export type ContactView = (typeof CONTACT_VIEWS)[number];
export const DEFAULT_CONTACT_VIEW: ContactView = "added";

export const CONTACT_VIEW_LABEL: Record<ContactView, string> = {
    added: "Pridané",
    pool: "Na volanie",
};

// Kolo: 1 = nikdy nerecyklovaný, 2 = druhé a ďalšie kolo (recyklovaný).
export const CONTACT_ROUNDS = ["all", "1", "2"] as const;
export type ContactRound = (typeof CONTACT_ROUNDS)[number];
export const DEFAULT_CONTACT_ROUND: ContactRound = "all";

export const CONTACT_ROUND_LABEL: Record<ContactRound, string> = {
    all: "Všetky kolá",
    "1": "Len nové (1. kolo)",
    "2": "Len recyklované",
};

function oneOf<T extends string>(values: readonly T[], v: unknown, fallback: T): T {
    return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function parseContactView(v: unknown): ContactView {
    return oneOf(CONTACT_VIEWS, v, DEFAULT_CONTACT_VIEW);
}

export function parseContactRound(v: unknown): ContactRound {
    return oneOf(CONTACT_ROUNDS, v, DEFAULT_CONTACT_ROUND);
}
