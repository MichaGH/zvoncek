import { redirect } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RecycleFilters from "@/components/admin/recycle/RecycleFilters";
import RecyclePanel from "@/components/admin/recycle/RecyclePanel";
import { requireUser } from "@/lib/access/user";
import { parseRecycleParams, recycleHref } from "@/lib/domain/recycling";
import { can } from "@/lib/permissions";
import { getRecycleCounts, getRecycleHeader, getRecycleHolders, getRecycleList } from "@/lib/queries/recycling";

// Recyklácia kontaktov (feature 02, spec §8): skončené / zaseknuté kontakty späť do spoločnej fronty ako nové.
// Proxy pustí /dashboard/admin len s admin.access; samotnú recykláciu stráži contacts.recycle (stránka aj príkaz).
export default async function RecyclePage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "admin.access") || !can(viewer, "contacts.recycle")) redirect("/dashboard");

    const params = parseRecycleParams(await searchParams);
    const [list, counts, holders, header] = await Promise.all([
        getRecycleList(params),
        getRecycleCounts(params),
        getRecycleHolders(params),
        getRecycleHeader(),
    ]);
    // Výber prežije stránkovanie, nie zmenu filtra (spec §8).
    const selectionKey = recycleHref(params, { page: 1 });

    return (
        <DashboardPage className="max-w-7xl">
            <DashboardPageHeader
                title="Recyklácia kontaktov"
                description="Skončené a zaseknuté kontakty späť do spoločnej fronty ako nové. Doterajšia história sa archivuje."
                backHref="/dashboard/admin"
                backLabel="Admin"
            />
            <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                    V spoločnej fronte: <span className="font-semibold text-foreground tabular-nums">{header.pool}</span>
                    {" · "}v dávkach volajúcich: <span className="font-semibold text-foreground tabular-nums">{header.inBatches}</span>
                </p>
                <RecycleFilters params={params} counts={counts} holders={holders} />
                <RecyclePanel key={selectionKey} params={params} total={list.total} rows={list.rows} />
            </div>
        </DashboardPage>
    );
}
