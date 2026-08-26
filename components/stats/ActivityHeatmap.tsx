"use client";

import type { DailyCount } from "@/lib/queries/stats";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

// GitHub-štýl heatmapa: stĺpce = týždne (Po–Ne), farba = intenzita v daný deň.
// Bunky majú shadcn Tooltip (počet + dátum). Šírka podľa obsahu (w-fit), aby sa
// nenaťahovala na celú kartu.

type Palette = "emerald" | "sky";

const PALETTES: Record<Palette, string[]> = {
    // index 0 = žiadna aktivita, 1..4 = rastúca intenzita (funguje v light aj dark)
    emerald: [
        "bg-muted",
        "bg-emerald-200 dark:bg-emerald-900",
        "bg-emerald-300 dark:bg-emerald-700",
        "bg-emerald-500 dark:bg-emerald-500",
        "bg-emerald-600 dark:bg-emerald-300",
    ],
    sky: [
        "bg-muted",
        "bg-sky-200 dark:bg-sky-900",
        "bg-sky-300 dark:bg-sky-700",
        "bg-sky-500 dark:bg-sky-500",
        "bg-sky-600 dark:bg-sky-300",
    ],
};

const WEEKDAY_LABELS = ["Po", "Ut", "St", "Št", "Pi", "So", "Ne"];
const MONTHS_SK = ["jan", "feb", "mar", "apr", "máj", "jún", "júl", "aug", "sep", "okt", "nov", "dec"];

const CELL = 16; // px – väčšie bunky
const GAP = 3; // px
const LABEL_W = 26; // px – stĺpec s popiskami dní

function parseKey(key: string) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function humanDate(key: string) {
    return parseKey(key).toLocaleDateString("sk-SK", {
        weekday: "long",
        day: "numeric",
        month: "long",
    });
}

// Po=0 … Ne=6 (getDay: Ne=0)
function weekdayIndex(key: string) {
    return (parseKey(key).getDay() + 6) % 7;
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export default function ActivityHeatmap({
    data,
    palette = "emerald",
    noun = "pridané",
    label,
}: {
    data: DailyCount[];
    palette?: Palette;
    noun?: string;
    label?: string;
}) {
    const classes = PALETTES[palette];
    const max = data.reduce((m, d) => Math.max(m, d.count), 0);
    const total = data.reduce((s, d) => s + d.count, 0);

    const levelOf = (count: number) => {
        if (count <= 0 || max <= 0) return 0;
        return Math.min(4, Math.ceil((count / max) * 4));
    };

    // Prázdne bunky na začiatku, aby prvý stĺpec začínal v pondelok, potom po týždňoch.
    const leading = data.length > 0 ? weekdayIndex(data[0].date) : 0;
    const cells: (DailyCount | null)[] = [...Array(leading).fill(null), ...data];
    const weeks = chunk(cells, 7);

    // Popisok mesiaca nad stĺpcom, kde sa mesiac mení.
    const weekMonths = weeks.map((week) => {
        const firstReal = week.find((c): c is DailyCount => c !== null);
        return firstReal ? parseKey(firstReal.date).getMonth() : null;
    });
    const monthLabels = weekMonths.map((month, index) => {
        if (month === null) return "";
        const previousMonth = weekMonths
            .slice(0, index)
            .reduce<number | null>((previous, value) => value ?? previous, null);
        return month !== previousMonth ? MONTHS_SK[month] : "";
    });

    return (
        <TooltipProvider delayDuration={100}>
        <div className="w-fit max-w-full overflow-x-auto">
            {label && <p className="mb-2 text-sm text-muted-foreground">{label}</p>}

            <div className="flex flex-col" style={{ gap: GAP }}>
                {/* Riadok mesiacov */}
                <div className="flex text-[10px] leading-none text-muted-foreground" style={{ gap: GAP, height: 12 }}>
                    <div style={{ width: LABEL_W }} />
                    {weeks.map((_, wi) => (
                        <div key={wi} className="relative" style={{ width: CELL }}>
                            {monthLabels[wi] && (
                                <span className="absolute left-0 top-0 whitespace-nowrap">
                                    {monthLabels[wi]}
                                </span>
                            )}
                        </div>
                    ))}
                </div>

                {/* Popisky dní + stĺpce týždňov */}
                <div className="flex" style={{ gap: GAP }}>
                    <div className="flex flex-col" style={{ gap: GAP, width: LABEL_W }}>
                        {WEEKDAY_LABELS.map((w, i) => (
                            <span
                                key={w}
                                className="flex items-center text-[10px] leading-none text-muted-foreground"
                                style={{ height: CELL }}
                            >
                                {i % 2 === 0 ? w : ""}
                            </span>
                        ))}
                    </div>

                    {weeks.map((week, wi) => (
                        <div key={wi} className="flex flex-col" style={{ gap: GAP }}>
                            {Array.from({ length: 7 }).map((_, di) => {
                                const cell = week[di] ?? null;
                                if (!cell) {
                                    return <div key={di} style={{ width: CELL, height: CELL }} />;
                                }
                                return (
                                    <Tooltip key={di}>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                aria-label={`${cell.count} ${noun} · ${humanDate(cell.date)}`}
                                                className={`rounded-[3px] ${classes[levelOf(cell.count)]}`}
                                                style={{ width: CELL, height: CELL }}
                                            />
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            {`${cell.count} ${noun} · ${humanDate(cell.date)}`}
                                        </TooltipContent>
                                    </Tooltip>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>

            {/* Legenda */}
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                    {total} {noun} spolu
                </span>
                <span className="ml-auto">Menej</span>
                {classes.map((c, i) => (
                    <span key={i} className={`rounded-[3px] ${c}`} style={{ width: 12, height: 12 }} />
                ))}
                <span>Viac</span>
            </div>
        </div>
        </TooltipProvider>
    );
}
