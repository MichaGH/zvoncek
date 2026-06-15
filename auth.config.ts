import type { NextAuthConfig } from "next-auth";
import { can, requiredPermissionForPath } from "@/lib/permissions";

export const authConfig = {
    pages: {
        signIn: "/login",
    },
    callbacks: {
        authorized({ auth, request: { nextUrl } }) {
            const isLoggedIn = !!auth?.user;
            const path = nextUrl.pathname;
            const isOnDashboard = path.startsWith("/dashboard");
            const isOnAuthPage = ["/login", "/signup"].includes(path);

            if (isOnDashboard) {
                if (!isLoggedIn) return false; // dashboard len pre prihlásených
                // Route-level guard: ak na danú stránku rola nemá právo, presmeruj na Dnes.
                const perm = requiredPermissionForPath(path);
                if (perm && !can(auth!.user, perm)) {
                    return Response.redirect(new URL("/dashboard", nextUrl));
                }
                return true;
            }
            if (isOnAuthPage && isLoggedIn) {
                return Response.redirect(new URL("/dashboard", nextUrl)); // prihlásený nemá čo robiť na login/signup
            }
            return true; // všetko ostatné je verejné
        },
        jwt({ token, user }) {
            // user existuje len pri logine – vtedy si z neho zoberieme čo treba
            if (user) {
                const authUser = user as typeof user & {
                    role?: unknown;
                    username?: unknown;
                    firstName?: unknown;
                    lastName?: unknown;
                };
                token.id = user.id;
                if (typeof authUser.role === "string") token.role = authUser.role;
                if (typeof authUser.username === "string") token.username = authUser.username;
                if (typeof authUser.firstName === "string") token.firstName = authUser.firstName;
                if (typeof authUser.lastName === "string") token.lastName = authUser.lastName;
            }
            return token;
        },
        session({ session, token }) {
            if (token.id) session.user.id = token.id as string;
            const sessionUser = session.user as typeof session.user & {
                role?: unknown;
                username?: unknown;
                firstName?: unknown;
                lastName?: unknown;
            };
            sessionUser.role = token.role;
            sessionUser.username = token.username;
            sessionUser.firstName = token.firstName;
            sessionUser.lastName = token.lastName;
            return session;
        },
    },
    providers: [], // Add providers with an empty array for now
} satisfies NextAuthConfig;
