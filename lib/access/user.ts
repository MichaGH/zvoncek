import { auth } from "@/auth";
import type { Role } from "@/app/generated/prisma/enums";
import prisma from "@/lib/db";

export type AccessUser = {
    id: string;
    role: Role;
    teamId: string | null;
    firstName: string;
    lastName: string;
    username: string;
};

// Aktuálny používateľ z DB (rola + deaktivácia), nie len z JWT. null = neprihlásený alebo deaktivovaný.
// Rýchla predkontrola bez zámku; operácie závislé od stavu používateľa to overia znova pod zámkom User riadku.
export async function requireUser(): Promise<AccessUser | null> {
    const session = await auth();
    const id = session?.user?.id;
    if (!id) return null;
    return prisma.user.findUnique({
        where: { id, deletedAt: null },
        select: { id: true, role: true, teamId: true, firstName: true, lastName: true, username: true },
    });
}
