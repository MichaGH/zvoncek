import type { FollowUpNextKind, FollowUpOutcome } from "@/lib/domain/leadFlow";

// „Čo povedali" – ponuka odpovedí po tom, čo sa obchodník dovolal (round 2, D-06).
// Je to MENU, nie dátový model: kľúč sa uloží do `Activity.meta.reply`, popisok sa vloží do poznámky,
// takže história ostane čitateľná aj keď sa zoznam neskôr zmení. Žiadny stĺpec ani enum v DB (zatiaľ).
//
// Pridať/odobrať odpoveď = jeden riadok tu. Ak sa niektorá ustáli a budeme na ňu chcieť štatistiku,
// povýši sa na `Activity.replyKind` (S-04 v context/new-feature/db-changes.md) s backfillom z `meta`.

export type ClientReply = {
    key: string;
    label: string;
    outcome: FollowUpOutcome;
    nextKind?: FollowUpNextKind; // predvolený ďalší krok
    days?: number; // predvyplnený dátum (obchodné dni sa neriešia, je to len návrh do poľa)
    needsDate?: boolean; // bez dátumu sa neodošle
    terminal?: boolean; // výsledok si ďalší krok nastaví sám (napr. chcú CP)
};

export const CLIENT_REPLIES: ClientReply[] = [
    { key: "NOT_LOOKED_YET", label: "Ešte sa na to nepozreli", outcome: "POSITIVE", nextKind: "CALL", days: 2, needsDate: true },
    { key: "WANTS_CHANGES", label: "Pozreli, chcú zmeny", outcome: "POSITIVE", nextKind: "SEND_DESIGN" },
    { key: "RESEND", label: "Neprišlo im to – poslať znova", outcome: "POSITIVE", nextKind: "SEND_EMAIL" },
    { key: "WILL_CONTACT_US", label: "Ozvú sa sami", outcome: "POSITIVE", nextKind: "WAITING_FOR_CLIENT", days: 7 },
    { key: "DECIDING", label: "Majú poradu / rozhodujú sa", outcome: "POSITIVE", nextKind: "CALL", days: 7, needsDate: true },
    { key: "SOMEONE_ELSE", label: "Rieši to niekto iný", outcome: "POSITIVE", nextKind: "CALL", days: 3, needsDate: true },
    { key: "PRICE_HIGH", label: "Cena je vysoká", outcome: "POSITIVE", nextKind: "CALL", days: 3, needsDate: true },
    { key: "WANTS_QUOTE", label: "Chcú cenovú ponuku", outcome: "WANTS_QUOTE", terminal: true },
    { key: "WANTS_DESIGN", label: "Chcú návrh", outcome: "WANTS_DESIGN", terminal: true },
    { key: "WANTS_TO_ORDER", label: "Chcú objednať", outcome: "WANTS_TO_ORDER", terminal: true },
];

export const REPLY_KEYS = CLIENT_REPLIES.map((r) => r.key);

export function replyOf(key: string | null | undefined): ClientReply | undefined {
    return key ? CLIENT_REPLIES.find((r) => r.key === key) : undefined;
}

// Poznámka v histórii: „Ešte sa na to nepozreli – vraj v piatok". Popisok je vždy prvý, aby sa dal čítať zoznam.
export function noteWithReply(replyKey: string | null | undefined, note: string | null | undefined): string | null {
    const label = replyOf(replyKey)?.label;
    const text = note?.trim() || null;
    if (!label) return text;
    return text ? `${label} – ${text}` : label;
}
