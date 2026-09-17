import Link from "next/link";
import { LeadStatus } from "@/app/generated/prisma/enums";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import PipelineOwnerSelect from "@/components/pipeline/PipelineOwnerSelect";
import PipelineSearch from "@/components/pipeline/PipelineSearch";
import PipelineStatusTabs from "@/components/pipeline/PipelineStatusTabs";
import PipelineTable from "@/components/pipeline/PipelineTable";
import PipelineViewTabs from "@/components/pipeline/PipelineViewTabs";
import TransferDealsDialog from "@/components/pipeline/TransferDealsDialog";
import { Button } from "@/components/ui/button";
import {
    getDealOwnerOptions,
    getPipelineCounts,
    getPipelineList,
    PIPELINE_PAGE_SIZE,
} from "@/lib/queries/pipeline";
import { requireUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";
import prisma from "@/lib/db";
import { redirect } from "next/navigation";
import { TriangleAlert } from "lucide-react";

const FILTERS: Record<string, LeadStatus | undefined> = {
    active: "ACTIVE",
    snoozed: "SNOOZED",
    won: "WON",
    lost: "LOST",
    unreachable: "UNREACHABLE",
    all: undefined,
};

export default async function PipelinePage({
    searchParams,
}: {
    searchParams: Promise<{ filter?: string; q?: string; view?: string; limit?: string; owner?: string }>;
}) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "pipeline.view")) redirect("/dashboard");
    const params = await searchParams;
    const filter = params.filter && params.filter in FILTERS ? params.filter : "active";
    const { q, view, limit } = params;
    const owner = params.owner ?? "all";
    const parsedLimit = Number(limit);
    const take =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : PIPELINE_PAGE_SIZE;

    // Sekundárny "pohľad" má zmysel v rámci Aktívnych; Požiadavky platia naprieč stavmi.
    const activeView = view === "requests" || filter === "active" ? view : undefined;

    const [{ rows, hasMore }, counts, owners, callers] = await Promise.all([
        getPipelineList({ status: FILTERS[filter], query: q, view: activeView, owner, viewerId: viewer.id, take }),
        getPipelineCounts(),
        getDealOwnerOptions(),
        prisma.user.findMany({
            where: { handedOffLeads: { some: {} } },
            select: { id: true, firstName: true, lastName: true },
            orderBy: { firstName: "asc" },
        }),
    ]);
    const canManage = can(viewer, "pipeline.manage");

    const moreParams = new URLSearchParams({ filter });
    if (q) moreParams.set("q", q);
    if (activeView) moreParams.set("view", activeView);
    if (owner !== "all") moreParams.set("owner", owner);
    moreParams.set("limit", String(take + PIPELINE_PAGE_SIZE));

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Pipeline"
                description="Obchody po pozitívnom prvom hovore"
                actions={
                    <>
                        {canManage && <TransferDealsDialog owners={owners} callers={callers} />}
                        <RefreshButton />
                    </>
                }
            >
                <div className="flex flex-col gap-3">
                    {counts.unassignedOpen > 0 && (
                        <Link
                            href="/dashboard/pipeline?filter=all&owner=unassigned"
                            className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                        >
                            <TriangleAlert className="h-4 w-4 shrink-0" />
                            {counts.unassignedOpen} {counts.unassignedOpen === 1 ? "obchod nemá" : "obchodov nemá"} vlastníka – priradiť
                        </Link>
                    )}
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <PipelineStatusTabs current={filter} query={q} owner={owner} />
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <PipelineOwnerSelect owner={owner} users={owners} />
                            <PipelineSearch filter={filter} query={q} view={activeView} owner={owner} />
                        </div>
                    </div>
                    <PipelineViewTabs
                        filter={filter}
                        view={activeView}
                        query={q}
                        owner={owner}
                        requestCount={counts.requestDeals}
                    />
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
