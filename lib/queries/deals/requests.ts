import type { Prisma } from "@/app/generated/prisma/client";
import type { AccessUser } from "@/lib/access/user";
import { scopeWhere, type DealScope } from "@/lib/domain/dealScope";
import { can } from "@/lib/permissions";

// JEDNA definícia „ktoré požiadavky ma zaujímajú". Dnes: kto ich vybavuje, vidí všetky otvorené v svojom rozsahu;
// ostatní vidia tie, ktoré sami podali. Keď pribudne vývojár alebo vedúci tímu (round 2, D-15), rozšíri sa
// o adresáta (`toRole` / `toUserId`) TU – volajúci (pilulka „Požiadavky", dashboard) sa nemenia.
export function openRequestsWhere(
    viewer: Pick<AccessUser, "id" | "role">,
    scope: DealScope,
): Prisma.DealRequestWhereInput {
    const lead: Prisma.LeadWhereInput = { deletedAt: null, ...scopeWhere(scope) };
    return {
        status: "OPEN",
        lead,
        ...(can(viewer, "requests.resolve") ? {} : { createdById: viewer.id }),
    };
}
