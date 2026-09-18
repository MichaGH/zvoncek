import type { Lead } from "@/app/generated/prisma/client";
import type {
    ActivitySource,
    ActivityType,
    LeadStatus,
    NextActionKind,
    NextActionMode,
    ProjectType,
} from "@/app/generated/prisma/enums";
import { AccessError } from "@/lib/access/errors";
import { NEXT_STEP_KINDS } from "@/lib/domain/nextStepOptions";
import { isClosedDealStatus } from "@/lib/access/leads";
import type { Tx } from "@/lib/access/locks";
import {
    createAuditActivity,
    createBusinessActivity,
    createPlanningActivity,
    describeNextAction,
    nextActionData,
} from "@/lib/activityLog";
import {
    addBusinessCalendarDays,
    businessDate,
    businessDayStart,
    businessTodayStart,
} from "@/lib/domain/businessTime";
import { closeRequestsForStatus, resolveOpenRequests } from "@/lib/domain/dealRequests";
import { bump, isLeadBumped, markLeadBumped } from "@/lib/domain/revision";
import { resolveSchedule, scheduleSchema, type Schedule } from "@/lib/domain/schedule";
import { z } from "zod";
import { STATUS_LABEL } from "@/lib/dictionaries";

// Telá biznis mutácií obchodu (plán §7.7). Volajú ich pipeline akcie (manažér) aj client akcie (vlastník) –
// `lead` je riadok už zamknutý guardom v tej istej transakcii. Pravidlá požiadaviek (§7.6) sú tu, takže oba vstupy
// sa správajú rovnako. Každá funkcia zvýši revíziu presne raz (bump + markLeadBumped alebo bumpLeadOnce cez helpery).

export type DealActor = { id: string; firstName: string };

// Jediný zápis Lead stĺpcov; revízia sa zvýši len pri prvom zápise v transakcii.
async function updateLead(tx: Tx, leadId: string, data: Parameters<Tx["lead"]["update"]>[0]["data"]) {
    const updated = await tx.lead.update({
        where: { id: leadId },
        data: { ...data, ...(isLeadBumped(tx, leadId) ? {} : bump) },
    });
    markLeadBumped(tx, leadId);
    return updated;
}

function hadNextAction(lead: Pick<Lead, "nextActionKind" | "nextActionAt" | "nextActionNote">) {
    return Boolean(lead.nextActionKind || lead.nextActionAt || lead.nextActionNote);
}

// Follow-up hovor o 7 obchodných kalendárnych dní od odoslania, len deň.
export function followUpInSevenDays(sentAt: Date): Date {
    return businessDayStart(addBusinessCalendarDays(businessDate(sentAt), 7));
}

async function planFollowUp(tx: Tx, actor: DealActor, lead: Lead, note: string, sentAt: Date, source: ActivitySource) {
    const next = nextActionData("CALL", followUpInSevenDays(sentAt), note, false);
    await tx.activity.create({
        data: createPlanningActivity({
            leadId: lead.id,
            userId: actor.id,
            type: hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
            source,
            note: describeNextAction(next),
        }),
    });
    return next;
}

// ── Údaje ────────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
    companyName: "Firma",
    website: "Web",
    phone: "Telefón",
    email: "Email",
    note: "Poznámka",
    price: "Cena",
    priceNote: "Rozpis ceny",
};

function fmtVal(key: string, v: unknown): string {
    if (v == null || v === "") return "—";
    if (key === "price") return `${Number(v)} €`;
    const s = String(v);
    return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

// „Telefón: 0900 → 0901 · Email: a → b"
function diffNote(current: Record<string, unknown>, data: Record<string, unknown>): string | null {
    const parts: string[] = [];
    for (const key of Object.keys(data)) {
        const oldV = current[key] ?? null;
        const newV = data[key] ?? null;
        const oldKey = oldV == null ? "" : key === "price" ? String(Number(oldV)) : String(oldV);
        const newKey = newV == null ? "" : String(newV);
        if (oldKey !== newKey) parts.push(`${FIELD_LABELS[key] ?? key}: ${fmtVal(key, oldV)} → ${fmtVal(key, newV)}`);
    }
    return parts.length ? parts.join(" · ") : null;
}

export type DealContactInput = {
    companyName?: string | null;
    website?: string | null;
    phone?: string | null;
    email?: string | null;
    note?: string | null;
};

// Vstupy z klienta sa validujú striktne za behu (TypeScript typ neodfiltruje extra kľúče z crafted requestu).
// Neznámy kľúč = chyba; do Prisma update ide len päť pomenovaných polí.
const optionalText = (max: number) => z.string().max(max).nullable().optional();
export const dealContactSchema = z
    .object({
        companyName: optionalText(200),
        website: optionalText(300),
        phone: optionalText(50),
        email: optionalText(200),
        note: optionalText(5000),
    })
    .strict();

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new AccessError("FORBIDDEN", "Neplatné údaje.");
    return parsed.data;
}

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

export async function updateDealContact(tx: Tx, actor: DealActor, lead: Lead, input: DealContactInput, source: ActivitySource) {
    const valid = parseInput(dealContactSchema, input);
    const data: DealContactInput = {
        companyName: clean(valid.companyName),
        website: clean(valid.website),
        phone: clean(valid.phone),
        email: clean(valid.email),
        note: clean(valid.note),
    };
    for (const key of Object.keys(data) as (keyof DealContactInput)[]) if (data[key] === undefined) delete data[key];
    const note = diffNote(lead as unknown as Record<string, unknown>, data as Record<string, unknown>);
    await updateLead(tx, lead.id, data);
    if (note) {
        await tx.activity.create({
            data: createAuditActivity({ leadId: lead.id, userId: actor.id, type: "CONTACT_UPDATED", source, note }),
        });
    }
}

// ── Cena ─────────────────────────────────────────────────────────────────────

export async function saveQuote(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    input: { price: number | null; priceNote: string | null },
    source: ActivitySource,
) {
    input = parseInput(
        z.object({ price: z.number().finite().min(0).max(10_000_000).nullable(), priceNote: z.string().max(2000).nullable() }).strict(),
        input,
    );
    const priceNote = input.priceNote?.trim() || null;
    const oldPrice = lead.price != null ? Number(lead.price) : null;
    await updateLead(tx, lead.id, { price: input.price, priceNote });
    if (oldPrice !== input.price) {
        const fmt = (p: number | null) => (p != null ? `${p} €` : "—");
        await tx.activity.create({
            data: createAuditActivity({
                leadId: lead.id,
                userId: actor.id,
                type: "CONTACT_UPDATED",
                source,
                note: `Cena: ${fmt(oldPrice)} → ${fmt(input.price)}`,
            }),
        });
    }
    if (input.price !== null) {
        await resolveOpenRequests(tx, lead.id, ["PRICE"], "DONE", actor.id, `Cena doplnená: ${input.price} €`, source);
    }
}

// Označenie CP ako odoslanej: priceDisclosed + follow-up hovor o 7 dní. Revertovateľné (sent=false).
export async function setQuoteSent(tx: Tx, actor: DealActor, lead: Lead, sent: boolean, source: ActivitySource) {
    if (!sent) {
        await updateLead(tx, lead.id, { quoteSentAt: null });
        await tx.activity.create({
            data: createAuditActivity({
                leadId: lead.id,
                userId: actor.id,
                type: "CONTACT_UPDATED",
                source,
                note: "Odoslanie cenovej ponuky zrušené",
            }),
        });
        return;
    }
    const at = new Date();
    const p = lead.price != null ? Number(lead.price) : null;
    await tx.activity.create({
        data: createBusinessActivity({
            leadId: lead.id,
            userId: actor.id,
            type: "QUOTE_SENT",
            source,
            note: p != null ? `Cenová ponuka odoslaná: ${p} €` : "Cenová ponuka odoslaná",
            createdAt: at,
        }),
    });
    const next = await planFollowUp(tx, actor, lead, "Zavolať, či cenová ponuka prišla", at, source);
    await updateLead(tx, lead.id, { quoteSentAt: at, priceDisclosed: true, ...next });
    await resolveOpenRequests(tx, lead.id, ["PRICE"], "DONE", actor.id, "Cenová ponuka odoslaná", source);
}

export async function setPriceDisclosed(tx: Tx, actor: DealActor, lead: Lead, disclosed: boolean, source: ActivitySource) {
    await updateLead(tx, lead.id, { priceDisclosed: disclosed });
    await tx.activity.create({
        data: createAuditActivity({
            leadId: lead.id,
            userId: actor.id,
            type: "CONTACT_UPDATED",
            source,
            note: disclosed ? "Klient oboznámený s cenou" : "Oboznámenie s cenou zrušené",
        }),
    });
}

// ── Ďalší krok ───────────────────────────────────────────────────────────────

export type NextActionInput = {
    kind: NextActionKind | null;
    schedule?: Schedule | null;
    note?: string | null;
    mode?: NextActionMode;
};

// Whitelist ide zo zdieľaného zoznamu krokov (lib/domain/nextStepOptions.ts), nie z enumu –
// nová hodnota v schéme sa tak nestane zapisovateľnou skôr, než ju UI naozaj ponúka.
const NEXT_ACTION_KINDS = NEXT_STEP_KINDS;
export const nextActionInputSchema = z
    .object({
        kind: z.enum(NEXT_ACTION_KINDS).nullable(),
        schedule: scheduleSchema.nullable().optional(),
        note: z.string().max(1000).nullable().optional(),
        mode: z.enum(["SCHEDULED", "IN_PROGRESS"]).optional(),
    })
    .strict();

export async function setNextAction(tx: Tx, actor: DealActor, lead: Lead, input: NextActionInput, source: ActivitySource) {
    input = parseInput(nextActionInputSchema, input);
    const mode = input.kind ? (input.mode ?? "SCHEDULED") : "SCHEDULED";
    let at: Date | null = null;
    let hasTime = false;
    if (input.kind && mode === "IN_PROGRESS") {
        // Rozpracované: nextActionAt = začiatok; pri pokračovaní sa nereštartuje „trvá X dní".
        at = lead.nextActionMode === "IN_PROGRESS" && lead.nextActionAt ? lead.nextActionAt : new Date();
    } else if (input.kind && input.schedule) {
        const resolved = resolveSchedule(input.schedule);
        at = resolved.at;
        hasTime = resolved.hasTime;
    }
    const next = input.kind ? nextActionData(input.kind, at, input.note, hasTime, mode) : nextActionData(null);
    const type = !input.kind ? "NEXT_ACTION_CLEARED" : hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET";
    await updateLead(tx, lead.id, next);
    await tx.activity.create({
        data: createPlanningActivity({ leadId: lead.id, userId: actor.id, type, source, note: describeNextAction(next) }),
    });
}

// ── Odoslané / poznámky ──────────────────────────────────────────────────────

const SENT_DEFAULTS: Record<"QUOTE_SENT" | "EMAIL_SENT", { dateField: "quoteSentAt" | "aboutUsSentAt"; note: string }> = {
    QUOTE_SENT: { dateField: "quoteSentAt", note: "Zavolať, či cenová ponuka prišla" },
    EMAIL_SENT: { dateField: "aboutUsSentAt", note: "Zavolať, či email prišiel / či si ho pozreli" },
};

export async function logSent(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    what: "QUOTE_SENT" | "EMAIL_SENT",
    source: ActivitySource,
) {
    const at = new Date();
    const defaults = SENT_DEFAULTS[what];
    await tx.activity.create({
        data: createBusinessActivity({ leadId: lead.id, userId: actor.id, type: what, source, createdAt: at }),
    });
    const next = await planFollowUp(tx, actor, lead, defaults.note, at, source);
    await updateLead(tx, lead.id, { [defaults.dateField]: at, ...next });
    if (what === "EMAIL_SENT") {
        await resolveOpenRequests(tx, lead.id, ["EMAIL"], "DONE", actor.id, "Email odoslaný", source);
    } else {
        await resolveOpenRequests(tx, lead.id, ["PRICE"], "DONE", actor.id, "Cenová ponuka odoslaná", source);
    }
}

export async function addBusinessNote(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    input: { note: string; type?: Extract<ActivityType, "NOTE" | "SMS_SENT"> },
    source: ActivitySource,
) {
    const note = input.note.trim();
    const type = input.type ?? "NOTE";
    if (type === "NOTE" && !note) throw new AccessError("FORBIDDEN", "Poznámka nemôže byť prázdna.");
    await tx.activity.create({
        data: createBusinessActivity({ leadId: lead.id, userId: actor.id, type, source, note: note || null }),
    });
    await updateLead(tx, lead.id, {});
}

export async function setProjectType(tx: Tx, actor: DealActor, lead: Lead, projectType: ProjectType | null) {
    void actor;
    await updateLead(tx, lead.id, { projectType });
}

// ── Stav obchodu ─────────────────────────────────────────────────────────────

export const DEAL_STATUSES = ["ACTIVE", "SNOOZED", "WON", "LOST", "UNREACHABLE"] as const satisfies readonly LeadStatus[];
export type DealStatus = (typeof DEAL_STATUSES)[number];

// Uzavretie: closedAt = now, nextAction vymazaný, požiadavky podľa §7.6.
export async function closeDeal(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    input: { status: "WON" | "LOST" | "UNREACHABLE"; lostReason?: string | null; note: string },
    source: ActivitySource,
) {
    const now = new Date();
    await updateLead(tx, lead.id, {
        status: input.status,
        closedAt: now,
        lostReason: input.status === "WON" ? null : input.lostReason?.trim() || lead.lostReason || null,
        ...nextActionData(null),
    });
    await tx.activity.create({
        data: createAuditActivity({ leadId: lead.id, userId: actor.id, type: "STATUS_CHANGED", source, note: input.note }),
    });
    if (hadNextAction(lead)) {
        await tx.activity.create({
            data: createPlanningActivity({
                leadId: lead.id,
                userId: actor.id,
                type: "NEXT_ACTION_CLEARED",
                source,
                note: `Ďalší krok zmazaný (${STATUS_LABEL[input.status].toLowerCase()})`,
            }),
        });
    }
    await closeRequestsForStatus(tx, lead.id, input.status, actor.id, source);
}

export async function markLost(tx: Tx, actor: DealActor, lead: Lead, reason: string | null, source: ActivitySource) {
    if (isClosedDealStatus(lead.status)) throw new AccessError("DEAL_CLOSED");
    await closeDeal(
        tx,
        actor,
        lead,
        { status: "LOST", lostReason: reason, note: reason?.trim() ? `Stratená: ${reason.trim()}` : "Označené ako stratené" },
        source,
    );
}

// Znovu otvorenie uzavretého obchodu (len manažér): ACTIVE, closedAt/lostReason null, CALL dnes, REOPEN → DONE. Vlastník ostáva.
export async function reopenDeal(tx: Tx, actor: DealActor, lead: Lead, source: ActivitySource) {
    if (!isClosedDealStatus(lead.status)) throw new AccessError("FORBIDDEN", "Obchod nie je uzavretý.");
    const next = nextActionData("CALL", businessTodayStart(), "Obchod znovu otvorený – ozvať sa", false);
    await updateLead(tx, lead.id, { status: "ACTIVE", closedAt: null, lostReason: null, ...next });
    await tx.activity.create({
        data: createAuditActivity({
            leadId: lead.id,
            userId: actor.id,
            type: "DEAL_REOPENED",
            source,
            note: `Obchod znovu otvorený (${STATUS_LABEL[lead.status]} → Aktívny)`,
        }),
    });
    await tx.activity.create({
        data: createPlanningActivity({
            leadId: lead.id,
            userId: actor.id,
            type: hadNextAction(lead) ? "NEXT_ACTION_CHANGED" : "NEXT_ACTION_SET",
            source,
            note: describeNextAction(next),
        }),
    });
    await resolveOpenRequests(tx, lead.id, ["REOPEN"], "DONE", actor.id, "Obchod znovu otvorený", source);
}

// Stavový select v pipeline: len stavy obchodu; uzavretie a znovuotvorenie cez pravidlá vyššie.
export async function changeDealStatus(tx: Tx, actor: DealActor, lead: Lead, status: DealStatus, source: ActivitySource) {
    if (!(DEAL_STATUSES as readonly string[]).includes(status)) throw new AccessError("FORBIDDEN", "Neplatný stav obchodu.");
    if (status === lead.status) return;
    const wasClosed = isClosedDealStatus(lead.status);
    if (status === "WON" || status === "LOST" || status === "UNREACHABLE") {
        await closeDeal(tx, actor, lead, { status, note: `Stav zmenený na ${STATUS_LABEL[status]}` }, source);
        return;
    }
    if (wasClosed) {
        await reopenDeal(tx, actor, lead, source);
        if (status === "ACTIVE") return;
        const reopened = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
        lead = reopened;
    }
    await updateLead(tx, lead.id, { status });
    await tx.activity.create({
        data: createAuditActivity({
            leadId: lead.id,
            userId: actor.id,
            type: "STATUS_CHANGED",
            source,
            note: `Stav zmenený na ${STATUS_LABEL[status]}`,
        }),
    });
}

export async function changeOwner(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    owner: { id: string; firstName: string; lastName: string } | null,
    source: ActivitySource,
) {
    if ((owner?.id ?? null) === lead.ownerId) return;
    await updateLead(tx, lead.id, { ownerId: owner?.id ?? null });
    await tx.activity.create({
        data: createAuditActivity({
            leadId: lead.id,
            userId: actor.id,
            type: "OWNER_CHANGED",
            source,
            note: owner ? `Vlastník: ${`${owner.firstName} ${owner.lastName}`.trim()}` : "Vlastník príležitosti bol odobratý",
        }),
    });
}
