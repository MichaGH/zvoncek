"use server";

import { revalidatePath } from "next/cache";
import type { DealRequestStatus, LeadStatus, ProjectType } from "@/app/generated/prisma/enums";
import { UNAUTHENTICATED } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import * as cmd from "@/lib/commands/pipeline";
import * as work from "@/lib/commands/dealWork";
import * as offers from "@/lib/commands/offers";
import type { DealContactInput } from "@/lib/domain/dealMutations";
import type { DealRequestKind } from "@/app/generated/prisma/enums";

// Tenké server akcie obrazovky obchodov (/dashboard/pipeline): aktuálny používateľ z DB + príkaz
// (guard, zámky, revízia) + revalidácia. Dve úrovne guardu, jeden súbor:
//   - manažérske akcie  → lib/commands/pipeline.ts  (requireDealManage, akýkoľvek stav)
//   - práca na obchode  → lib/commands/dealWork.ts  (requireDealWork = vlastník alebo manažér)
// Komponent volá tú úroveň, ktorá zodpovedá jeho právam; server si právo aj tak overuje sám.

function revalidatePipeline(leadId?: string) {
    revalidatePath("/dashboard/pipeline");
    if (leadId) revalidatePath(`/dashboard/pipeline/${leadId}`);
    revalidatePath("/dashboard");
}

type User = NonNullable<Awaited<ReturnType<typeof requireUser>>>;

async function run<T extends object>(leadId: string | undefined, fn: (user: User) => Promise<T>) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await fn(user);
    if (!("error" in result)) revalidatePipeline(leadId);
    return result;
}

export async function updateLead(leadId: string, data: DealContactInput) {
    return run(leadId, (u) => cmd.updateLeadAs(u, leadId, data));
}

export async function saveQuote(leadId: string, input: { price: number | null; priceNote: string | null }) {
    return run(leadId, (u) => cmd.saveQuoteAs(u, leadId, input));
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

export async function markLost(leadId: string, reason: string | null) {
    return run(leadId, (u) => cmd.markLostAs(u, leadId, reason));
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

// ── Práca na obchode (vlastník alebo manažér) ────────────────────────────────

export async function logFollowUp(input: work.FollowUpInput) {
    return run(input?.leadId, (u) => work.logFollowUpAs(u, input));
}

export async function updateDealContact(leadId: string, data: DealContactInput) {
    return run(leadId, (u) => work.updateDealContactAs(u, leadId, data));
}

export async function saveDealQuote(leadId: string, input: { price: number | null; priceNote: string | null }) {
    return run(leadId, (u) => work.saveDealQuoteAs(u, leadId, input));
}

export async function createDealRequest(leadId: string, kind: DealRequestKind, note: string | null) {
    return run(leadId, (u) => work.createDealRequestAs(u, leadId, kind, note));
}

export async function cancelOwnDealRequest(requestId: string, note: string | null) {
    return run(undefined, (u) => work.cancelOwnDealRequestAs(u, requestId, note));
}

// ── Čo klient dostal (round 2, wave 3a) ──────────────────────────────────────

export async function recordOfferSent(input: offers.RecordOfferSentInput) {
    return run(input?.leadId, (u) => offers.recordOfferSentAs(u, input));
}

export async function correctRecord(leadId: string, activityId: string, reason: string) {
    return run(leadId, (u) => offers.correctRecordAs(u, activityId, reason));
}

export async function confirmLegacyReviewed(leadId: string) {
    return run(leadId, (u) => offers.confirmLegacyReviewedAs(u, leadId));
}
