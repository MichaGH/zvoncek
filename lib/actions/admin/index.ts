"use server";

import prisma from "@/lib/db";
import bcrypt from "bcrypt";
import { revalidatePath } from "next/cache";
import { can } from "@/lib/permissions";
import { requireUser, type AccessUser } from "@/lib/access/user";
import { deactivateUserAs, updateUserProfileAs, type RemainingWork } from "@/lib/commands/admin";
import { usernameSchema, emailSchema, passwordSchema } from "@/lib/domain/validation";
import { z } from "zod";
import { Role } from "@/app/generated/prisma/enums";

type Result<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function assertAdmin(): Promise<{ ok: true; userId: string; user: AccessUser } | { ok: false; error: string }> {
    const user = await requireUser();
    if (!user) return { ok: false, error: "Nie si prihlásený." };
    if (!can(user, "admin.access")) return { ok: false, error: "Nemáš oprávnenie." };
    return { ok: true, userId: user.id, user };
}

function revalidateAdmin() {
    revalidatePath("/dashboard/admin");
    revalidatePath("/dashboard/admin/users");
}

// ── Vytvorenie nového používateľa ─────────────────────────────────────────────

const CreateUserSchema = z.object({
    firstName: z.string().min(1, "Meno je povinné.").max(50),
    lastName: z.string().min(1, "Priezvisko je povinné.").max(50),
    username: usernameSchema,
    email: z.union([emailSchema, z.literal("")]).optional(),
    phone: z.string().max(30).optional(),
    role: z.enum(Role),
    password: passwordSchema,
});

export async function adminCreateUser(
    formData: FormData,
): Promise<Result<{ id: string }>> {
    const guard = await assertAdmin();
    if (!guard.ok) return guard;

    const parsed = CreateUserSchema.safeParse({
        firstName: formData.get("firstName"),
        lastName: formData.get("lastName"),
        username: formData.get("username"),
        email: formData.get("email") || "",
        phone: formData.get("phone") || "",
        role: formData.get("role"),
        password: formData.get("password"),
    });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

    const { firstName, lastName, username, email, phone, role, password } = parsed.data;

    const existingUsername = await prisma.user.findUnique({ where: { username } });
    if (existingUsername) return { ok: false, error: "Toto používateľské meno už existuje." };

    if (email) {
        const existingEmail = await prisma.user.findUnique({ where: { email } });
        if (existingEmail) return { ok: false, error: "Tento email už existuje." };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
        data: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            username,
            email: email || null,
            phone: phone?.trim() || null,
            role: role as Role,
            password: passwordHash,
        },
        select: { id: true },
    });

    revalidateAdmin();
    return { ok: true, data: { id: user.id } };
}

// ── Aktualizácia profilu ───────────────────────────────────────────────────────

const UpdateProfileSchema = z.object({
    firstName: z.string().min(1, "Meno je povinné.").max(50),
    lastName: z.string().min(1, "Priezvisko je povinné.").max(50),
    username: usernameSchema,
    email: z.union([emailSchema, z.literal("")]).optional(),
    phone: z.string().max(30).optional(),
    role: z.enum(Role),
    note: z.string().max(500).optional(),
});

export async function adminUpdateUser(
    id: string,
    formData: FormData,
): Promise<Result> {
    const guard = await assertAdmin();
    if (!guard.ok) return guard;

    const parsed = UpdateProfileSchema.safeParse({
        firstName: formData.get("firstName"),
        lastName: formData.get("lastName"),
        username: formData.get("username"),
        email: formData.get("email") || "",
        phone: formData.get("phone") || "",
        role: formData.get("role"),
        note: formData.get("note") || "",
    });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

    const { firstName, lastName, username, email, phone, role, note } = parsed.data;

    const existingUsername = await prisma.user.findFirst({ where: { username, NOT: { id } } });
    if (existingUsername) return { ok: false, error: "Toto používateľské meno už existuje." };

    if (email) {
        const existingEmail = await prisma.user.findFirst({ where: { email, NOT: { id } } });
        if (existingEmail) return { ok: false, error: "Tento email už existuje." };
    }

    // Zmena roly bez calls.work/claim uvoľní nevolané NEW v tej istej transakcii (plán §9).
    const result = await updateUserProfileAs(guard.user, id, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        username,
        email: email || null,
        phone: phone?.trim() || null,
        role: role as Role,
        note: note?.trim() || null,
    });
    if (!result.ok) return { ok: false, error: result.error };

    revalidateAdmin();
    revalidatePath(`/dashboard/admin/users/${id}`);
    revalidatePath("/dashboard/calls");
    return { ok: true };
}

// ── Reset hesla ───────────────────────────────────────────────────────────────

export async function adminResetPassword(
    id: string,
    formData: FormData,
): Promise<Result> {
    const guard = await assertAdmin();
    if (!guard.ok) return guard;

    const parsed = z
        .object({
            password: passwordSchema,
            confirm: z.string(),
        })
        .refine((d) => d.password === d.confirm, { message: "Heslá sa nezhodujú.", path: ["confirm"] })
        .safeParse({ password: formData.get("password"), confirm: formData.get("confirm") });

    if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    await prisma.user.update({ where: { id }, data: { password: passwordHash } });
    revalidatePath(`/dashboard/admin/users/${id}`);
    return { ok: true };
}

// ── Deaktivácia / reaktivácia ─────────────────────────────────────────────────

// Deaktivácia počká na rozbehnutú prácu používateľa, uvoľní jeho nevolané NEW (musí ostať 0, inak sa nevykoná)
// a vráti, čo ešte drží (retry, callbacky, spiace, obchody) – tie presúva manažér ručne.
export async function adminDeactivateUser(id: string): Promise<Result<RemainingWork>> {
    const guard = await assertAdmin();
    if (!guard.ok) return guard;

    const result = await deactivateUserAs(guard.user, id);
    if (!result.ok) return { ok: false, error: result.error };
    revalidateAdmin();
    revalidatePath(`/dashboard/admin/users/${id}`);
    revalidatePath("/dashboard/calls/assignments");
    return { ok: true, data: result.data };
}

export async function adminReactivateUser(id: string): Promise<Result> {
    const guard = await assertAdmin();
    if (!guard.ok) return guard;

    await prisma.user.update({ where: { id }, data: { deletedAt: null } });
    revalidateAdmin();
    revalidatePath(`/dashboard/admin/users/${id}`);
    return { ok: true };
}
