import { AccessError, isUniqueViolation, toActionError, type ActionCode } from "@/lib/access/errors";
import { lockTeams, lockUsers, withLockTx } from "@/lib/access/locks";

// Zmeny tímov, ktoré menia smerovanie obchodov (plán §5.1). Oprávnenie overuje volajúca akcia.

type Result = { ok: true } | { ok: false; error: string; code?: ActionCode };

// ── Zmazanie tímu ──────────────────────────────────────────────────────────────
// Členom sa teamId nastaví na null (FK je optional), vedúci sa uvoľní. Kontakty
// ani ich história sa NEMAŽÚ – tie visia na Lead, nie na Team.
// Zámky: Team FOR UPDATE najprv, potom členovia FOR UPDATE (poradie Team → User, §5.1).

export async function deleteTeamAs(id: string): Promise<Result> {
    try {
        await withLockTx(async (tx) => {
            const teams = await lockTeams(tx, [id], "UPDATE");
            if (!teams.has(id)) throw new AccessError("NOT_FOUND", "Tím neexistuje.");
            const members = await tx.user.findMany({ where: { teamId: id }, select: { id: true } });
            await lockUsers(tx, members.map((m) => m.id), "UPDATE");
            await tx.user.updateMany({ where: { id: { in: members.map((m) => m.id) }, teamId: id }, data: { teamId: null } });
            await tx.team.delete({ where: { id } });
        });
    } catch (error) {
        return { ok: false, ...toActionError(error, "Nepodarilo sa zmazať tím.", "deleteTeam") };
    }
    return { ok: true };
}

// ── Vedúci tímu ────────────────────────────────────────────────────────────────
// leaderId má @unique: jeden user vedie max. jeden tím. leaderId=null vedúceho uvoľní.
// Vedúci smeruje obchody z pozitívnych hovorov členov → zámky zdieľané s handoffom (Team FOR UPDATE → User FOR SHARE).

export async function setTeamLeaderAs(teamId: string, leaderId: string | null): Promise<Result> {
    try {
        await withLockTx(async (tx) => {
            const teams = await lockTeams(tx, [teamId], "UPDATE");
            const team = teams.get(teamId);
            if (!team) throw new AccessError("NOT_FOUND", "Tím neexistuje.");
            const users = await lockUsers(tx, [team.leaderId, leaderId], "SHARE");
            if (leaderId) {
                const leader = users.get(leaderId);
                if (!leader || leader.deletedAt) throw new AccessError("NOT_FOUND", "Používateľ neexistuje.");
            }
            await tx.team.update({ where: { id: teamId }, data: { leaderId } });
        });
    } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, error: "Tento používateľ už vedie iný tím." };
        return { ok: false, ...toActionError(error, "Nepodarilo sa uložiť vedúceho.", "setTeamLeader") };
    }
    return { ok: true };
}

// ── Členstvo používateľa v tíme ─────────────────────────────────────────────────
// teamId=null používateľa z tímu vyradí. Priraďuje sa z detailu používateľa.
// Zámky: starý aj nový Team FOR UPDATE (vzostupne), potom User FOR UPDATE.

export async function setUserTeamAs(userId: string, teamId: string | null): Promise<Result> {
    try {
        await withLockTx(async (tx) => {
            const pre = await tx.user.findUnique({ where: { id: userId }, select: { teamId: true } });
            if (!pre) throw new AccessError("NOT_FOUND", "Používateľ neexistuje.");
            const teams = await lockTeams(tx, [pre.teamId, teamId], "UPDATE");
            if (teamId && !teams.has(teamId)) throw new AccessError("NOT_FOUND", "Tím neexistuje.");
            const users = await lockUsers(tx, [userId], "UPDATE");
            const user = users.get(userId);
            if (!user) throw new AccessError("NOT_FOUND", "Používateľ neexistuje.");
            if (user.teamId !== pre.teamId) throw new AccessError("RETRYABLE");
            await tx.user.update({ where: { id: userId }, data: { teamId } });
        });
    } catch (error) {
        return { ok: false, ...toActionError(error, "Nepodarilo sa uložiť tím.", "setUserTeam") };
    }
    return { ok: true };
}
