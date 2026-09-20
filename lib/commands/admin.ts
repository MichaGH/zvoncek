import type { Role } from "@/app/generated/prisma/enums";
import { AccessError, toActionError, type ActionError } from "@/lib/access/errors";
import { withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import prisma from "@/lib/db";
import { can } from "@/lib/permissions";

// Deaktivácia / zmena roly (plán §9). Jedna transakcia s lock_timeout 10 s:
// 1. UPDATE "User" zoberie riadok FOR UPDATE ako PRVÝ krok – počká na každú rozbehnutú prácu používateľa
//    (logCall, revert, úprava kontaktu, follow-up, handoff na neho ako vedúceho, úloha / presun obchodu na neho –
//    všetky držia FOR SHARE) a zablokuje nové.
// 2. Wave 3 (D14): kým vlastní otvorené obchody alebo má pridelené otvorené úlohy, deaktivácia (a zmena roly, ktorá mu
//    berie deals.receive / requests.resolve) sa odmietne – admin ich najprv presunie. Počíta sa až pod zámkom.
// 3. Ak už nemá calls.claim / calls.work: uvoľní VŠETKY jeho nevolané NEW (bez SKIP LOCKED) a overí, že ostalo 0.
//    Inak ROLLBACK celého kroku vrátane deaktivácie → RETRYABLE. Retry, callbacky a snooze sa neposúvajú.

export type RemainingWork = { retries: number; scheduled: number; snoozed: number; deals: number; released: number };

async function releaseNewIfNeeded(tx: Tx, actorId: string, userId: string, role: Role, deactivated: boolean): Promise<number> {
    const keepsCalls = !deactivated && can({ role }, "calls.claim") && can({ role }, "calls.work");
    if (keepsCalls) return 0;
    const picked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Lead"
         WHERE "assignedCallerId" = ${userId} AND status = 'NEW' AND "pipelineEnteredAt" IS NULL AND "deletedAt" IS NULL
         ORDER BY id
         FOR UPDATE`;
    let released: { id: string }[] = [];
    if (picked.length) {
        released = await tx.$queryRaw<{ id: string }[]>`
            UPDATE "Lead" SET "assignedCallerId" = NULL, "assignedCallerAt" = NULL, "revision" = "revision" + 1
             WHERE id = ANY(${picked.map((p) => p.id)}) AND "assignedCallerId" = ${userId}
         RETURNING id`;
        if (released.length) {
            await tx.activity.createMany({
                data: released.map((r) => ({
                    leadId: r.id,
                    userId: actorId,
                    type: "CALLER_RELEASED" as const,
                    category: "AUDIT" as const,
                    source: "ADMIN" as const,
                    note: deactivated ? "Uvoľnené do fronty (deaktivácia volajúceho)" : "Uvoľnené do fronty (zmena roly)",
                })),
            });
        }
    }
    const left = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "Lead" WHERE "assignedCallerId" = ${userId} AND status = 'NEW' AND "deletedAt" IS NULL`;
    if (left[0].n !== 0) throw new AccessError("RETRYABLE", "Používateľ práve pracuje – skús znova o chvíľu.");
    return released.length;
}

// Otvorené obchody vo vlastníctve a otvorené úlohy pridelené používateľovi (pod zámkom jeho User riadku).
async function heldDealWork(tx: Tx, userId: string): Promise<{ deals: number; tasks: number }> {
    const rows = await tx.$queryRaw<{ deals: number; tasks: number }[]>`
        SELECT
            (SELECT count(*)::int FROM "Lead"
              WHERE "ownerId" = ${userId} AND "pipelineEnteredAt" IS NOT NULL AND "deletedAt" IS NULL
                AND status IN ('ACTIVE', 'SNOOZED')) AS deals,
            (SELECT count(*)::int FROM "DealTask" t JOIN "Lead" l ON l.id = t."leadId"
              WHERE t."assigneeId" = ${userId} AND t.status = 'OPEN' AND l."deletedAt" IS NULL) AS tasks`;
    return rows[0] ?? { deals: 0, tasks: 0 };
}

function refuseHeldWork(held: { deals: number; tasks: number }, what: { deals: boolean; tasks: boolean }) {
    const parts: string[] = [];
    if (what.deals && held.deals > 0) parts.push(`${held.deals} ${held.deals === 1 ? "obchod" : held.deals < 5 ? "obchody" : "obchodov"} (Pipeline → Presunúť obchody)`);
    if (what.tasks && held.tasks > 0) parts.push(`${held.tasks} ${held.tasks === 1 ? "úlohu" : held.tasks < 5 ? "úlohy" : "úloh"} (Pre mňa → Presunúť)`);
    if (parts.length) throw new AccessError("FORBIDDEN", `Najprv presuň ${parts.join(" a ")}.`);
}

export async function getRemainingWork(userId: string): Promise<Omit<RemainingWork, "released">> {
    const base = { assignedCallerId: userId, deletedAt: null, pipelineEnteredAt: null };
    const [retries, scheduled, snoozed, deals] = await Promise.all([
        prisma.lead.count({ where: { ...base, status: "CALLING", callbackKind: "RETRY" } }),
        prisma.lead.count({ where: { ...base, status: "CALLING", callbackKind: "SCHEDULED" } }),
        prisma.lead.count({ where: { ...base, status: "SNOOZED" } }),
        prisma.lead.count({
            where: { ownerId: userId, deletedAt: null, pipelineEnteredAt: { not: null }, status: { in: ["ACTIVE", "SNOOZED"] } },
        }),
    ]);
    return { retries, scheduled, snoozed, deals };
}

export async function deactivateUserAs(
    actor: AccessUser,
    userId: string,
): Promise<{ ok: true; data: RemainingWork } | ({ ok: false } & ActionError)> {
    if (!can(actor, "users.manage") && !can(actor, "admin.access")) return { ok: false, error: "Nemáš oprávnenie.", code: "FORBIDDEN" };
    if (userId === actor.id) return { ok: false, error: "Nemôžeš deaktivovať vlastný účet." };
    try {
        const released = await withLockTx(
            async (tx) => {
                const updated = await tx.$queryRaw<{ role: Role }[]>`
                    UPDATE "User" SET "deletedAt" = COALESCE("deletedAt", (now() AT TIME ZONE 'UTC'))
                     WHERE id = ${userId}
                 RETURNING role`;
                if (!updated[0]) throw new AccessError("NOT_FOUND", "Používateľ neexistuje.");
                refuseHeldWork(await heldDealWork(tx, userId), { deals: true, tasks: true });
                return releaseNewIfNeeded(tx, actor.id, userId, updated[0].role, true);
            },
            { lockTimeout: "10s", timeout: 30_000 },
        );
        return { ok: true, data: { ...(await getRemainingWork(userId)), released } };
    } catch (error) {
        return { ok: false, ...toActionError(error, "Deaktivácia sa nepodarila.", "deactivateUser") };
    }
}

export type ProfileUpdate = {
    firstName: string;
    lastName: string;
    username: string;
    email: string | null;
    phone: string | null;
    role: Role;
    note: string | null;
};

// Úprava profilu; pri zmene roly rovnaká serializácia ako deaktivácia.
export async function updateUserProfileAs(
    actor: AccessUser,
    userId: string,
    data: ProfileUpdate,
): Promise<{ ok: true; data: { released: number } } | ({ ok: false } & ActionError)> {
    if (!can(actor, "admin.access")) return { ok: false, error: "Nemáš oprávnenie.", code: "FORBIDDEN" };
    try {
        const released = await withLockTx(
            async (tx) => {
                // Zámok User riadku PRED čítaním pôvodnej roly (R02-1): súbežná zmena roly / pridelenie obchodu či úlohy
                // (tie držia tento riadok FOR SHARE) sa dokončí skôr, alebo počká na nás – nikdy sa nerozhoduje podľa
                // zastaralého čítania.
                const locked = await tx.$queryRaw<{ role: Role }[]>`SELECT role FROM "User" WHERE id = ${userId} FOR UPDATE`;
                const before = locked[0];
                if (!before) throw new AccessError("NOT_FOUND", "Používateľ neexistuje.");
                const updated = await tx.$queryRaw<{ role: Role; deletedAt: Date | null }[]>`
                    UPDATE "User" SET "firstName" = ${data.firstName}, "lastName" = ${data.lastName}, username = ${data.username},
                           email = ${data.email}, phone = ${data.phone}, role = ${data.role}::"Role", note = ${data.note}
                     WHERE id = ${userId}
                 RETURNING role, "deletedAt"`;
                if (!updated[0]) throw new AccessError("NOT_FOUND", "Používateľ neexistuje.");
                // D14 podľa NOVEJ roly, bez ohľadu na pôvodnú: kto po uložení nemôže vlastniť obchody / riešiť úlohy, nesmie
                // žiadne držať (aj keby ich dostal medzitým).
                refuseHeldWork(await heldDealWork(tx, userId), {
                    deals: !can({ role: data.role }, "deals.receive"),
                    tasks: !can({ role: data.role }, "requests.resolve"),
                });
                if (before.role === data.role) return 0;
                return releaseNewIfNeeded(tx, actor.id, userId, data.role, updated[0].deletedAt !== null);
            },
            { lockTimeout: "10s", timeout: 30_000 },
        );
        return { ok: true, data: { released } };
    } catch (error) {
        return { ok: false, ...toActionError(error, "Nepodarilo sa uložiť.", "updateUserProfile") };
    }
}
