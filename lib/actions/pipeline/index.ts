"use server";

import { revalidatePath } from "next/cache";
import type { DealRequestStatus, LeadStatus, NextActionKind, NextActionMode, ProjectType } from "@/app/generated/prisma/enums";
import { UNAUTHENTICATED } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import * as cmd from "@/lib/commands/pipeline";
import type { DealContactInput } from "@/lib/domain/dealMutations";
import type { Schedule } from "@/lib/domain/schedule";

// Tenké server akcie pipeline: aktuálny používateľ z DB + príkaz (guard, zámky, revízia) + revalidácia.

function revalidatePipeline(leadId?: string) {
    revalidatePath("/dashboard/pipeline");
    if (leadId) revalidatePath(`/dashboard/pipeline/${leadId}`);
    revalidatePath("/dashboard/clients");
    if (leadId) revalidatePath(`/dashboard/clients/${leadId}`);
    revalidatePath("/dashboard");
}

async function run(leadId: string | undefined, fn: (user: NonNullable<Awaited<ReturnType<typeof requireUser>>>) => Promise<cmd.CommandResult>) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await fn(user);
    if ("success" in result) revalidatePipeline(leadId);
    return result;
}

export async function updateLead(leadId: string, data: DealContactInput) {
    return run(leadId, (u) => cmd.updateLeadAs(u, leadId, data));
}

export async function saveQuote(leadId: string, input: { price: number | null; priceNote: string | null }) {
    return run(leadId, (u) => cmd.saveQuoteAs(u, leadId, input));
}

export async function setQuoteSent(leadId: string, sent: boolean) {
    return run(leadId, (u) => cmd.setQuoteSentAs(u, leadId, Boolean(sent)));
}

export async function setPriceDisclosed(leadId: string, disclosed: boolean) {
    return run(leadId, (u) => cmd.setPriceDisclosedAs(u, leadId, Boolean(disclosed)));
}

export async function setProjectType(leadId: string, projectType: ProjectType | null) {
    return run(leadId, (u) => cmd.setProjectTypeAs(u, leadId, projectType));
}

export async function changeStatus(leadId: string, status: LeadStatus) {
    return run(leadId, (u) => cmd.changeStatusAs(u, leadId, status));
}

export async function reopenDeal(leadId: string) {
    return run(leadId, (u) => cmd.reopenDealAs(u, leadId));
}

export async function changeOwner(leadId: string, ownerId: string | null) {
    return run(leadId, (u) => cmd.changeOwnerAs(u, leadId, ownerId));
}

export async function setNextAction(
    leadId: string,
    input: { kind: NextActionKind | null; schedule?: Schedule | null; note?: string | null; mode?: NextActionMode },
    expectedRevision: number,
) {
    return run(leadId, (u) => cmd.setNextActionAs(u, leadId, input, expectedRevision));
}

export async function logSent(leadId: string, what: "QUOTE_SENT" | "EMAIL_SENT") {
    return run(leadId, (u) => cmd.logSentAs(u, leadId, what));
}

export async function markLost(leadId: string, reason: string | null) {
    return run(leadId, (u) => cmd.markLostAs(u, leadId, reason));
}

export async function addBusinessNote(leadId: string, note: string) {
    return run(leadId, (u) => cmd.addBusinessNoteAs(u, leadId, note, "NOTE"));
}

export async function logBusinessActivity(leadId: string, type: "SMS_SENT", note?: string) {
    return run(leadId, (u) => cmd.addBusinessNoteAs(u, leadId, note ?? "", type));
}

export async function resolveDealRequest(requestId: string, status: Exclude<DealRequestStatus, "OPEN">, note: string | null) {
    return run(undefined, (u) => cmd.resolveDealRequestAs(u, requestId, status, note));
}

export async function transferDeals(input: cmd.TransferDealsInput) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await cmd.transferDealsAs(user, input);
    revalidatePipeline();
    return result;
}
