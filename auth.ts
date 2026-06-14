import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config";
import { z } from "zod";
import prisma from "./lib/db";
import bcrypt from "bcrypt";
import { usernameSchema } from "./lib/domain/validation";

async function getUser(username: string) {
    try {
        const user = await prisma.user.findUnique({
            where: {
                username,
            },
            select: {
                id: true,
                email: true,
                username: true,
                password: true,
                role: true,
            },
        });

        return user;
    } catch (error) {
        console.error("Failed to fetch user: ", error);
        throw new Error("Failed to fetch user.");
    }
}

export const { auth, signIn, signOut } = NextAuth({
    ...authConfig,
    providers: [
        Credentials({
            async authorize(credentials) {
                const parsedCredentials = z
                    .object({
                        username: usernameSchema,
                        password: z.string().min(6),
                    })
                    .safeParse(credentials);

                if (parsedCredentials.success) {
                    const { username, password } = parsedCredentials.data;
                    const user = await getUser(username);
                    if (!user) return null;
                    const passwordsMatch = await bcrypt.compare(
                        password,
                        user.password,
                    );

                    if (passwordsMatch) {
                        // password von zo session objektu
                        const { password: passwordHash, ...safeUser } = user;
                        void passwordHash;
                        return safeUser;
                    }

                    /* if(passwordsMatch) return user bolo pôvodne */
                }

                console.log("Invalid Credentials");
                return null;
            },
        }),
    ],
});
