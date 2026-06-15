import { auth } from "@/auth";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import MobileNav from "@/components/layout/MobileNav";
import { can, type Permission } from "@/lib/permissions";
import { logout } from "@/lib/actions";
import { LogOut } from "lucide-react";

const NAV: { href: string; label: string; perm: Permission | null }[] = [
    { href: "/dashboard",          label: "Dashboard",  perm: null              },
    { href: "/dashboard/calls",    label: "Volania",    perm: "calls.view"      },
    { href: "/dashboard/pipeline", label: "Pipeline",   perm: "pipeline.view"   },
    { href: "/dashboard/contacts", label: "Kontakty",   perm: "contacts.access" },
    { href: "/dashboard/stats",    label: "Štatistiky", perm: "stats.view"      },
    { href: "/dashboard/admin",    label: "Admin",      perm: "admin.access"    },
];

export default async function Header() {
    const session = await auth();
    const user = session?.user;
    const links = user ? NAV.filter((n) => n.perm === null || can(user, n.perm)) : [];

    const u = user as typeof user & {
        username?: string;
        firstName?: string;
        lastName?: string;
    };

    return (
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">

                {/* ── Left: logo + desktop nav ─────────────────────── */}
                <div className="flex items-center gap-6">
                    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
                        <svg viewBox="0 0 40 50" height="24" fill="none" aria-hidden="true" className="w-auto shrink-0">
                            <path d="M10 8 Q20 2 30 8" stroke="#6366f1" strokeWidth="1.7" strokeLinecap="round"/>
                            <path d="M3 36 L8 36 C5 30 12 20 13 14 Q20 8 27 14 C28 20 35 30 32 36 L37 36" stroke="currentColor" strokeWidth="2.3" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                            <circle cx="20" cy="44" r="3" fill="#6366f1"/>
                        </svg>
                        Zvonček
                    </Link>

                    {user && (
                        <nav className="hidden items-center gap-1 text-sm md:flex">
                            {links.map((link) => (
                                <Button key={link.href} asChild variant="ghost" size="sm">
                                    <Link href={link.href}>{link.label}</Link>
                                </Button>
                            ))}
                        </nav>
                    )}
                </div>

                {/* ── Right ────────────────────────────────────────── */}
                <div className="flex items-center gap-2">
                    {user ? (
                        <>
                            {/* lg+: Michal Chovanec (michal) — plné meno, viditeľné */}
                            <span className="hidden items-center gap-1.5 text-sm lg:inline-flex">
                                <span className="font-medium">{u.firstName} {u.lastName}</span>
                                <span className="font-mono text-xs text-muted-foreground">({u.username})</span>
                            </span>

                            {/* md–lg: len username bez zátvoriek */}
                            <span className="hidden font-mono text-sm text-muted-foreground md:inline lg:hidden">
                                {u.username}
                            </span>

                            {/* Logout — outline vždy; lg+ má text, md- len ikonka */}
                            <form action={logout} className="flex items-center">
                                <Button
                                    type="submit"
                                    variant="outline"
                                    size="sm"
                                    aria-label="Odhlásiť sa"
                                    className="gap-1.5"
                                >
                                    <LogOut className="h-4 w-4 shrink-0" />
                                    <span className="hidden lg:inline">Odhlásiť sa</span>
                                </Button>
                            </form>

                            {/* Mobile burger — flex aby sedel vertikálne */}
                            <div className="flex items-center md:hidden">
                                <MobileNav links={links} />
                            </div>
                        </>
                    ) : (
                        <Button asChild size="sm">
                            <Link href="/login">Prihlásiť sa</Link>
                        </Button>
                    )}
                </div>
            </div>
        </header>
    );
}
