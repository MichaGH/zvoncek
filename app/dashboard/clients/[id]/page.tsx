import { notFound, redirect } from "next/navigation";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import ClientDetail from "@/components/clients/ClientDetail";
import { AccessError } from "@/lib/access/errors";
import { requireDealView } from "@/lib/access/leads";
import { requireUser } from "@/lib/access/user";
import prisma from "@/lib/db";
import { can } from "@/lib/permissions";
import { getClientDetail } from "@/lib/queries/clients";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "clients.view")) redirect("/dashboard");
    const { id } = await params;

    try {
        // Vlastník (clients.view + ownerId) alebo manažér; cudzí obchod / nie-obchod → 404.
        await requireDealView(prisma, viewer, id);
    } catch (error) {
        if (error instanceof AccessError) notFound();
        throw error;
    }
    const deal = await getClientDetail(id, viewer);
    if (!deal) notFound();

    return (
        <DashboardPage>
            <ClientDetail deal={deal} viewerId={viewer.id} canWork={can(viewer, "clients.work") || can(viewer, "pipeline.manage")} />
        </DashboardPage>
    );
}
