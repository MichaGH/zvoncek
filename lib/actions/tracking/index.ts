"use server";

import { auth } from "@/auth";
import prisma from "@/lib/db";
import { revalidatePath } from "next/cache";
import { generateToken } from "@/lib/tracking/tokens";
import { canManagePipeline } from "@/lib/permissions";
import { createBusinessActivity } from "@/lib/activityLog";
import type { TrackedLinkKind } from "@/app/generated/prisma/enums";

function revalidateForLead(leadId: string | null | undefined) {
    if (leadId) {
        revalidatePath(`/dashboard/pipeline/${leadId}`);
        revalidatePath("/dashboard/pipeline");
    }
    revalidatePath("/dashboard/tracking");
}

export async function createTrackedLink(input: {
    leadId?: string | null;
    kind?: TrackedLinkKind;
    label?: string | null;
    url?: string | null;
}) {
    const session = await auth();
    if (!canManagePipeline(session?.user)) return { error: "Nemáš oprávnenie." };
    const userId = session!.user!.id!;

    const token = generateToken();
    const kind = input.kind ?? "DESIGN";
    const url = input.url?.trim() || null;
    const label = input.label?.trim() || null;

    try {
        const created = await prisma.$transaction(async (tx) => {
            const link = await tx.trackedLink.create({
                data: {
                    token,
                    kind,
                    leadId: input.leadId ?? null,
                    label,
                    targetUrl: url,
                    currentVersion: 1,
                    createdById: userId,
                    versions: { create: { version: 1, url, createdById: userId } },
                },
                select: { id: true, token: true },
            });
            if (input.leadId) {
                await tx.activity.create({
                    data: createBusinessActivity({
                        leadId: input.leadId,
                        userId,
                        type: "TRACKER_ATTACHED",
                        source: "PIPELINE",
                        note: label ? `Tracker pripojený: ${label}` : "Tracker pripojený",
                    }),
                });
            }
            return link;
        });
        revalidateForLead(input.leadId);
        return { success: true, id: created.id, token: created.token };
    } catch {
        return { error: "Nepodarilo sa vytvoriť tracker." };
    }
}

export async function markTrackedLinkUpdated(
    linkId: string,
    input: { url?: string | null; note?: string | null },
) {
    const session = await auth();
    if (!canManagePipeline(session?.user)) return { error: "Nemáš oprávnenie." };
    const userId = session!.user!.id!;

    const newUrl = input.url?.trim();
    const note = input.note?.trim() || null;

    try {
        const result = await prisma.$transaction(async (tx) => {
            const link = await tx.trackedLink.findUnique({
                where: { id: linkId },
                select: { id: true, leadId: true, currentVersion: true, targetUrl: true },
            });
            if (!link) throw new Error("not found");

            const nextVersion = link.currentVersion + 1;
            const nextUrl = newUrl ? newUrl : link.targetUrl;

            await tx.trackedLinkVersion.create({
                data: { linkId, version: nextVersion, url: nextUrl, note, createdById: userId },
            });
            await tx.trackedLink.update({
                where: { id: linkId },
                data: {
                    currentVersion: nextVersion,
                    targetUrl: nextUrl,
                    lastMarkedUpdateAt: new Date(),
                },
            });
            if (link.leadId) {
                await tx.activity.create({
                    data: createBusinessActivity({
                        leadId: link.leadId,
                        userId,
                        type: "TRACKER_UPDATED",
                        source: "PIPELINE",
                        note: `Dizajn aktualizovaný (v${nextVersion})${note ? ` – ${note}` : ""}`,
                    }),
                });
            }
            return { leadId: link.leadId, version: nextVersion };
        });
        revalidateForLead(result.leadId);
        return { success: true, version: result.version };
    } catch {
        return { error: "Nepodarilo sa aktualizovať tracker." };
    }
}

export async function revokeTrackedLink(linkId: string) {
    const session = await auth();
    if (!canManagePipeline(session?.user)) return { error: "Nemáš oprávnenie." };

    try {
        const link = await prisma.trackedLink.update({
            where: { id: linkId },
            data: { revokedAt: new Date() },
            select: { leadId: true },
        });
        revalidateForLead(link.leadId);
        return { success: true };
    } catch {
        return { error: "Nepodarilo sa zrušiť tracker." };
    }
}
