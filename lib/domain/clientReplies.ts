import type { RequestContent } from "@/app/generated/prisma/enums";
import type { FollowUpNextKind, FollowUpOutcome } from "@/lib/domain/leadFlow";

// „Čo povedali" – ponuka odpovedí po tom, čo sa obchodník dovolal (round 2, D-06).
// Je to MENU, nie dátový model: kľúč sa uloží do `Activity.meta.reply`, popisok sa vloží do poznámky,
// takže história ostane čitateľná aj keď sa zoznam neskôr zmení. Žiadny stĺpec ani enum v DB (zatiaľ).
//
// Pridať/odobrať odpoveď = jeden riadok tu. Ak sa niektorá ustáli a budeme na ňu chcieť štatistiku,
// povýši sa na `Activity.replyKind` (S-04 v context/features/01-salesrep/round2-deal-workspace.md §4) s backfillom z `meta`.

export type ClientReply = {
    key: string;
    label: string;
    outcome: FollowUpOutcome;
    nextKind?: FollowUpNextKind; // predvolený ďalší krok
    days?: number; // predvyplnený dátum (obchodné dni sa neriešia, je to len návrh do poľa)
    needsDate?: boolean; // bez dátumu sa neodošle
    terminal?: boolean; // výsledok si ďalší krok nastaví sám (napr. chcú CP)
    // Wave 5 UI: ktoré kroky majú po TEJTO odpovedi zmysel. Prázdne = všetky. Akčné okno ukáže len tieto, takže
    // po „Ozvú sa sami" sa neponúka „Poslať cenu" (Michal, 2026-09-20 – reťazec sa opakoval a mýlil).
    nextKinds?: FollowUpNextKind[];
    // `legacy` = kľúč ostáva platný kvôli histórii a testom, ale v ponuke sa už nezobrazuje: „chcú cenu / návrh /
    // info" je teraz cesta „Chcú niečo…", ktorá zapíše požiadavku klienta, nie len výsledok hovoru.
    group?: "follow" | "legacy";
    // Wave 5 (§3.5): odpoveď, ktorá JE požiadavkou klienta – predzaškrtne „Chcú aj …". Riadok vzniká vždy nanovo,
    // aj keď to isté už raz dostali.
    asks?: RequestContent[];
};

export const CLIENT_REPLIES: ClientReply[] = [
    { key: "NOT_LOOKED_YET", label: "Ešte sa na to nepozreli", outcome: "POSITIVE", nextKind: "CALL", days: 2, needsDate: true, nextKinds: ["CALL", "WAITING_FOR_CLIENT"] },
    { key: "WANTS_CHANGES", label: "Pozreli, chcú zmeny", outcome: "POSITIVE", nextKind: "SEND_DESIGN", nextKinds: ["SEND_DESIGN", "CUSTOM", "CALL"] },
    { key: "RESEND", label: "Neprišlo im to", outcome: "POSITIVE", nextKind: "SEND_EMAIL", nextKinds: ["SEND_EMAIL", "CALL", "WAITING_FOR_CLIENT"] },
    { key: "WILL_CONTACT_US", label: "Ozvú sa sami", outcome: "POSITIVE", nextKind: "WAITING_FOR_CLIENT", days: 7, nextKinds: ["WAITING_FOR_CLIENT", "CALL"] },
    { key: "DECIDING", label: "Majú poradu / rozhodujú sa", outcome: "POSITIVE", nextKind: "CALL", days: 7, needsDate: true, nextKinds: ["CALL", "WAITING_FOR_CLIENT"] },
    // Kľúč ostáva čitateľný v starej histórii, ale ako dnešná voľba bol nejasný (kto to rieši a čo má rep urobiť?).
    { key: "SOMEONE_ELSE", label: "Rieši to niekto iný", outcome: "POSITIVE", nextKind: "CALL", days: 3, needsDate: true, nextKinds: ["CALL", "WAITING_FOR_CLIENT"], group: "legacy" },
    { key: "PRICE_HIGH", label: "Cena je vysoká", outcome: "POSITIVE", nextKind: "CALL", days: 3, needsDate: true, nextKinds: ["CALL", "SEND_QUOTE", "CUSTOM"] },
    // Obyčajná odpoveď (wave 3, D15): zapíše sa, ďalší krok vyberá obchodník; odovzdanie manažérovi je samostatná akcia.
    { key: "WANTS_TO_ORDER", label: "Chcú objednať", outcome: "WANTS_TO_ORDER", nextKind: "CALL", days: 1, needsDate: true, nextKinds: ["CALL", "CUSTOM"] },
    // Nahradené cestou „Chcú niečo…" (wave 5): kľúče ostávajú platné pre staré záznamy a testy, v ponuke nie sú.
    { key: "WANTS_INFO", label: "Chcú info (o nás, cenník)", outcome: "POSITIVE", nextKind: "SEND_EMAIL", group: "legacy" },
    { key: "WANTS_QUOTE", label: "Chcú konkrétnu cenu", outcome: "WANTS_QUOTE", terminal: true, asks: ["PRICE"], group: "legacy" },
    { key: "WANTS_DESIGN", label: "Chcú návrh", outcome: "WANTS_DESIGN", terminal: true, asks: ["DESIGN"], group: "legacy" },
];

// Čo sa ponúka v akčnom okne („Čo povedali"). „Chcú niečo…" je samostatná cesta, nie odpoveď.
export const FOLLOW_UP_REPLIES = CLIENT_REPLIES.filter((r) => r.group !== "legacy");

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
