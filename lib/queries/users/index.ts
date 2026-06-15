import prisma from "@/lib/db";

export async function getUserOptions() {
    return prisma.user.findMany({
        where: { deletedAt: null },
        select: { id: true, firstName: true, lastName: true },
        orderBy: { firstName: "asc" },
    });
}

export type UserOptions = Awaited<ReturnType<typeof getUserOptions>>;
export type UserOption = UserOptions[number];

// ── Admin queries ──────────────────────────────────────────────────────────────

export async function getAdminUserList() {
    return prisma.user.findMany({
        select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
            email: true,
            phone: true,
            role: true,
            emailVerifiedAt: true,
            phoneVerifiedAt: true,
            deletedAt: true,
            lastLoginAt: true,
            createdAt: true,
        },
        orderBy: [{ deletedAt: "asc" }, { firstName: "asc" }],
    });
}

export type AdminUserRow = Awaited<ReturnType<typeof getAdminUserList>>[number];

export async function getAdminUserDetail(id: string) {
    return prisma.user.findUnique({
        where: { id },
        select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
            email: true,
            phone: true,
            role: true,
            note: true,
            emailVerifiedAt: true,
            phoneVerifiedAt: true,
            deletedAt: true,
            lastLoginAt: true,
            createdAt: true,
        },
    });
}

export type AdminUserDetail = NonNullable<Awaited<ReturnType<typeof getAdminUserDetail>>>;

// Pre štatistiky – kolko userov podla role
export async function getAdminUserStats() {
    const [total, active, byRole] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { deletedAt: null } }),
        prisma.user.groupBy({ by: ["role"], where: { deletedAt: null }, _count: true }),
    ]);
    return { total, active, byRole };
}
