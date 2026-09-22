import LoginForm from "@/components/layout/LoginForm"
import Link from "next/link";
import { Suspense } from "react";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ deactivated?: string }> }) {
  const { deactivated } = await searchParams;
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4">
      {deactivated && (
        <p className="mb-4 max-w-sm rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-center text-sm text-destructive">
          Tento účet už nemá prístup. Prihlás sa iným účtom alebo kontaktuj administrátora.
        </p>
      )}
      <Suspense fallback={<div className="h-96 w-full max-w-sm rounded-xl border" />}>
        <LoginForm />
      </Suspense>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        Nemáš účet?{" "}
        <Link href="/signup" className="font-medium text-foreground underline underline-offset-4 hover:no-underline">
          Zaregistruj sa
        </Link>
      </p>
    </main>
  );
}
