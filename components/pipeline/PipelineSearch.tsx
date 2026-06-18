"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function PipelineSearch({
    filter,
    query = "",
    view,
}: {
    filter: string;
    query?: string;
    view?: string;
}) {
    const router = useRouter();
    const [value, setValue] = useState(query);

    function submit(q: string) {
        const params = new URLSearchParams();
        params.set("filter", filter);
        if (view) params.set("view", view);
        if (q.trim()) params.set("q", q.trim());
        // limit intentionally reset on a new search
        router.push(`/dashboard/pipeline?${params.toString()}`);
    }

    return (
        <form
            className="flex w-full items-center gap-2 lg:max-w-xs"
            onSubmit={(event) => {
                event.preventDefault();
                submit(value);
            }}
        >
            <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder="Hľadať firmu, web, telefón…"
                    className="h-10 pl-8 pr-8"
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
            </div>
            <Button type="submit" variant="outline" className="h-10 shrink-0">
                Hľadať
            </Button>
        </form>
    );
}
