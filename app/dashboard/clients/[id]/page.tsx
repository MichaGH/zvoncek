import { redirect } from "next/navigation";

// Round 2 (D-01): jeden detail obchodu pre všetky roly – /dashboard/pipeline/[id].
export default async function ClientDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    redirect(`/dashboard/pipeline/${id}`);
}
