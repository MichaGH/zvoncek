import { notFound } from "next/navigation";
import PipelineDetail from "@/components/pipeline/PipelineDetail";
import { getPipelineDetail, getPipelineUsers } from "@/lib/queries/pipeline";

export default async function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const [lead, users] = await Promise.all([getPipelineDetail(id), getPipelineUsers()]);
    if (!lead) notFound();

    return (
        <main className="mx-auto max-w-3xl px-4 py-8">
            <PipelineDetail lead={lead} users={users} />
        </main>
    );
}
