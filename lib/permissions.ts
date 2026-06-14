import type { Role } from "@/app/generated/prisma/enums";

// ── Práva (capabilities) ──────────────────────────────────────────────────────
// Kód kontroluje PRÁVA, nie role. Pridať rolu = jeden riadok v matici nižšie.
// Pridať právo = pridať do union + priradiť v matici + vynútiť (route/action/query).
export type Permission =
    | "today.view"
    | "calls.view"
    | "calls.work"
    | "callHistory.access"
    | "callHistory.viewAll"
    | "callHistory.revert"
    | "contacts.access"
    | "contacts.viewAll"
    | "contacts.create"
    | "contacts.deleteOwnUncalled"
    | "contacts.deleteAny"
    | "pipeline.view"
    | "pipeline.manage"
    | "stats.view"
    | "stats.viewAll"
    | "admin.access"
    | "users.manage";

const ALL_PERMISSIONS: Permission[] = [
    "today.view",
    "calls.view",
    "calls.work",
    "callHistory.access",
    "callHistory.viewAll",
    "callHistory.revert",
    "contacts.access",
    "contacts.viewAll",
    "contacts.create",
    "contacts.deleteOwnUncalled",
    "contacts.deleteAny",
    "pipeline.view",
    "pipeline.manage",
    "stats.view",
    "stats.viewAll",
    "admin.access",
    "users.manage",
];

// ── Matica: rola → práva (jediný zdroj pravdy) ────────────────────────────────
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
    // Pridávač kontaktov – vidí len svoje pridané kontakty (kým nie sú obvolané).
    SCOUT: ["today.view", "contacts.access", "contacts.create", "contacts.deleteOwnUncalled"],
    // Marketing / prvotné volanie – rieši calls + vlastnú históriu, môže rýchlo pridať kontakt.
    TELESALES: [
        "today.view",
        "calls.view",
        "calls.work",
        "callHistory.access",
        "callHistory.revert",
        "contacts.create",
    ],
    // Manažér – vidí a rieši všetko okrem admin-only vecí.
    MANAGER: [
        "today.view",
        "calls.view",
        "calls.work",
        "callHistory.access",
        "callHistory.viewAll",
        "callHistory.revert",
        "contacts.access",
        "contacts.viewAll",
        "contacts.create",
        "contacts.deleteOwnUncalled",
        "contacts.deleteAny",
        "pipeline.view",
        "pipeline.manage",
        "stats.view",
        "stats.viewAll",
    ],
    // Admin – úplne všetko.
    ADMIN: ALL_PERMISSIONS,
};

// Prijímame čokoľvek – typy session.user sa medzi NextAuth a našou augmentáciou líšia,
// rolu vytiahneme bezpečne cez narrowing.
type Userish = unknown;

export function roleOf(user: Userish): Role | null {
    const r = (user as { role?: unknown } | null | undefined)?.role;
    if (r === "SCOUT" || r === "TELESALES" || r === "MANAGER" || r === "ADMIN") return r;
    return null;
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

// Spätná kompatibilita pre tracking/pipeline akcie.
export function canManagePipeline(
    user: { id?: string | null; role?: unknown } | null | undefined,
): boolean {
    return Boolean(user?.id) && can(user, "pipeline.manage");
}

// Ktoré právo treba na otvorenie danej cesty (route guard v auth.config).
export function requiredPermissionForPath(path: string): Permission | null {
    if (path.startsWith("/dashboard/calls/history")) return "callHistory.access";
    if (path.startsWith("/dashboard/calls")) return "calls.view";
    if (path.startsWith("/dashboard/pipeline")) return "pipeline.view";
    if (path.startsWith("/dashboard/contacts")) return "contacts.access";
    if (path.startsWith("/dashboard/stats")) return "stats.view";
    if (path.startsWith("/dashboard/admin")) return "admin.access";
    // /dashboard (Dnes) je spoločné – stačí byť prihlásený.
    return null;
}
