import { redirect } from "next/navigation";
import Link from "next/link";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import { Button } from "@/components/ui/button";
import TeamsManager from "@/components/admin/TeamsManager";
import { can } from "@/lib/permissions";
import { requireUser } from "@/lib/access/user";
import { getTeams } from "@/lib/queries/teams";
import { getUserOptions } from "@/lib/queries/users";
import { ArrowLeft } from "lucide-react";

export default async function AdminTeamsPage() {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "teams.manage")) redirect("/dashboard");

    const [teams, userOptions] = await Promise.all([getTeams(), getUserOptions()]);

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Tímy"
                description="Vytvor tímy, priraď vedúcich. Členov priradíš na detaile používateľa."
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/dashboard/admin">
                            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                            Späť
                        </Link>
                    </Button>
                }
            />
            <TeamsManager teams={teams} userOptions={userOptions} />
        </DashboardPage>
    );
}
