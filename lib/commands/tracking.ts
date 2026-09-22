import { AccessError, FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealManage } from "@/lib/access/leads";
import { withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { createBusinessActivity } from "@/lib/activityLog";
import { bumpLeadOnce } from "@/lib/domain/revision";
import { recomputeOffers } from "@/lib/domain/offerMutations";
import { can } from "@/lib/permissions";
import { generateToken } from "@/lib/tracking/tokens";

// Návrhy a tracking – len manažér. Guard zamyká Lead cez design.leadId (§6.2), potom sa návrh prečíta znova.

type Result = { success: true; leadId: string } | ActionError;

async function withDesign(
    user: AccessUser,
    designId: string,
    label: string,
    fn: (tx: Tx, design: { id: string; leadId: string }, actor: { id: string; firstName: string }) => Promise<void>,
): Promise<Result> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    try {
        const leadId = await withLockTx(async (tx) => {
            const pre = await tx.design.findUnique({ where: { id: designId }, select: { leadId: true } });
            if (!pre) throw new AccessError("NOT_FOUND");
            const { actor } = await requireDealManage(tx, user, pre.leadId);
            const design = await tx.design.findUnique({ where: { id: designId }, select: { id: true, leadId: true, deletedAt: true } });
            if (!design || design.leadId !== pre.leadId || design.deletedAt) throw new AccessError("NOT_FOUND");
            await fn(tx, design, actor);
            return design.leadId;
        });
        return { success: true, leadId };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa uložiť.", label);
    }
}

export async function createDesignAs(
    user: AccessUser,
    input: { leadId: string; label?: string | null; url?: string | null; repoUrl?: string | null },
): Promise<Result> {
    if (!can(user, "deals.manage")) return FORBIDDEN;
    const url = input.url?.trim() || null;
    const label = input.label?.trim() || null;
    const repoUrl = input.repoUrl?.trim() || null;
    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealManage(tx, user, input.leadId);
            await tx.design.create({
                data: {
                    leadId: lead.id,
                    label,
                    targetUrl: url,
                    repoUrl,
                    currentVersion: 1,
                    createdById: actor.id,
                    versions: { create: { version: 1, url, createdById: actor.id } },
                    tracker: { create: { token: generateToken() } },
                },
            });
            await bumpLeadOnce(tx, lead.id);
            await tx.activity.create({
                data: createBusinessActivity({
                    leadId: lead.id,
                    userId: actor.id,
                    type: "TRACKER_ATTACHED",
                    source: "PIPELINE",
                    note: label ? `Návrh pridaný: ${label}` : "Návrh pridaný",
                }),
            });
        });
        return { success: true, leadId: input.leadId };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa vytvoriť návrh.", "createDesign");
    }
}

export const addDesignVersionAs = (user: AccessUser, designId: string, input: { url?: string | null; note?: string | null }) =>
    withDesign(user, designId, "addDesignVersion", async (tx, design, actor) => {
        const current = await tx.design.findUniqueOrThrow({ where: { id: design.id }, select: { currentVersion: true, targetUrl: true } });
        const nextVersion = current.currentVersion + 1;
        const nextUrl = input.url?.trim() || current.targetUrl;
        const note = input.note?.trim() || null;
        await tx.designVersion.create({ data: { designId: design.id, version: nextVersion, url: nextUrl, note, createdById: actor.id } });
        await tx.design.update({ where: { id: design.id }, data: { currentVersion: nextVersion, targetUrl: nextUrl } });
        await bumpLeadOnce(tx, design.leadId);
        await tx.activity.create({
            data: createBusinessActivity({
                leadId: design.leadId,
                userId: actor.id,
                type: "TRACKER_UPDATED",
                source: "PIPELINE",
                note: `Návrh aktualizovaný (v${nextVersion})${note ? ` – ${note}` : ""}`,
            }),
        });
    });

export const updateDesignMetaAs = (
    user: AccessUser,
    designId: string,
    input: { label?: string | null; repoUrl?: string | null; isLive?: boolean },
) =>
    withDesign(user, designId, "updateDesignMeta", async (tx, design) => {
        const data: { label?: string | null; repoUrl?: string | null; isLive?: boolean } = {};
        if (input.label !== undefined) data.label = input.label?.trim() || null;
        if (input.repoUrl !== undefined) data.repoUrl = input.repoUrl?.trim() || null;
        if (input.isLive !== undefined) data.isLive = input.isLive;
        await tx.design.update({ where: { id: design.id }, data });
        await bumpLeadOnce(tx, design.leadId);
    });

export const removeDesignAs = (user: AccessUser, designId: string) =>
    withDesign(user, designId, "removeDesign", async (tx, design) => {
        await tx.design.update({ where: { id: design.id }, data: { deletedAt: new Date() } });
        // Zmazaný návrh už nie je „posledný poslaný" – súhrn obchodu sa prepočíta (a zvýši revíziu raz).
        await recomputeOffers(tx, design.leadId);
        await bumpLeadOnce(tx, design.leadId);
    });
