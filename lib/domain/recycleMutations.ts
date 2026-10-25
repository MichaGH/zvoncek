import { Prisma, type Lead } from "@/app/generated/prisma/client";
import type { Tx } from "@/lib/access/locks";
import { bump, markLeadBumped } from "@/lib/domain/revision";

// Zápis recyklácie (spec §4). Volá sa LEN pod zámkom Lead riadkov z recycleLeadsAs, po kontrole recycleBlocker.

// Archívny riadok = presná kópia kontaktu pred recykláciou (menované polia, žiadny spread – code-standards §4).
// Výnimky sú v ARCHIVE_COPY_EXCEPTIONS; rc1Snapshot overuje, že tu nechýba žiadny stĺpec.
export function archiveCopy(lead: Lead, actorId: string, now: Date): Prisma.LeadCreateManyInput {
    return {
        companyName: lead.companyName,
        phone: lead.phone,
        website: lead.website,
        email: lead.email,
        note: lead.note,
        status: lead.status,
        origin: lead.origin,
        projectType: lead.projectType,
        ownerId: lead.ownerId,
        nextActionKind: lead.nextActionKind,
        nextActionAt: lead.nextActionAt,
        nextActionHasTime: lead.nextActionHasTime,
        nextActionMode: lead.nextActionMode,
        nextActionNote: lead.nextActionNote,
        callbackKind: lead.callbackKind,
        callbackAt: lead.callbackAt,
        callbackHasTime: lead.callbackHasTime,
        callbackNote: lead.callbackNote,
        price: lead.price,
        priceNote: lead.priceNote,
        designSentAt: lead.designSentAt,
        offerAboutUsAt: lead.offerAboutUsAt,
        offerPricelistAt: lead.offerPricelistAt,
        offerPriceAt: lead.offerPriceAt,
        offerReviewAt: lead.offerReviewAt,
        lostReason: lead.lostReason,
        createdById: lead.createdById,
        createdAt: lead.createdAt,
        assignedCallerId: lead.assignedCallerId,
        assignedCallerAt: lead.assignedCallerAt,
        pipelineEnteredAt: lead.pipelineEnteredAt,
        handedOffById: lead.handedOffById,
        closedAt: lead.closedAt,
        revision: lead.revision,
        round: lead.round,
        roundStartedAt: lead.roundStartedAt,
        deletedAt: now,
        archiveOfId: lead.id,
        archivedById: actorId,
    };
}

// Živý kontakt po recyklácii = nový kontakt (RECYCLE_RESET_FIELDS); kolo, začiatok kola a revízia sa menia zvlášť.
export const RECYCLE_RESET = {
    status: "NEW",
    projectType: null,
    ownerId: null,
    nextActionKind: null,
    nextActionAt: null,
    nextActionHasTime: false,
    nextActionMode: "SCHEDULED",
    nextActionNote: null,
    callbackKind: null,
    callbackAt: null,
    callbackHasTime: false,
    callbackNote: null,
    price: null,
    priceNote: null,
    designSentAt: null,
    offerAboutUsAt: null,
    offerPricelistAt: null,
    offerPriceAt: null,
    offerReviewAt: null,
    lostReason: null,
    assignedCallerId: null,
    assignedCallerAt: null,
    pipelineEnteredAt: null,
    handedOffById: null,
    closedAt: null,
} as const satisfies Prisma.LeadUncheckedUpdateInput;

// Tabuľky, ktorých riadky patria kontaktu cez "leadId". Pod nimi visia ďalšie (časti úloh, verzie, tracker, eventy);
// idú s nimi, lebo sa odkazujú na ich id, nie na lead.
const CHILD_TABLES = ["Activity", "LeadRequest", "DealTask", "DealOwnership", "Design"] as const;

export type RecycleRound = {
    lead: Lead;
    // R02-08: poradie vo fronte = poradie výberu admina (začiatok kola = base + poradie v ms), nie id.
    order: number;
};

// Uzavrie kolá celej dávky naraz (R02-01): archívne riadky jedným INSERT, každá podriadená tabuľka jedným UPDATE,
// reset živých kontaktov jedným UPDATE – ~8 príkazov na dávku bez ohľadu na jej veľkosť (predtým 7 na kontakt, takže
// 100 kontaktov stálo 700 sieťových ciest). Volá sa LEN pod zámkom Lead riadkov z recycleLeadsAs, po recycleBlocker.
// Podriadené riadky sa presúvajú surovým SQL len cez FK: Prisma @updatedAt by prepísal historické časy (R01-01).
export async function archiveRounds(tx: Tx, actorId: string, rounds: RecycleRound[], now: Date, base: Date): Promise<void> {
    if (rounds.length === 0) return;
    const archives = await tx.lead.createManyAndReturn({
        data: rounds.map(({ lead }) => archiveCopy(lead, actorId, now)),
        select: { id: true, archiveOfId: true },
    });
    const archiveOf = new Map(archives.map((a) => [a.archiveOfId, a.id]));
    const live = rounds.map(({ lead }) => lead.id);
    const arch = live.map((id) => archiveOf.get(id));
    if (archives.length !== rounds.length || arch.some((id) => !id)) throw new Error("archiveRounds: archive rows do not match the batch");

    for (const table of CHILD_TABLES) {
        await tx.$executeRaw`
            UPDATE ${Prisma.raw(`"${table}"`)} c SET "leadId" = m.archive_id
              FROM unnest(${live}::text[], ${arch as string[]}::text[]) AS m(live_id, archive_id)
             WHERE c."leadId" = m.live_id`;
    }

    await tx.lead.updateMany({ where: { id: { in: live } }, data: { ...RECYCLE_RESET, round: { increment: 1 }, ...bump } });
    // Čas ako ISO text (nie Date parameter): stĺpec je timestamp bez zóny v UTC, ako všade v appke.
    await tx.$executeRaw`
        UPDATE "Lead" l SET "roundStartedAt" = (${base.toISOString()}::timestamptz AT TIME ZONE 'UTC') + m.ord * interval '1 millisecond'
          FROM unnest(${live}::text[], ${rounds.map((r) => r.order)}::int[]) AS m(id, ord)
         WHERE l.id = m.id`;
    for (const id of live) markLeadBumped(tx, id);
}
