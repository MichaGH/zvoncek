import prisma from "@/lib/db";
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
        // Only NEW contacts haven't been called yet – safe to edit/delete freely.
        callable: lead.status === "NEW",
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
}: {
    query?: string;
    take?: number;
    createdById?: string; // scout → len vlastné pridané
}): Promise<{ rows: ContactListRow[]; hasMore: boolean }> {
    const leads = await prisma.lead.findMany({
        where: {
            deletedAt: null,
            ...(createdById ? { createdById } : {}),
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

export async function getContactsOverview(createdById?: string): Promise<{
    total: number;
    addedToday: number;
    callable: number;
}> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const scope = createdById ? { createdById } : {};

    const [total, addedToday, callable] = await Promise.all([
        prisma.lead.count({ where: { deletedAt: null, ...scope } }),
        prisma.lead.count({ where: { deletedAt: null, ...scope, createdAt: { gte: startOfToday } } }),
        // "Voľné na volanie" = ešte sa nevolalo (status NEW).
        prisma.lead.count({ where: { deletedAt: null, ...scope, status: "NEW" } }),
    ]);

    return { total, addedToday, callable };
}
