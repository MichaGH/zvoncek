"use server";

import { auth } from "@/auth";
import prisma from "@/lib/db";
import bcrypt from "bcrypt";
import { revalidatePath } from "next/cache";
import { can } from "@/lib/permissions";
import { usernameSchema, emailSchema, passwordSchema } from "@/lib/domain/validation";
import { z } from "zod";
import type { Role } from "@/app/generated/prisma/enums";

type Result<T = void> = { ok: true; data?: T } | { ok: false; error: string };

async function assertAdmin(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Nie si prihlásený." };
    if (!can(session.user, "admin.access")) return { ok: false, error: "Nemáš oprávnenie." };
    return { ok: true, userId: session.user.id };
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
    role: z.enum(["SCOUT", "TELESALES", "MANAGER", "ADMIN"]),
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
    role: z.enum(["SCOUT", "TELESALES", "MANAGER", "ADMIN"]),
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

    await prisma.user.update({
        where: { id },
        data: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            username,
            email: email || null,
            phone: phone?.trim() || null,
            role: role as Role,
            note: note?.trim() || null,
        },
    });

    revalidateAdmin();
    revalidatePath(`/dashboard/admin/users/${id}`);
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

export async function adminDeactivateUser(id: string): Promise<Result> {
    const guard = await assertAdmin();
    if (!guard.ok) return guard;
    if (id === guard.userId) return { ok: false, error: "Nemôžeš deaktivovať vlastný účet." };

    await prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
    revalidateAdmin();
    revalidatePath(`/dashboard/admin/users/${id}`);
    return { ok: true };
}

export async function adminReactivateUser(id: string): Promise<Result> {
    const guard = await assertAdmin();
    if (!guard.ok) return guard;

    await prisma.user.update({ where: { id }, data: { deletedAt: null } });
    revalidateAdmin();
    revalidatePath(`/dashboard/admin/users/${id}`);
    return { ok: true };
}
