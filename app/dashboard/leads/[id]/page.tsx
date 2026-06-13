import { notFound } from "next/navigation";
import { getLeadDetail, getUsers } from "@/lib/queries/leads";
import LeadDetail from "@/components/leads/LeadDetail";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const [lead, users] = await Promise.all([getLeadDetail(id), getUsers()]);
    if (!lead) notFound();

    return (
        <main className="mx-auto max-w-3xl px-4 py-8">
            <LeadDetail lead={lead} users={users} />
        </main>
    );
}