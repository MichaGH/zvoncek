import prisma from "@/lib/db";
import { businessTodayStart } from "@/lib/domain/businessTime";
import { POOL_WHERE } from "@/lib/queries/calls";
import type { LeadStatus } from "@/app/generated/prisma/enums";

export const CONTACTS_PAGE_SIZE = 50;

type ContactLead = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    note: string | null;
    status: LeadStatus;
    assignedCallerId: string | null;
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
        createdAt: lead.createdAt.toISOString(),
        addedBy: lead.creator ? `${lead.creator.firstName} ${lead.creator.lastName}`.trim() : null,
        owner: lead.owner?.firstName ?? null,
    };
}

export type ContactListRow = ReturnType<typeof toContactRow>;

export async function getContactsList({
    query,
    take = CONTACTS_PAGE_SIZE,
    createdById,
    createdByIds,
    assignedCallerId,
    ownerId,
}: {
    query?: string;
    take?: number;
    createdById?: string; // scout → len vlastné pridané
    createdByIds?: string[]; // vedúci → pridané kontakty jeho tímu (scoping vynútený na stránke)
    assignedCallerId?: string; // „Volá" – kto má kontakt vo svojej práci volania
    ownerId?: string; // „Rieši obchod"
}): Promise<{ rows: ContactListRow[]; hasMore: boolean }> {
    const leads = await prisma.lead.findMany({
        where: {
            deletedAt: null,
            ...(createdById
                ? { createdById }
                : createdByIds
                  ? { createdById: { in: createdByIds } }
                  : {}),
            ...(assignedCallerId ? { assignedCallerId } : {}),
            ...(ownerId ? { ownerId } : {}),
            ...(query
                ? {
                      OR: [
                          { companyName: { contains: query, mode: "insensitive" } },
                          { website: { contains: query, mode: "insensitive" } },
                          { phone: { contains: query } },
                      ],
                  }
                : {}),
        },
        select: {
            id: true,
            number: true,
            companyName: true,
            website: true,
            phone: true,
            note: true,
            status: true,
            assignedCallerId: true,
            _count: { select: { activities: { where: { type: "CALL" } } } },
            createdAt: true,
            creator: { select: { firstName: true, lastName: true } },
            owner: { select: { firstName: true } },
        },
        // Newest first: sorters want to see what they just added.
        orderBy: { createdAt: "desc" },
        take: take + 1,
    });

    const hasMore = leads.length > take;
    const rows = leads.slice(0, take).map(toContactRow);
    return { rows, hasMore };
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
