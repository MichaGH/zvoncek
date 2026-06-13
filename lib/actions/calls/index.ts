"use server";

import prisma from "@/lib/db";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { CallOutcome } from "@/app/generated/prisma/enums";
import { leadStateForOutcome } from "@/lib/domain/leadFlow";

type Opts = { note?: string; callbackNote?: string; when?: string; email?: string };
type LogCallInput = { leadId: string; outcome: CallOutcome } & Opts;

export async function logCall(input: LogCallInput) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    const { leadId, outcome, note, callbackNote, when, email } = input;
    const date = when ? new Date(when) : null;

    const flow = leadStateForOutcome(outcome, date, callbackNote ?? null);
    const extra = email?.trim() ? { email: email.trim() } : {};

    try {
        await prisma.$transaction([
            prisma.activity.create({
                data: { leadId, userId: session.user.id, type: "CALL", category: "CLIENT", outcome, note: note?.trim() || null },
            }),
            prisma.lead.update({ where: { id: leadId }, data: { ...flow, ...extra } }),
        ]);
    } catch (error) {
        console.error("logCall failed:", error);
        return { error: "Nepodarilo sa uložiť. Skús znova." };
    }

    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/leads");
    revalidatePath("/dashboard");
    return { success: true };
}

export async function updateLeadNote(leadId: string, note: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    try {
        await prisma.lead.update({ where: { id: leadId }, data: { note: note.trim() || null } });
    } catch {
        return { error: "Nepodarilo sa uložiť poznámku." };
    }
    revalidatePath("/dashboard/calls");
    return { success: true };
}

export async function updateLeadContact(
    leadId: string,
    data: { companyName?: string | null; website?: string | null; phone?: string | null; email?: string | null },
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    try {
        await prisma.lead.update({ where: { id: leadId }, data });
    } catch {
        return { error: "Nepodarilo sa uložiť kontakt." };
    }
    revalidatePath("/dashboard/calls");
    return { success: true };
}