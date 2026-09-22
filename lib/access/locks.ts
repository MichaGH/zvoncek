import type { Prisma } from "@/app/generated/prisma/client";
import type { Role } from "@/app/generated/prisma/enums";
import prisma from "@/lib/db";

// Disciplína zámkov (plán §10.1):
// 1. poradie Team (vzostupne id) → User (vzostupne id) → Lead (vzostupne id), nikdy späť
// 2. mutácia leadu vždy zamkne Lead riadok FOR UPDATE a stav/rozsah/revíziu overí pod zámkom
// 3. mutácia leadu s assignedCallerId najprv zamkne User riadok priradeného volajúceho FOR SHARE;
//    zmeny práce/stavu používateľa (claim, presun, deaktivácia, zmena roly) berú ten istý riadok FOR UPDATE

export type Tx = Prisma.TransactionClient;
export type LockMode = "SHARE" | "UPDATE";

export type LockedUser = {
    id: string;
    role: Role;
    deletedAt: Date | null;
    teamId: string | null;
    firstName: string;
    lastName: string;
};

export const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

// Interaktívna transakcia s lock_timeout. Pri 40P01 / lock timeoute vyhodí chybu → toActionError ju zmení na RETRYABLE.
export async function withLockTx<T>(
    fn: (tx: Tx) => Promise<T>,
    opts: { lockTimeout?: "5s" | "10s"; timeout?: number } = {},
): Promise<T> {
    return prisma.$transaction(
        async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${opts.lockTimeout ?? "5s"}'`);
            return fn(tx);
        },
        { ...TX_OPTIONS, ...(opts.timeout ? { timeout: opts.timeout } : {}) },
    );
}

function sortedUnique(ids: (string | null | undefined)[]): string[] {
    return [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
}

// Zamkne User riadky jeden po druhom vo vzostupnom poradí id. Vráti mapu nájdených (aj deaktivovaných) používateľov.
export async function lockUsers(
    tx: Tx,
    ids: (string | null | undefined)[],
    mode: LockMode,
): Promise<Map<string, LockedUser>> {
    const result = new Map<string, LockedUser>();
    for (const id of sortedUnique(ids)) {
        const rows =
            mode === "UPDATE"
                ? await tx.$queryRaw<LockedUser[]>`
                    SELECT id, role, "deletedAt", "teamId", "firstName", "lastName" FROM "User" WHERE id = ${id} FOR UPDATE`
                : await tx.$queryRaw<LockedUser[]>`
                    SELECT id, role, "deletedAt", "teamId", "firstName", "lastName" FROM "User" WHERE id = ${id} FOR SHARE`;
        if (rows[0]) result.set(id, rows[0]);
    }
    return result;
}

// Zamkne User riadky s rôznymi režimami v JEDNOM vzostupnom poradí id (UPDATE má prednosť, ak je id viackrát).
export async function lockUserModes(
    tx: Tx,
    modes: { id: string | null | undefined; mode: LockMode }[],
): Promise<Map<string, LockedUser>> {
    const wanted = new Map<string, LockMode>();
    for (const { id, mode } of modes) {
        if (!id) continue;
        wanted.set(id, wanted.get(id) === "UPDATE" ? "UPDATE" : mode);
    }
    const result = new Map<string, LockedUser>();
    for (const id of [...wanted.keys()].sort()) {
        const locked = await lockUsers(tx, [id], wanted.get(id)!);
        const row = locked.get(id);
        if (row) result.set(id, row);
    }
    return result;
}

export async function lockTeams(
    tx: Tx,
    ids: (string | null | undefined)[],
    mode: LockMode,
): Promise<Map<string, { id: string; leaderId: string | null }>> {
    const result = new Map<string, { id: string; leaderId: string | null }>();
    for (const id of sortedUnique(ids)) {
        const rows =
            mode === "UPDATE"
                ? await tx.$queryRaw<{ id: string; leaderId: string | null }[]>`
                    SELECT id, "leaderId" FROM "Team" WHERE id = ${id} FOR UPDATE`
                : await tx.$queryRaw<{ id: string; leaderId: string | null }[]>`
                    SELECT id, "leaderId" FROM "Team" WHERE id = ${id} FOR SHARE`;
        if (rows[0]) result.set(id, rows[0]);
    }
    return result;
}

// Zamkne jeden Lead riadok FOR UPDATE. Vráti true, ak existuje.
export async function lockLeadRow(tx: Tx, leadId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
    return rows.length > 0;
}
