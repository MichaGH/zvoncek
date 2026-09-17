import { notFound, redirect } from "next/navigation";
import PipelineDetail from "@/components/pipeline/PipelineDetail";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import { AccessError } from "@/lib/access/errors";
import { requireDealView } from "@/lib/access/leads";
import { requireUser } from "@/lib/access/user";
import prisma from "@/lib/db";
import { can } from "@/lib/permissions";
import { getDealOwnerOptions, getPipelineDetail } from "@/lib/queries/pipeline";
import { getDesignsForLead } from "@/lib/queries/tracking";

export default async function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "pipeline.view")) redirect("/dashboard");
    const { id } = await params;

    try {
        await requireDealView(prisma, viewer, id);
    } catch (error) {
        if (error instanceof AccessError) notFound();
        throw error;
    }

    const [lead, users, designs] = await Promise.all([
        getPipelineDetail(id),
        getDealOwnerOptions(),
        getDesignsForLead(id),
    ]);
    if (!lead) notFound();

    return (
        <DashboardPage>
            <PipelineDetail lead={lead} users={users} designs={designs} />
        </DashboardPage>
    );
}
