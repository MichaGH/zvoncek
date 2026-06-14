import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
    label,
    value,
    hint,
    className,
}: {
    label: string;
    value: React.ReactNode;
    hint?: React.ReactNode;
    className?: string;
}) {
    return (
        <Card className={cn("gap-0", className)}>
            <CardContent className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                </p>
                <p className="text-2xl font-semibold tabular-nums">{value}</p>
                {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            </CardContent>
        </Card>
    );
}

export function StatBar({
    label,
    count,
    total,
    accent,
}: {
    label: string;
    count: number;
    total: number;
    accent?: "good" | "bad" | "muted";
}) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const barColor =
        accent === "good"
            ? "bg-emerald-500"
            : accent === "bad"
              ? "bg-destructive"
              : "bg-foreground/70";
    return (
        <div className="space-y-1">
            <div className="flex items-baseline justify-between text-sm">
                <span>{label}</span>
                <span className="text-muted-foreground tabular-nums">
                    {count}
                    <span className="ml-1.5 text-xs">{pct}%</span>
                </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}
