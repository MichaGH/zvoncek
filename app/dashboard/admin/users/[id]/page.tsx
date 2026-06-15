import Link from "next/link";
import { auth } from "@/auth";
import { notFound } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/permissions";
import { getAdminUserDetail } from "@/lib/queries/users";
import UserProfileCard from "@/components/admin/UserProfileCard";
import UserPasswordCard from "@/components/admin/UserPasswordCard";
import UserStatusCard from "@/components/admin/UserStatusCard";
import { ArrowLeft, BarChart2 } from "lucide-react";

function formatDateTime(d: Date | null) {
    if (!d) return "—";
    return d.toLocaleDateString("sk-SK", { day: "numeric", month: "long", year: "numeric" })
        + " " + d.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
}

export default async function AdminUserDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const session = await auth();
    if (!can(session?.user, "admin.access")) notFound();

    const { id } = await params;
    const user = await getAdminUserDetail(id);
    if (!user) notFound();

    const isSelf = session?.user?.id === id;

    return (
        <DashboardPage>
            <DashboardPageHeader
                title={`${user.firstName} ${user.lastName}`}
                description={`@${user.username}`}
                actions={
                    <div className="flex gap-2">
                        <Button asChild size="sm" variant="outline">
                            <Link href={`/dashboard/stats/${id}`}>
                                <BarChart2 className="mr-1.5 h-3.5 w-3.5" />
                                Štatistiky
                            </Link>
                        </Button>
                        <Button asChild size="sm" variant="ghost">
                            <Link href="/dashboard/admin/users">
                                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                                Späť
                            </Link>
                        </Button>
                    </div>
                }
            />

            <div className="grid gap-4 lg:grid-cols-3">
                {/* Main column */}
                <div className="space-y-4 lg:col-span-2">
                    <UserProfileCard user={user} />
                    <UserPasswordCard userId={user.id} />
                </div>

                {/* Sidebar */}
                <div className="space-y-4">
                    <UserStatusCard
                        userId={user.id}
                        deletedAt={user.deletedAt}
                        isSelf={isSelf}
                    />

                    {/* Meta */}
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">Info</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <dl className="space-y-2 text-sm">
                                <div className="flex justify-between gap-2">
                                    <dt className="text-muted-foreground">Vytvorený</dt>
                                    <dd className="tabular-nums">{formatDateTime(user.createdAt)}</dd>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <dt className="text-muted-foreground">Posl. prihlásenie</dt>
                                    <dd className="tabular-nums">{formatDateTime(user.lastLoginAt)}</dd>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <dt className="text-muted-foreground">Email overený</dt>
                                    <dd>{user.emailVerifiedAt ? formatDateTime(user.emailVerifiedAt) : <span className="text-muted-foreground">Nie</span>}</dd>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <dt className="text-muted-foreground">Tel. overený</dt>
                                    <dd>{user.phoneVerifiedAt ? formatDateTime(user.phoneVerifiedAt) : <span className="text-muted-foreground">Nie</span>}</dd>
                                </div>
                            </dl>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </DashboardPage>
    );
}
