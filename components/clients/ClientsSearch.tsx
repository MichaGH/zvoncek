"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function ClientsSearch({ query = "", archive = false }: { query?: string; archive?: boolean }) {
    const router = useRouter();
    const [value, setValue] = useState(query);

    function submit(q: string) {
        const params = new URLSearchParams();
        if (archive) params.set("archive", "1");
        if (q.trim()) params.set("q", q.trim());
        router.push(`/dashboard/clients${params.size ? `?${params.toString()}` : ""}`);
    }

    return (
        <form
            className="relative w-full sm:w-64"
            onSubmit={(event) => {
                event.preventDefault();
                submit(value);
            }}
        >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Hľadať firmu, web, telefón…"
                className="h-9 pl-8 pr-8"
            />
            {value && (
                <button
                    type="button"
                    aria-label="Vymazať hľadanie"
                    onClick={() => {
                        setValue("");
                        submit("");
                    }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                    <X className="h-4 w-4" />
                </button>
            )}
        </form>
    );
}
