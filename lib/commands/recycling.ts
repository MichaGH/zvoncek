import { AccessError, FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { lockUsers, withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { archiveRounds, type RecycleRound } from "@/lib/domain/recycleMutations";
import {
    recycleBlocker,
    recycleInputSchema,
    type RecycleInput,
    type RecycleSkipReason,
} from "@/lib/domain/recycling";
import { can } from "@/lib/permissions";

// Hromadná recyklácia (spec §6). Recykluje PRESNE riadky, ktoré admin videl, s revíziou z obrazovky – nikdy „všetko
// podľa filtra" vypočítané na serveri. Dávky po 100 vzostupne podľa id, každá vo vlastnej transakcii:
// User riadky (aktér + držitelia) FOR SHARE → Lead riadky FOR UPDATE, bez SKIP LOCKED (project-overview §5).

const CHUNK = 100;

export type RecycleSkip = { leadId: string; number: number | null; reason: RecycleSkipReason };
export type RecycleResult = { recycled: number; skipped: RecycleSkip[] } | ActionError;

type Item = RecycleInput["items"][number];

async function recycleChunk(
    tx: Tx,
    user: AccessUser,
    items: Item[],
    order: Map<string, number>,
    base: Date,
    now: Date,
): Promise<{ recycled: number; skipped: RecycleSkip[] }> {
    const ids = items.map((i) => i.leadId);

    // Držitelia prečítaní bez zámku, zamknutí, a pod zámkom leadu overení (lock order Team → User → Lead).
    const pre = await tx.lead.findMany({ where: { id: { in: ids } }, select: { id: true, assignedCallerId: true, ownerId: true } });
    const holders = new Map(pre.map((l) => [l.id, l]));
    const users = await lockUsers(tx, [user.id, ...pre.flatMap((l) => [l.assignedCallerId, l.ownerId])], "SHARE");
    const actor = users.get(user.id);
    if (!actor || actor.deletedAt) throw new AccessError("UNAUTHENTICATED");
    if (!can(actor, "contacts.recycle")) throw new AccessError("FORBIDDEN");

    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE`;
    const leads = new Map((await tx.lead.findMany({ where: { id: { in: ids } } })).map((l) => [l.id, l]));
    const openTasks = new Set(
        (await tx.dealTask.findMany({ where: { leadId: { in: ids }, status: "OPEN" }, select: { leadId: true } })).map(
            (t) => t.leadId,
        ),
    );

    // Opakované odoslanie toho istého výberu: kolo z tejto revízie už je v archíve → úspech, nie „zmenil sa".
    // Jeden dopyt pre celú dávku (R02-01), nie jeden na kontakt.
    const moved = items.filter((i) => leads.has(i.leadId) && leads.get(i.leadId)!.revision !== i.expectedRevision);
    const archived = moved.length
        ? await tx.lead.findMany({
              where: { archiveOfId: { in: moved.map((i) => i.leadId) } },
              select: { archiveOfId: true, revision: true },
          })
        : [];
    const done = new Set(archived.map((a) => `${a.archiveOfId}:${a.revision}`));

    let recycled = 0;
    const skipped: RecycleSkip[] = [];
    const rounds: RecycleRound[] = [];
    for (const item of items) {
        const lead = leads.get(item.leadId);
        if (!lead) {
            skipped.push({ leadId: item.leadId, number: null, reason: "NOT_FOUND" });
            continue;
        }
        if (lead.revision !== item.expectedRevision) {
            if (done.has(`${lead.id}:${item.expectedRevision}`)) recycled++;
            else skipped.push({ leadId: lead.id, number: lead.number, reason: "CHANGED" });
            continue;
        }
        const before = holders.get(lead.id);
        if (!before || before.assignedCallerId !== lead.assignedCallerId || before.ownerId !== lead.ownerId) {
            skipped.push({ leadId: lead.id, number: lead.number, reason: "CHANGED" });
            continue;
        }
        const blocker = recycleBlocker({ ...lead, hasOpenTask: openTasks.has(lead.id) });
        if (blocker) {
            skipped.push({ leadId: lead.id, number: lead.number, reason: blocker });
            continue;
        }
        rounds.push({ lead, order: order.get(lead.id) ?? 0 });
    }
    await archiveRounds(tx, actor.id, rounds, now, base);
    return { recycled: recycled + rounds.length, skipped };
}

export async function recycleLeadsAs(user: AccessUser, input: RecycleInput): Promise<RecycleResult> {
    if (!can(user, "contacts.recycle")) return FORBIDDEN;
    const parsed = recycleInputSchema.safeParse(input);
    if (!parsed.success) return { error: "Neplatný výber kontaktov." };

    // Poradie výberu admina = poradie vo fronte (R02-08); dávky sú po id kvôli zámkom, preto sa poradie nesie zvlášť
    // a začiatok kola sa ráta od jedného spoločného času pre všetky dávky.
    const order = new Map(parsed.data.items.map((item, i) => [item.leadId, i]));
    const base = new Date();
    const items = [...parsed.data.items].sort((a, b) => (a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0));
    let recycled = 0;
    const skipped: RecycleSkip[] = [];
    try {
        for (let i = 0; i < items.length; i += CHUNK) {
            const result = await withLockTx((tx) => recycleChunk(tx, user, items.slice(i, i + CHUNK), order, base, new Date()), {
                lockTimeout: "10s",
                timeout: 30_000,
            });
            recycled += result.recycled;
            skipped.push(...result.skipped);
        }
        return { recycled, skipped };
    } catch (error) {
        const e = toActionError(error, "Recyklácia sa nepodarila.", "recycleLeads");
        return recycled > 0 ? { ...e, error: `${e.error} (recyklované už: ${recycled})` } : e;
    }
}
