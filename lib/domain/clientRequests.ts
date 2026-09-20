import { z } from "zod";
import type { DealTaskContent, NextActionKind, RequestContent, RequestOrigin, RequestState } from "@/app/generated/prisma/enums";
import { businessTodayStart } from "@/lib/domain/businessTime";
import type { NextActionFields } from "@/lib/domain/leadFlow";
import { defaultStepNote } from "@/lib/domain/nextStepOptions";
import type { OfferContent } from "@/lib/domain/offers";
import type { ItemKind, PendingItem } from "@/lib/domain/tasks";

// Čo klient pýtal (wave 5 – context/features/01-salesrep/wave-5-proposal.md).
// Čisté pravidlá bez DB: dá sa importovať aj z klientskych komponentov. Zápisy sú v lib/domain/requestMutations.ts.
//
// Požiadavka je UDALOSŤ s časom, nie trvalá nálepka (R01-2): klient môže to isté pýtať znova aj mesiace po tom, čo to
// dostal, a to je nová práca. Stav riadku je preto vždy VÝSLEDOK prepočtu nad požiadavkami a platnými odoslaniami
// (§6.7), nikdy lokálne prepnutý – rovnako ako súhrny odoslaní v lib/domain/offerMutations.ts.

export const REQUEST_CONTENTS = ["INFO", "PRICELIST", "PRICE", "DESIGN", "REVIEW"] as const satisfies readonly RequestContent[];

// Čo klient pýtal, ako sa to volá na obrazovke. „O nás" je od wave 5 „Info / ukážky" (§2) – mení sa len popisok,
// ukladaný obsah odoslania ostáva ABOUT_US.
export const REQUEST_CONTENT_LABEL: Record<RequestContent, string> = {
    INFO: "Info / ukážky",
    PRICELIST: "Cenník",
    PRICE: "Konkrétna cena",
    DESIGN: "Návrh",
    REVIEW: "Rozbor webu",
};

// Krátky tvar do jedného riadku („Poslať návrh + cenu + cenník", „Chceli návrh").
export const REQUEST_SHORT_LABEL: Record<RequestContent, string> = {
    INFO: "info",
    PRICELIST: "cenník",
    PRICE: "cenu",
    DESIGN: "návrh",
    REVIEW: "rozbor webu",
};

// §5 – normatívne: čo klient pýtal → čo to splní. Jedno miesto pre UI, príkazy aj prepočet.
export const SATISFIED_BY: Record<RequestContent, OfferContent> = {
    INFO: "ABOUT_US",
    PRICELIST: "PRICELIST",
    PRICE: "PRICE",
    DESIGN: "DESIGN",
    REVIEW: "REVIEW",
};

const CONTENT_OF_OFFER = Object.fromEntries(
    REQUEST_CONTENTS.map((c) => [SATISFIED_BY[c], c]),
) as Record<OfferContent, RequestContent>;

export function contentOfOffer(sent: OfferContent): RequestContent {
    return CONTENT_OF_OFFER[sent];
}

// Manažérska práca hovorí vlastným slovníkom (PRICE / DESIGN / OTHER); „iné" nie je nič, čo by klient pýtal (§7).
export function contentOfTask(kind: DealTaskContent | ItemKind): RequestContent | null {
    return kind === "PRICE" ? "PRICE" : kind === "DESIGN" ? "DESIGN" : null;
}

// Poradie dôležitosti (§5): návrh nesie aj cenu, cena je konkrétnejšia než email.
const DOMINANCE: RequestContent[] = ["DESIGN", "PRICE", "PRICELIST", "INFO", "REVIEW"];

export function sortContents(contents: readonly RequestContent[]): RequestContent[] {
    return [...new Set(contents)].sort((a, b) => DOMINANCE.indexOf(a) - DOMINANCE.indexOf(b));
}

// Vnútorný druh kroku, kým je obsah nevybavený (§5). Zostáva jedna kategória pre pilulky, filtre a „Na dnes" –
// kombinovaná hodnota enumu by pribúdala pri každom novom obsahu (R01-5).
export function stepKindFor(content: RequestContent): NextActionKind {
    return content === "DESIGN" ? "SEND_DESIGN" : content === "PRICE" ? "SEND_QUOTE" : "SEND_EMAIL";
}

export function dominantContent(contents: readonly RequestContent[]): RequestContent | null {
    return sortContents(contents)[0] ?? null;
}

export function stepKindForOutstanding(contents: readonly RequestContent[]): NextActionKind | null {
    const dominant = dominantContent(contents);
    return dominant ? stepKindFor(dominant) : null;
}

// ── §6.9a Čo pokrýva aktuálny krok ──────────────────────────────────────────
// Obchodník si môže nechať užší krok, než čo všetko je nevybavené („pošlem cenu teraz, návrh zajtra"). Jedno
// pravidlo rozhoduje, čo hovorí nadpis a čo ešte varuje – detail, zoznam aj pilulky čítajú to isté.

const COVERS: Partial<Record<NextActionKind, readonly RequestContent[]>> = {
    SEND_EMAIL: ["INFO", "PRICELIST", "REVIEW"],
    SEND_QUOTE: ["PRICE"],
    // Návrh nesie aj cenu – to je zabehnuté pravidlo I10 z wave 3, nie nová výnimka.
    SEND_DESIGN: ["DESIGN", "PRICE"],
};

export function coveredContents(
    stepKind: NextActionKind | null,
    outstanding: readonly RequestContent[],
): RequestContent[] {
    const covers = stepKind ? (COVERS[stepKind] ?? []) : [];
    return sortContents(outstanding.filter((c) => covers.includes(c)));
}

export type StepView = {
    headline: string | null; // null = ukáž uložený krok, ako ho pozná NEXT_ACTION_LABEL
    warn: RequestContent[]; // čo krok nepokrýva – „⚠ Chceli návrh – ešte nedostali"
};

// Nadpis kroku a varovanie (§3.2, §6.9a). Krok, ktorý je predvoľbou §6.8, vymenuje všetko nevybavené; užší krok,
// ktorý si používateľ nechal zámerne, si ponechá vlastný popisok a to, čo nepokrýva, varuje.
export function stepView(stepKind: NextActionKind | null, outstanding: readonly RequestContent[]): StepView {
    const all = sortContents(outstanding);
    const derived = stepKindForOutstanding(all);
    if (!derived) return { headline: null, warn: [] };
    if (stepKind === derived) return { headline: `Poslať ${all.map((c) => REQUEST_SHORT_LABEL[c]).join(" + ")}`, warn: [] };
    const covered = coveredContents(stepKind, all);
    return { headline: null, warn: all.filter((c) => !covered.includes(c)) };
}

// Dokončí toto odoslanie aktuálny krok (a predvolí sa „Zavolať, či prišlo")? Áno, keď posiela obsah druhu kroku
// a nič nevybavené už neostáva. Krok „Poslať…" dokončí aj spotrebovanie POSLEDNEJ nevybavenej veci, aj keď to, čo
// práve odišlo, je iného druhu (R03-1: návrh išiel skôr, teraz posledná cena). Iný krok (napr. dohodnutý hovor) sa
// predvolene ponecháva – používateľ si ho vybral (R02-2).
export function sendCompletesStep(
    step: NextActionKind | null,
    sent: readonly OfferContent[],
    outstandingBefore: readonly RequestContent[],
    outstandingAfter: readonly RequestContent[],
): boolean {
    if (!step) return true;
    if (outstandingAfter.length > 0) return false;
    if (step === "SEND_QUOTE" && sent.includes("PRICE")) return true;
    if (step === "SEND_DESIGN" && sent.includes("DESIGN")) return true;
    if (step === "SEND_EMAIL" && (sent.includes("ABOUT_US") || sent.includes("PRICELIST") || sent.includes("REVIEW"))) return true;
    return (step === "SEND_QUOTE" || step === "SEND_DESIGN") && outstandingBefore.length > 0;
}

export function warningText(warn: readonly RequestContent[]): string | null {
    if (warn.length === 0) return null;
    return `Chceli ${sortContents(warn).map((c) => REQUEST_SHORT_LABEL[c]).join(" + ")} – ešte nedostali`;
}

// ── §6.7 Prepočet: požiadavky × platné odoslania ────────────────────────────

export type RequestRow = {
    id: string;
    content: RequestContent;
    state: RequestState;
    requestedAt: Date;
    resolvedAt: Date | null;
    resolvedById: string | null;
    resolvedActivityId: string | null;
};

// Platné (neprečiarknuté) odoslanie: okamih je offerInstant(meta, createdAt) – spätný záznam má deň, dnešný čas zápisu.
export type ReceiptRow = { id: string; userId: string; instant: Date; contents: readonly OfferContent[] };

export type Resolution = {
    state: RequestState;
    resolvedAt: Date | null;
    resolvedById: string | null;
    resolvedActivityId: string | null;
};

// Odoslanie a požiadavka z tej istej transakcie (cena povedaná v tom istom hovore) sa spájajú ODKAZOM, nie
// porovnaním rovnakých časov (§5). V Postgrese majú všetky riadky jednej transakcie rovnaký CURRENT_TIMESTAMP,
// takže na samotnom porovnaní by záležalo od toho, či je „nie neskôr" ostré – tu na tom nezáleží.
export type RequestLink = { requestId: string; activityId: string };

// Aký stav majú riadky mať. Poradie volaní na výsledku nezáleží: počíta sa vždy nanovo z celej histórie.
export function resolveRequests(
    requests: readonly RequestRow[],
    receipts: readonly ReceiptRow[],
    links: readonly RequestLink[] = [],
): Map<string, Resolution> {
    const ordered = [...receipts].sort((a, b) => a.instant.getTime() - b.instant.getTime() || (a.id < b.id ? -1 : 1));
    const linked = new Map(links.map((l) => [l.requestId, l.activityId]));
    const out = new Map<string, Resolution>();
    for (const r of requests) {
        // Ručne stiahnutú požiadavku neoživí žiadne odoslanie (§6.7 bod 4).
        if (r.state === "WITHDRAWN") {
            out.set(r.id, { state: "WITHDRAWN", resolvedAt: r.resolvedAt, resolvedById: r.resolvedById, resolvedActivityId: r.resolvedActivityId });
            continue;
        }
        const want = SATISFIED_BY[r.content];
        const link = linked.get(r.id);
        const hit = ordered.find((o) => o.contents.includes(want) && (o.id === link || o.instant.getTime() >= r.requestedAt.getTime()));
        out.set(
            r.id,
            hit
                ? { state: "SENT", resolvedAt: hit.instant, resolvedById: hit.userId, resolvedActivityId: hit.id }
                : { state: "OPEN", resolvedAt: null, resolvedById: null, resolvedActivityId: null },
        );
    }
    return out;
}

export function resolutionChanged(row: RequestRow, next: Resolution): boolean {
    return (
        row.state !== next.state ||
        (row.resolvedAt?.getTime() ?? null) !== (next.resolvedAt?.getTime() ?? null) ||
        row.resolvedById !== next.resolvedById ||
        row.resolvedActivityId !== next.resolvedActivityId
    );
}

// ── §6.9 Jedna projekcia, tri zdroje ────────────────────────────────────────
// Nevybavená práca nie je len „otvorená požiadavka klienta": manažérov výsledok ostáva živý aj po tom, čo sa jeho
// úloha zavrela (wave 3 ho nesie v pendingItems, kým ho odoslanie nespotrebuje alebo ho niekto neodmietne), a
// obchodník môže manažéra požiadať aj bez toho, aby klient čokoľvek pýtal (R03-1). Preto sú vstupom tri zdroje.

export type ManagerWork = {
    making: readonly DealTaskContent[]; // otvorená úloha – „robí sa"
    prepared: readonly PendingItem[]; // vrátené a ešte neposlané – „pripravené"
};

export const NO_MANAGER_WORK: ManagerWork = { making: [], prepared: [] };

export type HistoryRow = {
    id: string;
    content: RequestContent;
    state: RequestState;
    origin: RequestOrigin;
    requestedAt: string;
    requestedBy: string | null;
    resolvedAt: string | null;
    reason: string | null;
};

export type OutstandingRow = {
    content: RequestContent;
    askedAt: string | null; // najstaršia otvorená požiadavka klienta; null = pýta si to len naša strana
    openIds: string[]; // riadky, ktoré tento obsah otvárajú (pre ceruzku)
    making: boolean; // manažér to práve robí
    prepared: PendingItem[]; // vrátené, ešte neodoslané
};

export type ClientRequestState = {
    history: HistoryRow[]; // najnovšie hore – „Chceli" na karte
    outstanding: OutstandingRow[]; // jeden riadok na obsah, v poradí dôležitosti
};

export type RequestHistoryInput = RequestRow & {
    origin: RequestOrigin;
    requestedBy: string | null;
    reason: string | null;
};

// Zoskupené podľa OBSAHU, nie podľa udalosti (R02-6): dve požiadavky na cenu = dva riadky histórie, ale jedna
// práca. Štatistiky čítajú surové udalosti (origin = LIVE), obrazovky túto množinu.
export function clientRequestState(
    requests: readonly RequestHistoryInput[],
    managerWork: ManagerWork = NO_MANAGER_WORK,
): ClientRequestState {
    const history = [...requests]
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || (a.id < b.id ? 1 : -1))
        .map((r) => ({
            id: r.id,
            content: r.content,
            state: r.state,
            origin: r.origin,
            requestedAt: r.requestedAt.toISOString(),
            requestedBy: r.requestedBy,
            resolvedAt: r.resolvedAt?.toISOString() ?? null,
            reason: r.reason,
        }));

    const rows = new Map<RequestContent, OutstandingRow>();
    const row = (content: RequestContent): OutstandingRow => {
        const found = rows.get(content) ?? { content, askedAt: null, openIds: [], making: false, prepared: [] };
        rows.set(content, found);
        return found;
    };
    for (const r of requests) {
        if (r.state !== "OPEN") continue;
        const target = row(r.content);
        target.openIds.push(r.id);
        const at = r.requestedAt.toISOString();
        if (!target.askedAt || at < target.askedAt) target.askedAt = at;
    }
    for (const c of managerWork.making) {
        const content = contentOfTask(c);
        if (content) row(content).making = true;
    }
    for (const item of managerWork.prepared) {
        const content = contentOfTask(item.kind);
        // „Iné" a zamietnutie sa len berú na vedomie – nikdy sa nestanú obsahom na odoslanie.
        if (content) row(content).prepared.push(item);
    }
    return { history, outstanding: sortContents([...rows.keys()]).map((c) => rows.get(c)!) };
}

export function outstandingContents(state: ClientRequestState): RequestContent[] {
    return state.outstanding.map((o) => o.content);
}

// Čo sa o riadku povie v zozname úloh na karte (§3.7). Zelená ✓ patrí len tomu, čo klient naozaj dostal.
export function outstandingLabel(row: OutstandingRow, makerName?: string | null): string {
    if (row.prepared.length) return `pripravené – ${row.prepared.map((p) => p.label).join(", ")}`;
    if (row.making) return makerName ? `robí ${makerName}` : "robí sa";
    return "treba poslať";
}

// ── §6.8 Celý ďalší krok, nielen jeho druh ──────────────────────────────────

// Krok, ktorý si appka nastavila sama (odosielanie) alebo ktorý ešte nie je nastavený. Len taký sa smie prepočítať;
// dohodnutý hovor, čakanie a vlastný krok sú ROZHODNUTIE používateľa a prepočet ich nikdy neprepíše (R01-8, R02-2).
export function isSystemStep(kind: NextActionKind | null): boolean {
    return kind === null || kind === "SEND_QUOTE" || kind === "SEND_DESIGN" || kind === "SEND_EMAIL";
}

export type CurrentStep = {
    nextActionKind: NextActionKind | null;
    nextActionAt: Date | null;
    nextActionHasTime: boolean;
    nextActionMode: "SCHEDULED" | "IN_PROGRESS";
    nextActionNote: string | null;
};

// Predvoľba kroku pre príkaz. null = nič nie je nevybavené → platí vlastné pravidlo príkazu (§6.4).
// Keď sa DRUH kroku nemení, nehýbe sa ani dátum, režim a poznámka – rozpracovaný návrh si tak pri pribudnutom
// cenníku nereštartuje „trvá X dní".
export function defaultStep(
    outstanding: readonly RequestContent[],
    current: CurrentStep,
    opts: { locked?: boolean; now?: Date } = {},
): NextActionFields | null {
    const kind = stepKindForOutstanding(outstanding);
    if (!kind) return null;
    if (kind === current.nextActionKind) {
        return {
            nextActionKind: kind,
            nextActionAt: opts.locked ? null : current.nextActionAt,
            nextActionHasTime: opts.locked ? false : current.nextActionHasTime,
            nextActionMode: opts.locked ? "SCHEDULED" : current.nextActionMode,
            nextActionNote: current.nextActionNote,
        };
    }
    return {
        nextActionKind: kind,
        // Zamknutý krok nemá dátum (wave 3, I8); inak je splatný dnes.
        nextActionAt: opts.locked ? null : businessTodayStart(opts.now ?? new Date()),
        nextActionHasTime: false,
        // Cena, ktorá sa stane dominantnou po odoslaní návrhu, je termín – nededí „rozpracované" po návrhu.
        nextActionMode: kind === "SEND_DESIGN" ? "IN_PROGRESS" : "SCHEDULED",
        nextActionNote: defaultStepNote(kind),
    };
}

// ── Vstupy z klienta ────────────────────────────────────────────────────────

export const REQUEST_CONTENT_ENUM = z.enum(REQUEST_CONTENTS);
export const askedSchema = z.array(REQUEST_CONTENT_ENUM).min(1).max(REQUEST_CONTENTS.length);

// Server si zoznam vždy znormalizuje: poradie ani duplicita nie sú vstupom (odtlačok musí byť kanonický, R01-4).
export function normalizeAsked(asked: readonly RequestContent[]): RequestContent[] {
    return REQUEST_CONTENTS.filter((c) => asked.includes(c));
}

export const ASK_REASON_MAX = 500;

// Čo klient pýtal v tom hovore – audit v Activity.meta.asked (§6.3). Riadky LeadRequest sú práca, toto je záznam.
const askedMetaSchema = z.object({ asked: z.array(REQUEST_CONTENT_ENUM) });

export function askedOfMeta(meta: unknown): RequestContent[] {
    const parsed = askedMetaSchema.safeParse(meta);
    return parsed.success ? normalizeAsked(parsed.data.asked) : [];
}
