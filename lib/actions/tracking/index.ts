"use server";

import { revalidatePath } from "next/cache";
import { UNAUTHENTICATED, type ActionError } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import * as cmd from "@/lib/commands/tracking";

type Result = { success: true } | ActionError;

async function run(fn: (user: NonNullable<Awaited<ReturnType<typeof requireUser>>>) => ReturnType<typeof cmd.removeDesignAs>): Promise<Result> {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await fn(user);
    if ("error" in result) return result;
    revalidatePath(`/dashboard/pipeline/${result.leadId}`);
    revalidatePath("/dashboard/pipeline");
    revalidatePath(`/dashboard/clients/${result.leadId}`);
    revalidatePath("/dashboard/clients");
    revalidatePath("/dashboard");
    return { success: true };
}

export async function createDesign(input: { leadId: string; label?: string | null; url?: string | null; repoUrl?: string | null }) {
    return run((u) => cmd.createDesignAs(u, input));
}

export async function addDesignVersion(designId: string, input: { url?: string | null; note?: string | null }) {
    return run((u) => cmd.addDesignVersionAs(u, designId, input));
}

export async function updateDesignMeta(designId: string, input: { label?: string | null; repoUrl?: string | null; isLive?: boolean }) {
    return run((u) => cmd.updateDesignMetaAs(u, designId, input));
}

export async function removeDesign(designId: string) {
    return run((u) => cmd.removeDesignAs(u, designId));
}

export async function setDesignSent(designId: string, sent: boolean) {
    return run((u) => cmd.setDesignSentAs(u, designId, Boolean(sent)));
}
