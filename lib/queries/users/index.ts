import prisma from "@/lib/db";

export async function getUserOptions() {
    return prisma.user.findMany({
        select: {
            id: true,
            firstName: true,
            lastName: true,
        },
        orderBy: {
            firstName: "asc",
        },
    });
}

export type UserOptions = Awaited<ReturnType<typeof getUserOptions>>;
export type UserOption = UserOptions[number];