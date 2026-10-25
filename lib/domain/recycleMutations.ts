import type { Lead, Prisma } from "@/app/generated/prisma/client";
import type { Tx } from "@/lib/access/locks";
import { bump, markLeadBumped } from "@/lib/domain/revision";

// Zápis jednej recyklácie (spec §4). Volá sa LEN pod zámkom Lead riadku z recycleLeadsAs, po kontrole recycleBlocker.

// Archívny riadok = presná kópia kontaktu pred recykláciou (menované polia, žiadny spread – code-standards §4).
// Výnimky sú v ARCHIVE_COPY_EXCEPTIONS; rc1Snapshot overuje, že tu nechýba žiadny stĺpec.
export function archiveCopy(lead: Lead, actorId: string, now: Date): Prisma.LeadUncheckedCreateInput {
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

// Uzavrie kolo: archívny riadok + presun VŠETKÝCH podriadených riadkov naň + reset živého kontaktu, jedna revízia.
// Pod Activity / DealTask / Design visia ďalšie tabuľky (časti úloh, verzie, tracker); idú s nimi, lebo sa odkazujú
// na ich id, nie na lead.
export async function archiveRound(tx: Tx, actorId: string, lead: Lead, now: Date): Promise<string> {
    const archive = await tx.lead.create({ data: archiveCopy(lead, actorId, now), select: { id: true } });
    const move = { where: { leadId: lead.id }, data: { leadId: archive.id } };
    await tx.activity.updateMany(move);
    // Prisma @updatedAt would rewrite historical timestamps on these two models.
    // Move the FK only, preserving every child's individual scalar snapshot.
    await tx.$executeRaw`UPDATE "LeadRequest" SET "leadId" = ${archive.id} WHERE "leadId" = ${lead.id}`;
    await tx.dealTask.updateMany(move);
    await tx.dealOwnership.updateMany(move);
    await tx.$executeRaw`UPDATE "Design" SET "leadId" = ${archive.id} WHERE "leadId" = ${lead.id}`;
    await tx.lead.update({
        where: { id: lead.id },
        data: { ...RECYCLE_RESET, round: { increment: 1 }, roundStartedAt: now, ...bump },
    });
    markLeadBumped(tx, lead.id);
    return archive.id;
}
