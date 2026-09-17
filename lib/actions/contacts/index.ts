"use server";

import prisma from "@/lib/db";
import { createAuditActivity } from "@/lib/activityLog";
import { AccessError, toActionError } from "@/lib/access/errors";
import { lockLeadWithUsers } from "@/lib/access/leads";
import { withLockTx, type Tx } from "@/lib/access/locks";
import type { AccessUser } from "@/lib/access/user";
import { bump, markLeadBumped } from "@/lib/domain/revision";
import { can } from "@/lib/permissions";
import { requireUser } from "@/lib/access/user";
import { getTeamScopeForLeader } from "@/lib/queries/teams";
import { revalidatePath } from "next/cache";

// Scout smie upravovať/mazať len svoje a iba kým sú nedotknuté: NEW, nikým nenárokované, bez hovoru (§4.7).
// Vedúci s contacts.manageTeam smie to isté pre nedotknuté kontakty členov svojho tímu.
// Manager/admin (contacts.deleteAny) smú hocičo – pri priradenom kontakte s assignee lockom.
// Kontrola beží v transakcii pod zámkom Lead riadku (claim môže prebehnúť súbežne).
async function lockContactForManage(tx: Tx, user: AccessUser, leadId: string, teamIds: string[] | null) {
    const { lead, users } = await lockLeadWithUsers(tx, leadId, [user.id]);
    const actor = users.get(user.id);
    if (!actor || actor.deletedAt) throw new AccessError("UNAUTHENTICATED");
    if (lead.deletedAt) throw new AccessError("NOT_FOUND", "Kontakt neexistuje.");
    if (can(actor, "contacts.deleteAny")) return lead;

    const calls = await tx.activity.count({ where: { leadId, type: "CALL" } });
    const untouched = lead.status === "NEW" && lead.assignedCallerId === null && calls === 0;
    if (untouched && lead.createdById === actor.id) return lead;
    if (untouched && can(actor, "contacts.manageTeam") && lead.createdById && teamIds?.includes(lead.createdById)) {
        return lead;
    }
    throw new AccessError(
        "FORBIDDEN",
        "Môžeš upravovať len ešte neobvolané kontakty (svoje alebo svojho tímu), ktoré si nikto nezobral na volanie.",
    );
}

function revalidateContacts() {
    revalidatePath("/dashboard/contacts");
    revalidatePath("/dashboard/contacts/new");
    revalidatePath("/dashboard/calls");
    revalidatePath("/dashboard/pipeline");
}

export type CreateContactInput = {
    companyName?: string;
    website?: string;
    phone?: string;
    note?: string;
};

export type CreateContactResult =
    | { ok: true; id: string; number: number }
    | { ok: false; error: string; duplicate?: { number: number; name: string } };

// Adding contacts is the one job the (non-technical) sorters do.
// A contact needs a name (company OR website) and a phone number to be callable.
// Inserts never collide with people calling/editing other leads, so concurrent
// adding is safe; the only shared guard is the soft duplicate-phone check below.
function normalizeWebsite(raw: string | undefined): string | null {
    const s = raw?.trim();
    if (!s) return null;
    const withProtocol = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    try {
        const { hostname } = new URL(withProtocol);
        return hostname.replace(/^www\./i, "") || s;
    } catch {
        return s;
    }
}

export async function createContact(input: CreateContactInput): Promise<CreateContactResult> {
    const user = await requireUser();
    if (!user) return { ok: false, error: "Nie si prihlásený." };
    if (!can(user, "contacts.create")) return { ok: false, error: "Nemáš oprávnenie." };

    const companyName = input.companyName?.trim() || null;
    const website = normalizeWebsite(input.website);
    const phone = input.phone?.trim() || null;
    const note = input.note?.trim() || null;

    if (!companyName && !website) {
        return { ok: false, error: "Vyplň firmu alebo web." };
    }
    if (!phone) {
        return { ok: false, error: "Telefón je povinný." };
    }

    if (phone) {
        const existing = await prisma.lead.findFirst({
            where: { phone, deletedAt: null },
            select: { number: true, companyName: true, website: true },
        });
        if (existing) {
            // Bez prístupu ku kontaktom žiadne detaily – nesmie prezradiť cudzí obchod.
            if (!can(user, "contacts.access")) return { ok: false, error: "Toto číslo už v databáze existuje." };
            const name = existing.companyName ?? existing.website ?? "—";
            return {
                ok: false,
                error: `Toto číslo už existuje ako #${existing.number} (${name}).`,
                duplicate: { number: existing.number, name },
            };
        }
    }

    try {
        const lead = await prisma.lead.create({
            data: { companyName, website, phone, note, createdById: user.id },
            select: { id: true, number: true },
        });
        revalidateContacts();
        return { ok: true, id: lead.id, number: lead.number };
    } catch {
        return { ok: false, error: "Nepodarilo sa uložiť. Skús znova." };
    }
}

export type UpdateContactInput = {
    companyName?: string;
    website?: string;
    phone?: string;
    note?: string;
};

export async function updateContact(
    id: string,
    input: UpdateContactInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const user = await requireUser();
    if (!user) return { ok: false, error: "Nie si prihlásený." };
    if (!can(user, "contacts.access")) return { ok: false, error: "Nemáš oprávnenie." };
    const teamIds = can(user, "contacts.manageTeam") ? ((await getTeamScopeForLeader(user.id))?.ids ?? []) : null;

    const companyName = input.companyName?.trim() || null;
    const website = normalizeWebsite(input.website);
    const phone = input.phone?.trim() || null;
    const note = input.note?.trim() || null;

    if (!companyName && !website) return { ok: false, error: "Vyplň firmu alebo web." };
    if (!phone) return { ok: false, error: "Telefón je povinný." };

    try {
        await withLockTx(async (tx) => {
            const lead = await lockContactForManage(tx, user, id, teamIds);
            await tx.lead.update({ where: { id: lead.id }, data: { companyName, website, phone, note, ...bump } });
            markLeadBumped(tx, lead.id);
            await tx.activity.create({
                data: createAuditActivity({
                    leadId: lead.id,
                    userId: user.id,
                    type: "CONTACT_UPDATED",
                    source: "CONTACTS",
                    note: "Kontakt upravený",
                }),
            });
        });
    } catch (error) {
        return { ok: false, error: toActionError(error, "Nepodarilo sa uložiť.", "updateContact").error };
    }
    revalidateContacts();
    return { ok: true };
}

// Soft delete – kontakt sa schová, ale nestratí sa (dá sa obnoviť v DB).
export async function deleteContact(
    id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const user = await requireUser();
    if (!user) return { ok: false, error: "Nie si prihlásený." };
    if (!can(user, "contacts.access")) return { ok: false, error: "Nemáš oprávnenie." };
    const teamIds = can(user, "contacts.manageTeam") ? ((await getTeamScopeForLeader(user.id))?.ids ?? []) : null;

    try {
        await withLockTx(async (tx) => {
            const lead = await lockContactForManage(tx, user, id, teamIds);
            await tx.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date(), ...bump } });
        });
    } catch (error) {
        return { ok: false, error: toActionError(error, "Nepodarilo sa vymazať.", "deleteContact").error };
    }
    revalidateContacts();
    return { ok: true };
}
