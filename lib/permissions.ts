import { Role } from "@/app/generated/prisma/enums";

// ── Práva (capabilities) ──────────────────────────────────────────────────────
// Kód kontroluje PRÁVA, nie role. Pridať rolu = jeden riadok v matici nižšie.
// Pridať právo = pridať do union + priradiť v matici + vynútiť (route/action/query).
//
// Tímové varianty (*.viewTeam / *.manageTeam) sú vedomé zúženie *.viewAll: vedúci
// tímu vidí/spravuje len členov SVOJHO tímu (scoping vynútený server-side cez
// getTeamScopeUserIds). Ten istý mechanizmus obslúži budúceho telesales/spoločného
// vedúceho – stačí pridať rolu a priradiť jej existujúce tímové práva.
export type Permission =
    | "today.view"
    | "calls.view"
    | "calls.work"
    | "calls.claim"
    | "calls.assign"
    | "callHistory.access"
    | "callHistory.viewAll"
    | "callHistory.viewTeam"
    | "callHistory.revert"
    | "contacts.access"
    | "contacts.viewAll"
    | "contacts.viewTeam"
    | "contacts.create"
    | "contacts.deleteOwnUncalled"
    | "contacts.deleteAny"
    | "contacts.manageTeam"
    | "clients.view"
    | "clients.work"
    | "deals.receive"
    | "pipeline.view"
    | "pipeline.manage"
    | "requests.resolve"
    | "stats.view"
    | "stats.viewAll"
    | "stats.viewTeam"
    | "teams.manage"
    | "admin.access"
    | "users.manage";

const ALL_PERMISSIONS: Permission[] = [
    "today.view",
    "calls.view",
    "calls.work",
    "calls.claim",
    "calls.assign",
    "callHistory.access",
    "callHistory.viewAll",
    "callHistory.viewTeam",
    "callHistory.revert",
    "contacts.access",
    "contacts.viewAll",
    "contacts.viewTeam",
    "contacts.create",
    "contacts.deleteOwnUncalled",
    "contacts.deleteAny",
    "contacts.manageTeam",
    "clients.view",
    "clients.work",
    "deals.receive",
    "pipeline.view",
    "pipeline.manage",
    "requests.resolve",
    "stats.view",
    "stats.viewAll",
    "stats.viewTeam",
    "teams.manage",
    "admin.access",
    "users.manage",
];

// ── Matica: rola → práva (jediný zdroj pravdy) ────────────────────────────────
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
    // Pridávač kontaktov – vidí len svoje pridané kontakty (kým nie sú obvolané).
    SCOUT: ["today.view", "contacts.access", "contacts.create", "contacts.deleteOwnUncalled"],
    // Vedúci tímu scoutov – vidí a spravuje kontakty/štatistiky SVOJHO tímu.
    // `contacts.manageTeam` je zámerne oddelené: odobrať vedúcemu právo zasahovať
    // do kontaktov tímu = zmazať tento jeden riadok, nič iné sa nemení.
    SCOUT_LEADER: [
        "today.view",
        "contacts.access",
        "contacts.create",
        "contacts.viewTeam",
        "contacts.manageTeam",
        "stats.view",
        "stats.viewTeam",
    ],
    // Marketing / prvotné volanie – rieši calls + vlastnú históriu, môže rýchlo pridať kontakt.
    // Pozitívne hovory odovzdáva (routing cez tím), sám obchody nevlastní.
    TELESALES: [
        "today.view",
        "calls.view",
        "calls.work",
        "calls.claim",
        "callHistory.access",
        "callHistory.revert",
        "contacts.create",
    ],
    // Obchodník – prvé hovory ako TELESALES + follow-upy na VLASTNÝCH obchodoch (/dashboard/clients).
    SALES_REP: [
        "today.view",
        "calls.view",
        "calls.work",
        "calls.claim",
        "callHistory.access",
        "callHistory.revert",
        "contacts.create",
        "clients.view",
        "clients.work",
        "deals.receive",
    ],
    // Manažér – vidí a rieši všetko okrem admin-only vecí.
    MANAGER: [
        "today.view",
        "calls.view",
        "calls.work",
        "calls.claim",
        "calls.assign",
        "callHistory.access",
        "callHistory.viewAll",
        "callHistory.revert",
        "contacts.access",
        "contacts.viewAll",
        "contacts.create",
        "contacts.deleteOwnUncalled",
        "contacts.deleteAny",
        "deals.receive",
        "pipeline.view",
        "pipeline.manage",
        "requests.resolve",
        "stats.view",
        "stats.viewAll",
    ],
    // Admin – úplne všetko.
    ADMIN: ALL_PERMISSIONS,
};

// Prijímame čokoľvek – typy session.user sa medzi NextAuth a našou augmentáciou líšia,
// rolu vytiahneme bezpečne cez narrowing.
type Userish = unknown;

// Enum-driven narrowing: nová hodnota v Role enume je automaticky akceptovaná,
// netreba ju dopisovať sem (jediné bývalé miesto, kde by nová rola potichu prepadla).
const ROLE_VALUES = Object.values(Role) as string[];

export function roleOf(user: Userish): Role | null {
    const r = (user as { role?: unknown } | null | undefined)?.role;
    return typeof r === "string" && ROLE_VALUES.includes(r) ? (r as Role) : null;
}

export function permissionsOf(user: Userish): Permission[] {
    const role = roleOf(user);
    return role ? ROLE_PERMISSIONS[role] : [];
}

export function can(user: Userish, permission: Permission): boolean {
    return permissionsOf(user).includes(permission);
}

export function canAny(user: Userish, permissions: Permission[]): boolean {
    const perms = permissionsOf(user);
    return permissions.some((p) => perms.includes(p));
}

// Ktoré právo treba na otvorenie danej cesty (route guard v auth.config).
export function requiredPermissionForPath(path: string): Permission | null {
    // Špecifickejšie cesty musia byť pred prefixom rodiča.
    if (path.startsWith("/dashboard/calls/history")) return "callHistory.access";
    if (path.startsWith("/dashboard/calls/assignments")) return "calls.assign";
    if (path.startsWith("/dashboard/calls")) return "calls.view";
    if (path.startsWith("/dashboard/pipeline")) return "pipeline.view";
    if (path.startsWith("/dashboard/clients")) return "clients.view";
    if (path.startsWith("/dashboard/contacts/new")) return "contacts.create";
    if (path.startsWith("/dashboard/contacts")) return "contacts.access";
    if (path.startsWith("/dashboard/stats")) return "stats.view";
    if (path.startsWith("/dashboard/admin")) return "admin.access";
    // /dashboard (Dnes) je spoločné – stačí byť prihlásený.
    return null;
}
