"use server";

import { revalidatePath } from "next/cache";
import { UNAUTHENTICATED } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import { releaseBatchAs, transferCallWorkAs, type CallWorkKind } from "@/lib/commands/assignments";

function revalidateAssignments() {
    revalidatePath("/dashboard/calls/assignments");
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard");
}

export async function releaseBatch(fromUserId: string) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await releaseBatchAs(user, fromUserId);
    revalidateAssignments();
    return result;
}

export async function transferCallWork(input: { fromUserId: string; toUserId: string; kind: CallWorkKind; limit?: number | null }) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await transferCallWorkAs(user, input);
    revalidateAssignments();
    return result;
}
