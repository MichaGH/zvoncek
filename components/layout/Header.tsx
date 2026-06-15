import { auth } from "@/auth";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import LogoutButton from "@/components/layout/LogoutButton";
import { can, type Permission } from "@/lib/permissions";

const NAV: { href: string; label: string; perm: Permission | null }[] = [
    { href: "/dashboard", label: "Dashboard", perm: null },
    { href: "/dashboard/calls", label: "Volania", perm: "calls.view" },
    { href: "/dashboard/pipeline", label: "Pipeline", perm: "pipeline.view" },
    { href: "/dashboard/contacts", label: "Kontakty", perm: "contacts.access" },
    { href: "/dashboard/stats", label: "Štatistiky", perm: "stats.view" },
    { href: "/dashboard/admin", label: "Admin", perm: "admin.access" },
];

export default async function Header() {
    const session = await auth();
    const user = session?.user;
    const links = user ? NAV.filter((n) => n.perm === null || can(user, n.perm)) : [];

    return (
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
                <div className="flex items-center gap-6">
                    <Link href="/" className="font-semibold tracking-tight">
                        Zvonček
                    </Link>

                    {user && (
                        <nav className="flex items-center gap-1 text-sm">
                            {links.map((link) => (
                                <Button key={link.href} asChild variant="ghost" size="sm">
                                    <Link href={link.href}>{link.label}</Link>
                                </Button>
                            ))}
                        </nav>
                    )}
                </div>

                <div className="flex items-center gap-3">
                    {user ? (
                        <>
                            <span className="hidden text-sm text-muted-foreground sm:inline">
                                {user.email}
                            </span>
                            <LogoutButton />
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
