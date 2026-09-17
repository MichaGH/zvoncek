import type { Prisma } from "@/app/generated/prisma/client";

// Pravidlo revízie: každá biznis transakcia, ktorá sa týka leadu, zvýši jeho `revision` PRESNE raz.
// - `bump` sa použije vo vnútri jediného lead.update, keď transakcia mení aj polia leadu
// - `bumpLeadOnce` pre transakcie, ktoré lead stĺpce nemenia (aktivity, návrhy, požiadavky)
// Jedna transakcia použije pre jeden lead buď jedno, alebo druhé – nikdy oboje.
// Zápis `Activity.leadRevision` / `revertedAt` je evidencia, revíziu nezvyšuje.

export const bump = { revision: { increment: 1 } } as const;

const bumpedPerTx = new WeakMap<object, Set<string>>();

export async function bumpLeadOnce(tx: Prisma.TransactionClient, leadId: string): Promise<number | null> {
    let bumped = bumpedPerTx.get(tx);
    if (!bumped) {
        bumped = new Set();
        bumpedPerTx.set(tx, bumped);
    }
    if (bumped.has(leadId)) return null;
    bumped.add(leadId);
    const rows = await tx.$queryRaw<{ revision: number }[]>`
        UPDATE "Lead" SET "revision" = "revision" + 1 WHERE id = ${leadId} RETURNING "revision"`;
    return rows[0]?.revision ?? null;
}

// Pre transakcie, ktoré lead už zvýšili cez `bump` v lead.update – aby neskorší bumpLeadOnce nezvýšil znova.
export function markLeadBumped(tx: Prisma.TransactionClient, leadId: string): void {
    let bumped = bumpedPerTx.get(tx);
    if (!bumped) {
        bumped = new Set();
        bumpedPerTx.set(tx, bumped);
    }
    bumped.add(leadId);
}

export function isLeadBumped(tx: Prisma.TransactionClient, leadId: string): boolean {
    return bumpedPerTx.get(tx)?.has(leadId) ?? false;
}
