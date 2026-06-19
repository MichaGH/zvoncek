import { Loader2 } from "lucide-react";

export default function Loading() {
    return (
        <div className="flex min-h-[70vh] flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 text-muted-foreground motion-safe:animate-spin" />
            <span className="sr-only">Načítavam…</span>
        </div>
    );
}
