"use server";

import { revalidatePath } from "next/cache";
import { UNAUTHENTICATED, type ActionError } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import { logCallAs, updateLeadContactAs, type ContactPatch, type LogCallInput } from "@/lib/commands/calls";
import type { LogCallResult } from "@/lib/domain/idempotency";
import { can } from "@/lib/permissions";
import { getMoreRetriesFor } from "@/lib/queries/calls";

function revalidateCalls() {
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/calls/history");
    revalidatePath("/dashboard/pipeline");
    revalidatePath("/dashboard");
}

export async function logCall(input: LogCallInput): Promise<LogCallResult> {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await logCallAs(user, input);
    if ("success" in result) revalidateCalls();
    return result;
}

// Ďalšia strana „Skúsiť znova" – len vlastné (rozsah z prihláseného používateľa, nikdy z parametra).
export async function getMoreRetries(cursor: string) {
    const user = await requireUser();
    if (!user || !can(user, "calls.view") || typeof cursor !== "string") return { leads: [], nextCursor: null };
    return getMoreRetriesFor(user.id, cursor);
}

export async function updateLeadContact(leadId: string, data: ContactPatch): Promise<{ success: true } | ActionError> {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await updateLeadContactAs(user, leadId, data);
    if ("success" in result) revalidateCalls();
    return result;
}
