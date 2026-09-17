"use server";

import { revalidatePath } from "next/cache";
import { UNAUTHENTICATED, type ActionError } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import { revertCallResultAs } from "@/lib/commands/history";

export async function revertCallResult(activityId: string, expectedRevision: number): Promise<{ success: true } | ActionError> {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await revertCallResultAs(user, activityId, expectedRevision);
    if ("success" in result) {
        revalidatePath("/dashboard/calls");
        revalidatePath("/dashboard/calls/history");
        revalidatePath("/dashboard/pipeline");
        revalidatePath("/dashboard/clients");
        revalidatePath("/dashboard");
    }
    return result;
}
