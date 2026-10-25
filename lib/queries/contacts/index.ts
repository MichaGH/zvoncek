import prisma from "@/lib/db";
import type { Prisma } from "@/app/generated/prisma/client";
import { businessTodayStart } from "@/lib/domain/businessTime";
import type { ContactRound, ContactView } from "@/lib/domain/contactFilters";
import { POOL_ORDER_SQL, POOL_WHERE } from "@/lib/queries/calls";
import type { LeadStatus } from "@/app/generated/prisma/enums";

export const CONTACTS_PAGE_SIZE = 50;

const CONTACT_SELECT = {
    id: true,
    number: true,
    companyName: true,
    website: true,
    phone: true,
    note: true,
    status: true,
    assignedCallerId: true,
    round: true,
    roundStartedAt: true,
    _count: { select: { activities: { where: { type: "CALL" as const } } } },
    createdAt: true,
    creator: { select: { firstName: true, lastName: true } },
    owner: { select: { firstName: true } },
} satisfies Prisma.LeadSelect;

type ContactLead = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    note: string | null;
    status: LeadStatus;
    assignedCallerId: string | null;
    round: number;
    roundStartedAt: Date | null;
    _count: { activities: number };
    createdAt: Date;
    creator: { firstName: string; lastName: string } | null;
    owner: { firstName: string } | null;
};

function toContactRow(lead: ContactLead) {
    return {
        id: lead.id,
        number: lead.number,
        name: lead.companyName ?? lead.website ?? "—",
        companyName: lead.companyName,
        website: lead.website,
        phone: lead.phone,
        note: lead.note,
        status: lead.status,
        // Nedotknutý = NEW, nikto si ho nezobral na volanie a nemá hovor. Len vtedy ho smie meniť pridávač.
        callable: lead.status === "NEW" && lead.assignedCallerId === null && lead._count.activities === 0,
        // Upravovať / mazať smie pridávač len kontakt v 1. kole – recyklovaný (feature 02) už nie je jeho.
        editable: lead.round === 1 && lead.status === "NEW" && lead.assignedCallerId === null && lead._count.activities === 0,
        round: lead.round,
        recycledAt: lead.roundStartedAt?.toISOString() ?? null,
        createdAt: lead.createdAt.toISOString(),
        addedBy: lead.creator ? `${lead.creator.firstName} ${lead.creator.lastName}`.trim() : null,
        owner: lead.owner?.firstName ?? null,
    };
}

export type ContactListRow = ReturnType<typeof toContactRow>;

export type ContactsFilter = {
    query?: string;
    createdById?: string; // scout → len vlastné pridané
    createdByIds?: string[]; // vedúci → pridané kontakty jeho tímu (scoping vynútený na stránke)
    assignedCallerId?: string; // „Volá" – kto má kontakt vo svojej práci volania
    ownerId?: string; // „Rieši obchod"
    round?: ContactRound; // feature 02 §15: všetky / len 1. kolo / len recyklované
};

// Jeden predikát pre zoznam aj počty pohľadov (ui-context §5): číslo na prepínači = to, čo ukáže klik.
function contactsWhere(f: ContactsFilter, view: ContactView): Prisma.LeadWhereInput {
    return {
        deletedAt: null,
        ...(f.createdById ? { createdById: f.createdById } : f.createdByIds ? { createdById: { in: f.createdByIds } } : {}),
        ...(f.assignedCallerId ? { assignedCallerId: f.assignedCallerId } : {}),
        ...(f.ownerId ? { ownerId: f.ownerId } : {}),
        ...(f.round === "1" ? { round: 1 } : f.round === "2" ? { round: { gte: 2 } } : {}),
        ...(f.query
            ? {
                  OR: [
                      { companyName: { contains: f.query, mode: "insensitive" } },
                      { website: { contains: f.query, mode: "insensitive" } },
                      { phone: { contains: f.query } },
                  ],
              }
            : {}),
        // Na volanie = spoločná fronta (POOL_WHERE) v rozsahu a filtroch používateľa.
        ...(view === "pool" ? { AND: [POOL_WHERE] } : {}),
    };
}

export async function getContactsList({
    view = "added",
    take = CONTACTS_PAGE_SIZE,
    ...filter
}: ContactsFilter & { view?: ContactView; take?: number }): Promise<{ rows: ContactListRow[]; hasMore: boolean }> {
    const where = contactsWhere(filter, view);

    if (view === "added") {
        const leads = await prisma.lead.findMany({
            where,
            select: CONTACT_SELECT,
            // Newest first: sorters want to see what they just added.
            orderBy: { createdAt: "desc" },
            take: take + 1,
        });
        return { rows: leads.slice(0, take).map(toContactRow), hasMore: leads.length > take };
    }

    // Na volanie: poradie fronty sa v Prisma orderBy vyjadriť nedá → id v SQL (to isté POOL_ORDER_SQL ako claim),
    // riadky cez Prisma v tom istom poradí.
    const candidates = await prisma.lead.findMany({ where, select: { id: true } });
    if (candidates.length === 0) return { rows: [], hasMore: false };
    const ordered = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Lead" WHERE id = ANY(${candidates.map((c) => c.id)})
         ORDER BY ${POOL_ORDER_SQL}
         LIMIT ${take + 1}`;
    const page = ordered.slice(0, take).map((o) => o.id);
    const leads = await prisma.lead.findMany({ where: { id: { in: page } }, select: CONTACT_SELECT });
    const byId = new Map(leads.map((l) => [l.id, l]));
    return {
        rows: page.map((id) => byId.get(id)).filter((l): l is ContactLead => Boolean(l)).map(toContactRow),
        hasMore: ordered.length > take,
    };
}

// Počty na prepínači pohľadov – ten istý predikát a filtre ako zoznam.
export async function getContactsViewCounts(filter: ContactsFilter): Promise<Record<ContactView, number>> {
    const [added, pool] = await Promise.all([
        prisma.lead.count({ where: contactsWhere(filter, "added") }),
        prisma.lead.count({ where: contactsWhere(filter, "pool") }),
    ]);
    return { added, pool };
}

export async function getContactsOverview(
    scopeInput: string | { createdById?: string; createdByIds?: string[] } = {},
): Promise<{
    total: number;
    addedToday: number;
    callable: number;
}> {
    const startOfToday = businessTodayStart();
    // Spätná kompatibilita: string === createdById.
    const norm = typeof scopeInput === "string" ? { createdById: scopeInput } : scopeInput;
    const scope = norm.createdById
        ? { createdById: norm.createdById }
        : norm.createdByIds
          ? { createdById: { in: norm.createdByIds } }
          : {};

    const [total, addedToday, callable] = await Promise.all([
        prisma.lead.count({ where: { deletedAt: null, ...scope } }),
        prisma.lead.count({ where: { deletedAt: null, ...scope, createdAt: { gte: startOfToday } } }),
        // "Voľné na volanie" = nedotknuté: NEW, nikým nenárokované, bez hovoru (bez scope = spoločná fronta).
        prisma.lead.count({ where: { ...POOL_WHERE, ...scope } }),
    ]);

    return { total, addedToday, callable };
}
