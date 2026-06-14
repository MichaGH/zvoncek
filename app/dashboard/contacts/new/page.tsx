import { auth } from "@/auth";
import { DashboardContent, DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import ContactGrid from "@/components/contacts/ContactGrid";
import { Button } from "@/components/ui/button";
import { getContactsOverview } from "@/lib/queries/contacts";
import { UploadIcon } from "lucide-react";

export default async function NewContactsPage() {
    const session = await auth();
    if (!session?.user?.id) return null;

    const overview = await getContactsOverview();

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Pridať kontakty"
                description="Vyplň riadok a stlač Enter – uloží sa sám. Ďalší riadok pribudne automaticky."
                backHref="/dashboard/contacts"
                backLabel="Všetky kontakty"
                actions={
                    <Button variant="outline" disabled title="Čoskoro">
                        <UploadIcon className="h-4 w-4" />
                        Import CSV
                    </Button>
                }
            />
            <DashboardContent width="wide">
                <ContactGrid initialCallable={overview.callable} />
            </DashboardContent>
        </DashboardPage>
    );
}
