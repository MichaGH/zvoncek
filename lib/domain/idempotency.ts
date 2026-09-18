import type { ActivitySource, ActivityType, CallOutcome } from "@/app/generated/prisma/enums";
import type { ActionError } from "@/lib/access/errors";
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
// kľúč patrí tej istej osobe, obchodu a niektorému z očakávaných typov → úspech bez ďalšieho zápisu; inak konflikt.
export async function activityReplay(
    key: string,
    expected: { userId: string; leadId: string; types: readonly ActivityType[] },
): Promise<{ success: true } | ActionError | null> {
    const existing = await prisma.activity.findUnique({
        where: { idempotencyKey: key },
        select: { userId: true, leadId: true, type: true },
    });
    if (!existing) return null;
    const matches = existing.userId === expected.userId && existing.leadId === expected.leadId && expected.types.includes(existing.type);
    return matches ? { success: true } : { error: "Obchod sa medzitým zmenil – obnovujem.", code: "IDEMPOTENCY_CONFLICT" };
}
