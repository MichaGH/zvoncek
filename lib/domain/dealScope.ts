import type { Prisma } from "@/app/generated/prisma/client";
import type { AccessUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";

// JEDINÉ miesto, kde sa rozhoduje „ktoré obchody používateľ vidí". Rozsah sa odvodzuje z práv, nikdy z URL.
// Filter `?owner=` vyberá LEN v rámci tohto rozsahu (resolveOwnerFilter nižšie), takže podstrčené id nič neotvorí.
// Nová rola (napr. vedúci obchodného tímu) = jedna vetva tu + jeden riadok v matici práv, nie nová stránka.

export type DealScope =
    | { kind: "all" }
    | { kind: "team"; teamId: string; userIds: string[] }
    | { kind: "own"; userId: string };

type Viewer = Pick<AccessUser, "id" | "role" | "teamId">;

// teamUserIds sa načítava len ak je rozsah tímový (volajúci ho dodá; getDealScope v lib/queries/pipeline dotiahne členov tímu).
export function dealScope(viewer: Viewer, teamUserIds?: string[]): DealScope {
    if (can(viewer, "deals.viewAll")) return { kind: "all" };
    if (can(viewer, "deals.viewTeam") && viewer.teamId) {
        const ids = teamUserIds ?? [viewer.id];
        return { kind: "team", teamId: viewer.teamId, userIds: ids.includes(viewer.id) ? ids : [...ids, viewer.id] };
    }
    return { kind: "own", userId: viewer.id };
}

// Povinná časť `where` pre KAŽDÝ zoznam aj detail obchodu.
export function scopeWhere(scope: DealScope): Prisma.LeadWhereInput {
    switch (scope.kind) {
        case "all":
            return {};
        case "team":
            return { ownerId: { in: scope.userIds } };
        case "own":
            return { ownerId: scope.userId };
    }
}

export type OwnerFilter = "all" | "unassigned" | { userId: string };

// Preloží hodnotu z URL na filter v rámci rozsahu. Čokoľvek mimo rozsahu spadne na „moje" – bez chyby,
// aby sa stará/podstrčená URL správala ako predvolený pohľad, nie ako 403 hádanka.
export function resolveOwnerFilter(raw: string | undefined, viewer: Viewer, scope: DealScope): OwnerFilter {
    const value = raw && raw.length > 0 ? raw : "me";
    if (scope.kind === "own") return { userId: viewer.id };
    if (value === "me") return { userId: viewer.id };
    if (value === "all") return "all";
    if (value === "unassigned") return scope.kind === "all" ? "unassigned" : { userId: viewer.id };
    if (scope.kind === "team" && !scope.userIds.includes(value)) return { userId: viewer.id };
    return { userId: value };
}

export function ownerFilterWhere(filter: OwnerFilter): Prisma.LeadWhereInput {
    if (filter === "all") return {};
    if (filter === "unassigned") return { ownerId: null };
    return { ownerId: filter.userId };
}

// Hodnota pre URL (aby si stránka vedela postaviť odkazy „načítať ďalších" a pod.).
export function ownerFilterParam(filter: OwnerFilter, viewerId: string): string {
    if (filter === "all") return "all";
    if (filter === "unassigned") return "unassigned";
    return filter.userId === viewerId ? "me" : filter.userId;
}
