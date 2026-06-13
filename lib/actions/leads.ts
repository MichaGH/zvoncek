"use server";

import { auth } from "@/auth";
import prisma from "@/lib/db";
import { revalidatePath } from "next/cache";

export async function createLead(data: {
    companyName?: string;
    website?: string;
    phone: string;
    note?: string;
}) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    const companyName = data.companyName?.trim() || null;
    const website = data.website?.trim() || null;
    const phone = data.phone.trim();

    if (!phone) return { error: "Telefón je povinný." };
    if (!companyName && !website) return { error: "Zadaj meno alebo web." };

    const existing = await prisma.lead.findFirst({
        where: { phone },
        select: { number: true, companyName: true, website: true },
    });
    if (existing) {
        return {
            error: `Toto číslo už má lead #${existing.number} (${existing.companyName ?? existing.website})`,
        };
    }

    try {
        const lead = await prisma.lead.create({
            data: { companyName, website, phone, note: data.note?.trim() || null },
            select: { number: true },
        });
        revalidatePath("/dashboard/calls");
        revalidatePath("/dashboard/pipeline");
        return { success: true, number: lead.number };
    } catch {
        return { error: "Nepodarilo sa pridať." };
    }
}
