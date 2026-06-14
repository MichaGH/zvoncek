"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ContactsSearch({ query = "" }: { query?: string }) {
    const router = useRouter();
    const [value, setValue] = useState(query);

    function submit(q: string) {
        const params = new URLSearchParams();
        if (q.trim()) params.set("q", q.trim());
        router.push(`/dashboard/contacts?${params.toString()}`);
    }

    return (
        <form
            className="flex w-full max-w-sm items-center gap-2"
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
                    className="pl-8"
                />
                {value && (
                    <button
                        type="button"
                        aria-label="Vymazať hľadanie"
                        onClick={() => {
                            setValue("");
                            submit("");
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                )}
            </div>
            <Button type="submit" size="sm" variant="outline">
                Hľadať
            </Button>
        </form>
    );
}
