import { z } from "zod";
import type { Lead } from "@/app/generated/prisma/client";
import { AccessError, FORBIDDEN, toActionError, type ActionError } from "@/lib/access/errors";
import { requireDealWork, type ClosedPolicy } from "@/lib/access/leads";
import { withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { createPlanningActivity, describeNextAction } from "@/lib/activityLog";
import * as deal from "@/lib/domain/dealMutations";
import { runKeyed } from "@/lib/domain/idempotency";
import { recordOffer } from "@/lib/domain/offerMutations";
import { businessDate } from "@/lib/domain/businessTime";
import { dealStateForFollowUp, FOLLOW_UP_NEXT_KINDS, FOLLOW_UP_OUTCOMES, type FollowUpOutcome } from "@/lib/domain/leadFlow";
import { noteWithReply, REPLY_KEYS } from "@/lib/domain/clientReplies";
import { moneyToString } from "@/lib/domain/offers";
import { resolveSchedule, scheduleSchema } from "@/lib/domain/schedule";
import {
    canonical,
    dismissInputSchema,
    fulfilsSchema,
    OVERLAP_CHOICES,
    sortedItems,
    type ItemRef,
} from "@/lib/domain/tasks";
import {
    assertStepAllowed,
    cancelOpenTask,
    dismissAllPending,
    assertDecidesResults,
    dismissItems,
    loadPending,
    openTaskOf,
    requireOpenTask,
} from "@/lib/domain/taskMutations";
import { can } from "@/lib/permissions";

// Práca na obchode – jedna sada príkazov pre VLASTNÍKA aj manažéra (/dashboard/pipeline).
// Guard: requireDealWork – manažér alebo vlastník s deals.work; uzavreté obchody sú pre vlastníka len na čítanie.
// Manažérske zmeny stavu/vlastníka/návrhov sú v lib/commands/pipeline.ts, úlohy pre manažéra v lib/commands/tasks.ts.
//
// Zdroj aktivity sa určuje podľa AKTÉRA, nie podľa cesty (round 2, D-01): manažér = PIPELINE, ostatní = CLIENTS.
// Štatistiky tak vedia rozlíšiť „follow-up obchodníka" od manažérskeho zásahu aj po zlúčení obrazoviek.

export function sourceFor(user: AccessUser): "PIPELINE" | "CLIENTS" {
    return can(user, "deals.manage") ? "PIPELINE" : "CLIENTS";
}

export type Ok = { success: true };
export type CommandResult = Ok | ActionError;
type Actor = { id: string; firstName: string };
type Source = "PIPELINE" | "CLIENTS";

async function owned(
    user: AccessUser,
    leadId: string,
    label: string,
    fn: (tx: Tx, lead: Lead, actor: Actor, source: Source) => Promise<void>,
    opts: { expectedRevision?: number; closedPolicy?: ClosedPolicy } = {},
): Promise<CommandResult> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    try {
        await withLockTx(async (tx) => {
            const { lead, actor } = await requireDealWork(tx, user, leadId, {
                expectedRevision: opts.expectedRevision,
                closedPolicy: opts.closedPolicy ?? "reject",
            });
            await fn(tx, lead, actor, sourceFor(user));
        });
        return { success: true };
    } catch (error) {
        return toActionError(error, "Nepodarilo sa uložiť.", label);
    }
}

// ── Interakcia (hovor, odpoveď, SMS, len plán) ──────────────────────────────

// Čo sa naozaj stalo – do histórie ide ako správny typ, nie všetko ako „hovor" (round 2 §2c, 9a.3):
//   CALL    = hovor (aj nezdvihli)          → Activity CALL
//   REPLIED = klient odpísal                → Activity CLIENT_REPLIED
//   SMS     = poslali sme SMS               → Activity SMS_SENT (nemení, čo klient vie)
//   NONE    = bez kontaktu, len naplánovať  → žiadny kontakt, len zmena ďalšieho kroku
const CONTACTS = ["CALL", "REPLIED", "SMS", "NONE"] as const;
type Contact = (typeof CONTACTS)[number];

const followUpSchema = z
    .object({
        leadId: z.string().min(1),
        contact: z.enum(CONTACTS).default("CALL"),
        outcome: z.enum(FOLLOW_UP_OUTCOMES),
        expectedRevision: z.number().int().min(0),
        idempotencyKey: z.string().min(8).max(100),
        schedule: scheduleSchema.nullish(),
        // „Čo povedali" – poznámka kontaktu do histórie (pri SMS jej text). Wave 3 F1: nikdy nejde do kroku.
        note: z.string().max(5000).nullish(),
        // „Poznámka ku kroku" – len Lead.nextActionNote (prázdna = predvolený text kroku).
        stepNote: z.string().max(1000).nullish(),
        nextKind: z.enum(FOLLOW_UP_NEXT_KINDS).nullish(),
        lostReason: z.string().max(500).nullish(),
        reply: z.enum(REPLY_KEYS as [string, ...string[]]).nullish(),
        // Cena povedaná v tomto hovore – zapíše sa ako OFFER_SENT (telefón) v tej istej transakcii.
        phonePrice: z
            .object({ amount: z.number().finite().min(0).max(10_000_000), note: z.string().max(2000).nullish() })
            .strict()
            .nullish(),
        // Wave 3: povedaná cena bola tá, ktorú vrátil manažér (len PRICE, najviac jedna).
        fulfils: fulfilsSchema.nullish(),
        // Krok je zamknutý úlohou → zapíše sa len kontakt, krok ani stav sa nemenia (§5.1).
        keepLockedStep: z.boolean().optional(),
        // Povedaná cena sa kryje s otvorenou úlohou na cenu – čo s úlohou (W3-R2-05).
        overlap: z.enum(OVERLAP_CHOICES).nullish(),
        // Zrušiť otvorenú úlohu v tom istom uložení (D5): uspať, uzavrieť, preplánovať.
        cancelTask: deal.cancelTaskSchema.nullish(),
        // Vrátené položky, ktoré sa neposielajú / berú na vedomie v tom istom uložení (§6.13).
        dismiss: dismissInputSchema.nullish(),
    })
    .strict();

export type FollowUpInput = z.input<typeof followUpSchema>;

const CONTACT_TYPE: Record<Exclude<Contact, "NONE">, "CALL" | "CLIENT_REPLIED" | "SMS_SENT"> = {
    CALL: "CALL",
    REPLIED: "CLIENT_REPLIED",
    SMS: "SMS_SENT",
};
const PLANNING_TYPES = ["NEXT_ACTION_SET", "NEXT_ACTION_CHANGED", "NEXT_ACTION_CLEARED"] as const;
const CLOSING_OUTCOMES: FollowUpOutcome[] = ["BAD_NUMBER", "NOT_INTERESTED"];
const NO_PHONE_PRICE: FollowUpOutcome[] = ["NO_ANSWER", "BAD_NUMBER", "NOT_INTERESTED"];
// Kým je krok zamknutý, zapisuje sa len to, čo klient povedal – nič, čo mení stav alebo krok (uspať / uzavrieť = zrušiť úlohu).
const FACT_ONLY_OUTCOMES: FollowUpOutcome[] = ["POSITIVE", "NO_ANSWER", "WANTS_QUOTE", "WANTS_DESIGN", "WANTS_TO_ORDER"];

const trim = (v: string | null | undefined) => v?.trim() || null;

export async function logFollowUpAs(user: AccessUser, raw: FollowUpInput): Promise<CommandResult> {
    if (!can(user, "deals.work") && !can(user, "deals.manage")) return FORBIDDEN;
    const parsed = followUpSchema.safeParse(raw);
    if (!parsed.success) return { error: "Neplatné údaje." };
    const input = parsed.data;
    const closing = CLOSING_OUTCOMES.includes(input.outcome);
    const factOnly = input.keepLockedStep === true;
    // SMS a „len plán" nie sú rozhovor – nenesú výsledok hovoru; odpoveď klienta nemôže byť „nezdvihli".
    if ((input.contact === "SMS" || input.contact === "NONE") && input.outcome !== "POSITIVE") return { error: "Neplatné údaje." };
    if (input.contact === "REPLIED" && input.outcome === "NO_ANSWER") return { error: "Neplatné údaje." };
    if (input.phonePrice && (input.contact !== "CALL" || NO_PHONE_PRICE.includes(input.outcome))) return { error: "Neplatné údaje." };
    // F1: pole, ktoré nemá kam ísť, je skryté a server ho odmietne (W3-R3-09).
    if (input.contact === "NONE" && trim(input.note)) return { error: "Bez kontaktu sa nezapisuje, čo povedali." };
    if ((closing || factOnly) && trim(input.stepNote)) return { error: "Poznámka ku kroku sa tu neukladá." };
    if (factOnly) {
        if (input.contact === "NONE" || !FACT_ONLY_OUTCOMES.includes(input.outcome)) return { error: "Neplatné údaje." };
        if (input.nextKind || input.schedule || input.lostReason || input.cancelTask) return { error: "Neplatné údaje." };
    }
    if (input.fulfils?.length && (!input.phonePrice || input.fulfils.some((f) => f.kind !== "PRICE") || input.fulfils.length > 1)) {
        return { error: "Neplatné údaje." };
    }
    if (input.overlap === "KEEP_OPEN" && !factOnly) return { error: "Neplatné údaje." };
    if (input.overlap === "CANCEL_TASK" && !input.cancelTask) return { error: "Neplatné údaje." };

    const source = sourceFor(user);
    // Jeden kanonický odtlačok všetkého, čo používateľ odoslal (W3-R3-07) – bez revízie a samotného kľúča.
    const fp = canonical({
        contact: input.contact,
        outcome: input.outcome,
        reply: input.reply ?? null,
        note: trim(input.note),
        stepNote: trim(input.stepNote),
        nextKind: input.nextKind ?? null,
        schedule: input.schedule ?? null,
        lostReason: trim(input.lostReason),
        phonePrice: input.phonePrice
            ? { amount: moneyToString(input.phonePrice.amount), note: input.phonePrice.note === undefined ? "=" : trim(input.phonePrice.note) }
            : null,
        fulfils: sortedItems(input.fulfils),
        keepLockedStep: factOnly,
        overlap: input.overlap ?? null,
        cancelTask: input.cancelTask ? { taskId: input.cancelTask.taskId, reason: trim(input.cancelTask.reason) } : null,
        dismiss: input.dismiss ? { items: sortedItems(input.dismiss.items), reason: trim(input.dismiss.reason) } : null,
    });

    return runKeyed(
        input.idempotencyKey,
        {
            userId: user.id,
            leadId: input.leadId,
            types: input.contact === "NONE" ? PLANNING_TYPES : [CONTACT_TYPE[input.contact]],
            fp,
        },
        () =>
            withLockTx(async (tx) => {
                const { lead, actor } = await requireDealWork(tx, user, input.leadId, {
                    expectedRevision: input.expectedRevision,
                    closedPolicy: "reject",
                });
                const open = await openTaskOf(tx, lead.id);
                if (factOnly && !open) throw new AccessError("STALE", "Úloha sa medzitým uzavrela – obnovujem.");
                if (!factOnly && open && !input.cancelTask) throw new AccessError("STEP_LOCKED");
                if (!open && input.cancelTask) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
                // Povedaná cena, na ktorú manažér práve robí úlohu: bez voľby sa neuloží (W3-R2-05).
                if (open && input.phonePrice && open.type === "HELP" && open.contents.includes("PRICE") && !input.overlap) {
                    throw new AccessError("TASK_OVERLAP");
                }
                let cancelTask: typeof open = null;
                if (input.cancelTask) {
                    cancelTask = await requireOpenTask(tx, lead.id, input.cancelTask.taskId);
                    // Úlohu ruší vlastník; manažér len výslovnou akciou, ktorá ju menuje – tu uzavretím obchodu (§5.2).
                    if (lead.ownerId !== actor.id && !(closing && can(actor, "deals.manage"))) {
                        throw new AccessError("FORBIDDEN", "Úlohu ruší vlastník obchodu.");
                    }
                    if (!closing && !trim(input.cancelTask.reason)) throw new AccessError("FORBIDDEN", "Napíš, prečo úlohu rušíš.");
                }

                const now = new Date();
                const pending = await loadPending(tx, lead.id);
                let dismissed: ItemRef[] = [];
                if (input.dismiss) {
                    assertDecidesResults(lead, actor);
                    dismissed = await dismissItems(tx, actor, lead.id, input.dismiss, source, { pending });
                }

                // V histórii chceme čítať „čo povedali" bez lúštenia meta; kľúč ostáva strojovo spracovateľný.
                const note = input.contact === "SMS" ? trim(input.note) : noteWithReply(input.reply, input.note);
                let contactId: string | null = null;
                if (input.contact !== "NONE") {
                    const contact = await tx.activity.create({
                        data: {
                            leadId: lead.id,
                            userId: actor.id,
                            type: CONTACT_TYPE[input.contact],
                            category: "BUSINESS",
                            source,
                            outcome: input.contact === "SMS" ? null : input.outcome,
                            note,
                            meta: { ...(input.reply && input.contact !== "SMS" ? { reply: input.reply } : {}), fp },
                            idempotencyKey: input.idempotencyKey,
                        },
                        select: { id: true },
                    });
                    contactId = contact.id;
                }
                const phoneFulfils: ItemRef[] = (input.fulfils ?? []).map((f) => ({ taskId: f.taskId, kind: f.kind }));
                const phone = async () => {
                    if (!input.phonePrice || !contactId) return;
                    await recordOffer(
                        tx,
                        actor,
                        lead,
                        {
                            channel: "PHONE",
                            contents: ["PRICE"],
                            sentOn: businessDate(now),
                            historical: false,
                            price: input.phonePrice,
                            followUp: false,
                            callActivityId: contactId,
                            fulfils: phoneFulfils,
                            factOnly: true,
                        },
                        source,
                    );
                };

                if (factOnly) {
                    // „Naposledy" sa posunie, krok ani stav nie (§5.1). Revízia sa zvýši raz.
                    await phone();
                    await deal.updateLead(tx, lead.id, {});
                    return;
                }

                if (cancelTask) {
                    await cancelOpenTask(
                        tx,
                        actor,
                        cancelTask,
                        closing ? `obchod uzavretý${trim(input.cancelTask?.reason) ? ` – ${trim(input.cancelTask?.reason)}` : ""}` : trim(input.cancelTask?.reason)!,
                        source,
                    );
                }

                const when = input.schedule ? resolveSchedule(input.schedule, now) : null;
                let state: ReturnType<typeof dealStateForFollowUp>;
                try {
                    state = dealStateForFollowUp(
                        input.outcome,
                        { when, nextKind: input.nextKind, stepNote: input.stepNote, lostReason: input.lostReason },
                        lead,
                        now,
                    );
                } catch (error) {
                    throw new AccessError("FORBIDDEN", error instanceof Error ? error.message : "Neplatný výsledok.");
                }
                const { closes, lostReason, status: stateStatus, ...next } = state;
                if (closes) {
                    // Uzavretie odmietne všetko vrátené a neposlané s pevným dôvodom (W3-R3-04).
                    await dismissAllPending(tx, actor, lead.id, "obchod uzavretý", source);
                } else {
                    // I10: kým čaká vrátená cena / návrh, krok ostáva „Poslať …" (ak sa to v tomto uložení neodmietlo).
                    await assertStepAllowed(tx, lead.id, next.nextActionKind, [...dismissed, ...phoneFulfils]);
                }
                // „Len naplánovať" (aj „Zmeniť krok" v detaile) nemení stav – spiaci obchod ostane spiaci (round 2 §2d).
                const status = input.contact === "NONE" ? lead.status : stateStatus;
                await deal.updateLead(tx, lead.id, {
                    status,
                    ...next,
                    ...(closes ? { closedAt: now, lostReason: lostReason ?? null } : {}),
                });
                await tx.activity.create({
                    data: {
                        ...createPlanningActivity({
                            leadId: lead.id,
                            userId: actor.id,
                            type: !next.nextActionKind ? "NEXT_ACTION_CLEARED" : lead.nextActionKind ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
                            source,
                            note: describeNextAction(next),
                        }),
                        ...(input.contact === "NONE" ? { idempotencyKey: input.idempotencyKey, meta: { fp } } : {}),
                    },
                });
                await phone();
            }),
        (error) => toActionError(error, "Nepodarilo sa uložiť. Skús znova.", "logFollowUp"),
    );
}

// ── Detail obchodu ──────────────────────────────────────────────────────────

export const setDealNextActionAs = (user: AccessUser, leadId: string, input: deal.NextActionInput, expectedRevision: number) =>
    owned(user, leadId, "setDealNextAction", (tx, lead, actor, source) => deal.setNextAction(tx, actor, lead, input, source), {
        expectedRevision,
    });

export const updateDealContactAs = (user: AccessUser, leadId: string, data: deal.DealContactInput) =>
    owned(user, leadId, "updateDealContact", (tx, lead, actor, source) => deal.updateDealContact(tx, actor, lead, data, source));

export const saveDealQuoteAs = (user: AccessUser, leadId: string, input: { price: number | null; priceNote: string | null }) =>
    owned(user, leadId, "saveDealQuote", (tx, lead, actor, source) => deal.saveQuote(tx, actor, lead, input, source));

export const addDealNoteAs = (user: AccessUser, leadId: string, note: string) =>
    owned(user, leadId, "addDealNote", (tx, lead, actor, source) => deal.addBusinessNote(tx, actor, lead, { note }, source));
