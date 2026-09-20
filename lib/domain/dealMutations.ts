import type { Lead } from "@/app/generated/prisma/client";
import type {
    ActivitySource,
    LeadStatus,
    NextActionKind,
    NextActionMode,
    ProjectType,
} from "@/app/generated/prisma/enums";
import { AccessError } from "@/lib/access/errors";
import { NEXT_STEP_KINDS } from "@/lib/domain/nextStepOptions";
import { isClosedDealStatus } from "@/lib/access/leads";
import type { LockedUser, Tx } from "@/lib/access/locks";
import { can } from "@/lib/permissions";
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
import { defaultStep } from "@/lib/domain/clientRequests";
import { hadNextAction, updateLead } from "@/lib/domain/leadWrites";
import { outstandingOf } from "@/lib/domain/requestMutations";
import { resolveSchedule, scheduleSchema, type Schedule } from "@/lib/domain/schedule";
import {
    assertStepAllowed,
    assertStepUnlocked,
    cancelOpenTask,
    dismissAllPending,
    openTaskOf,
    ownerTransition,
    unlockStep,
} from "@/lib/domain/taskMutations";
import { z } from "zod";
import { STATUS_LABEL } from "@/lib/dictionaries";

// Telá biznis mutácií obchodu (plán §7.7). Volajú ich pipeline akcie (manažér) aj client akcie (vlastník) –
// `lead` je riadok už zamknutý guardom v tej istej transakcii. Každá funkcia zvýši revíziu presne raz
// (bump + markLeadBumped alebo bumpLeadOnce cez helpery). Wave 3: zápis kroku / stavu prechádza zámkom úlohy
// (assertStepUnlocked) a pravidlom vrátených výsledkov (assertStepAllowed, I10); uzavretie ruší úlohu len výslovne.

export type DealActor = { id: string; firstName: string };

export { hadNextAction, updateLead };

// Výslovné zrušenie otvorenej úlohy v tom istom uložení (D5): formulár menuje úlohu, ktorú ruší.
export type CancelTaskInput = { taskId: string; reason?: string | null };
export const cancelTaskSchema = z.object({ taskId: z.string().min(1), reason: z.string().max(500).nullish() }).strict();

// Hlavný riadok príkazu (idempotentné opakovanie, §5.5): kľúč + kanonický odtlačok toho, čo používateľ odoslal.
export type Primary = { key: string; fp: string } | null | undefined;
function primaryData(primary: Primary, meta: Record<string, string> = {}): { idempotencyKey?: string; meta?: Record<string, string> } {
    if (primary) return { idempotencyKey: primary.key, meta: { ...meta, fp: primary.fp } };
    return Object.keys(meta).length ? { meta } : {};
}

// Otvorená úloha pri zmene stavu: bez výslovného zrušenia je krok zamknutý; zrušenie musí menovať presne tú úlohu.
async function cancelForStatus(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    cancelTask: CancelTaskInput | null | undefined,
    source: ActivitySource,
    reasonText: (userReason: string | null) => string,
): Promise<boolean> {
    const open = await openTaskOf(tx, lead.id);
    if (!open) {
        if (cancelTask) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
        return false;
    }
    if (!cancelTask) throw new AccessError("STEP_LOCKED");
    if (cancelTask.taskId !== open.id) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
    await cancelOpenTask(tx, actor, open, reasonText(cancelTask.reason?.trim() || null), source);
    return true;
}

// Follow-up hovor o 7 obchodných kalendárnych dní od odoslania, len deň.
export function followUpInSevenDays(sentAt: Date): Date {
    return businessDayStart(addBusinessCalendarDays(businessDate(sentAt), 7));
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
    await assertStepUnlocked(tx, lead.id);
    await assertStepAllowed(tx, lead.id, input.kind);
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

// ── Poznámky ─────────────────────────────────────────────────────────────────

export async function addBusinessNote(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    input: { note: string },
    source: ActivitySource,
) {
    const note = input.note.trim();
    if (!note) throw new AccessError("FORBIDDEN", "Poznámka nemôže byť prázdna.");
    await tx.activity.create({
        data: createBusinessActivity({ leadId: lead.id, userId: actor.id, type: "NOTE", source, note }),
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

// Uzavretie: closedAt = now, nextAction vymazaný. Otvorená úloha sa ruší len výslovne (cancelTask, „obchod uzavretý"),
// všetko vrátené a neposlané sa odmietne s tým istým dôvodom (W3-R3-04) – znovuotvorenie nič z toho neoživí.
export async function closeDeal(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    input: {
        status: "WON" | "LOST" | "UNREACHABLE";
        lostReason?: string | null;
        note: string;
        cancelTask?: CancelTaskInput | null;
        primary?: Primary;
    },
    source: ActivitySource,
) {
    await cancelForStatus(tx, actor, lead, input.cancelTask, source, (r) => (r ? `obchod uzavretý – ${r}` : "obchod uzavretý"));
    await dismissAllPending(tx, actor, lead.id, "obchod uzavretý", source);
    const now = new Date();
    await updateLead(tx, lead.id, {
        status: input.status,
        closedAt: now,
        lostReason: input.status === "WON" ? null : input.lostReason?.trim() || lead.lostReason || null,
        ...nextActionData(null),
    });
    await tx.activity.create({
        data: {
            ...createAuditActivity({ leadId: lead.id, userId: actor.id, type: "STATUS_CHANGED", source, note: input.note }),
            ...primaryData(input.primary, { status: input.status }),
        },
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
}

export async function markLost(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    reason: string | null,
    source: ActivitySource,
    opts: { cancelTask?: CancelTaskInput | null; primary?: Primary; people?: ReopenPeople } = {},
) {
    if (isClosedDealStatus(lead.status)) throw new AccessError("DEAL_CLOSED");
    await closeDeal(
        tx,
        actor,
        lead,
        {
            status: "LOST",
            lostReason: reason,
            note: reason?.trim() ? `Stratená: ${reason.trim()}` : "Označené ako stratené",
            cancelTask: opts.cancelTask,
            primary: opts.primary,
        },
        source,
    );
}

// Znovu otvorenie uzavretého obchodu (len manažér): ACTIVE, closedAt/lostReason null, CALL dnes. Vlastník ostáva.
// Uzavretý obchod nikdy nemá otvorenú úlohu (I7) a vrátené výsledky boli pri uzavretí odmietnuté – nič sa neoživí.
export const REOPEN_STEP_NOTE = "Obchod znovu otvorený – ozvať sa";
// Ľudia, ktorých znovuotvorenie potrebuje zamknuté (User pred Lead): doterajší vlastník a otvárajúci manažér.
export type ReopenPeople = { owner: LockedUser | null; me: LockedUser };

// Uzavretý obchod si vlastníka ponecháva, aj keď ten medzitým odišiel alebo zmenil rolu (D14 blokuje len otvorené
// obchody). Znovuotvorenie by z neho urobilo živý obchod, ktorý nikto nevidí (R01-3) – preto ho prevezme manažér,
// ktorý ho otvára (ak môže vlastniť obchody), inak ostane bez vlastníka („Nepriradené"). Zapíše sa ako každá zmena
// vlastníka (OWNER_CHANGED + DealOwnership), v tej istej transakcii a revízii.
export function reopenOwnerTarget(people: ReopenPeople): { change: boolean; target: LockedUser | null } {
    const owner = people.owner;
    if (!owner || (!owner.deletedAt && can(owner, "deals.receive"))) return { change: false, target: owner };
    const me = people.me;
    return { change: true, target: !me.deletedAt && can(me, "deals.receive") ? me : null };
}

export async function reopenDeal(tx: Tx, actor: DealActor, lead: Lead, source: ActivitySource, primary: Primary, people: ReopenPeople) {
    if (!isClosedDealStatus(lead.status)) throw new AccessError("FORBIDDEN", "Obchod nie je uzavretý.");
    if ((people.owner?.id ?? null) !== lead.ownerId) throw new AccessError("STALE", "Obchod sa medzitým zmenil – obnovujem.");
    await assertStepUnlocked(tx, lead.id);
    // Wave 5 (§6.10): ak je ešte niečo nevybavené, obchod sa otvorí na TO – „Poslať návrh", nie „Zavolať". Pevné
    // „Zavolať" ostáva len vtedy, keď nie je čo poslať (pôvodné wave-3 zjednodušenie).
    const outstanding = await outstandingOf(tx, lead.id);
    const derived = defaultStep(outstanding, { ...lead, nextActionKind: null, nextActionAt: null, nextActionNote: null });
    const next = derived ?? nextActionData("CALL", businessTodayStart(), REOPEN_STEP_NOTE, false);
    await updateLead(tx, lead.id, { status: "ACTIVE", closedAt: null, lostReason: null, ...next });
    await tx.activity.create({
        data: {
            ...createAuditActivity({
                leadId: lead.id,
                userId: actor.id,
                type: "DEAL_REOPENED",
                source,
                note: `Obchod znovu otvorený (${STATUS_LABEL[lead.status]} → Aktívny)`,
            }),
            ...primaryData(primary),
        },
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
    const owner = reopenOwnerTarget(people);
    if (owner.change) {
        await ownerTransition(tx, actor, lead, owner.target, {
            kind: "CHANGE",
            source,
            note: "znovuotvorenie – pôvodný vlastník už nemôže viesť obchody",
        });
    }
}

// Stavový select v pipeline: len stavy obchodu; uzavretie a znovuotvorenie cez pravidlá vyššie.
// Uspanie s otvorenou úlohou ju musí výslovne zrušiť (spiaci obchod nemôže mať zamknutý krok, §5.3).
export async function changeDealStatus(
    tx: Tx,
    actor: DealActor,
    lead: Lead,
    status: DealStatus,
    source: ActivitySource,
    opts: { cancelTask?: CancelTaskInput | null; primary?: Primary; people?: ReopenPeople } = {},
) {
    if (!(DEAL_STATUSES as readonly string[]).includes(status)) throw new AccessError("FORBIDDEN", "Neplatný stav obchodu.");
    if (status === lead.status) {
        if (opts.cancelTask) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
        return;
    }
    const wasClosed = isClosedDealStatus(lead.status);
    if (status === "WON" || status === "LOST" || status === "UNREACHABLE") {
        await closeDeal(
            tx,
            actor,
            lead,
            { status, note: `Stav zmenený na ${STATUS_LABEL[status]}`, cancelTask: opts.cancelTask, primary: opts.primary },
            source,
        );
        return;
    }
    let primary = opts.primary;
    if (wasClosed) {
        if (opts.cancelTask) throw new AccessError("STALE", "Úloha sa medzitým zmenila – obnovujem.");
        if (!opts.people) throw new Error("reopen needs the locked owner (ReopenPeople)");
        await reopenDeal(tx, actor, lead, source, primary, opts.people);
        primary = null; // kľúč nesie DEAL_REOPENED
        if (status === "ACTIVE") return;
        const reopened = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
        lead = reopened;
    }
    const cancelled = await cancelForStatus(tx, actor, lead, opts.cancelTask, source, (r) => r ?? "obchod uspaný");
    await updateLead(tx, lead.id, { status });
    if (cancelled) await unlockStep(tx, lead);
    await tx.activity.create({
        data: {
            ...createAuditActivity({
                leadId: lead.id,
                userId: actor.id,
                type: "STATUS_CHANGED",
                source,
                note: `Stav zmenený na ${STATUS_LABEL[status]}`,
            }),
            ...primaryData(primary, { status }),
        },
    });
}
