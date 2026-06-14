"use server";

import { auth } from "@/auth";
import { ActivityType, LeadStatus, NextActionKind } from "@/app/generated/prisma/enums";
import {
    createAuditActivity,
    createBusinessActivity,
    createPlanningActivity,
    describeNextAction,
    nextActionData,
} from "@/lib/activityLog";
import prisma from "@/lib/db";
import { revalidatePath } from "next/cache";

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
    const userId = session.user.id;

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId,
                    type: "CONTACT_UPDATED",
                    source: "PIPELINE",
                    note: "Údaje príležitosti boli upravené",
                }),
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function changeStatus(leadId: string, status: LeadStatus) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    const userId = session.user.id;

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data: { status } }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId,
                    type: "STATUS_CHANGED",
                    source: "PIPELINE",
                    note: `Stav zmenený na ${status}`,
                }),
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
    const userId = session.user.id;

    try {
        await prisma.$transaction([
            prisma.lead.update({ where: { id: leadId }, data: { ownerId } }),
            prisma.activity.create({
                data: createAuditActivity({
                    leadId,
                    userId,
                    type: "OWNER_CHANGED",
                    source: "PIPELINE",
                    note: ownerId ? "Vlastník príležitosti bol zmenený" : "Vlastník príležitosti bol odobratý",
                }),
            }),
        ]);
    } catch {
        return { error: "Nepodarilo sa zmeniť vlastníka." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function setNextAction(
    leadId: string,
    kind: NextActionKind | null,
    at: string | null,
    note: string | null,
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    const userId = session.user.id;

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.lead.findUnique({
                where: { id: leadId },
                select: { nextActionKind: true, nextActionAt: true, nextActionNote: true },
            });
            if (!current) throw new Error("Lead not found");

            const next = nextActionData(kind, at ? new Date(at) : null, note);
            const hadNextAction = Boolean(
                current.nextActionKind || current.nextActionAt || current.nextActionNote,
            );
            const type = !kind
                ? "NEXT_ACTION_CLEARED"
                : hadNextAction
                  ? "NEXT_ACTION_CHANGED"
                  : "NEXT_ACTION_SET";

            await tx.lead.update({ where: { id: leadId }, data: next });
            await tx.activity.create({
                data: createPlanningActivity({
                    leadId,
                    userId,
                    type,
                    source: "PIPELINE",
                    note: describeNextAction(next),
                }),
            });
        });
    } catch {
        return { error: "Nepodarilo sa nastaviť ďalší krok." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

const SENT_DEFAULTS: Record<
    "QUOTE_SENT" | "DESIGN_SENT" | "EMAIL_SENT",
    { dateField: "quoteSentAt" | "designSentAt" | "aboutUsSentAt"; note: string }
> = {
    QUOTE_SENT: {
        dateField: "quoteSentAt",
        note: "Zavolať, či cenová ponuka prišla",
    },
    DESIGN_SENT: {
        dateField: "designSentAt",
        note: "Zavolať, či si návrh pozreli",
    },
    EMAIL_SENT: {
        dateField: "aboutUsSentAt",
        note: "Zavolať, či email prišiel / či si ho pozreli",
    },
};

export async function logSent(
    leadId: string,
    what: "QUOTE_SENT" | "DESIGN_SENT" | "EMAIL_SENT",
    sentAt?: string,
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    const userId = session.user.id;

    const at = sentAt ? new Date(sentAt) : new Date();
    const followUpAt = new Date(at);
    followUpAt.setDate(followUpAt.getDate() + 7);
    const defaults = SENT_DEFAULTS[what];
    const next = nextActionData("CALL", followUpAt, defaults.note);

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.lead.findUnique({
                where: { id: leadId },
                select: { nextActionKind: true, nextActionAt: true, nextActionNote: true },
            });
            if (!current) throw new Error("Lead not found");
            const hadNextAction = Boolean(
                current.nextActionKind || current.nextActionAt || current.nextActionNote,
            );

            await tx.lead.update({
                where: { id: leadId },
                data: { [defaults.dateField]: at, ...next },
            });
            await tx.activity.create({
                data: createBusinessActivity({
                    leadId,
                    userId,
                    type: what,
                    source: "PIPELINE",
                    createdAt: at,
                }),
            });
            await tx.activity.create({
                data: createPlanningActivity({
                    leadId,
                    userId,
                    type: hadNextAction ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                    source: "PIPELINE",
                    note: describeNextAction(next),
                }),
            });
        });
    } catch {
        return { error: "Nepodarilo sa zapísať." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function addBusinessNote(leadId: string, note: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };
    if (!note.trim()) return { error: "Poznámka nemôže byť prázdna." };

    try {
        await prisma.activity.create({
            data: createBusinessActivity({
                leadId,
                userId: session.user.id,
                type: "NOTE",
                source: "PIPELINE",
                note: note.trim(),
            }),
        });
    } catch {
        return { error: "Nepodarilo sa pridať poznámku." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}

export async function logBusinessActivity(
    leadId: string,
    type: Extract<ActivityType, "SMS_SENT">,
    note?: string,
) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Nie si prihlásený." };

    try {
        await prisma.activity.create({
            data: createBusinessActivity({
                leadId,
                userId: session.user.id,
                type,
                source: "PIPELINE",
                note: note?.trim() || null,
            }),
        });
    } catch {
        return { error: "Nepodarilo sa zapísať aktivitu." };
    }
    revalidatePipeline(leadId);
    return { success: true };
}
