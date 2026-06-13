"use server";

import prisma from "@/lib/db";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { LeadStatus } from "@/app/generated/prisma/enums";

function revalidatePipeline(leadId: string) {
    revalidatePath("/dashboard/pipeline");
    revalidatePath(`/dashboard/pipeline/${leadId}`);
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/calls");
}

export async function updateLead(
    leadId: string,
    data: {
        companyName?: string | null;
        website?: string | null;
        phone?: string | null;
        email?: string | null;
        note?: string | null;
        price?: number | null;
        priceNote?: string | null;
        designUrl?: string | null;
    },
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    try {
        await prisma.lead.update({ where: { id: leadId }, data });
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
    revalidatePipeline(leadId);
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
    revalidatePipeline(leadId);
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
    revalidatePipeline(leadId);
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
    revalidatePipeline(leadId);
    return { success: true };
}

export async function logSent(
    leadId: string,
    what: "QUOTE_SENT" | "DESIGN_SENT" | "EMAIL_SENT" | "SMS_SENT",
    sentAt?: string,
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    const at = sentAt ? new Date(sentAt) : new Date();
    const dateField =
        what === "QUOTE_SENT"
            ? { quoteSentAt: at }
            : what === "DESIGN_SENT"
              ? { designSentAt: at }
              : what === "EMAIL_SENT"
                ? { aboutUsSentAt: at }
                : {};

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
    revalidatePipeline(leadId);
    return { success: true };
}
