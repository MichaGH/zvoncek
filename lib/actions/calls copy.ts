"use server";

import prisma from "@/lib/db";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { CallOutcome, LeadStatus, CallbackKind } from "@/app/generated/prisma/enums";

type Opts = { note?: string; callbackNote?: string; when?: string };
type LogCallInput = { leadId: string; outcome: CallOutcome } & Opts;

export async function logCall(input: LogCallInput) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    const { leadId, outcome, note, callbackNote, when } = input;
    const date = when ? new Date(when) : null;

    const data: {
        status?: LeadStatus;
        callbackKind?: CallbackKind | null;
        callbackAt?: Date | null;
        callbackNote?: string | null;
        nextActionAt?: Date | null;
        nextActionNote?: string | null;
        lostReason?: string | null;
    } = {};

    switch (outcome) {
        case "NO_ANSWER":
            // nedovolala sa → skúsiť znova, BEZ presného času
            data.status = "CALLING";
            data.callbackKind = "RETRY";
            data.callbackAt = null;
            data.callbackNote = callbackNote || null;
            break;
        case "CALL_AGAIN":
            // zdvihla, dohodli presný čas → urgentné
            data.status = "CALLING";
            data.callbackKind = "SCHEDULED";
            data.callbackAt = date;
            data.callbackNote = callbackNote || "Dohodnutý hovor";
            break;
        case "BAD_NUMBER":
            data.status = "UNREACHABLE";
            data.callbackKind = null;
            data.callbackAt = null;
            data.lostReason = "Zlé / nefunkčné číslo";
            break;
        case "NOT_INTERESTED":
            data.status = "LOST";
            data.callbackKind = null;
            data.callbackAt = null;
            data.lostReason = "Nemajú záujem";
            break;
        case "WANTS_QUOTE":
            data.status = "ACTIVE";
            data.callbackKind = null;
            data.callbackAt = null;
            data.nextActionAt = new Date();
            data.nextActionNote = "Poslať cenovú ponuku";
            break;
        case "WANTS_DESIGN":
            data.status = "ACTIVE";
            data.callbackKind = null;
            data.callbackAt = null;
            data.nextActionAt = new Date();
            data.nextActionNote = "Vytvoriť a poslať dizajnový návrh";
            break;
        case "WANTS_EMAIL":
            data.status = "ACTIVE";
            data.callbackKind = null;
            data.callbackAt = null;
            data.nextActionAt = new Date();
            data.nextActionNote = "Napísať im email";
            break;
        case "SNOOZE":
            data.status = "SNOOZED";
            data.callbackKind = null;
            data.callbackAt = null;
            data.nextActionAt = date;
            data.nextActionNote = "Znovu osloviť (chceli o pár mesiacov)";
            break;
    }

    try {
        await prisma.$transaction([
            prisma.activity.create({
                data: { leadId, userId: session.user.id, type: "CALL", outcome, note: note || null },
            }),
            prisma.lead.update({ where: { id: leadId }, data }),
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