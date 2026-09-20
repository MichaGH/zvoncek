import { z } from "zod";
import type { DealTaskContent, DealTaskType, NextActionKind, RequestContent } from "@/app/generated/prisma/enums";
import type { PendingItem } from "@/lib/domain/tasks";
import { businessDate, businessDayStart, isValidBusinessDate } from "@/lib/domain/businessTime";

// Čo klient dostal (round 2, wave 3a – context/features/01-salesrep/round2-deal-workspace.md §2c).
// Jeden záznam OFFER_SENT = jedno odoslanie ponukových materiálov (email) alebo cena povedaná telefonicky.
// Obsah je v Activity.meta; súhrnné stĺpce na Lead (offer*) sú z neho VŽDY prepočítané (lib/domain/offerMutations.ts).
// Staré polia (quoteSentAt, aboutUsSentAt, priceDisclosed) sú zmrazené – nikdy neznamenajú „áno", len „?".
// Čisté funkcie bez DB – dá sa importovať aj z klientskych komponentov.

export const OFFER_CONTENTS = ["ABOUT_US", "PRICELIST", "PRICE", "DESIGN", "REVIEW"] as const;
export type OfferContent = (typeof OFFER_CONTENTS)[number];
export type OfferChannel = "EMAIL" | "PHONE";

export const OFFER_CONTENT_LABEL: Record<OfferContent, string> = {
    ABOUT_US: "o nás",
    PRICELIST: "cenník",
    PRICE: "cena",
    DESIGN: "návrh",
    REVIEW: "rozbor webu", // wave 5: čo je zlé na ich súčasnom webe
};

const moneyString = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/);

const offerMetaSchema = z.object({
    channel: z.enum(["EMAIL", "PHONE"]),
    contents: z.array(z.enum(OFFER_CONTENTS)).min(1),
    price: z.object({ amount: moneyString, note: z.string().nullable() }).nullable().optional(),
    designs: z
        .array(z.object({ id: z.string(), label: z.string().nullable(), url: z.string().nullable(), version: z.number().int() }))
        .optional(),
    sentOn: z.string(),
    historical: z.boolean(),
    callActivityId: z.string().optional(),
    migrated: z.boolean().optional(), // prevedené zo starého systému skriptom 2026-09-offer-migrate.ts (ak sa použije)
    // Wave 3: ktoré vrátené výsledky úloh toto odoslanie použilo (lib/domain/tasks.ts) + odtlačok odoslania.
    fulfils: z
        .array(z.object({ taskId: z.string(), kind: z.enum(["PRICE", "DESIGN"]), designId: z.string().optional() }))
        .optional(),
    fp: z.string().optional(),
    correction: z.object({ reason: z.string(), byId: z.string(), at: z.string() }).nullable().optional(),
});

export type OfferMeta = z.infer<typeof offerMetaSchema>;

export function parseOfferMeta(meta: unknown): OfferMeta | null {
    const parsed = offerMetaSchema.safeParse(meta);
    return parsed.success ? parsed.data : null;
}

// Peniaze v meta ako desatinný reťazec, nikdy JSON float.
export function moneyToString(amount: number): string {
    return (Math.round(amount * 100) / 100).toFixed(2).replace(/\.00$/, "");
}

export function formatMoney(amount: string | number): string {
    const n = typeof amount === "number" ? amount : Number(amount);
    return `${n.toLocaleString("sk-SK", { maximumFractionDigits: 2 })} €`;
}

// Krátky obsah odoslania: „návrh smrek1 + cena 1 100 €" / „cena 900 € (telefonicky)".
export function offerSummary(meta: Pick<OfferMeta, "channel" | "contents" | "price" | "designs">): string {
    if (meta.channel === "PHONE") return meta.price ? `cena ${formatMoney(meta.price.amount)} (telefonicky)` : "cena (telefonicky)";
    return meta.contents
        .map((c) => {
            if (c === "PRICE" && meta.price) return `cena ${formatMoney(meta.price.amount)}`;
            if (c === "DESIGN" && meta.designs?.length) {
                return `návrh ${meta.designs.map((d) => d.label ?? d.url ?? "").filter(Boolean).join(", ")}`.trim();
            }
            return OFFER_CONTENT_LABEL[c];
        })
        .join(" + ");
}

// Čitateľný text do Activity.note, aby história nepotrebovala lúštiť meta.
export function offerNote(meta: Pick<OfferMeta, "channel" | "contents" | "price" | "designs">): string {
    if (meta.channel === "PHONE") {
        return meta.price ? `Cena telefonicky: ${formatMoney(meta.price.amount)}` : "Cena telefonicky";
    }
    const priceNote = meta.contents.includes("PRICE") && meta.price?.note ? `\n${meta.price.note}` : "";
    return `Poslali sme: ${offerSummary(meta)}${priceNote}`;
}

// Posledné, čo klient od nás dostal (platné záznamy, v poradí compareOffers). Zobrazuje sa pri „Naposledy",
// aby po ďalšom hovore nezmizlo, že čakáme, kým si pozrú návrh / cenu (round 2 §2d).
export function lastOfferOf(rows: OfferRow[]): { text: string; at: string } | null {
    // Spätne doplnené staré odoslania sa tu nezobrazujú – „Naposledy" je o nedávnom kontakte (§2c 5.3).
    const valid = rows.filter((r) => r.revertedAt === null && !r.meta.historical).sort(compareOffers);
    const last = valid[valid.length - 1];
    return last ? { text: offerSummary(last.meta), at: offerInstant(last.meta, last.createdAt).toISOString() } : null;
}

// Kedy to klient dostal ako okamih: dnešné (a včasné) záznamy nesú presný čas zápisu, spätné len deň.
export function offerInstant(meta: Pick<OfferMeta, "sentOn">, createdAt: Date): Date {
    return businessDate(createdAt) === meta.sentOn ? createdAt : businessDayStart(meta.sentOn);
}

export type OfferRow = { id: string; createdAt: Date; revertedAt: Date | null; meta: OfferMeta };

// Poradie odoslaní: podľa dňa, v rovnaký deň je spätný záznam starší než bežný, inak podľa času zápisu.
// Posledná cena v tomto poradí je tá, ktorú klient videl naposledy (kotva ceny).
export function compareOffers(a: OfferRow, b: OfferRow): number {
    if (a.meta.sentOn !== b.meta.sentOn) return a.meta.sentOn < b.meta.sentOn ? -1 : 1;
    if (a.meta.historical !== b.meta.historical) return a.meta.historical ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
}

export type OfferSummary = {
    aboutUsAt: Date | null;
    pricelistAt: Date | null;
    priceAt: Date | null;
    reviewAt: Date | null;
    lastPrice: { amount: string; note: string | null; channel: OfferChannel; sentOn: string } | null;
    designFirstSent: Map<string, Date>;
};

// Súhrn z PLATNÝCH záznamov (neprečiarknutých). Nezávisí od poradia opráv – vždy sa počíta nanovo.
export function summarizeOffers(rows: OfferRow[]): OfferSummary {
    const valid = rows.filter((r) => r.revertedAt === null).sort(compareOffers);
    const first = (content: OfferContent) => {
        const hit = valid.find((r) => r.meta.contents.includes(content));
        return hit ? offerInstant(hit.meta, hit.createdAt) : null;
    };
    const priced = valid.filter((r) => r.meta.contents.includes("PRICE") && r.meta.price);
    const last = priced[priced.length - 1];
    const designFirstSent = new Map<string, Date>();
    for (const r of valid) {
        if (!r.meta.contents.includes("DESIGN")) continue;
        for (const d of r.meta.designs ?? []) {
            if (!designFirstSent.has(d.id)) designFirstSent.set(d.id, offerInstant(r.meta, r.createdAt));
        }
    }
    return {
        aboutUsAt: first("ABOUT_US"),
        pricelistAt: first("PRICELIST"),
        reviewAt: first("REVIEW"),
        priceAt: last ? offerInstant(last.meta, last.createdAt) : null,
        lastPrice: last?.meta.price
            ? { amount: last.meta.price.amount, note: last.meta.price.note, channel: last.meta.channel, sentOn: last.meta.sentOn }
            : null,
        designFirstSent,
    };
}

// ── Čo klient vie (zobrazenie) ─────────────────────────────────────────────────

export type KnowledgeState = { state: "yes"; at: string } | { state: "unknown" } | { state: "no" };

export type KnowledgeInput = {
    offerAboutUsAt: string | null;
    offerPricelistAt: string | null;
    offerPriceAt: string | null;
    offerReviewAt: string | null;
    designSentAt: string | null;
    hadLegacySends: boolean;
    legacySendsReviewedAt: string | null;
};

export function legacyUnreviewed(k: Pick<KnowledgeInput, "hadLegacySends" | "legacySendsReviewedAt">): boolean {
    return k.hadLegacySends && k.legacySendsReviewedAt === null;
}

// Nový záznam = „áno"; na neoverenom starom obchode prázdne = „?" (nikdy „nie"); inak „nie".
// Návrh má spoľahlivý starý údaj (Design.legacySentAt), preto sa berie zo sentAt priamo.
export function clientKnowledge(k: KnowledgeInput): Record<OfferContent, KnowledgeState> {
    const unknown = legacyUnreviewed(k);
    const of = (at: string | null): KnowledgeState => (at ? { state: "yes", at } : unknown ? { state: "unknown" } : { state: "no" });
    return {
        ABOUT_US: of(k.offerAboutUsAt),
        PRICELIST: of(k.offerPricelistAt),
        PRICE: of(k.offerPriceAt),
        REVIEW: of(k.offerReviewAt),
        DESIGN: k.designSentAt ? { state: "yes", at: k.designSentAt } : unknown ? { state: "unknown" } : { state: "no" },
    };
}

// Odtlačok odoslania pre idempotentné opakovanie: ten istý kľúč musí niesť ten istý obsah. Wave 3 (W3-R3-07): celý
// odoslaný obsah – aj cena (suma + rozpis), voľba ďalšieho kroku a jeho deň, prekryv s úlohou, zrušenie úlohy,
// použité a odmietnuté vrátené položky. Uloží sa do meta.fp a pri opakovaní sa porovná reťazec.
export function offerFingerprint(x: {
    channel: OfferChannel;
    contents: readonly string[];
    sentOn: string;
    historical: boolean;
    designIds?: readonly string[];
    price?: { amount: number; note?: string | null } | null;
    followUp?: boolean;
    followUpOn?: string | null;
    overlap?: string | null;
    cancelTask?: { taskId: string; reason?: string | null } | null;
    fulfils?: readonly { taskId: string; kind: string; designId?: string }[];
    dismiss?: { items: readonly { taskId: string; kind: string; designId?: string }[]; reason?: string | null } | null;
}): string {
    const items = (list: readonly { taskId: string; kind: string; designId?: string }[] | undefined) =>
        [...(list ?? [])].map((i) => `${i.taskId}:${i.kind}:${i.designId ?? ""}`).sort();
    return JSON.stringify([
        x.channel,
        [...x.contents].sort(),
        x.sentOn,
        x.historical,
        [...(x.designIds ?? [])].sort(),
        x.price ? [moneyToString(x.price.amount), x.price.note === undefined ? "=" : (x.price.note?.trim() ?? "")] : null,
        x.followUp ?? false,
        x.followUpOn ?? null,
        x.overlap ?? null,
        x.cancelTask ? [x.cancelTask.taskId, x.cancelTask.reason?.trim() ?? ""] : null,
        items(x.fulfils),
        x.dismiss ? [items(x.dismiss.items), x.dismiss.reason?.trim() ?? ""] : null,
    ]);
}

export function offerFingerprintOfMeta(meta: unknown): string {
    return parseOfferMeta(meta)?.fp ?? "";
}

export function isValidSentOn(value: string, today: string): boolean {
    return isValidBusinessDate(value) && value <= today;
}

// „Naposledy" = posledný SKUTOČNÝ kontakt s klientom. Úpravy (cena, krok), požiadavky ani audit sem nepatria.
export const LAST_TOUCH_TYPES = ["CALL", "CLIENT_REPLIED", "SMS_SENT", "OFFER_SENT", "NOTE", "QUOTE_SENT", "EMAIL_SENT", "DESIGN_SENT"] as const;

// Čo potrebuje dialóg „Čo sme poslali" – dodá ho detail aj riadok zoznamu (dialóg sa otvára na mieste, round 2 §2d).
export type OfferDialogDeal = {
    id: string;
    revision: number;
    owner: { id: string; firstName: string } | null;
    price: number | null;
    priceNote: string | null;
    nextActionKind: NextActionKind | null;
    nextActionAt: string | null;
    // Wave 3: otvorená úloha (zámok → odoslanie je len fakt; prekryv sa pýta) a vrátené položky na „použitie".
    openTask: { id: string; type: DealTaskType; contents: DealTaskContent[]; assignee: string } | null;
    pending: PendingItem[];
    // Wave 5: čo klient pýta a ešte nedostal (predvyplní sa) a celá nevybavená práca (predvolí ďalší krok, §6.9).
    asked: RequestContent[];
    outstanding: RequestContent[];
    offers: KnowledgeInput & {
        legacy: { quoteSentAt: string | null; aboutUsSentAt: string | null; priceDisclosed: boolean };
    };
    designs: { id: string; label: string | null; url: string | null; trackedUrl: string | null; sentAt: string | null }[];
};
