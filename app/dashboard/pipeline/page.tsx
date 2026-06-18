import Link from "next/link";
import { LeadStatus } from "@/app/generated/prisma/enums";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import PipelineSearch from "@/components/pipeline/PipelineSearch";
import PipelineStatusTabs from "@/components/pipeline/PipelineStatusTabs";
import PipelineTable from "@/components/pipeline/PipelineTable";
import PipelineViewTabs from "@/components/pipeline/PipelineViewTabs";
import { Button } from "@/components/ui/button";
import { getPipelineList, PIPELINE_PAGE_SIZE } from "@/lib/queries/pipeline";

const FILTERS: Record<string, LeadStatus | undefined> = {
    active: "ACTIVE",
    new: "NEW",
    snoozed: "SNOOZED",
    won: "WON",
    lost: "LOST",
    unreachable: "UNREACHABLE",
    all: undefined,
};

export default async function PipelinePage({
    searchParams,
}: {
    searchParams: Promise<{ filter?: string; q?: string; view?: string; limit?: string }>;
}) {
    const { filter = "active", q, view, limit } = await searchParams;
    const parsedLimit = Number(limit);
    const take =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : PIPELINE_PAGE_SIZE;

    // Sekundárny "pohľad" má zmysel len v rámci Aktívnych.
    const showViews = filter === "active";
    const activeView = showViews ? view : undefined;

    const { rows, hasMore } = await getPipelineList({
        status: FILTERS[filter],
        query: q,
        view: activeView,
        take,
    });

    const moreParams = new URLSearchParams({ filter });
    if (q) moreParams.set("q", q);
    if (activeView) moreParams.set("view", activeView);
    moreParams.set("limit", String(take + PIPELINE_PAGE_SIZE));

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Pipeline"
                description="Firmy, ktoré sa posunuli do reálneho riešenia"
                actions={<RefreshButton />}
            >
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <PipelineStatusTabs current={filter} query={q} />
                        <PipelineSearch filter={filter} query={q} view={activeView} />
                    </div>
                    {showViews && <PipelineViewTabs filter={filter} view={activeView} query={q} />}
                </div>
            </DashboardPageHeader>

            <div className="mb-3 text-sm text-muted-foreground">
                {rows.length} {hasMore ? "+ záznamov" : "záznamov"}
            </div>

            <PipelineTable rows={rows} showStatus={filter === "all"} />

            {hasMore && (
                <div className="mt-4 flex justify-center">
                    <Button asChild variant="outline">
                        <Link href={`/dashboard/pipeline?${moreParams.toString()}`}>
                            Načítať ďalších {PIPELINE_PAGE_SIZE}
                        </Link>
                    </Button>
                </div>
            )}
        </DashboardPage>
    );
}
