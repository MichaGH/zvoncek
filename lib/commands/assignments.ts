import { Prisma } from "@/app/generated/prisma/client";
import { AccessError, FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { lockUserModes, withLockTx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { CLAIM_BATCH_SIZE } from "@/lib/domain/callAssignment";
import { can } from "@/lib/permissions";

// Manažérsky presun práce volajúcich (plán §4.6): uvoľnenie dávky do fronty alebo presun na iného volajúceho.
// Nikdy nepreskakuje riadky: User riadky zdroja a cieľa FOR UPDATE počkajú na každú rozbehnutú prácu volajúceho
// (tá drží FOR SHARE), Lead riadky FOR UPDATE bez SKIP LOCKED (ohraničené lock_timeout → RETRYABLE).

export type CallWorkKind = "NEW" | "RETRY" | "SCHEDULED" | "SNOOZED";
const BATCH = 200;

const KIND_SQL: Record<CallWorkKind, { filter: Prisma.Sql; order: Prisma.Sql }> = {
    NEW: { filter: Prisma.sql`status = 'NEW'`, order: Prisma.sql`"createdAt"` },
    RETRY: { filter: Prisma.sql`status = 'CALLING' AND "callbackKind" = 'RETRY'`, order: Prisma.sql`"updatedAt"` },
    SCHEDULED: { filter: Prisma.sql`status = 'CALLING' AND "callbackKind" = 'SCHEDULED'`, order: Prisma.sql`"callbackAt"` },
    SNOOZED: { filter: Prisma.sql`status = 'SNOOZED'`, order: Prisma.sql`"callbackAt"` },
};

export type TransferResult = { moved: number } | ActionError;

// Jedna bounded dávka v jednej transakcii. Vráti počet presunutých riadkov.
async function moveBatch(
    actor: AccessUser,
    fromUserId: string,
    toUserId: string | null,
    kind: CallWorkKind,
    want: number,
): Promise<number> {
    return withLockTx(async (tx) => {
        const users = await lockUserModes(tx, [
            { id: actor.id, mode: "SHARE" },
            { id: fromUserId, mode: "UPDATE" },
            { id: toUserId, mode: "UPDATE" },
        ]);
        const me = users.get(actor.id);
        if (!me || me.deletedAt || !can(me, "calls.assign")) throw new AccessError("FORBIDDEN");
        if (!users.get(fromUserId)) throw new AccessError("NOT_FOUND", "Volajúci neexistuje.");

        let limit = Math.min(BATCH, want);
        if (toUserId) {
            const target = users.get(toUserId);
            if (!target || target.deletedAt || !can(target, "calls.work")) {
                throw new AccessError("FORBIDDEN", "Cieľ musí byť aktívny volajúci.");
            }
            if (kind === "NEW") {
                const held = await tx.$queryRaw<{ n: number }[]>`
                    SELECT count(*)::int AS n FROM "Lead"
                     WHERE "assignedCallerId" = ${toUserId} AND status = 'NEW' AND "pipelineEnteredAt" IS NULL AND "deletedAt" IS NULL`;
                const capacity = CLAIM_BATCH_SIZE - held[0].n;
                if (capacity <= 0) {
                    throw new AccessError("FORBIDDEN", "Cieľ má plnú dávku nových kontaktov – najprv ich uvoľni do fronty.");
                }
                limit = Math.min(limit, capacity);
            }
        }

        const k = KIND_SQL[kind];
        const picked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "Lead"
             WHERE "assignedCallerId" = ${fromUserId} AND "deletedAt" IS NULL AND "pipelineEnteredAt" IS NULL AND ${k.filter}
             ORDER BY ${k.order} ASC NULLS LAST, id
             LIMIT ${limit}
             FOR UPDATE`;
        if (picked.length === 0) return 0;
        const ids = picked.map((p) => p.id);
        const moved = toUserId
            ? await tx.$queryRaw<{ id: string }[]>`
                UPDATE "Lead" SET "assignedCallerId" = ${toUserId}, "assignedCallerAt" = (now() AT TIME ZONE 'UTC'),
                       "revision" = "revision" + 1
                 WHERE id = ANY(${ids}) AND "assignedCallerId" = ${fromUserId}
             RETURNING id`
            : await tx.$queryRaw<{ id: string }[]>`
                UPDATE "Lead" SET "assignedCallerId" = NULL, "assignedCallerAt" = NULL, "revision" = "revision" + 1
                 WHERE id = ANY(${ids}) AND "assignedCallerId" = ${fromUserId} AND status = 'NEW'
             RETURNING id`;
        if (moved.length !== picked.length) throw new AccessError("RETRYABLE");

        const from = users.get(fromUserId)!;
        const to = toUserId ? users.get(toUserId)! : null;
        await tx.activity.createMany({
            data: moved.map((m) => ({
                leadId: m.id,
                userId: actor.id,
                type: to ? ("CALLER_ASSIGNED" as const) : ("CALLER_RELEASED" as const),
                category: "AUDIT" as const,
                source: "ADMIN" as const,
                note: to
                    ? `Volanie presunuté: ${from.firstName} ${from.lastName} → ${to.firstName} ${to.lastName}`
                    : `Uvoľnené do spoločnej fronty (${from.firstName} ${from.lastName})`,
                meta: { fromUserId, toUserId, kind } as Prisma.InputJsonValue,
            })),
        });
        return moved.length;
    });
}

export async function transferCallWorkAs(
    actor: AccessUser,
    input: { fromUserId: string; toUserId: string | null; kind: CallWorkKind; limit?: number | null },
): Promise<TransferResult> {
    if (!can(actor, "calls.assign")) return FORBIDDEN;
    if (!["NEW", "RETRY", "SCHEDULED", "SNOOZED"].includes(input.kind)) return { error: "Neplatný druh práce." };
    if (input.toUserId === input.fromUserId) return { error: "Zdroj a cieľ sú rovnakí." };
    if (input.toUserId === null && input.kind !== "NEW") return { error: "Do fronty sa vracajú len nové kontakty." };
    const requested = input.limit && input.limit > 0 ? Math.floor(input.limit) : Number.POSITIVE_INFINITY;

    let moved = 0;
    try {
        while (moved < requested) {
            const n = await moveBatch(actor, input.fromUserId, input.toUserId, input.kind, requested - moved);
            moved += n;
            if (n === 0) break;
            // NEW je ohraničené kapacitou cieľa – po prvej dávke už nie je čo presúvať.
            if (input.kind === "NEW" && input.toUserId) break;
        }
        return { moved };
    } catch (error) {
        const e = toActionError(error, "Presun sa nepodaril.", "transferCallWork");
        return moved > 0 ? { ...e, error: `${e.error} (presunuté už: ${moved})` } : e;
    }
}

export async function releaseBatchAs(actor: AccessUser, fromUserId: string): Promise<TransferResult> {
    return transferCallWorkAs(actor, { fromUserId, toUserId: null, kind: "NEW" });
}
