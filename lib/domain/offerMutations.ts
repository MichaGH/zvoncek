import type { Lead, Prisma } from "@/app/generated/prisma/client";
import type { ActivitySource } from "@/app/generated/prisma/enums";
import { AccessError } from "@/lib/access/errors";
import type { Tx } from "@/lib/access/locks";
import { createPlanningActivity, describeNextAction, nextActionData } from "@/lib/activityLog";
import { followUpInSevenDays, hadNextAction, saveQuote, updateLead, type DealActor } from "@/lib/domain/dealMutations";
import { assertStepAllowed, loadPending, validateFulfils } from "@/lib/domain/taskMutations";
import { defaultStep, isSystemStep } from "@/lib/domain/clientRequests";
import { outstandingOf, reconcileRequests } from "@/lib/domain/requestMutations";
import type { ItemRef } from "@/lib/domain/tasks";
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
import { businessDayStart } from "@/lib/domain/businessTime";

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
        offerReviewAt: summary.reviewAt,
        // Obchod bez jediného návrhu si ponechá starý údaj (návrhy spred modelu Design).
        ...(designs.length ? { designSentAt: latestDesign } : {}),
    });
    return summary;
}

// Návrh, ktorý starý kód označil ako poslaný a nový systém ho ešte nikdy nezapísal, si pred prvým novým odoslaním
// uloží starý dátum do legacySentAt – inak by ho prepočet prepísal (okno medzi jednorazovým krokom a nasadením).
async function baselineOldDesignDates(tx: Tx, leadId: string, designIds: string[]) {
    const candidates = await tx.design.findMany({
        where: { id: { in: designIds }, sentAt: { not: null }, legacySentAt: null },
        select: { id: true, sentAt: true },
    });
    for (const d of candidates) {
        const seen = await tx.activity.count({
            where: { leadId, type: "OFFER_SENT", meta: { path: ["designs"], array_contains: [{ id: d.id }] } },
        });
        if (seen === 0) await tx.design.update({ where: { id: d.id }, data: { legacySentAt: d.sentAt } });
    }
}

export type RecordOfferInput = {
    channel: OfferChannel;
    contents: OfferContent[];
    sentOn: string;
    historical: boolean;
    price?: { amount: number; note?: string | null } | null; // note undefined = ponechať uložený rozpis
    designIds?: string[];
    followUp: boolean; // true = nahradiť ďalší krok „Zavolať, či prišlo" (predvolene o 7 dní)
    followUpOn?: string; // iný deň pre ten hovor (YYYY-MM-DD, overený volajúcim)
    callActivityId?: string;
    idempotencyKey?: string;
    // Wave 3: ktoré vrátené položky toto odoslanie použilo (§6.4) + položky odmietnuté v tom istom uložení (pre I10).
    fulfils?: ItemRef[];
    dismissedInSave?: ItemRef[];
    // Krok je zamknutý úlohou → odoslanie je len fakt, ďalší krok sa nemení (vynútené na serveri, §5.1).
    factOnly?: boolean;
    fp?: string; // odtlačok hlavného riadku (§5.5)
    // Wave 5: požiadavky, ktoré toto odoslanie spĺňa ODKAZOM (cena povedaná v tom istom hovore, §5).
    resolves?: readonly string[];
};

function followUpNote(contents: OfferContent[]): string {
    if (contents.includes("DESIGN")) return "Zavolať, či si pozreli návrh";
    if (contents.includes("PRICE")) return "Zavolať, či cena prišla";
    return "Zavolať, či email prišiel";
}

// Po odoslaní sa druh kroku riadi tým, čo NEVYBAVENÉ ostalo (§3.7, §6.8): poslaný návrh pri nevybavenej cene posunie
// krok na „Poslať cenu". Prepíše sa len krok, ktorý si appka nastavila sama – dohodnutý hovor, čakanie ani vlastný
// krok prepočet nikdy neprepíše (R01-8, R02-2). Nič nevybavené = krok ostáva, ako ho používateľ nechal (§6.4 bod 4).
async function refreshSystemStep(tx: Tx, actor: DealActor, lead: Lead, source: ActivitySource) {
    if (!isSystemStep(lead.nextActionKind)) return;
    const next = defaultStep(await outstandingOf(tx, lead.id), lead);
    if (!next || next.nextActionKind === lead.nextActionKind) return;
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
                // Bez rozpisu: pri tej istej sume ostáva uložený rozpis; iná suma starý rozpis nezdedí.
                const note =
                    input.price.note !== undefined
                        ? input.price.note?.trim() || null
                        : current === input.price.amount
                          ? (lead.priceNote ?? null)
                          : null;
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
        await baselineOldDesignDates(tx, lead.id, ids);
    }

    const fulfils = input.fulfils ?? [];
    if (fulfils.length) {
        validateFulfils(fulfils, { contents, designIds: designs?.map((d) => d.id) ?? [], historical: input.historical }, await loadPending(tx, lead.id));
        // Vrátený návrh bez odkazu sa nedá poslať ako „ten od manažéra" (dialóg to vysvetlí, server to vynúti).
        const fulfilled = fulfils.filter((f) => f.kind === "DESIGN").map((f) => f.designId);
        if (designs?.some((d) => fulfilled.includes(d.id) && !d.url)) throw new AccessError("FORBIDDEN", "Návrh nemá odkaz.");
    }

    const meta: OfferMeta = {
        channel: input.channel,
        contents,
        price,
        ...(designs ? { designs } : {}),
        sentOn: input.sentOn,
        historical: input.historical,
        ...(input.callActivityId ? { callActivityId: input.callActivityId } : {}),
        ...(fulfils.length ? { fulfils: fulfils.map((f) => ({ taskId: f.taskId, kind: f.kind as "PRICE" | "DESIGN", ...(f.designId ? { designId: f.designId } : {}) })) } : {}),
        ...(input.fp ? { fp: input.fp } : {}),
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
    // §6.7: stav požiadaviek je vždy výsledok prepočtu nad platnými odoslaniami, nikdy lokálne prepnutý.
    await reconcileRequests(tx, lead.id, { links: (input.resolves ?? []).map((requestId) => ({ requestId, activityId: activity.id })) });

    if (input.historical || input.factOnly) return { activityId: activity.id };

    if (!input.followUp) {
        await refreshSystemStep(tx, actor, lead, source);
        return { activityId: activity.id };
    }

    {
        // I10: ak po tomto odoslaní ešte čaká vrátená cena / návrh, krok nesmie prejsť na „Zavolať, či prišlo".
        await assertStepAllowed(tx, lead.id, "CALL", [...fulfils, ...(input.dismissedInSave ?? [])]);
        const at = input.followUpOn ? businessDayStart(input.followUpOn) : followUpInSevenDays(offerInstant(meta, activity.createdAt));
        const next = nextActionData("CALL", at, followUpNote(contents), false);
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
    return { activityId: activity.id };
}

export const CORRECTABLE_TYPES = ["OFFER_SENT", "SMS_SENT", "CLIENT_REPLIED"] as const;

// Prečiarknutie záznamu: opraví to, čo klient vie; ďalší krok sa nemení (§2c 5.4). Prečiarknuté odoslanie, ktoré
// použilo vrátený výsledok úlohy (meta.fulfils), ho tým znova sprístupní (wave 3 §6.13) – nič iné netreba.
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
    if (activity.type === "OFFER_SENT") {
        await recomputeOffers(tx, activity.leadId);
        // Prečiarknuté odoslanie otvorí požiadavku len vtedy, keď ju nespĺňa žiadne iné platné odoslanie (R02-1).
        await reconcileRequests(tx, activity.leadId);
    } else await bumpLeadOnce(tx, activity.leadId);
}
