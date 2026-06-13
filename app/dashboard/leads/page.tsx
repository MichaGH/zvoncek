import prisma from "@/lib/db";
import { LeadStatus } from "@/app/generated/prisma/enums";
import LeadsTable from "@/components/leads/LeadsTable";
import StatusTabs from "@/components/leads/StatusTabs";

const FILTERS: Record<string, LeadStatus | undefined> = {
    active: "ACTIVE",
    new: "NEW",
    snoozed: "SNOOZED",
    won: "WON",
    lost: "LOST",
    all: undefined,
};

export default async function LeadsPage({
    searchParams,
}: {
    searchParams: Promise<{ filter?: string; q?: string }>;
}) {
    const { filter = "active", q } = await searchParams;
    const status = FILTERS[filter];

    const leads = await prisma.lead.findMany({
        where: {
            ...(status ? { status } : {}),
            ...(q
                ? {
                      OR: [
                          { companyName: { contains: q, mode: "insensitive" } },
                          { website: { contains: q, mode: "insensitive" } },
                          { phone: { contains: q } },
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
            status: true,
            nextActionAt: true,
            nextActionNote: true,
            price: true,
            owner: { select: { firstName: true } },
            activities: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { type: true, outcome: true, createdAt: true },
            },
        },
        orderBy: { nextActionAt: { sort: "asc", nulls: "last" } },
    });

    const rows = leads.map((l) => ({
        id: l.id,
        number: l.number,
        name: l.companyName ?? l.website ?? "—",
        phone: l.phone,
        status: l.status,
        nextActionAt: l.nextActionAt?.toISOString() ?? null,
        nextActionNote: l.nextActionNote,
        price: l.price ? Number(l.price) : null,
        owner: l.owner?.firstName ?? null,
        lastActivity: l.activities[0]
            ? { type: l.activities[0].type, outcome: l.activities[0].outcome, at: l.activities[0].createdAt.toISOString() }
            : null,
    }));

    return (
        <main className="mx-auto max-w-6xl px-4 py-8">
            <div className="mb-4 flex items-center justify-between">
                <h1 className="text-2xl font-semibold tracking-tight">Leady</h1>
                <p className="text-sm text-muted-foreground">{rows.length} záznamov</p>
            </div>
            <StatusTabs current={filter} query={q} />
            <LeadsTable rows={rows} />
        </main>
    );
}