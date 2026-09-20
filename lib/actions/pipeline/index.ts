"use server";

import { revalidatePath } from "next/cache";
import type { ProjectType } from "@/app/generated/prisma/enums";
import { UNAUTHENTICATED } from "@/lib/access/errors";
import { requireUser } from "@/lib/access/user";
import * as cmd from "@/lib/commands/pipeline";
import * as work from "@/lib/commands/dealWork";
import * as offers from "@/lib/commands/offers";
import * as tasks from "@/lib/commands/tasks";
import type { DealContactInput } from "@/lib/domain/dealMutations";

// Tenké server akcie obrazovky obchodov (/dashboard/pipeline): aktuálny používateľ z DB + príkaz
// (guard, zámky, revízia) + revalidácia. Tri úrovne guardu, jeden súbor:
//   - manažérske akcie  → lib/commands/pipeline.ts  (requireDealManage, akýkoľvek stav)
//   - práca na obchode  → lib/commands/dealWork.ts  (requireDealWork = vlastník alebo manažér)
//   - úlohy pre manažéra → lib/commands/tasks.ts    (vlastník zadáva, manažér vybavuje – wave 3)
// Komponent volá tú úroveň, ktorá zodpovedá jeho právam; server si právo aj tak overuje sám.

function revalidatePipeline(leadId?: string) {
    revalidatePath("/dashboard/pipeline");
    if (leadId) revalidatePath(`/dashboard/pipeline/${leadId}`);
    revalidatePath("/dashboard");
}

// Príkazy nad úlohou poznajú len taskId – obnoví sa celá vetva pipeline (zoznam, detail, História).
function revalidateTasks() {
    revalidatePath("/dashboard/pipeline", "layout");
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

async function runTask<T extends object>(fn: (user: User) => Promise<T>) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await fn(user);
    if (!("error" in result)) revalidateTasks();
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

export async function changeStatus(leadId: string, input: cmd.ChangeStatusInput) {
    return run(leadId, (u) => cmd.changeStatusAs(u, leadId, input));
}

export async function reopenDeal(leadId: string, input: cmd.ReopenInput) {
    return run(leadId, (u) => cmd.reopenDealAs(u, leadId, input));
}

export async function changeOwner(leadId: string, input: cmd.ChangeOwnerInput) {
    return run(leadId, (u) => cmd.changeOwnerAs(u, leadId, input));
}

export async function markLost(leadId: string, input: cmd.MarkLostInput) {
    return run(leadId, (u) => cmd.markLostAs(u, leadId, input));
}

export async function transferDeals(input: cmd.TransferDealsInput) {
    const user = await requireUser();
    if (!user) return UNAUTHENTICATED;
    const result = await cmd.transferDealsAs(user, input);
    revalidateTasks();
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

// ── Úlohy pre manažéra (wave 3) ──────────────────────────────────────────────

export async function askManager(input: tasks.AskManagerInput) {
    return run(input?.leadId, (u) => tasks.askManagerAs(u, input));
}

export async function taskMessage(input: tasks.TaskMessageInput) {
    return runTask((u) => tasks.taskMessageAs(u, input));
}

export async function finishTask(input: tasks.FinishTaskInput) {
    return runTask((u) => tasks.finishTaskAs(u, input));
}

export async function finishAndSend(input: tasks.FinishAndSendInput) {
    return runTask((u) => tasks.finishAndSendAs(u, input));
}

export async function declineTask(input: tasks.DeclineTaskInput) {
    return runTask((u) => tasks.declineTaskAs(u, input));
}

export async function reassignTask(input: tasks.ReassignTaskInput) {
    return runTask((u) => tasks.reassignTaskAs(u, input));
}

export async function dismissResults(input: tasks.DismissResultsInput) {
    return run(input?.leadId, (u) => tasks.dismissResultsAs(u, input));
}

export async function takeover(input: tasks.TakeoverInput) {
    return runTask((u) => tasks.takeoverAs(u, input));
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
