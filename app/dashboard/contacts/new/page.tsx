import { requireUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { DashboardContent, DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import ContactGrid from "@/components/contacts/ContactGrid";
import { Button } from "@/components/ui/button";
import { getPoolCount } from "@/lib/queries/calls";
import { UploadIcon } from "lucide-react";

export default async function NewContactsPage() {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "contacts.create")) redirect("/dashboard");

    // Voľné na volanie = spoločná fronta (volajúci vidia len tento súhrnný počet).
    const poolCount = await getPoolCount();
    const hasContacts = can(viewer, "contacts.access");

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Pridať kontakty"
                description="Vyplň riadok a stlač Enter – uloží sa sám. Ďalší riadok pribudne automaticky."
                backHref={hasContacts ? "/dashboard/contacts" : "/dashboard"}
                backLabel={hasContacts ? "Všetky kontakty" : "Späť"}
                actions={
                    <Button variant="outline" disabled title="Čoskoro">
                        <UploadIcon className="h-4 w-4" />
                        Import CSV
                    </Button>
                }
            />
            <DashboardContent width="wide">
                <ContactGrid initialCallable={poolCount} />
            </DashboardContent>
        </DashboardPage>
    );
}
