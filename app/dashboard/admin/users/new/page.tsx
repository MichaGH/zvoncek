import { redirect } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import NewUserForm from "@/components/admin/NewUserForm";
import { can } from "@/lib/permissions";
import { requireUser } from "@/lib/access/user";

export default async function NewUserPage() {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "admin.access")) redirect("/dashboard");

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Nový používateľ"
                description="Vytvorenie nového účtu v systéme"
            />
            <NewUserForm />
        </DashboardPage>
    );
}
