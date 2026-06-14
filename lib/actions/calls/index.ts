"use server";

import { auth } from "@/auth";
import { CallOutcome } from "@/app/generated/prisma/enums";
import {
    createAuditActivity,
    createBusinessActivity,
    createPlanningActivity,
    describeNextAction,
} from "@/lib/activityLog";
import prisma from "@/lib/db";
import { hasNextAction, leadStateForOutcome } from "@/lib/domain/leadFlow";
import { can } from "@/lib/permissions";
import { revalidatePath } from "next/cache";

type Opts = { note?: string; callbackNote?: string; when?: string; email?: string };
type LogCallInput = { leadId: string; outcome: CallOutcome } & Opts;

function revalidateCalls() {
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/calls/history");
    revalidatePath("/dashboard/pipeline");
    revalidatePath("/dashboard");
}

export async function logCall(input: LogCallInput) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "calls.work")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    const { leadId, outcome, note, callbackNote, when, email } = input;
    const date = when ? new Date(when) : null;
    const flow = leadStateForOutcome(outcome, date, callbackNote ?? null);
    const extra = email?.trim() ? { email: email.trim() } : {};

    try {
        await prisma.$transaction(async (tx) => {
            await tx.activity.create({
                data: createBusinessActivity({
                    leadId,
                    userId,
                    type: "CALL",
                    source: "CALL_QUEUE",
                    outcome,
                    note: note?.trim() || null,
                }),
            });
            await tx.lead.update({ where: { id: leadId }, data: { ...flow, ...extra } });

            if (hasNextAction(flow)) {
                await tx.activity.create({
                    data: createPlanningActivity({
                        leadId,
                        userId,
                        type: "NEXT_ACTION_SET",
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
    } catch (error) {
        console.error("logCall failed:", error);
        return { error: "Nepodarilo sa uložiť. Skús znova." };
    }

    revalidateCalls();
    return { success: true };
}

export async function updateLeadNote(leadId: string, note: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "calls.work")) return { error: "Nemáš oprávnenie." };

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data: { note: note.trim() || null } }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId: session.user.id,
                    type: "CONTACT_UPDATED",
                    source: "CALL_QUEUE",
                    note: "Interná poznámka kontaktu bola upravená",
                }),
            }),
        ]);
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
    if (!can(session.user, "calls.work")) return { error: "Nemáš oprávnenie." };

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId: session.user.id,
                    type: "CONTACT_UPDATED",
                    source: "CALL_QUEUE",
                    note: "Kontaktné údaje boli upravené",
                }),
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa uložiť kontakt." };
    }
    revalidateCalls();
    return { success: true };
}

// Vráti kontakt z histórie späť do volaní (status NEW) – len ak ho ešte nerieši manažér.
export async function resetLeadToCalls(leadId: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!can(session.user, "callHistory.revert")) return { error: "Nemáš oprávnenie." };
    const userId = session.user.id;

    try {
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            select: {
                price: true,
                quoteSentAt: true,
                designSentAt: true,
                aboutUsSentAt: true,
                ownerId: true,
                status: true,
                designs: { where: { deletedAt: null }, select: { id: true }, take: 1 },
            },
        });
        if (!lead) return { error: "Kontakt neexistuje." };
        const locked = Boolean(
            lead.price != null ||
                lead.quoteSentAt ||
                lead.designSentAt ||
                lead.aboutUsSentAt ||
                lead.ownerId ||
                lead.status === "WON" ||
                lead.designs.length > 0,
        );
        if (locked) return { error: "Kontakt už rieši manažér – nedá sa vrátiť." };

        await prisma.$transaction([
            prisma.lead.update({
                where: { id: leadId },
                data: {
                    status: "NEW",
                    callbackKind: null,
                    callbackAt: null,
                    callbackNote: null,
                    nextActionKind: null,
                    nextActionAt: null,
                    nextActionNote: null,
                    lostReason: null,
                },
            }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId,
                    type: "STATUS_CHANGED",
                    source: "CALL_QUEUE",
                    note: "Vrátené do volaní (reset na nový)",
                }),
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa vrátiť kontakt." };
    }
    revalidateCalls();
    revalidatePath("/dashboard/calls/history");
    return { success: true };
}
