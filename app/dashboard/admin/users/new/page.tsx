import { auth } from "@/auth";
import { notFound } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import NewUserForm from "@/components/admin/NewUserForm";
import { can } from "@/lib/permissions";

export default async function NewUserPage() {
    const session = await auth();
    if (!can(session?.user, "admin.access")) notFound();

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
