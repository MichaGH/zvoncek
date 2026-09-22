import { FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { lockUsers, withLockTx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { CLAIM_BATCH_SIZE } from "@/lib/domain/callAssignment";
import { can } from "@/lib/permissions";

export type ClaimResult = { claimed: number; reason?: "BATCH_NOT_EMPTY" } | ActionError;

// Explicitné nárokovanie dávky NEW zo spoločnej fronty (§4.3). Nikdy sa nevolá automaticky.
export async function claimBatchAs(user: AccessUser): Promise<ClaimResult> {
    if (!can(user, "calls.claim")) return FORBIDDEN;

    try {
        const result = await withLockTx(async (tx) => {
            // User riadok FOR UPDATE: serializuje taby toho istého používateľa a koliduje s deaktiváciou/zmenou roly.
            const me = (await lockUsers(tx, [user.id], "UPDATE")).get(user.id);
            if (!me || me.deletedAt || !can(me, "calls.claim")) return FORBIDDEN;

            const batch = await tx.$queryRaw<{ n: number }[]>`
                SELECT count(*)::int AS n FROM "Lead"
                 WHERE "deletedAt" IS NULL AND status = 'NEW' AND "pipelineEnteredAt" IS NULL
                   AND "assignedCallerId" = ${user.id}`;
            if (batch[0].n > 0) return { claimed: 0, reason: "BATCH_NOT_EMPTY" as const };

            const claimed = await tx.$queryRaw<{ id: string }[]>`
                WITH picked AS (
                    SELECT id FROM "Lead"
                     WHERE "deletedAt" IS NULL AND status = 'NEW'
                       AND "pipelineEnteredAt" IS NULL AND "assignedCallerId" IS NULL
                       AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = "Lead".id AND a.type = 'CALL')
                     ORDER BY "createdAt", id
                     LIMIT ${CLAIM_BATCH_SIZE}
                     FOR UPDATE SKIP LOCKED
                )
                UPDATE "Lead" l
                   SET "assignedCallerId" = ${user.id}, "assignedCallerAt" = (now() AT TIME ZONE 'UTC'), "revision" = l."revision" + 1
                  FROM picked
                 WHERE l.id = picked.id AND l."assignedCallerId" IS NULL
             RETURNING l.id`;
            return { claimed: claimed.length };
        });
        return result;
    } catch (error) {
        return toActionError(error, "Nepodarilo sa zobrať kontakty.", "claimBatch");
    }
}
