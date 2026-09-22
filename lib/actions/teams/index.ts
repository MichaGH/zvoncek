"use server";

import prisma from "@/lib/db";
import { can } from "@/lib/permissions";
import { requireUser } from "@/lib/access/user";
import { deleteTeamAs, setTeamLeaderAs, setUserTeamAs } from "@/lib/commands/teams";
import { revalidatePath } from "next/cache";
import { z } from "zod";

type Result<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function assertCanManageTeams(): Promise<
    { ok: true; userId: string } | { ok: false; error: string }
> {
    const user = await requireUser();
    if (!user) return { ok: false, error: "Nie si prihlásený." };
    if (!can(user, "teams.manage")) return { ok: false, error: "Nemáš oprávnenie." };
    return { ok: true, userId: user.id };
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
// Členom sa teamId nastaví na null, vedúci sa uvoľní. Kontakty ani ich história sa NEMAŽÚ.

export async function deleteTeam(id: string): Promise<Result> {
    const guard = await assertCanManageTeams();
    if (!guard.ok) return guard;
    const result = await deleteTeamAs(id);
    if (result.ok) revalidateTeams();
    return result;
}

// ── Vedúci tímu ────────────────────────────────────────────────────────────────
// Vedúci s deals.receive dostáva obchody z pozitívnych hovorov členov – zámky zdieľané s handoffom.

export async function setTeamLeader(teamId: string, leaderId: string | null): Promise<Result> {
    const guard = await assertCanManageTeams();
    if (!guard.ok) return guard;
    const result = await setTeamLeaderAs(teamId, leaderId);
    if (result.ok) revalidateTeams();
    return result;
}

// ── Členstvo používateľa v tíme ─────────────────────────────────────────────────

export async function setUserTeam(userId: string, teamId: string | null): Promise<Result> {
    const guard = await assertCanManageTeams();
    if (!guard.ok) return guard;
    const result = await setUserTeamAs(userId, teamId);
    if (result.ok) {
        revalidateTeams();
        revalidatePath(`/dashboard/admin/users/${userId}`);
    }
    return result;
}
