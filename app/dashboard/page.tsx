import { auth } from "@/auth";
import { DashboardPage as DashboardShell, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";

export default async function DashboardPage() {
    const session = await auth();

    return (
        <DashboardShell>
            <DashboardPageHeader title="Dnes" description={`Ahoj, ${session?.user?.email ?? ""}`} />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">
                            Naplánované na dnes
                        </CardTitle>
                        <CardDescription>
                            Follow-upy podľa termínu
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Zatiaľ prázdne – pridáme po napojení leadov.
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">
                            Nové  ešte sa nevolalo
                        </CardTitle>
                        <CardDescription>
                            Čakajú na prvý kontakt
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Zatiaľ prázdne.
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Kalendár</CardTitle>
                        <CardDescription>Príde neskôr</CardDescription>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        🙂
                    </CardContent>
                </Card>
            </div>
        </DashboardShell>
    );
}
