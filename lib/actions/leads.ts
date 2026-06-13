"use server";

import prisma from "@/lib/db";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { LeadStatus } from "@/app/generated/prisma/enums";

function revalidate(leadId: string) {
    revalidatePath("/dashboard/leads");
    revalidatePath(`/dashboard/leads/${leadId}`);
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/calls");
}

// Univerzálny update polí leadu (firma, web, telefón, cena, poznámka...)
export async function updateLead(leadId: string, data: {
    companyName?: string | null;
    website?: string | null;
    phone?: string | null;
    email?: string | null;
    note?: string | null;
    price?: number | null;
    priceNote?: string | null;
    designUrl?: string | null;
}) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    try {
        await prisma.lead.update({ where: { id: leadId }, data });
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
    revalidate(leadId);
    return { success: true };
}

export async function changeStatus(leadId: string, status: LeadStatus) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data: { status } }),
            prisma.activity.create({
                data: {
                    leadId,
                    userId: session.user.id,
                    type: "NOTE",
                    note: `Stav zmenený na ${status}`,
                },
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa zmeniť stav." };
    }
    revalidate(leadId);
    return { success: true };
}

export async function changeOwner(leadId: string, ownerId: string | null) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    try {
        await prisma.lead.update({ where: { id: leadId }, data: { ownerId } });
    } catch {
        return { error: "Nepodarilo sa zmeniť vlastníka." };
    }
    revalidate(leadId);
    return { success: true };
}

export async function setNextAction(leadId: string, at: string | null, note: string | null) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    try {
        await prisma.lead.update({
            where: { id: leadId },
            data: { nextActionAt: at ? new Date(at) : null, nextActionNote: note },
        });
    } catch {
        return { error: "Nepodarilo sa nastaviť termín." };
    }
    revalidate(leadId);
    return { success: true };
}

// "Poslal som X" – zapíše dátum + aktivitu naraz
export async function logSent(
    leadId: string,
    what: "QUOTE_SENT" | "DESIGN_SENT" | "EMAIL_SENT" | "SMS_SENT",
    sentAt?: string, // ak sa zapisuje spätne
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    const at = sentAt ? new Date(sentAt) : new Date();
    const dateField =
        what === "QUOTE_SENT" ? { quoteSentAt: at } :
        what === "DESIGN_SENT" ? { designSentAt: at } :
        what === "EMAIL_SENT" ? { aboutUsSentAt: at } : {};

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data: dateField }),
            prisma.activity.create({
                data: { leadId, userId: session.user.id, type: what, createdAt: at },
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa zapísať." };
    }
    revalidate(leadId);
    return { success: true };
}

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

    // ochrana proti duplicite – rovnaké číslo už existuje?
    const existing = await prisma.lead.findFirst({
        where: { phone },
        select: { number: true, companyName: true, website: true },
    });
    if (existing) {
        return { error: `Toto číslo už má lead #${existing.number} (${existing.companyName ?? existing.website})` };
    }

    try {
        const lead = await prisma.lead.create({
            data: { companyName, website, phone, note: data.note?.trim() || null },
            select: { id: true, number: true },
        });
        revalidatePath("/dashboard/calls");
        revalidatePath("/dashboard/leads");
        return { success: true, number: lead.number };
    } catch {
        return { error: "Nepodarilo sa pridať." };
    }
}