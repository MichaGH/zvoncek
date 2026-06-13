import { auth } from "@/auth";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import LogoutButton from "@/components/layout/LogoutButton";

export default async function Header() {
  const session = await auth();

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight">
            Zvonček
          </Link>

          {session?.user && (
            <nav className="flex items-center gap-1 text-sm">
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard">Dnes</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/calls">Volania</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/pipeline">Pipeline</Link>
              </Button>
            </nav>
          )}
        </div>

        <div className="flex items-center gap-3">
          {session?.user ? (
            <>
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {session.user.email}
              </span>
              <LogoutButton />
            </>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Prihlásiť sa</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/signup">Registrovať sa</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
