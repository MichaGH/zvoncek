import type { Lead, Prisma } from "@/app/generated/prisma/client";
import type { ActivitySource } from "@/app/generated/prisma/enums";
import { AccessError } from "@/lib/access/errors";
import type { Tx } from "@/lib/access/locks";
import { createPlanningActivity, describeNextAction, nextActionData } from "@/lib/activityLog";
import { resolveOpenRequests } from "@/lib/domain/dealRequests";
import { followUpInSevenDays, hadNextAction, saveQuote, updateLead, type DealActor } from "@/lib/domain/dealMutations";
import {
    moneyToString,
    offerInstant,
    offerNote,
    parseOfferMeta,
    summarizeOffers,
    type OfferChannel,
    type OfferContent,
    type OfferMeta,
    type OfferRow,
} from "@/lib/domain/offers";
import { bumpLeadOnce } from "@/lib/domain/revision";

// Telá zápisov „čo klient dostal" (round 2 §2c). Volajú ich príkazy pod zámkom Lead riadku; revízia sa zvýši raz.
// Pravidlo: súhrnné stĺpce sa NIKDY nezapisujú ručne – vždy recomputeOffers() z platných OFFER_SENT záznamov.

// Prepočet Lead.offer* + Design.sentAt z platných záznamov. Design.sentAt = PRVÉ odoslanie: skorší z najskoršieho
// platného záznamu a starého údaja (Design.legacySentAt) – nové odoslanie staršie datovanie neprepíše.
export async function recomputeOffers(tx: Tx, leadId: string) {
    const activities = await tx.activity.findMany({
        where: { leadId, type: "OFFER_SENT" },
        select: { id: true, createdAt: true, revertedAt: true, meta: true },
    });
    const rows: OfferRow[] = [];
    for (const a of activities) {
        const meta = parseOfferMeta(a.meta);
        if (meta) rows.push({ id: a.id, createdAt: a.createdAt, revertedAt: a.revertedAt, meta });
    }
    const summary = summarizeOffers(rows);

    const designs = await tx.design.findMany({
        where: { leadId },
        select: { id: true, sentAt: true, legacySentAt: true, deletedAt: true },
    });
    let latestDesign: Date | null = null;
    for (const d of designs) {
        const fresh = summary.designFirstSent.get(d.id) ?? null;
        const next = fresh && d.legacySentAt ? (fresh < d.legacySentAt ? fresh : d.legacySentAt) : (fresh ?? d.legacySentAt);
        if ((next?.getTime() ?? null) !== (d.sentAt?.getTime() ?? null)) {
            await tx.design.update({ where: { id: d.id }, data: { sentAt: next } });
        }
        if (next && d.deletedAt === null && (!latestDesign || next > latestDesign)) latestDesign = next;
    }

    await updateLead(tx, leadId, {
        offerAboutUsAt: summary.aboutUsAt,
        offerPricelistAt: summary.pricelistAt,
        offerPriceAt: summary.priceAt,
        // Obchod bez jediného návrhu si ponechá starý údaj (návrhy spred modelu Design).
        ...(designs.length ? { designSentAt: latestDesign } : {}),
    });
    return summary;
}

export type RecordOfferInput = {
    channel: OfferChannel;
    contents: OfferContent[];
    sentOn: string;
    historical: boolean;
    price?: { amount: number; note?: string | null } | null; // note undefined = ponechať uložený rozpis
    designIds?: string[];
    followUp: boolean; // true = nahradiť ďalší krok „Zavolať, či prišlo · o 7 dní"
    callActivityId?: string;
    idempotencyKey?: string;
};

function followUpNote(contents: OfferContent[]): string {
    if (contents.includes("DESIGN")) return "Zavolať, či si pozreli návrh";
    if (contents.includes("PRICE")) return "Zavolať, či cena prišla";
    return "Zavolať, či email prišiel";
}

export async function recordOffer(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    input: RecordOfferInput,
    source: ActivitySource,
): Promise<{ activityId: string }> {
    const contents = [...new Set(input.contents)];
    let price: OfferMeta["price"] = null;

    if (contents.includes("PRICE")) {
        if (input.historical) {
            // Spätný záznam: suma, ako bola vtedy – dnešná cena obchodu sa nemení.
            if (!input.price) throw new AccessError("FORBIDDEN", "Doplň sumu, ktorú klient vtedy dostal.");
            price = { amount: moneyToString(input.price.amount), note: input.price.note?.trim() || null };
        } else {
            if (input.price) {
                const current = lead.price != null ? Number(lead.price) : null;
                const note = input.price.note === undefined ? (lead.priceNote ?? null) : input.price.note?.trim() || null;
                if (current !== input.price.amount || (lead.priceNote ?? null) !== note) {
                    await saveQuote(tx, actor, lead, { price: input.price.amount, priceNote: note }, source);
                }
            }
            const fresh = await tx.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { price: true, priceNote: true } });
            if (fresh.price == null) throw new AccessError("FORBIDDEN", "Najprv doplň cenu.");
            price = { amount: moneyToString(Number(fresh.price)), note: fresh.priceNote };
        }
    }

    let designs: OfferMeta["designs"];
    if (contents.includes("DESIGN")) {
        const ids = [...new Set(input.designIds ?? [])];
        if (!ids.length) throw new AccessError("FORBIDDEN", "Vyber návrh.");
        const found = await tx.design.findMany({
            where: { id: { in: ids }, leadId: lead.id, deletedAt: null },
            select: { id: true, label: true, targetUrl: true, currentVersion: true },
        });
        if (found.length !== ids.length) throw new AccessError("NOT_FOUND", "Návrh sa nenašiel.");
        designs = found.map((d) => ({ id: d.id, label: d.label, url: d.targetUrl, version: d.currentVersion }));
    }

    const meta: OfferMeta = {
        channel: input.channel,
        contents,
        price,
        ...(designs ? { designs } : {}),
        sentOn: input.sentOn,
        historical: input.historical,
        ...(input.callActivityId ? { callActivityId: input.callActivityId } : {}),
        correction: null,
    };
    const activity = await tx.activity.create({
        data: {
            leadId: lead.id,
            userId: actor.id,
            type: "OFFER_SENT",
            category: "BUSINESS",
            source,
            note: offerNote(meta),
            meta,
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        },
        select: { id: true, createdAt: true },
    });

    await recomputeOffers(tx, lead.id);

    if (input.historical) return { activityId: activity.id };

    if (input.followUp) {
        const next = nextActionData("CALL", followUpInSevenDays(offerInstant(meta, activity.createdAt)), followUpNote(contents), false);
        await updateLead(tx, lead.id, next);
        await tx.activity.create({
            data: createPlanningActivity({
                leadId: lead.id,
                userId: actor.id,
                type: hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                source,
                note: describeNextAction(next),
            }),
        });
    }

    // Do wave 3 sa požiadavky uzatvárajú ako doteraz, keď práca prebehla (spätný záznam nikdy).
    if (contents.includes("PRICE")) {
        await resolveOpenRequests(tx, lead.id, ["PRICE"], "DONE", actor.id, "Cena poslaná klientovi", source);
    }
    if (contents.includes("ABOUT_US") || contents.includes("PRICELIST")) {
        await resolveOpenRequests(tx, lead.id, ["EMAIL"], "DONE", actor.id, "Email poslaný", source);
    }
    if (contents.includes("DESIGN")) {
        await resolveOpenRequests(tx, lead.id, ["DESIGN"], "DONE", actor.id, "Návrh odoslaný", source);
    }
    return { activityId: activity.id };
}

export const CORRECTABLE_TYPES = ["OFFER_SENT", "SMS_SENT", "CLIENT_REPLIED"] as const;

// Prečiarknutie záznamu: opraví to, čo klient vie; ďalší krok ani požiadavky sa nemenia (§2c 5.4).
export async function correctRecord(
    tx: Tx,
    actor: DealActor,
    activity: { id: string; leadId: string; type: string; meta: Prisma.JsonValue },
    reason: string,
) {
    const base = activity.meta && typeof activity.meta === "object" && !Array.isArray(activity.meta) ? activity.meta : {};
    await tx.activity.update({
        where: { id: activity.id },
        data: {
            revertedAt: new Date(),
            revertedById: actor.id,
            meta: { ...base, correction: { reason, byId: actor.id, at: new Date().toISOString() } },
        },
    });
    if (activity.type === "OFFER_SENT") await recomputeOffers(tx, activity.leadId);
    else await bumpLeadOnce(tx, activity.leadId);
}
