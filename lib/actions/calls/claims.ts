"use server";

import { revalidatePath } from "next/cache";
import { UNAUTHENTICATED } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import { claimBatchAs, type ClaimResult } from "@/lib/commands/claims";

export async function claimBatch(): Promise<ClaimResult> {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await claimBatchAs(user);
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard");
    return result;
}
