import LoginForm from "@/components/layout/LoginForm"
import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4">
      <LoginForm />
      <p className="mt-4 text-center text-sm text-muted-foreground">
        Nemáš účet?{" "}
        <Link href="/signup" className="font-medium text-foreground underline underline-offset-4 hover:no-underline">
          Zaregistruj sa
        </Link>
      </p>
    </main>
  );
}