"use server";

import { revalidatePath } from "next/cache";
import type { DealRequestKind } from "@/app/generated/prisma/enums";
import { UNAUTHENTICATED } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import * as cmd from "@/lib/commands/dealWork";
import type { DealContactInput, NextActionInput } from "@/lib/domain/dealMutations";

// Tenké server akcie pre prácu na obchode (/dashboard/pipeline) – vlastník aj manažér.
// Rozsah, zámky, revíziu a zdroj aktivity rieši príkaz; tu je len auth + revalidácia.

function revalidateDeals(leadId?: string) {
    revalidatePath("/dashboard/pipeline");
    if (leadId) revalidatePath(`/dashboard/pipeline/${leadId}`);
    revalidatePath("/dashboard");
}

type User = NonNullable<Awaited<ReturnType<typeof requireUser>>>;

async function run<T extends object>(leadId: string | undefined, fn: (user: User) => Promise<T>) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await fn(user);
    if (!("error" in result)) revalidateDeals(leadId);
    return result;
}

export async function logFollowUp(input: cmd.FollowUpInput) {
    return run(input?.leadId, (u) => cmd.logFollowUpAs(u, input));
}

export async function setDealNextAction(leadId: string, input: NextActionInput, expectedRevision: number) {
    return run(leadId, (u) => cmd.setDealNextActionAs(u, leadId, input, expectedRevision));
}

export async function updateDealContact(leadId: string, data: DealContactInput) {
    return run(leadId, (u) => cmd.updateDealContactAs(u, leadId, data));
}

export async function saveDealQuote(leadId: string, input: { price: number | null; priceNote: string | null }) {
    return run(leadId, (u) => cmd.saveDealQuoteAs(u, leadId, input));
}

export async function setDealQuoteSent(leadId: string, sent: boolean) {
    return run(leadId, (u) => cmd.setDealQuoteSentAs(u, leadId, Boolean(sent)));
}

export async function setDealPriceDisclosed(leadId: string, disclosed: boolean) {
    return run(leadId, (u) => cmd.setDealPriceDisclosedAs(u, leadId, Boolean(disclosed)));
}

export async function logDealEmailSent(leadId: string) {
    return run(leadId, (u) => cmd.logDealEmailSentAs(u, leadId));
}

export async function addDealNote(leadId: string, note: string) {
    return run(leadId, (u) => cmd.addDealNoteAs(u, leadId, note));
}

export async function createDealRequest(leadId: string, kind: DealRequestKind, note: string | null) {
    return run(leadId, (u) => cmd.createDealRequestAs(u, leadId, kind, note));
}

export async function cancelOwnDealRequest(requestId: string, note: string | null) {
    return run(undefined, (u) => cmd.cancelOwnDealRequestAs(u, requestId, note));
}
