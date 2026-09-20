import type { ActivitySource, ActivityType, CallOutcome } from "@/app/generated/prisma/enums";
import { AccessError, isUniqueViolation, type ActionError } from "@/lib/access/errors";
import prisma from "@/lib/db";
import { isHandoffOutcome } from "@/lib/domain/leadFlow";

// Nie je server action – importujú ho len akcie. (Export zo "use server" súboru by bol verejne volateľný.)

export type HandoffRecipient = { id: string; name: string } | null;
export type LogCallResult = { success: true; recipient?: HandoffRecipient } | ActionError;

// Výsledok opakovaného odoslania s tým istým kľúčom (§4.5 krok 2, §10.2).
export async function idempotentReplay(
    key: string,
    expected: { userId: string; leadId: string; source: ActivitySource; outcome: CallOutcome },
): Promise<LogCallResult | null> {
    const existing = await prisma.activity.findUnique({
        where: { idempotencyKey: key },
        select: {
            userId: true,
            leadId: true,
            type: true,
            source: true,
            outcome: true,
            lead: { select: { owner: { select: { id: true, firstName: true, lastName: true } } } },
        },
    });
    if (!existing) return null;
    const matches =
        existing.userId === expected.userId &&
        existing.leadId === expected.leadId &&
        existing.type === "CALL" &&
        existing.source === expected.source &&
        existing.outcome === expected.outcome;
    if (!matches) {
        return { error: "Kontakt sa medzitým zmenil – obnovujem.", code: "IDEMPOTENCY_CONFLICT" };
    }
    if (!isHandoffOutcome(expected.outcome)) return { success: true };
    const owner = existing.lead.owner;
    return { success: true, recipient: owner ? { id: owner.id, name: `${owner.firstName} ${owner.lastName}`.trim() } : null };
}

// Všeobecná obdoba pre záznamy obchodu (odoslanie, SMS, odpoveď klienta, plán bez kontaktu – round 2 §2c):
// kľúč patrí tej istej osobe, obchodu, niektorému z očakávaných typov A TOMU ISTÉMU OBSAHU (`fingerprint`) →
// úspech bez ďalšieho zápisu. Iný obsah pod tým istým kľúčom = konflikt, nie falošné „uložené".
export type ReplayRow = { type: ActivityType; outcome: CallOutcome | null; note: string | null; meta: unknown };

export async function activityReplay(
    key: string,
    expected: { userId: string; leadId: string; types: readonly ActivityType[]; fingerprint?: (row: ReplayRow) => string; want?: string },
): Promise<{ success: true } | ActionError | null> {
    const existing = await prisma.activity.findUnique({
        where: { idempotencyKey: key },
        select: { userId: true, leadId: true, type: true, outcome: true, note: true, meta: true },
    });
    if (!existing) return null;
    const matches =
        existing.userId === expected.userId &&
        existing.leadId === expected.leadId &&
        expected.types.includes(existing.type) &&
        (!expected.fingerprint || expected.fingerprint(existing) === expected.want);
    return matches ? { success: true } : { error: "Obchod sa medzitým zmenil – obnovujem.", code: "IDEMPOTENCY_CONFLICT" };
}

// Príkaz s jedným hlavným riadkom a kľúčom (wave 3 §5.5): kľúč sa hľadá PRED kontrolou revízie – ten istý kľúč + ten
// istý odtlačok = predchádzajúci úspech (dvojklik nikdy neukáže falošnú chybu), iný odtlačok = IDEMPOTENCY_CONFLICT.
// Prehratý súbeh (unique index alebo STALE po čakaní na zámok) sa znova pozrie na kľúč.
export async function runKeyed(
    key: string,
    expected: { userId: string; leadId: string; types: readonly ActivityType[]; fp: string },
    run: () => Promise<void>,
    fail: (error: unknown) => ActionError,
): Promise<{ success: true } | ActionError> {
    const replayArgs = {
        userId: expected.userId,
        leadId: expected.leadId,
        types: expected.types,
        fingerprint: (row: ReplayRow) => fpOf(row.meta),
        want: expected.fp,
    };
    const first = await activityReplay(key, replayArgs);
    if (first) return first;
    try {
        await run();
        return { success: true };
    } catch (error) {
        if (isUniqueViolation(error) || (error instanceof AccessError && error.code === "STALE")) {
            const again = await activityReplay(key, replayArgs);
            if (again) return again;
        }
        return fail(error);
    }
}

function fpOf(meta: unknown): string {
    return meta && typeof meta === "object" && !Array.isArray(meta) && typeof (meta as { fp?: unknown }).fp === "string"
        ? (meta as { fp: string }).fp
        : "";
}
