"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-4 text-center">
            <TriangleAlert className="h-10 w-10 text-destructive" />
            <div className="space-y-1">
                <h1 className="text-lg font-semibold">Niečo sa pokazilo</h1>
                <p className="text-sm text-muted-foreground">
                    Skús to znova. Ak problém pretrváva, obnov stránku.
                </p>
            </div>
            <Button onClick={reset}>Skúsiť znova</Button>
        </div>
    );
}
