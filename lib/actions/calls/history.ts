"use server";

import { auth } from "@/auth";
import { CallOutcome } from "@/app/generated/prisma/enums";
import {
    createAuditActivity,
    createPlanningActivity,
    describeNextAction,
} from "@/lib/activityLog";
import prisma from "@/lib/db";
import { hasNextAction, leadStateForOutcome } from "@/lib/domain/leadFlow";
import { revalidatePath } from "next/cache";

export async function editActivityNote(activityId: string, note: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    const userId = session.user.id;

    try {
        await prisma.$transaction(async (tx) => {
            const activity = await tx.activity.findUnique({
                where: { id: activityId },
                select: { leadId: true },
            });
            if (!activity) throw new Error("Activity not found");

            await tx.activity.update({
                where: { id: activityId },
                data: { note: note.trim() || null },
            });
            await tx.activity.create({
                data: createAuditActivity({
                    leadId: activity.leadId,
                    userId,
                    type: "NOTE",
                    source: "CALL_QUEUE",
                    note: "Poznámka hovoru bola opravená",
                }),
            });
        });
    } catch {
        return { error: "Nepodarilo sa upraviť." };
    }
    revalidatePath("/dashboard/calls/history");
    return { success: true };
}

export async function correctOutcome(activityId: string, newOutcome: CallOutcome) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    const userId = session.user.id;

    try {
        await prisma.$transaction(async (tx) => {
            const activity = await tx.activity.findUnique({
                where: { id: activityId },
                select: { leadId: true, outcome: true },
            });
            if (!activity) throw new Error("Activity not found");

            const flow = leadStateForOutcome(newOutcome);
            await tx.activity.update({
                where: { id: activityId },
                data: { outcome: newOutcome },
            });
            await tx.lead.update({ where: { id: activity.leadId }, data: flow });
            await tx.activity.create({
                data: createAuditActivity({
                    leadId: activity.leadId,
                    userId,
                    type: "OUTCOME_CORRECTED",
                    source: "CALL_QUEUE",
                    note: `Výsledok hovoru opravený: ${activity.outcome ?? "bez výsledku"} → ${newOutcome}`,
                }),
            });

            if (hasNextAction(flow)) {
                await tx.activity.create({
                    data: createPlanningActivity({
                        leadId: activity.leadId,
                        userId,
                        type: "NEXT_ACTION_CHANGED",
                        source: "CALL_QUEUE",
                        note: describeNextAction({
                            nextActionKind: flow.nextActionKind ?? null,
                            nextActionAt: flow.nextActionAt ?? null,
                            nextActionNote: flow.nextActionNote ?? null,
                        }),
                    }),
                });
            }
        });
    } catch {
        return { error: "Nepodarilo sa opraviť výsledok." };
    }
    revalidatePath("/dashboard/calls/history");
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/pipeline");
    return { success: true };
}
