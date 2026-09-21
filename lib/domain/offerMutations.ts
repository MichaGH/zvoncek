import type { Lead, Prisma } from "@/app/generated/prisma/client";
import type { ActivitySource, RequestContent } from "@/app/generated/prisma/enums";
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

// Prepočet Lead.offer* + Design.sentAt z platných záznamov. Design.sentAt = PRVÉ platné odoslanie toho návrhu
// (staré odoslania V1 sú od prevodu tiež OFFER_SENT záznamy).
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
        select: { id: true, sentAt: true, deletedAt: true },
    });
    let latestDesign: Date | null = null;
    for (const d of designs) {
        const next = summary.designFirstSent.get(d.id) ?? null;
        if ((next?.getTime() ?? null) !== (d.sentAt?.getTime() ?? null)) {
            await tx.design.update({ where: { id: d.id }, data: { sentAt: next } });
        }
        if (next && d.deletedAt === null && (!latestDesign || next > latestDesign)) latestDesign = next;
    }

    // Obchod bez jediného návrhu si ponechá starý údaj (návrhy spred modelu Design) – až kým sa pre neho nezapíše
    // odoslanie návrhu bez Design riadku (R01-5): od vtedy je stĺpec výsledkom prepočtu, takže prečiarknutie takého
    // odoslania ho aj vráti na prázdno.
    // R02-2: stĺpec je najnovší platný dátum z OBOCH zdrojov – sledované (nezmazané) návrhy aj odoslania bez Design
    // riadku. Zmazaný ani nový Design tak platné odoslanie bez záznamu nezhodí. Starý údaj ostáva len tam, kde
    // obchod nemá žiadnu históriu návrhov ani odoslanie bez záznamu.
    const untracked = summary.untrackedDesignAt;
    const designSentAt =
        designs.length === 0 && !summary.hadUntrackedDesign
            ? undefined
            : latestDesign && untracked
              ? (latestDesign > untracked ? latestDesign : untracked)
              : (latestDesign ?? untracked ?? null);
    await updateLead(tx, leadId, {
        offerAboutUsAt: summary.aboutUsAt,
        offerPricelistAt: summary.pricelistAt,
        offerPriceAt: summary.priceAt,
        offerReviewAt: summary.reviewAt,
        ...(designSentAt !== undefined ? { designSentAt } : {}),
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
    // Návrh poslaný mimo systému (PDF, odkaz v maili, starý obchod) – smie sa len tam, kde obchod nemá žiadny Design (R01-5).
    untrackedDesign?: boolean;
    // true = nahradiť ďalší krok „Zavolať, či prišlo" (predvolene o 7 dní); "IF_CLEAR" = naplánovať ho len vtedy,
    // keď klientovi po tomto odoslaní už nič nedlhujeme (manažérovo „Poslal som to sám" – wave 4 §7, P1).
    followUp: boolean | "IF_CLEAR";
    followUpOn?: string; // iný deň pre ten hovor (YYYY-MM-DD, overený volajúcim)
    callActivityId?: string; // kontakt, pri ktorom cena zaznela (CALL, alebo SMS ak via = "SMS")
    via?: "SMS"; // kanál cez ktorý cena zaznela mimo emailu: hovor (predvolené) alebo SMS
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
async function refreshSystemStep(tx: Tx, actor: DealActor, lead: Lead, source: ActivitySource, outstanding: readonly RequestContent[]) {
    if (!isSystemStep(lead.nextActionKind)) return;
    const next = defaultStep(outstanding, lead);
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
                    await saveQuote(tx, actor, lead, { price: input.price.amount, priceNote: note }, source, { via: "SEND" });
                }
            }
            const fresh = await tx.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { price: true, priceNote: true } });
            if (fresh.price == null) throw new AccessError("FORBIDDEN", "Najprv doplň cenu.");
            price = { amount: moneyToString(Number(fresh.price)), note: fresh.priceNote };
        }
    }

    let designs: OfferMeta["designs"];
    const untrackedDesign = contents.includes("DESIGN") && input.untrackedDesign === true;
    if (input.untrackedDesign && !contents.includes("DESIGN")) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    if (untrackedDesign) {
        // Voľba „návrh bez záznamu" nesmie obísť sledovaný návrh: existuje Design = vyberie sa on.
        if (input.designIds?.length) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
        if ((input.fulfils ?? []).some((f) => f.kind === "DESIGN")) throw new AccessError("FORBIDDEN", "Vrátený návrh treba poslať ako sledovaný návrh.");
        const tracked = await tx.design.count({ where: { leadId: lead.id, deletedAt: null } });
        if (tracked > 0) throw new AccessError("STALE", "Obchod má návrh v systéme – vyber ho. Obnovujem.");
    } else if (contents.includes("DESIGN")) {
        const ids = [...new Set(input.designIds ?? [])];
        if (!ids.length) throw new AccessError("FORBIDDEN", "Vyber návrh.");
        const found = await tx.design.findMany({
            where: { id: { in: ids }, leadId: lead.id, deletedAt: null },
            select: { id: true, label: true, targetUrl: true, currentVersion: true },
        });
        if (found.length !== ids.length) throw new AccessError("NOT_FOUND", "Návrh sa nenašiel.");
        designs = found.map((d) => ({ id: d.id, label: d.label, url: d.targetUrl, version: d.currentVersion }));
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
        ...(untrackedDesign ? { untrackedDesign: true } : {}),
        sentOn: input.sentOn,
        historical: input.historical,
        ...(input.callActivityId ? { callActivityId: input.callActivityId } : {}),
        ...(input.via ? { via: input.via } : {}),
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

    // R02-6 / P1: „Zavolať, či prišlo" sa smie naplánovať len vtedy, keď klientovi po tomto odoslaní už nič
    // nedlhujeme – inak by obchod hovoril „zavolaj, či email prišiel", kým sľúbené info a cenník nikdy neodišli
    // (wave 4 §7, P1). Nevybavená práca sa číta z JEDNEJ projekcie (§6.9), nie z vrátených položiek úloh.
    const outstanding = await outstandingOf(tx, lead.id);
    if (input.followUp === true) {
        // I10 najprv: jeho hláška presne menuje, čo ešte čaká („Ešte neposlané: návrh Variant A“).
        await assertStepAllowed(tx, lead.id, "CALL", [...fulfils, ...(input.dismissedInSave ?? [])]);
        // Dialóg túto voľbu pri nevybavenej práci neponúka – požiadavka je teda zastaraná alebo ručne poskladaná.
        if (outstanding.length > 0) throw new AccessError("FORBIDDEN", "Ešte neodišlo všetko, čo klient chce.");
    }
    if (!input.followUp || outstanding.length > 0) {
        await refreshSystemStep(tx, actor, lead, source, outstanding);
        return { activityId: activity.id };
    }

    {
        // I10 ešte raz pre vetvu "IF_CLEAR" – obrana do hĺbky, keď o hovore rozhodol prepočet, nie používateľ.
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
    } else {
        // R02-3: cena uvedená v SMS je dieťa tejto SMS (meta.callActivityId). Prečiarknutá SMS neexistovala, takže sa s ňou
        // prečiarkne aj cena – v tej istej transakcii, jedným prepočtom a jednou revíziou. Opačným smerom nič: prečiarknutá
        // cena môže nechať text SMS v histórii.
        const children = await tx.activity.findMany({
            where: { leadId: activity.leadId, type: "OFFER_SENT", revertedAt: null, meta: { path: ["callActivityId"], equals: activity.id } },
            select: { id: true, meta: true },
        });
        for (const child of children) {
            const childBase = child.meta && typeof child.meta === "object" && !Array.isArray(child.meta) ? child.meta : {};
            await tx.activity.update({
                where: { id: child.id },
                data: {
                    revertedAt: new Date(),
                    revertedById: actor.id,
                    meta: { ...childBase, correction: { reason: `súvisiaci záznam opravený: ${reason}`, byId: actor.id, at: new Date().toISOString() } },
                },
            });
        }
        if (children.length) {
            await recomputeOffers(tx, activity.leadId);
            await reconcileRequests(tx, activity.leadId);
        } else await bumpLeadOnce(tx, activity.leadId);
    }
}
