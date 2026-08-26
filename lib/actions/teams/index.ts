"use server";

import { auth } from "@/auth";
import prisma from "@/lib/db";
import { can } from "@/lib/permissions";
import { revalidatePath } from "next/cache";
import { z } from "zod";

type Result<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function assertCanManageTeams(): Promise<
    { ok: true; userId: string } | { ok: false; error: string }
> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Nie si prihlásený." };
    if (!can(session.user, "teams.manage")) return { ok: false, error: "Nemáš oprávnenie." };
    return { ok: true, userId: session.user.id };
}

function revalidateTeams() {
    revalidatePath("/dashboard/admin/teams");
    revalidatePath("/dashboard/admin/users");
    // scoping vedúcich závisí od zloženia tímu – prepočítať aj tam
    revalidatePath("/dashboard/contacts");
    revalidatePath("/dashboard/stats");
}

const nameSchema = z.string().trim().min(1, "Názov tímu je povinný.").max(60, "Názov je príliš dlhý.");

// ── Vytvorenie tímu ────────────────────────────────────────────────────────────

export async function createTeam(formData: FormData): Promise<Result<{ id: string }>> {
    const guard = await assertCanManageTeams();
    if (!guard.ok) return guard;

    const parsed = nameSchema.safeParse(formData.get("name"));
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

    const team = await prisma.team.create({ data: { name: parsed.data }, select: { id: true } });
    revalidateTeams();
    return { ok: true, data: { id: team.id } };
}

// ── Premenovanie ────────────────────────────────────────────────────────────────

export async function renameTeam(id: string, formData: FormData): Promise<Result> {
    const guard = await assertCanManageTeams();
    if (!guard.ok) return guard;

    const parsed = nameSchema.safeParse(formData.get("name"));
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

    await prisma.team.update({ where: { id }, data: { name: parsed.data } });
    revalidateTeams();
    return { ok: true };
}

// ── Zmazanie tímu ──────────────────────────────────────────────────────────────
// Členom sa teamId nastaví na null (FK je optional), vedúci sa uvoľní. Kontakty
// ani ich história sa NEMAŽÚ – tie visia na Lead, nie na Team.

export async function deleteTeam(id: string): Promise<Result> {
    const guard = await assertCanManageTeams();
    if (!guard.ok) return guard;

    await prisma.$transaction([
        prisma.user.updateMany({ where: { teamId: id }, data: { teamId: null } }),
        prisma.team.delete({ where: { id } }),
    ]);
    revalidateTeams();
    return { ok: true };
}

// ── Vedúci tímu ────────────────────────────────────────────────────────────────
// leaderId má @unique: jeden user vedie max. jeden tím. leaderId=null vedúceho uvoľní.

export async function setTeamLeader(teamId: string, leaderId: string | null): Promise<Result> {
    const guard = await assertCanManageTeams();
    if (!guard.ok) return guard;

    if (leaderId) {
        const leader = await prisma.user.findUnique({
            where: { id: leaderId, deletedAt: null },
            select: { id: true },
        });
        if (!leader) return { ok: false, error: "Používateľ neexistuje." };

        const alreadyLeads = await prisma.team.findUnique({
            where: { leaderId },
            select: { id: true },
        });
        if (alreadyLeads && alreadyLeads.id !== teamId) {
            return { ok: false, error: "Tento používateľ už vedie iný tím." };
        }
    }

    await prisma.team.update({ where: { id: teamId }, data: { leaderId } });
    revalidateTeams();
    return { ok: true };
}

// ── Členstvo používateľa v tíme ─────────────────────────────────────────────────
// teamId=null používateľa z tímu vyradí. Priraďuje sa z detailu používateľa.

export async function setUserTeam(userId: string, teamId: string | null): Promise<Result> {
    const guard = await assertCanManageTeams();
    if (!guard.ok) return guard;

    if (teamId) {
        const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
        if (!team) return { ok: false, error: "Tím neexistuje." };
    }

    await prisma.user.update({ where: { id: userId }, data: { teamId } });
    revalidateTeams();
    revalidatePath(`/dashboard/admin/users/${userId}`);
    return { ok: true };
}
