"use server";

import { auth } from "@/auth";
import prisma from "@/lib/db";
import { createAuditActivity } from "@/lib/activityLog";
import { revalidatePath } from "next/cache";

function revalidateContacts() {
    revalidatePath("/dashboard/contacts");
    revalidatePath("/dashboard/contacts/new");
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/pipeline");
}

export type CreateContactInput = {
    companyName?: string;
    website?: string;
    phone?: string;
    note?: string;
};

export type CreateContactResult =
    | { ok: true; id: string; number: number }
    | { ok: false; error: string; duplicate?: { number: number; name: string } };

// Adding contacts is the one job the (non-technical) sorters do.
// A contact needs a name (company OR website) and a phone number to be callable.
// Inserts never collide with people calling/editing other leads, so concurrent
// adding is safe; the only shared guard is the soft duplicate-phone check below.
export async function createContact(input: CreateContactInput): Promise<CreateContactResult> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Nie si prihlásený." };

    const companyName = input.companyName?.trim() || null;
    const website = input.website?.trim() || null;
    const phone = input.phone?.trim() || null;
    const note = input.note?.trim() || null;

    if (!companyName && !website) {
        return { ok: false, error: "Vyplň firmu alebo web." };
    }
    if (!phone) {
        return { ok: false, error: "Telefón je povinný." };
    }

    if (phone) {
        const existing = await prisma.lead.findFirst({
            where: { phone, deletedAt: null },
            select: { number: true, companyName: true, website: true },
        });
        if (existing) {
            const name = existing.companyName ?? existing.website ?? "—";
            return {
                ok: false,
                error: `Toto číslo už existuje ako #${existing.number} (${name}).`,
                duplicate: { number: existing.number, name },
            };
        }
    }

    try {
        const lead = await prisma.lead.create({
            data: { companyName, website, phone, note, createdById: session.user.id },
            select: { id: true, number: true },
        });
        revalidateContacts();
        return { ok: true, id: lead.id, number: lead.number };
    } catch {
        return { ok: false, error: "Nepodarilo sa uložiť. Skús znova." };
    }
}

export type UpdateContactInput = {
    companyName?: string;
    website?: string;
    phone?: string;
    note?: string;
};

export async function updateContact(
    id: string,
    input: UpdateContactInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Nie si prihlásený." };

    const companyName = input.companyName?.trim() || null;
    const website = input.website?.trim() || null;
    const phone = input.phone?.trim() || null;
    const note = input.note?.trim() || null;

    if (!companyName && !website) return { ok: false, error: "Vyplň firmu alebo web." };
    if (!phone) return { ok: false, error: "Telefón je povinný." };

    try {
        await prisma.$transaction([
            prisma.lead.update({
                where: { id },
                data: { companyName, website, phone, note },
            }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId: id,
                    userId: session.user.id,
                    type: "CONTACT_UPDATED",
                    source: "CONTACTS",
                    note: "Kontakt upravený",
                }),
            }),
        ]);
    } catch {
        return { ok: false, error: "Nepodarilo sa uložiť." };
    }
    revalidateContacts();
    return { ok: true };
}

// Soft delete – kontakt sa schová, ale nestratí sa (dá sa obnoviť v DB).
export async function deleteContact(
    id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Nie si prihlásený." };

    try {
        await prisma.lead.update({
            where: { id },
            data: { deletedAt: new Date() },
        });
    } catch {
        return { ok: false, error: "Nepodarilo sa vymazať." };
    }
    revalidateContacts();
    return { ok: true };
}
