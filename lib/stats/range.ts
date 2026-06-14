// Shared date-range handling for the stats pages.
// Presets + a custom "since–to" range, resolved from URL search params.

export type PeriodKey = "today" | "yesterday" | "7d" | "30d" | "90d" | "all" | "custom";

export type DateRange = {
    key: PeriodKey;
    from: Date | null; // inclusive lower bound (gte)
    to: Date | null; // exclusive upper bound (lt)
    label: string;
};

export const PERIOD_PRESETS: { key: Exclude<PeriodKey, "custom">; label: string }[] = [
    { key: "today", label: "Dnes" },
    { key: "yesterday", label: "Včera" },
    { key: "7d", label: "7 dní" },
    { key: "30d", label: "30 dní" },
    { key: "90d", label: "90 dní" },
    { key: "all", label: "Všetko" },
];

export const DEFAULT_PERIOD: PeriodKey = "30d";

function startOfDay(d = new Date()) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function addDays(d: Date, n: number) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

function isValidDate(d: Date) {
    return !Number.isNaN(d.getTime());
}

function fmt(d: Date) {
    return d.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric", year: "numeric" });
}

export function resolveRange(params: {
    period?: string;
    from?: string;
    to?: string;
}): DateRange {
    const today = startOfDay();
    const { period, from, to } = params;

    // Explicit custom range (or bare from/to params) wins.
    if (period === "custom" || from || to) {
        const f = from ? startOfDay(new Date(from)) : null;
        const rawTo = to ? startOfDay(new Date(to)) : null;
        const validFrom = f && isValidDate(f) ? f : null;
        const validTo = rawTo && isValidDate(rawTo) ? addDays(rawTo, 1) : null; // make end inclusive
        return {
            key: "custom",
            from: validFrom,
            to: validTo,
            label: customLabel(validFrom, validTo ? addDays(validTo, -1) : null),
        };
    }

    switch (period) {
        case "today":
            return { key: "today", from: today, to: null, label: "Dnes" };
        case "yesterday":
            return { key: "yesterday", from: addDays(today, -1), to: today, label: "Včera" };
        case "7d":
            return { key: "7d", from: addDays(today, -6), to: null, label: "Posledných 7 dní" };
        case "90d":
            return { key: "90d", from: addDays(today, -89), to: null, label: "Posledných 90 dní" };
        case "all":
            return { key: "all", from: null, to: null, label: "Celé obdobie" };
        case "30d":
        default:
            return { key: "30d", from: addDays(today, -29), to: null, label: "Posledných 30 dní" };
    }
}

function customLabel(from: Date | null, to: Date | null) {
    if (from && to) return `${fmt(from)} – ${fmt(to)}`;
    if (from) return `od ${fmt(from)}`;
    if (to) return `do ${fmt(to)}`;
    return "Celé obdobie";
}

// For prefilling <input type="date"> values (yyyy-mm-dd).
export function toDateInput(d: Date | null): string {
    if (!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
