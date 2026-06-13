import prisma from "@/lib/db";

export async function getLeadDetail(id: string) {
    const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
            owner: { select: { id: true, firstName: true, lastName: true } },
            activities: {
                orderBy: { createdAt: "desc" },
                include: { user: { select: { firstName: true } } },
            },
        },
    });
    if (!lead) return null;

    // serializácia pre klienta: Date → string, Decimal → number
    return {
        ...lead,
        price: lead.price ? Number(lead.price) : null,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        quoteSentAt: lead.quoteSentAt?.toISOString() ?? null,
        designSentAt: lead.designSentAt?.toISOString() ?? null,
        aboutUsSentAt: lead.aboutUsSentAt?.toISOString() ?? null,
        createdAt: lead.createdAt.toISOString(),
        updatedAt: lead.updatedAt.toISOString(),
        activities: lead.activities.map((a) => ({
            id: a.id,
            type: a.type,
            outcome: a.outcome,
            note: a.note,
            userName: a.user.firstName,
            createdAt: a.createdAt.toISOString(),
        })),
    };
}

export type LeadDetailData = NonNullable<Awaited<ReturnType<typeof getLeadDetail>>>;
export type LeadActivity = LeadDetailData["activities"][number];

export async function getUsers() {
    return prisma.user.findMany({
        select: { id: true, firstName: true, lastName: true },
        orderBy: { firstName: "asc" },
    });
}


export type UserOption = Awaited<ReturnType<typeof getUsers>>[number];


/* 
! getUsers() vráti promise:
Promise<
  {
    id: string;
    firstName: string;
    lastName: string;
  }[]
>


!takže ReturnType<typeof getUsers> znamená presne tento typ
  Promise<
  {
    id: string;
    firstName: string;
    lastName: string;
  }[]
>

!awaited dá preč promise
!Awaited<ReturnType<typeof getUsers>>
{
  id: string;
  firstName: string;
  lastName: string;
}[]

!Awaited<ReturnType<typeof getUsers>>[number]
!dá preč

export type UserOption = {
    id: string;
    firstName: string;
    lastName: string;
} 
    


! export type LeadDetailData = NonNullable<Awaited<ReturnType<typeof getLeadDetail>>>;
to isté, ale nesmie byť null!
*/