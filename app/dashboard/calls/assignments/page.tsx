import { redirect } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import AssignmentsTable from "@/components/calls/AssignmentsTable";
import { requireUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";
import { getAssignmentsOverview } from "@/lib/queries/calls/assignments";
import { getPoolCount } from "@/lib/queries/calls";

export default async function CallAssignmentsPage() {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "calls.assign")) redirect("/dashboard");

    const [overview, poolCount] = await Promise.all([getAssignmentsOverview(), getPoolCount()]);
    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Priradenia volaní"
                description={`Práca volajúcich · voľných v spoločnej fronte: ${poolCount}. Nič sa nepresúva automaticky.`}
                backHref="/dashboard/calls"
                backLabel="Volania"
                actions={<RefreshButton />}
            />
            <AssignmentsTable rows={overview.rows} targets={overview.targets} />
        </DashboardPage>
    );
}
