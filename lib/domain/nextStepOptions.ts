import type { NextActionKind, NextActionMode } from "@/app/generated/prisma/enums";

// JEDEN zoznam „ďalších krokov" pre všetky miesta, kde sa krok vyberá (editor v detaile aj akčné okno).
// Predtým existovali tri rôzne zoznamy v troch poradiach – preto v drawri chýbalo „Poslať návrh" (round 2, D-10/B-06).
// Poradie = poradie v UI. Popisky berieme z NEXT_ACTION_LABEL, aby existovali len raz.

// required  = bez dátumu to nedáva zmysel (Zavolať)
// today     = prázdny dátum znamená „dnes" (odosielanie – robí sa hneď)
// optional  = dátum je nepovinný; prázdny = bez termínu (napr. deň kontroly pri čakaní)
export type NextStepDateRule = "required" | "today" | "optional";

export type NextStepOption = {
    kind: NextActionKind;
    date: NextStepDateRule;
    mode?: NextActionMode;
    hint?: string;
};

export const NEXT_STEP_OPTIONS: NextStepOption[] = [
    { kind: "CALL", date: "required", hint: "Kedy zavolať" },
    { kind: "WAITING_FOR_CLIENT", date: "optional", hint: "Dátum = deň kontroly, či sa ozvali" },
    { kind: "SEND_QUOTE", date: "today" },
    { kind: "SEND_DESIGN", date: "today", mode: "IN_PROGRESS", hint: "Rozpracované – počíta dni" },
    { kind: "SEND_EMAIL", date: "today" },
    { kind: "CUSTOM", date: "optional" },
];

export const NEXT_STEP_KINDS = NEXT_STEP_OPTIONS.map((o) => o.kind) as [NextActionKind, ...NextActionKind[]];

export function nextStepOption(kind: NextActionKind): NextStepOption | undefined {
    return NEXT_STEP_OPTIONS.find((o) => o.kind === kind);
}

export function requiresDate(kind: NextActionKind): boolean {
    return nextStepOption(kind)?.date === "required";
}

// Predvolený text „Poznámky ku kroku" (wave 3, F1): použije sa, keď používateľ pole nechá prázdne, a predvyplní sa,
// keď sa krok mení na iný druh. Odosielacie kroky majú text, ostatné nie (hovor bez poznámky je v poriadku).
const DEFAULT_STEP_NOTE: Partial<Record<NextActionKind, string>> = {
    SEND_QUOTE: "Poslať cenu",
    SEND_DESIGN: "Poslať návrh",
    SEND_EMAIL: "Poslať info / cenník",
};

export function defaultStepNote(kind: NextActionKind | null | undefined): string | null {
    return kind ? (DEFAULT_STEP_NOTE[kind] ?? null) : null;
}
