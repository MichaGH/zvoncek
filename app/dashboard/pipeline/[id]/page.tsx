import { notFound } from "next/navigation";
import PipelineDetail from "@/components/pipeline/PipelineDetail";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import { getPipelineDetail, getPipelineUsers } from "@/lib/queries/pipeline";

export default async function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const [lead, users] = await Promise.all([getPipelineDetail(id), getPipelineUsers()]);
    if (!lead) notFound();

    return (
        <DashboardPage width="default">
            <PipelineDetail lead={lead} users={users} />
        </DashboardPage>
    );
}
