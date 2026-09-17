import Link from "next/link";
import { PIPELINE_VIEWS } from "@/lib/queries/pipeline";

function hrefFor(filter: string, view: string | null, query?: string, owner?: string) {
    const params = new URLSearchParams({ filter });
    if (view) params.set("view", view);
    if (query) params.set("q", query);
    if (owner && owner !== "all") params.set("owner", owner);
    return `/dashboard/pipeline?${params.toString()}`;
}

const PILL_BASE = "rounded-md px-3 py-1.5 text-sm transition-colors";
const PILL_ACTIVE = "bg-background font-medium shadow-sm";
const PILL_IDLE = "text-muted-foreground hover:text-foreground";

function Pill({ href, active, label }: { href: string; active: boolean; label: string }) {
    return (
        <Link href={href} className={`${PILL_BASE} ${active ? PILL_ACTIVE : PILL_IDLE}`}>
            {label}
        </Link>
    );
}

export default function PipelineViewTabs({
    filter,
    view,
    query,
    owner,
    requestCount,
}: {
    filter: string;
    view?: string;
    query?: string;
    owner?: string;
    requestCount: number;
}) {
    const todo = PIPELINE_VIEWS.filter((v) => v.group === "todo");
    const running = PIPELINE_VIEWS.filter((v) => v.group === "running");
    const current = view ?? "";

    return (
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
            {/* Požiadavky platia naprieč stavmi (aj REOPEN na uzavretom obchode). */}
            <Pill
                href={hrefFor("all", "requests", query, owner)}
                active={current === "requests"}
                label={`Požiadavky (${requestCount})`}
            />
            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
            <Pill href={hrefFor(filter === "all" && current === "requests" ? "active" : filter, null, query, owner)} active={current === ""} label="Všetko" />
            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
            {todo.map((v) => (
                <Pill key={v.key} href={hrefFor("active", v.key, query, owner)} active={current === v.key} label={v.label} />
            ))}
            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
            {running.map((v) => (
                <Pill key={v.key} href={hrefFor("active", v.key, query, owner)} active={current === v.key} label={v.label} />
            ))}
        </div>
    );
}
