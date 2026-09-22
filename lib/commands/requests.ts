import { z } from "zod";
import { FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealWork } from "@/lib/access/leads";
import { withLockTx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { sourceFor } from "@/lib/commands/dealWork";
import {
    ASK_REASON_MAX,
    defaultStep,
    isSystemStep,
    normalizeAsked,
    REQUEST_CONTENT_ENUM,
    REQUEST_CONTENT_LABEL,
    REQUEST_CONTENTS,
} from "@/lib/domain/clientRequests";
import { updateLead } from "@/lib/domain/dealMutations";
import { runKeyed } from "@/lib/domain/idempotency";
import { addRequests, outstandingOf, reconcileRequests, withdrawRequests } from "@/lib/domain/requestMutations";
import { canonical } from "@/lib/domain/tasks";
import { openTaskOf } from "@/lib/domain/taskMutations";
import { refreshLockedStep } from "@/lib/domain/lockedStep";
import { createPlanningActivity, describeNextAction } from "@/lib/activityLog";
import { hadNextAction } from "@/lib/domain/leadWrites";
import { can } from "@/lib/permissions";

// Ceruzka pri „Chceli" (wave 5 §6.4): pridať, čo klient chce, alebo stiahnuť, čo už nechce – nikdy potichu prepísať.
// Guard: requireDealWork → vlastník obchodu alebo manažér s deals.manage (obchod bez vlastníka je manažérsky);
// mimo rozsahu NOT_FOUND. Otvorenú úlohu ceruzka nezruší, ale zamknutý krok prepočíta (P6) – tú ruší „Zrušiť úlohu".

type Result = { success: true } | ActionError;

const setAsksSchema = z
    .object({
        leadId: z.string().min(1),
        expectedRevision: z.number().int().min(0),
        idempotencyKey: z.string().min(8).max(100),
        // Čo klient chce navyše – nový riadok aj vtedy, keď ten istý obsah už raz otvorený je.
        add: z.array(REQUEST_CONTENT_ENUM).max(REQUEST_CONTENTS.length).default([]),
        // Čo už nechce – ID OTVORENÝCH riadkov („už to nechcú" pošle všetky otvorené riadky toho obsahu).
        withdraw: z.array(z.string().min(1)).max(50).default([]),
        reason: z.string().max(ASK_REASON_MAX).nullish(),
    })
    .strict();

export type SetClientAsksInput = z.input<typeof setAsksSchema>;

export async function setClientAsksAs(user: AccessUser, raw: SetClientAsksInput): Promise<Result> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = setAsksSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const add = normalizeAsked(input.add);
    const withdraw = [...new Set(input.withdraw)].sort();
    const reason = input.reason?.trim() || null;
    if (add.length === 0 && withdraw.length === 0) return { error: "Nič sa nemení." };
    // Dôvod treba len vtedy, keď sa niečo sťahuje – doplnenie je oprava, nie rozhodnutie o klientovi (Q4).
    if (withdraw.length && !reason) return { error: "Napíš, prečo to už nechcú." };

    const fp = canonical({ add, withdraw, reason });
    return runKeyed(
        input.idempotencyKey,
        { userId: user.id, leadId: input.leadId, types: ["CLIENT_ASK_CHANGED"], fp },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor } = await requireDealWork(tx, user, input.leadId, {
                    expectedRevision: input.expectedRevision,
                    closedPolicy: "reject",
                });
                const source = sourceFor(user);
                const now = new Date();

                const withdrawn = withdraw.length
                    ? await withdrawRequests(tx, { leadId: lead.id, ids: withdraw, actorId: actor.id, reason: reason! })
                    : [];
                if (add.length) {
                    await addRequests(tx, { leadId: lead.id, contents: add, requestedAt: now, requestedById: actor.id, reason });
                }
                await reconcileRequests(tx, lead.id);

                const parts = [
                    add.length ? `pribudlo: ${add.map((c) => REQUEST_CONTENT_LABEL[c]).join(", ")}` : null,
                    withdrawn.length ? `už nechcú: ${withdrawn.map((r) => REQUEST_CONTENT_LABEL[r.content]).join(", ")}` : null,
                ].filter(Boolean);
                await tx.activity.create({
                    data: {
                        leadId: lead.id,
                        userId: actor.id,
                        type: "CLIENT_ASK_CHANGED",
                        category: "BUSINESS",
                        source,
                        note: `Upravené, čo klient chce – ${parts.join(" · ")}${reason ? ` (${reason})` : ""}`,
                        meta: {
                            added: add,
                            withdrawn: withdrawn.map((r) => ({ id: r.id, content: r.content })),
                            reason,
                            fp,
                        },
                        idempotencyKey: input.idempotencyKey,
                    },
                });

                // Kým je úloha otvorená, krok je čistá funkcia nevybaveného + záložného kroku (P6, wave 4) – rovnako ako
                // pri každej inej udalosti, ktorá ho mení; zámok ho pred voľným preplánovaním chráni sám, takže sa tu
                // `isSystemStep` nepýta. Bez úlohy platí §6.4: predvoľbu kroku dáva projekcia, ručne zvolený krok
                // (hovor, čakanie, vlastný) sa neprepisuje.
                if (await openTaskOf(tx, lead.id)) {
                    await refreshLockedStep(tx, actor, lead, source);
                } else if (isSystemStep(lead.nextActionKind)) {
                    const next = defaultStep(await outstandingOf(tx, lead.id), lead, { now });
                    if (next && next.nextActionKind !== lead.nextActionKind) {
                        await updateLead(tx, lead.id, next);
                        await tx.activity.create({
                            data: createPlanningActivity({
                                leadId: lead.id,
                                userId: actor.id,
                                type: hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                                source,
                                note: describeNextAction(next),
                            }),
                        });
                    }
                }
            }),
        (error) => toActionError(error, "Nepodarilo sa uložiť.", "setClientAsks"),
    );
}
