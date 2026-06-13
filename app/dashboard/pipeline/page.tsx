import { LeadStatus } from "@/app/generated/prisma/enums";
import PipelineStatusTabs from "@/components/pipeline/PipelineStatusTabs";
import PipelineTable from "@/components/pipeline/PipelineTable";
import { getPipelineList } from "@/lib/queries/pipeline";

const FILTERS: Record<string, LeadStatus | undefined> = {
    active: "ACTIVE",
    new: "NEW",
    snoozed: "SNOOZED",
    won: "WON",
    lost: "LOST",
    all: undefined,
};

export default async function PipelinePage({
    searchParams,
}: {
    searchParams: Promise<{ filter?: string; q?: string }>;
}) {
    const { filter = "active", q } = await searchParams;
    const rows = await getPipelineList({ status: FILTERS[filter], query: q });

    return (
        <main className="mx-auto max-w-6xl px-4 py-8">
            <div className="mb-4 flex items-center justify-between">
                <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
                <p className="text-sm text-muted-foreground">{rows.length} záznamov</p>
            </div>
            <PipelineStatusTabs current={filter} query={q} />
            <PipelineTable rows={rows} />
        </main>
    );
}
