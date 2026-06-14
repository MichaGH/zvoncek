"use server";

import { auth } from "@/auth";
import prisma from "@/lib/db";
import { revalidatePath } from "next/cache";
import { generateToken } from "@/lib/tracking/tokens";
import { canManagePipeline } from "@/lib/permissions";
import {
    createAuditActivity,
    createBusinessActivity,
    createPlanningActivity,
    describeNextAction,
    nextActionData,
} from "@/lib/activityLog";

function revalidateForLead(leadId: string | null | undefined) {
    if (leadId) {
        revalidatePath(`/dashboard/pipeline/${leadId}`);
        revalidatePath("/dashboard/pipeline");
    }
}

export async function createDesign(input: {
    leadId: string;
    label?: string | null;
    url?: string | null;
    repoUrl?: string | null;
}) {
    const session = await auth();
    if (!canManagePipeline(session?.user)) return { error: "Nemáš oprávnenie." };
    const userId = session!.user!.id!;

    const url = input.url?.trim() || null;
    const label = input.label?.trim() || null;
    const repoUrl = input.repoUrl?.trim() || null;
    const token = generateToken();

    try {
        await prisma.$transaction(async (tx) => {
            await tx.design.create({
                data: {
                    leadId: input.leadId,
                    label,
                    targetUrl: url,
                    repoUrl,
                    currentVersion: 1,
                    createdById: userId,
                    versions: { create: { version: 1, url, createdById: userId } },
                    tracker: { create: { token } },
                },
            });
            await tx.activity.create({
                data: createBusinessActivity({
                    leadId: input.leadId,
                    userId,
                    type: "TRACKER_ATTACHED",
                    source: "PIPELINE",
                    note: label ? `Návrh pridaný: ${label}` : "Návrh pridaný",
                }),
            });
        });
        revalidateForLead(input.leadId);
        return { success: true };
    } catch {
        return { error: "Nepodarilo sa vytvoriť návrh." };
    }
}

export async function addDesignVersion(
    designId: string,
    input: { url?: string | null; note?: string | null },
) {
    const session = await auth();
    if (!canManagePipeline(session?.user)) return { error: "Nemáš oprávnenie." };
    const userId = session!.user!.id!;

    const newUrl = input.url?.trim();
    const note = input.note?.trim() || null;

    try {
        const leadId = await prisma.$transaction(async (tx) => {
            const design = await tx.design.findUnique({
                where: { id: designId },
                select: { leadId: true, currentVersion: true, targetUrl: true },
            });
            if (!design) throw new Error("not found");

            const nextVersion = design.currentVersion + 1;
            const nextUrl = newUrl ? newUrl : design.targetUrl;

            await tx.designVersion.create({
                data: { designId, version: nextVersion, url: nextUrl, note, createdById: userId },
            });
            await tx.design.update({
                where: { id: designId },
                data: { currentVersion: nextVersion, targetUrl: nextUrl },
            });
            await tx.activity.create({
                data: createBusinessActivity({
                    leadId: design.leadId,
                    userId,
                    type: "TRACKER_UPDATED",
                    source: "PIPELINE",
                    note: `Návrh aktualizovaný (v${nextVersion})${note ? ` – ${note}` : ""}`,
                }),
            });
            return design.leadId;
        });
        revalidateForLead(leadId);
        return { success: true };
    } catch {
        return { error: "Nepodarilo sa aktualizovať návrh." };
    }
}

// Metadáta bez novej verzie: label, GitHub repo, live/off príznak.
export async function updateDesignMeta(
    designId: string,
    input: { label?: string | null; repoUrl?: string | null; isLive?: boolean },
) {
    const session = await auth();
    if (!canManagePipeline(session?.user)) return { error: "Nemáš oprávnenie." };

    const data: { label?: string | null; repoUrl?: string | null; isLive?: boolean } = {};
    if (input.label !== undefined) data.label = input.label?.trim() || null;
    if (input.repoUrl !== undefined) data.repoUrl = input.repoUrl?.trim() || null;
    if (input.isLive !== undefined) data.isLive = input.isLive;

    try {
        const design = await prisma.design.update({
            where: { id: designId },
            data,
            select: { leadId: true },
        });
        revalidateForLead(design.leadId);
        return { success: true };
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
}

export async function removeDesign(designId: string) {
    const session = await auth();
    if (!canManagePipeline(session?.user)) return { error: "Nemáš oprávnenie." };

    try {
        const design = await prisma.design.update({
            where: { id: designId },
            data: { deletedAt: new Date() },
            select: { leadId: true },
        });
        revalidateForLead(design.leadId);
        return { success: true };
    } catch {
        return { error: "Nepodarilo sa odstrániť návrh." };
    }
}

// Per-návrh „poslané" – revertovateľné. Pri zapnutí nastaví aj lead.designSentAt + follow-up.
export async function setDesignSent(designId: string, sent: boolean) {
    const session = await auth();
    if (!canManagePipeline(session?.user)) return { error: "Nemáš oprávnenie." };
    const userId = session!.user!.id!;

    try {
        const leadId = await prisma.$transaction(async (tx) => {
            const design = await tx.design.findUnique({
                where: { id: designId },
                select: { leadId: true },
            });
            if (!design) throw new Error("not found");

            await tx.design.update({
                where: { id: designId },
                data: { sentAt: sent ? new Date() : null },
            });

            if (sent) {
                const lead = await tx.lead.findUnique({
                    where: { id: design.leadId },
                    select: { nextActionKind: true, nextActionAt: true, nextActionNote: true },
                });
                const followUpAt = new Date();
                followUpAt.setDate(followUpAt.getDate() + 7);
                const next = nextActionData("CALL", followUpAt, "Zavolať, či si návrh pozreli");
                const hadNext = Boolean(
                    lead?.nextActionKind || lead?.nextActionAt || lead?.nextActionNote,
                );

                await tx.lead.update({
                    where: { id: design.leadId },
                    data: { designSentAt: new Date(), ...next },
                });
                await tx.activity.create({
                    data: createBusinessActivity({
                        leadId: design.leadId,
                        userId,
                        type: "DESIGN_SENT",
                        source: "PIPELINE",
                    }),
                });
                await tx.activity.create({
                    data: createPlanningActivity({
                        leadId: design.leadId,
                        userId,
                        type: hadNext ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                        source: "PIPELINE",
                        note: describeNextAction(next),
                    }),
                });
            } else {
                // Prepočítaj lead.designSentAt z ostatných poslaných návrhov.
                const latest = await tx.design.findFirst({
                    where: { leadId: design.leadId, deletedAt: null, sentAt: { not: null } },
                    orderBy: { sentAt: "desc" },
                    select: { sentAt: true },
                });
                await tx.lead.update({
                    where: { id: design.leadId },
                    data: { designSentAt: latest?.sentAt ?? null },
                });
                await tx.activity.create({
                    data: createAuditActivity({
                        leadId: design.leadId,
                        userId,
                        type: "TRACKER_UPDATED",
                        source: "PIPELINE",
                        note: "Návrh označený ako neposlaný",
                    }),
                });
            }
            return design.leadId;
        });
        revalidateForLead(leadId);
        return { success: true };
    } catch {
        return { error: "Nepodarilo sa uložiť." };
    }
}
