"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Po", "Ut", "St", "Št", "Pi", "So", "Ne"];

function key(year: number, month: number, day: number): string {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export default function TodayCalendar({
    counts,
    todayKey,
}: {
    counts: Record<string, number>;
    todayKey: string;
}) {
    const [today] = todayKey.split("T");
    const initial = new Date(`${today}T00:00:00`);
    const [view, setView] = useState({ year: initial.getFullYear(), month: initial.getMonth() });

    const firstOfMonth = new Date(view.year, view.month, 1);
    // Monday-first: JS getDay() has Sunday = 0.
    const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
    const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();

    const monthLabel = firstOfMonth.toLocaleDateString("sk-SK", { month: "long", year: "numeric" });

    function shift(delta: number) {
        setView((v) => {
            const d = new Date(v.year, v.month + delta, 1);
            return { year: d.getFullYear(), month: d.getMonth() };
        });
    }

    const cells: (number | null)[] = [
        ...Array.from({ length: leadingBlanks }, () => null),
        ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ];

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <span className="text-sm font-medium capitalize">{monthLabel}</span>
                <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => shift(-1)} aria-label="Predošlý mesiac">
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => shift(1)} aria-label="Ďalší mesiac">
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
                {WEEKDAYS.map((d) => (
                    <div key={d} className="py-1 font-medium">
                        {d}
                    </div>
                ))}

                {cells.map((day, i) => {
                    if (day === null) return <div key={`b-${i}`} />;
                    const k = key(view.year, view.month, day);
                    const count = counts[k] ?? 0;
                    const isToday = k === todayKey;
                    const isPast = k < todayKey;
                    const overdue = count > 0 && isPast;

                    return (
                        <div
                            key={k}
                            title={count > 0 ? `${count} naplánovaných` : undefined}
                            className={cn(
                                "relative flex aspect-square flex-col items-center justify-center rounded-md text-sm",
                                isToday && "ring-2 ring-primary ring-offset-1 ring-offset-background font-semibold",
                                count > 0 && !overdue && "bg-primary/10 font-medium text-foreground",
                                overdue && "bg-destructive/10 font-medium text-destructive",
                                count === 0 && !isToday && "text-muted-foreground",
                            )}
                        >
                            {day}
                            {count > 0 && (
                                <span
                                    className={cn(
                                        "absolute bottom-1 h-1.5 w-1.5 rounded-full",
                                        overdue ? "bg-destructive" : "bg-primary",
                                    )}
                                />
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-primary" /> naplánované
                </span>
                <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-destructive" /> po termíne
                </span>
            </div>
        </div>
    );
}
