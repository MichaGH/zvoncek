import type { ActivitySource, DealRequestKind, DealRequestStatus } from "@/app/generated/prisma/enums";
import type { Tx } from "@/lib/access/locks";
import { businessDayMonth } from "@/lib/domain/businessTime";
import { bumpLeadOnce } from "@/lib/domain/revision";
import { REQUEST_KIND_LABEL } from "@/lib/dictionaries";

// Pravidlá požiadaviek (plán §7.6). Všetko sa volá v transakcii, ktorá drží zámok Lead riadku.
// Max. jedna OPEN požiadavka na (lead, kind). Zmena požiadaviek sa započíta do jediného zvýšenia revízie transakcie.

type Actor = { id: string; firstName: string };

export async function ensureOpenRequest(
    tx: Tx,
    leadId: string,
    kind: DealRequestKind,
    actor: Actor,
    note: string | null | undefined,
    source: ActivitySource,
): Promise<{ id: string; created: boolean }> {
    const text = note?.trim() || null;
    const existing = await tx.dealRequest.findFirst({
        where: { leadId, kind, status: "OPEN" },
        select: { id: true, note: true },
    });
    await bumpLeadOnce(tx, leadId);
    if (existing) {
        if (text) {
            const line = `— ${businessDayMonth(new Date())} ${actor.firstName}: ${text}`;
            await tx.dealRequest.update({
                where: { id: existing.id },
                data: { note: existing.note ? `${existing.note}\n${line}` : line },
            });
        }
        return { id: existing.id, created: false };
    }
    const created = await tx.dealRequest.create({
        data: { leadId, kind, note: text, createdById: actor.id },
        select: { id: true },
    });
    await tx.activity.create({
        data: {
            leadId,
            userId: actor.id,
            type: "REQUEST_CREATED",
            category: "BUSINESS",
            source,
            note: text ? `${REQUEST_KIND_LABEL[kind]}: ${text}` : REQUEST_KIND_LABEL[kind],
            meta: { requestId: created.id, kind },
        },
    });
    return { id: created.id, created: true };
}

// Interné: volá sa LEN vo vnútri biznis mutácie, ktorá prácu reálne vykonala (alebo pri uzavretí/vrátení).
export async function resolveOpenRequests(
    tx: Tx,
    leadId: string,
    kinds: DealRequestKind[] | "ALL",
    status: Exclude<DealRequestStatus, "OPEN">,
    actorId: string,
    resolutionNote: string,
    source: ActivitySource,
): Promise<number> {
    const open = await tx.dealRequest.findMany({
        where: { leadId, status: "OPEN", ...(kinds === "ALL" ? {} : { kind: { in: kinds } }) },
        select: { id: true, kind: true },
    });
    if (open.length === 0) return 0;
    await bumpLeadOnce(tx, leadId);
    const now = new Date();
    for (const request of open) {
        await tx.dealRequest.update({
            where: { id: request.id },
            data: { status, resolvedById: actorId, resolvedAt: now, resolutionNote },
        });
        await tx.activity.create({
            data: {
                leadId,
                userId: actorId,
                type: "REQUEST_RESOLVED",
                category: "BUSINESS",
                source,
                note: `${REQUEST_KIND_LABEL[request.kind]} – ${status === "DONE" ? "vybavené" : "zrušené"}: ${resolutionNote}`,
                meta: { requestId: request.id, kind: request.kind, status },
            },
        });
    }
    return open.length;
}

// Uzavretie obchodu: WON → ORDER DONE, ostatné CANCELLED; LOST/UNREACHABLE → všetky CANCELLED.
export async function closeRequestsForStatus(
    tx: Tx,
    leadId: string,
    status: "WON" | "LOST" | "UNREACHABLE",
    actorId: string,
    source: ActivitySource,
): Promise<void> {
    if (status === "WON") {
        await resolveOpenRequests(tx, leadId, ["ORDER"], "DONE", actorId, "Obchod vyhraný", source);
    }
    await resolveOpenRequests(tx, leadId, "ALL", "CANCELLED", actorId, "Obchod uzavretý", source);
}
