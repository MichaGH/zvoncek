import Link from "next/link";
import { auth } from "@/auth";
import { notFound } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/permissions";
import { getAdminUserStats } from "@/lib/queries/users";
import { ROLE_LABEL } from "@/lib/dictionaries";
import { Users, ArrowRight } from "lucide-react";

export default async function AdminPage() {
    const session = await auth();
    if (!can(session?.user, "admin.access")) notFound();

    const stats = await getAdminUserStats();

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Admin"
                description="Správa systému — iba pre administrátorov"
            />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {/* Users card */}
                <Card className="flex flex-col">
                    <CardHeader className="flex items-center justify-between pb-3">
                        <div className="flex items-center gap-2">
                            <Users className="h-4 w-4 text-muted-foreground" />
                            <CardTitle className="text-base">Používatelia</CardTitle>
                        </div>
                        <Button asChild size="sm" variant="ghost" className="h-8 px-2">
                            <Link href="/dashboard/admin/users">
                                Zobraziť
                                <ArrowRight className="ml-1 h-3.5 w-3.5" />
                            </Link>
                        </Button>
                    </CardHeader>
                    <CardContent className="flex-1 space-y-3">
                        <div>
                            <span className="text-3xl font-semibold tabular-nums">{stats.active}</span>
                            <span className="ml-2 text-sm text-muted-foreground">aktívnych</span>
                            {stats.total !== stats.active && (
                                <span className="ml-2 text-sm text-muted-foreground">
                                    · {stats.total - stats.active} deaktivovaných
                                </span>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                            {stats.byRole.map((r) => (
                                <span key={r.role} className="text-xs text-muted-foreground">
                                    {ROLE_LABEL[r.role]}: <span className="font-medium text-foreground">{r._count}</span>
                                </span>
                            ))}
                        </div>
                        <Button asChild size="sm" variant="outline" className="w-full">
                            <Link href="/dashboard/admin/users/new">Nový používateľ</Link>
                        </Button>
                    </CardContent>
                </Card>

                {/* Pozvánky – future */}
                <Card className="flex flex-col opacity-50">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base text-muted-foreground">Pozvánky</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Pozývací link pre nového kolegu. Pripravené, príde neskôr.
                    </CardContent>
                </Card>

                {/* Nastavenia – future */}
                <Card className="flex flex-col opacity-50">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base text-muted-foreground">Nastavenia systému</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Tracking doména, email odosielateľ a ďalšie konfigurácie.
                    </CardContent>
                </Card>
            </div>
        </DashboardPage>
    );
}
