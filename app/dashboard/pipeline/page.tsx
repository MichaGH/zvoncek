import Link from "next/link";
import { redirect } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import DealFilters from "@/components/pipeline/DealFilters";
import DealList from "@/components/pipeline/DealList";
import TransferDealsDialog from "@/components/pipeline/TransferDealsDialog";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/access/user";
import { dealCapabilities } from "@/lib/domain/dealCapabilities";
import {
    dealsHref,
    parseDealParams,
    requestKindOf,
    statusOf,
    viewOf,
    type DealFilterParams,
} from "@/lib/domain/dealFilters";
import { ownerFilterParam, resolveOwnerFilter } from "@/lib/domain/dealScope";
import { can } from "@/lib/permissions";
import prisma from "@/lib/db";
import {
    DEAL_PAGE_SIZE,
    getDealCounts,
    getDealList,
    getDealOwnerOptions,
    getDealScope,
    getHandoffOptions,
} from "@/lib/queries/pipeline";

// Jedna obrazovka obchodov pre obchodníka aj manažéra (round 2, D-01). Rozsah rieši dealScope() na serveri,
// rola mení len ponuku filtrov a ovládacie prvky.

export default async function DealsPage({
    searchParams,
}: {
    searchParams: Promise<{ filter?: string; view?: string; owner?: string; q?: string; from?: string; kind?: string; limit?: string }>;
}) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "deals.view")) redirect("/dashboard");

    const raw = parseDealParams(await searchParams);
    const caps = dealCapabilities(viewer);
    const scope = await getDealScope(viewer);
    const ownerFilter = resolveOwnerFilter(raw.owner, viewer, scope);
    // Parametre normalizujeme na to, čo server naozaj použil – odkazy potom nikdy neukazujú niečo iné než zoznam.
    const params: DealFilterParams = { ...raw, owner: ownerFilterParam(ownerFilter, viewer.id) };
    const take = params.limit ?? DEAL_PAGE_SIZE;

    const [{ rows, hasMore }, counts, owners, handoffs, callers] = await Promise.all([
        getDealList({
            scope,
            owner: ownerFilter,
            status: statusOf(params),
            view: viewOf(params),
            query: params.q,
            handedOffBy: params.from,
            requestKind: requestKindOf(params),
            take,
        }),
        getDealCounts({ scope, owner: ownerFilter, handedOffBy: params.from }),
        caps.seeOthers ? getDealOwnerOptions(scope) : Promise.resolve([]),
        caps.seeOthers ? getHandoffOptions(scope) : Promise.resolve([]),
        caps.transferDeals
            ? prisma.user.findMany({
                  where: { handedOffLeads: { some: {} } },
                  select: { id: true, firstName: true, lastName: true },
                  orderBy: { firstName: "asc" },
              })
            : Promise.resolve([]),
    ]);

    const showOwner = caps.seeOthers && ownerFilter === "all";

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Pipeline"
                description={`${counts.open} otvorených · ${counts.today} na dnes${counts.requests ? ` · ${counts.requests} požiadaviek` : ""}`}
                actions={
                    <>
                        {caps.transferDeals && <TransferDealsDialog owners={owners} callers={callers} />}
                        <RefreshButton />
                    </>
                }
            >
                <div className="flex flex-col gap-3">
                    {caps.manage && counts.unassignedOpen > 0 && (
                        <Link
                            href={dealsHref(params, { filter: "all", view: "all", owner: "unassigned" })}
                            className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                        >
                            <TriangleAlert className="h-4 w-4 shrink-0" />
                            {counts.unassignedOpen} {counts.unassignedOpen === 1 ? "obchod nemá" : "obchodov nemá"} vlastníka – priradiť
                        </Link>
                    )}
                    <DealFilters
                        params={params}
                        counts={{ today: counts.today, requests: counts.requests }}
                        owners={owners}
                        handoffs={handoffs}
                        showOwner={caps.seeOthers}
                        showRequests={caps.resolveRequests || caps.createRequests}
                        showLegacy={caps.manage}
                    />
                </div>
            </DashboardPageHeader>

            <div className="mb-3 text-sm text-muted-foreground">
                {rows.length} {hasMore ? "+ záznamov" : "záznamov"}
            </div>

            <DealList rows={rows} caps={caps} showStatus={params.filter === "all"} showOwner={showOwner} />

            {hasMore && (
                <div className="mt-4 flex justify-center">
                    <Button asChild variant="outline">
                        <Link href={dealsHref(params, { limit: take + DEAL_PAGE_SIZE })}>Načítať ďalších {DEAL_PAGE_SIZE}</Link>
                    </Button>
                </div>
            )}
        </DashboardPage>
    );
}
