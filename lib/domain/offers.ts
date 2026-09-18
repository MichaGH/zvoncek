import { z } from "zod";
import { businessDate, businessDayStart, isValidBusinessDate } from "@/lib/domain/businessTime";

// Čo klient dostal (round 2, wave 3a – context/features/01-salesrep/round2-deal-workspace.md §2c).
// Jeden záznam OFFER_SENT = jedno odoslanie ponukových materiálov (email) alebo cena povedaná telefonicky.
// Obsah je v Activity.meta; súhrnné stĺpce na Lead (offer*) sú z neho VŽDY prepočítané (lib/domain/offerMutations.ts).
// Staré polia (quoteSentAt, aboutUsSentAt, priceDisclosed) sú zmrazené – nikdy neznamenajú „áno", len „?".
// Čisté funkcie bez DB – dá sa importovať aj z klientskych komponentov.

export const OFFER_CONTENTS = ["ABOUT_US", "PRICELIST", "PRICE", "DESIGN"] as const;
export type OfferContent = (typeof OFFER_CONTENTS)[number];
export type OfferChannel = "EMAIL" | "PHONE";

export const OFFER_CONTENT_LABEL: Record<OfferContent, string> = {
    ABOUT_US: "o nás",
    PRICELIST: "cenník",
    PRICE: "cena",
    DESIGN: "návrh",
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

// Čitateľný text do Activity.note, aby história nepotrebovala lúštiť meta.
export function offerNote(meta: Pick<OfferMeta, "channel" | "contents" | "price" | "designs">): string {
    if (meta.channel === "PHONE") {
        return meta.price ? `Cena telefonicky: ${formatMoney(meta.price.amount)}` : "Cena telefonicky";
    }
    const parts = meta.contents.map((c) => {
        if (c === "PRICE" && meta.price) return `cena ${formatMoney(meta.price.amount)}`;
        if (c === "DESIGN" && meta.designs?.length) {
            return `návrh ${meta.designs.map((d) => d.label ?? d.url ?? "").filter(Boolean).join(", ")}`.trim();
        }
        return OFFER_CONTENT_LABEL[c];
    });
    const priceNote = meta.contents.includes("PRICE") && meta.price?.note ? `\n${meta.price.note}` : "";
    return `Poslali sme: ${parts.join(" + ")}${priceNote}`;
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
        DESIGN: k.designSentAt ? { state: "yes", at: k.designSentAt } : unknown ? { state: "unknown" } : { state: "no" },
    };
}

export function isValidSentOn(value: string, today: string): boolean {
    return isValidBusinessDate(value) && value <= today;
}
