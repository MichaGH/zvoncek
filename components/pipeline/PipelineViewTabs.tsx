import Link from "next/link";
import { PIPELINE_VIEWS } from "@/lib/queries/pipeline";

function hrefFor(filter: string, view: string | null, query?: string) {
    const params = new URLSearchParams({ filter });
    if (view) params.set("view", view);
    if (query) params.set("q", query);
    return `/dashboard/pipeline?${params.toString()}`;
}

const PILL_BASE = "rounded-md px-3 py-1.5 text-sm transition-colors";
const PILL_ACTIVE = "bg-background font-medium shadow-sm";
const PILL_IDLE = "text-muted-foreground hover:text-foreground";

export default function PipelineViewTabs({
    filter,
    view,
    query,
}: {
    filter: string;
    view?: string;
    query?: string;
}) {
    const todo = PIPELINE_VIEWS.filter((v) => v.group === "todo");
    const running = PIPELINE_VIEWS.filter((v) => v.group === "running");

    function Pill({ k, label }: { k: string | null; label: string }) {
        const isActive = (k ?? "") === (view ?? "");
        return (
            <Link
                href={hrefFor(filter, k, query)}
                className={`${PILL_BASE} ${isActive ? PILL_ACTIVE : PILL_IDLE}`}
            >
                {label}
            </Link>
        );
    }

    return (
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
            <Pill k={null} label="Všetko" />
            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
            {todo.map((v) => (
                <Pill key={v.key} k={v.key} label={v.label} />
            ))}
            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
            {running.map((v) => (
                <Pill key={v.key} k={v.key} label={v.label} />
            ))}
        </div>
    );
}
