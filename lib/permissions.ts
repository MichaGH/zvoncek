// Single gate for pipeline/tracking management.
// Today: any logged-in user can manage. When MEMBER/MANAGER/ADMIN roles go live,
// tighten the rule HERE instead of at every call site.

type SessionUserish = { id?: string | null; role?: unknown } | null | undefined;

export function canManagePipeline(user: SessionUserish): boolean {
    if (!user?.id) return false;
    // TODO(roles): return user.role === "MANAGER" || user.role === "ADMIN";
    return true;
}
