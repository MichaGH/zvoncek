import { notFound } from "next/navigation";
import PipelineDetail from "@/components/pipeline/PipelineDetail";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import { getPipelineDetail, getPipelineUsers } from "@/lib/queries/pipeline";
import { getDesignsForLead } from "@/lib/queries/tracking";

export default async function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const [lead, users, designs] = await Promise.all([
        getPipelineDetail(id),
        getPipelineUsers(),
        getDesignsForLead(id),
    ]);
    if (!lead) notFound();

    return (
        <DashboardPage>
            <PipelineDetail lead={lead} users={users} designs={designs} />
        </DashboardPage>
    );
}
