"use server";

import { revalidatePath } from "next/cache";
import type { DealRequestKind } from "@/app/generated/prisma/enums";
import { UNAUTHENTICATED } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import * as cmd from "@/lib/commands/clients";
import type { DealContactInput, NextActionInput } from "@/lib/domain/dealMutations";

// Tenké server akcie pre /dashboard/clients. Rozsah (vlastník / manažér) a zámky rieši príkaz.

function revalidateClients(leadId?: string) {
    revalidatePath("/dashboard/clients");
    if (leadId) revalidatePath(`/dashboard/clients/${leadId}`);
    revalidatePath("/dashboard/pipeline");
    if (leadId) revalidatePath(`/dashboard/pipeline/${leadId}`);
    revalidatePath("/dashboard");
}

type User = NonNullable<Awaited<ReturnType<typeof requireUser>>>;

async function run<T extends object>(leadId: string | undefined, fn: (user: User) => Promise<T>) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await fn(user);
    if (!("error" in result)) revalidateClients(leadId);
    return result;
}

export async function logFollowUp(input: cmd.FollowUpInput) {
    return run(input?.leadId, (u) => cmd.logFollowUpAs(u, input));
}

export async function setClientNextAction(leadId: string, input: NextActionInput, expectedRevision: number) {
    return run(leadId, (u) => cmd.setClientNextActionAs(u, leadId, input, expectedRevision));
}

export async function updateClientContact(leadId: string, data: DealContactInput) {
    return run(leadId, (u) => cmd.updateClientContactAs(u, leadId, data));
}

export async function saveClientQuote(leadId: string, input: { price: number | null; priceNote: string | null }) {
    return run(leadId, (u) => cmd.saveClientQuoteAs(u, leadId, input));
}

export async function setClientQuoteSent(leadId: string, sent: boolean) {
    return run(leadId, (u) => cmd.setClientQuoteSentAs(u, leadId, Boolean(sent)));
}

export async function setClientPriceDisclosed(leadId: string, disclosed: boolean) {
    return run(leadId, (u) => cmd.setClientPriceDisclosedAs(u, leadId, Boolean(disclosed)));
}

export async function logClientEmailSent(leadId: string) {
    return run(leadId, (u) => cmd.logClientEmailSentAs(u, leadId));
}

export async function addClientNote(leadId: string, note: string) {
    return run(leadId, (u) => cmd.addClientNoteAs(u, leadId, note));
}

export async function createDealRequest(leadId: string, kind: DealRequestKind, note: string | null) {
    return run(leadId, (u) => cmd.createDealRequestAs(u, leadId, kind, note));
}

export async function cancelOwnDealRequest(requestId: string, note: string | null) {
    return run(undefined, (u) => cmd.cancelOwnDealRequestAs(u, requestId, note));
}
