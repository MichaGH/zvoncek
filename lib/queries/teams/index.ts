import prisma from "@/lib/db";

// Read model pre tímy. Scoping (kto vidí koho) sa rieši tu a vynucuje na stránkach
// cez práva – query len vráti ids, nikdy sa nespolieha na UI hiding.

export async function getTeams() {
    return prisma.team.findMany({
        select: {
            id: true,
            name: true,
            createdAt: true,
            leader: { select: { id: true, firstName: true, lastName: true } },
            _count: { select: { members: true } },
        },
        orderBy: { name: "asc" },
    });
}

export type TeamRow = Awaited<ReturnType<typeof getTeams>>[number];

// Ľahký zoznam pre výbery (filter kontaktov, štatistiky).
export async function getTeamOptions() {
    return prisma.team.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });
}

export type TeamOption = Awaited<ReturnType<typeof getTeamOptions>>[number];

// Ids aktívnych členov daného tímu – na scoping kontaktov/štatistík.
export async function getTeamMemberIds(teamId: string): Promise<string[]> {
    const members = await prisma.user.findMany({
        where: { teamId, deletedAt: null },
        select: { id: true },
    });
    return members.map((m) => m.id);
}

// Tím, ktorý user vedie (SCOUT_LEADER a pod.) + jeho členovia. null ak nič nevedie.
// leaderId má @unique, takže findUnique nájde tím jedným indexovaným dotazom.
export async function getTeamForLeader(leaderId: string) {
    const team = await prisma.team.findUnique({
        where: { leaderId },
        select: {
            id: true,
            name: true,
            members: {
                where: { deletedAt: null },
                select: { id: true, firstName: true, lastName: true },
                orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
            },
        },
    });
    if (!team) return null;
    return {
        id: team.id,
        name: team.name,
        members: team.members,
        memberIds: team.members.map((m) => m.id),
    };
}

export type LeaderTeam = NonNullable<Awaited<ReturnType<typeof getTeamForLeader>>>;

export type TeamPerson = { id: string; name: string; isLeader: boolean };

// Ľudia tímu ako jednotný zoznam: vedúci + aktívni členovia. Vedúci je zahrnutý,
// aby jeho vlastné pridané kontakty nevypadli z tímového pohľadu. `ids` je scope
// na kontakty/štatistiky. Používajú manager/admin (filter podľa tímu) aj vedúci.
export async function getTeamPeople(
    teamId: string,
): Promise<{ id: string; name: string; people: TeamPerson[]; ids: string[] } | null> {
    const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: {
            id: true,
            name: true,
            leader: { select: { id: true, firstName: true, lastName: true, deletedAt: true } },
            members: {
                where: { deletedAt: null },
                select: { id: true, firstName: true, lastName: true },
                orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
            },
        },
    });
    if (!team) return null;

    const people: TeamPerson[] = [];
    const seenIds = new Set<string>();
    if (team.leader && !team.leader.deletedAt) {
        people.push({
            id: team.leader.id,
            name: `${team.leader.firstName} ${team.leader.lastName}`.trim(),
            isLeader: true,
        });
        seenIds.add(team.leader.id);
    }
    for (const m of team.members) {
        if (seenIds.has(m.id)) continue;
        people.push({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim(), isLeader: false });
        seenIds.add(m.id);
    }

    return { id: team.id, name: team.name, people, ids: people.map((p) => p.id) };
}

// Scope pre prihláseného vedúceho: nájde tím, ktorý vedie, a vráti jeho ľudí.
// null ak nič nevedie (napr. rola SCOUT_LEADER, ale ešte nepriradený k tímu).
export async function getTeamScopeForLeader(leaderId: string) {
    const team = await prisma.team.findUnique({ where: { leaderId }, select: { id: true } });
    if (!team) return null;
    return getTeamPeople(team.id);
}
