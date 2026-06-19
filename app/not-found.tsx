import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
    return (
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="text-5xl font-semibold tracking-tight text-muted-foreground tabular-nums">404</p>
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Stránka sa nenašla</h1>
                <p className="text-sm text-muted-foreground">
                    Táto stránka neexistuje alebo bola presunutá.
                </p>
            </div>
            <Button asChild>
                <Link href="/dashboard">Späť na dashboard</Link>
            </Button>
        </div>
    );
}
