"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PERIOD_PRESETS, type PeriodKey } from "@/lib/stats/range";

export default function StatsPeriodPicker({
    current,
    userId,
    from,
    to,
}: {
    current: PeriodKey;
    userId?: string;
    from: string;
    to: string;
}) {
    const router = useRouter();
    const [customFrom, setCustomFrom] = useState(from);
    const [customTo, setCustomTo] = useState(to);

    function push(params: Record<string, string | undefined>) {
        const sp = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value) sp.set(key, value);
        }
        if (userId) sp.set("userId", userId);
        router.push(`/dashboard/stats?${sp.toString()}`);
    }

    return (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
                {PERIOD_PRESETS.map((preset) => (
                    <button
                        key={preset.key}
                        onClick={() => push({ period: preset.key })}
                        className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                            current === preset.key
                                ? "bg-background font-medium shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {preset.label}
                    </button>
                ))}
            </div>

            <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    push({ period: "custom", from: customFrom, to: customTo });
                }}
            >
                <Input
                    type="date"
                    value={customFrom}
                    onChange={(event) => setCustomFrom(event.target.value)}
                    className="w-auto"
                    aria-label="Od dátumu"
                />
                <span className="text-muted-foreground">–</span>
                <Input
                    type="date"
                    value={customTo}
                    onChange={(event) => setCustomTo(event.target.value)}
                    className="w-auto"
                    aria-label="Do dátumu"
                />
                <Button
                    type="submit"
                    size="sm"
                    variant={current === "custom" ? "default" : "outline"}
                    disabled={!customFrom && !customTo}
                >
                    Použiť
                </Button>
            </form>
        </div>
    );
}
