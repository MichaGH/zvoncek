"use server";

import prisma from "@/lib/db";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { CallOutcome } from "@/app/generated/prisma/enums";
import { leadStateForOutcome } from "../domain/leadFlow";

// oprava poznámky hovoru
export async function editActivityNote(activityId: string, note: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    try {
        const activity = await prisma.activity.findUnique({ where: { id: activityId }, select: { leadId: true } });
        if (!activity) return { error: "Záznam neexistuje." };

        await prisma.$transaction([
            prisma.activity.update({ where: { id: activityId }, data: { note: note.trim() || null } }),
            prisma.activity.create({
                data: {
                    leadId: activity.leadId,
                    userId: session.user.id,
                    type: "NOTE",
                    category: "SYSTEM",
                    note: "Upravená poznámka hovoru",
                },
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa upraviť." };
    }
    revalidatePath("/dashboard/calls/history");
    return { success: true };
}

// oprava výsledku hovoru – vráti aj stav leadu podľa nového outcome
export async function correctOutcome(activityId: string, newOutcome: CallOutcome) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    try {
        const activity = await prisma.activity.findUnique({
            where: { id: activityId },
            select: { leadId: true, outcome: true },
        });
        if (!activity) return { error: "Záznam neexistuje." };

        // mapovanie outcome → stav leadu (rovnaké pravidlá ako logCall)
        const leadData = leadStateForOutcome(newOutcome);

        await prisma.$transaction([
            prisma.activity.update({ where: { id: activityId }, data: { outcome: newOutcome } }),
            prisma.lead.update({ where: { id: activity.leadId }, data: leadData }),
            prisma.activity.create({
                data: {
                    leadId: activity.leadId,
                    userId: session.user.id,
                    type: "NOTE",
                    category: "SYSTEM",
                    note: `Opravený výsledok: ${activity.outcome} → ${newOutcome}`,
                },
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa opraviť výsledok." };
    }
    revalidatePath("/dashboard/calls/history");
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/leads");
    return { success: true };
}

/* // zdieľaná logika – rovnaká ako v logCall, vytiahnutá nech sa neopakuje
function leadStateForOutcome(outcome: CallOutcome) {
    switch (outcome) {
        case "NO_ANSWER": return { status: "CALLING" as const, callbackKind: "RETRY" as const, callbackAt: null };
        case "CALL_AGAIN": return { status: "CALLING" as const, callbackKind: "SCHEDULED" as const };
        case "BAD_NUMBER": return { status: "UNREACHABLE" as const, callbackKind: null, callbackAt: null, lostReason: "Zlé / nefunkčné číslo" };
        case "NOT_INTERESTED": return { status: "LOST" as const, callbackKind: null, callbackAt: null, lostReason: "Nemajú záujem" };
        case "WANTS_QUOTE": return { status: "ACTIVE" as const, callbackKind: null, callbackAt: null, nextActionAt: new Date(), nextActionNote: "Poslať cenovú ponuku" };
        case "WANTS_DESIGN": return { status: "ACTIVE" as const, callbackKind: null, callbackAt: null, nextActionAt: new Date(), nextActionNote: "Vytvoriť a poslať dizajnový návrh" };
        case "WANTS_EMAIL": return { status: "ACTIVE" as const, callbackKind: null, callbackAt: null, nextActionAt: new Date(), nextActionNote: "Napísať im email" };
        case "SNOOZE": return { status: "SNOOZED" as const, callbackKind: null, callbackAt: null };
        case "POSITIVE": return { status: "ACTIVE" as const, callbackKind: null, callbackAt: null };
    }
} */