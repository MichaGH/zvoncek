import { auth } from "@/auth";
import { notFound } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/permissions";

// Admin-only. Zatiaľ prázdny placeholder – sem pôjde správa používateľov, pozvánky, nastavenia.
export default async function AdminPage() {
    const session = await auth();
    if (!can(session?.user, "admin.access")) notFound();

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Admin"
                description="Správa systému – iba pre administrátorov"
            />
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Pripravené pre admin nástroje</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                    Táto sekcia je zatiaľ prázdna. Neskôr sem pribudne správa používateľov a
                    rolí, pozvánky a systémové nastavenia.
                </CardContent>
            </Card>
        </DashboardPage>
    );
}
