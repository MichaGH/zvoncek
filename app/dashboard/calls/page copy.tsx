/* import { getCallsBoard } from "@/lib/queries/calls";
import CallQueue from "@/components/calls/CallQueue";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { History } from "lucide-react";

export default async function CallsPage() {
    const board = await getCallsBoard();
    return (
        <main className="mx-auto max-w-4xl px-4 py-6">
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">Volania</h1>
                    <p className="text-sm text-muted-foreground">Prvý kontakt s firmami</p>
                </div>
                <Button asChild variant="outline" size="sm">
                    <Link href="/dashboard/calls/history"><History className="mr-1.5 h-4 w-4" />História</Link>
                </Button>
            </div>
            <CallQueue board={board} />
        </main>
    );
} */