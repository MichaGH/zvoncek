import Link from "next/link";

// Stavy obchodov. „Nové" (surové kontakty) už v pipeline nie je – obchod vzniká až pozitívnym hovorom.
const TABS = [
    { key: "active", label: "Aktívne" },
    { key: "snoozed", label: "Spiace" },
    { key: "won", label: "Vyhraté" },
    { key: "lost", label: "Stratené" },
    { key: "unreachable", label: "Nedostupné" },
    { key: "all", label: "Všetky" },
];

export default function PipelineStatusTabs({ current, query, owner }: { current: string; query?: string; owner?: string }) {
    return (
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
            {TABS.map((tab) => {
                const params = new URLSearchParams({ filter: tab.key });
                if (query) params.set("q", query);
                if (owner && owner !== "all") params.set("owner", owner);
                return (
                    <span key={tab.key} className="flex items-center gap-1">
                        {/* „Všetky" je iný druh pohľadu (cez všetky stavy) – oddelíme ho čiarou */}
                        {tab.key === "all" && (
                            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
                        )}
                        <Link
                            href={`/dashboard/pipeline?${params.toString()}`}
                            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                                current === tab.key
                                    ? "bg-background font-medium shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {tab.label}
                        </Link>
                    </span>
                );
            })}
        </div>
    );
}
