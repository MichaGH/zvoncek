import Link from "next/link";

const TABS = [
    { key: "active", label: "Aktívne" },
    { key: "new", label: "Nové" },
    { key: "snoozed", label: "Odložené" },
    { key: "won", label: "Vyhrané" },
    { key: "lost", label: "Stratené" },
    { key: "unreachable", label: "Nedostupné" },
    { key: "all", label: "Všetky" },
];

export default function PipelineStatusTabs({ current, query }: { current: string; query?: string }) {
    return (
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
            {TABS.map((tab) => {
                const params = new URLSearchParams({ filter: tab.key });
                if (query) params.set("q", query);
                return (
                    <Link
                        key={tab.key}
                        href={`/dashboard/pipeline?${params.toString()}`}
                        className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                            current === tab.key
                                ? "bg-background font-medium shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </div>
    );
}
