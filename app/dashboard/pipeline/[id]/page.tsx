import { notFound, redirect } from "next/navigation";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import DealDetail from "@/components/pipeline/DealDetail";
import { requireUser } from "@/lib/access/user";
import { dealCapabilities } from "@/lib/domain/dealCapabilities";
import { can } from "@/lib/permissions";
import { getDealDetail, getDealOwnerOptions, getDealScope } from "@/lib/queries/pipeline";
import { getDesignsForLead } from "@/lib/queries/tracking";

// Detail obchodu – rovnaká stránka pre vlastníka aj manažéra. Rozsah je v dotaze (getDealDetail),
// takže presun obchodu medzi kontrolou a načítaním nemôže vrátiť detail bývalému vlastníkovi.

export default async function DealDetailPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ zaznam?: string }>;
}) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "deals.view")) redirect("/dashboard");
    const { id } = await params;
    // Akčné okno v zozname posiela „Poslali sme ponuku" sem – dialóg potrebuje návrhy a cenu, ktoré zoznam nenačítava.
    const openOffer = (await searchParams).zaznam === "ponuka";

    const caps = dealCapabilities(viewer);
    const scope = await getDealScope(viewer);
    const lead = await getDealDetail(id, scope, caps);
    if (!lead) notFound();

    const [users, designs] = await Promise.all([
        caps.manage ? getDealOwnerOptions(scope) : Promise.resolve([]),
        caps.manageDesigns ? getDesignsForLead(id) : Promise.resolve([]),
    ]);

    return (
        <DashboardPage>
            <DealDetail lead={lead} caps={caps} viewerId={viewer.id} users={users} designs={designs} openOffer={openOffer && caps.work} />
        </DashboardPage>
    );
}
