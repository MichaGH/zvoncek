"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function RefreshButton({ label = "Obnoviť" }: { label?: string }) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    return (
        <Button
            variant="outline"
            size="sm"
            onClick={() => startTransition(() => router.refresh())}
            disabled={isPending}
        >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
            {label}
        </Button>
    );
}
