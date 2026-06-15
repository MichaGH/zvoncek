import Link from "next/link";
import { auth } from "@/auth";
import { DashboardPage as DashboardShell, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import TodayCalendar from "@/components/dashboard/TodayCalendar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stats/StatCard";
import { dateKey, getTodayBoard, type TodayUrgentItem } from "@/lib/queries/today";
import { getContactsOverview } from "@/lib/queries/contacts";
import { can, roleOf } from "@/lib/permissions";
import prisma from "@/lib/db";
import { ArrowRight, CalendarDays, Phone, Plus } from "lucide-react";

function greeting() {
    const h = new Date().getHours();
    if (h < 10) return "Dobré ráno";
    if (h < 18) return "Dobrý deň";
    return "Dobrý večer";
}

function formatWhen(iso: string | null, overdue: boolean) {
    if (!iso) return overdue ? "po termíne" : "";
    const d = new Date(iso);
    const todayKey = dateKey(new Date());
    const time = d.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
    if (dateKey(d) === todayKey) return time;
    return d.toLocaleDateString("sk-SK", { day: "numeric", month: "numeric" }) + " " + time;
}

export default async function DashboardPage() {
    const session = await auth();
    if (!session?.user?.id) return null;

    const role = roleOf(session.user);
    const todayLabel = new Date().toLocaleDateString("sk-SK", {
        weekday: "long",
        day: "numeric",
        month: "long",
    });

    // Scout vidí len personalizovaný prehľad kontaktov, nie globálnu frontu.
    if (role === "SCOUT") {
        const [overview, userData] = await Promise.all([
            getContactsOverview(session.user.id),
            prisma.user.findUnique({ where: { id: session.user.id }, select: { firstName: true } }),
        ]);
        const hello = userData?.firstName ? `${greeting()}, ${userData.firstName}` : greeting();

        return (
            <DashboardShell>
                <DashboardPageHeader
                    title="Dashboard"
                    description={`${hello} · ${todayLabel}`}
                    actions={<RefreshButton />}
                />

                <div className="mb-6 grid gap-4 sm:grid-cols-3">
                    <StatCard label="Dnes pridaných" value={overview.addedToday} hint="tvoje kontakty dnes" />
                    <StatCard label="Voľných na volanie" value={overview.callable} hint="ešte sa nevolalo" />
                    <StatCard label="Celkom tvojich" value={overview.total} hint="kontakty v databáze" />
                </div>

                <div className="flex flex-wrap gap-2">
                    <Button asChild>
                        <Link href="/dashboard/contacts/new">
                            <Plus className="h-4 w-4" />
                            Pridať kontakty
                        </Link>
                    </Button>
                    <Button asChild variant="outline">
                        <Link href="/dashboard/contacts">Moje kontakty</Link>
                    </Button>
                </div>
            </DashboardShell>
        );
    }

    // TELESALES, MANAGER, ADMIN — plný board
    const board = await getTodayBoard(session.user.id);
    const hello = board.firstName ? `${greeting()}, ${board.firstName}` : greeting();
    const canViewPipeline = can(session.user, "pipeline.view");

    // TELESALES nemá prístup k pipeline — nezobrazujeme pipeline urgenty.
    const urgentToShow = canViewPipeline
        ? board.urgent
        : board.urgent.filter((u) => u.kind === "callback");

    return (
        <DashboardShell>
            <DashboardPageHeader title="Dashboard" description={`${hello} · ${todayLabel}`} actions={<RefreshButton />} />

            <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard label="Voľné na volanie" value={board.newCount} hint="ešte sa nevolalo" />
                <StatCard label="Naplánované dnes" value={board.scheduledTodayCount} hint="spätné volania a kroky" />
                <StatCard
                    label="Po termíne"
                    value={board.overdueCount}
                    hint={board.overdueCount > 0 ? "vyriešiť čo najskôr" : "všetko stíhané"}
                    className={board.overdueCount > 0 ? "ring-destructive/30" : undefined}
                />
                <StatCard label="V krátkodobej fronte" value={board.callbackQueueCount} hint={'stav „Volá sa“'} />
            </div>

            <div className={`grid gap-6 ${canViewPipeline ? "lg:grid-cols-3" : ""}`}>
                <Card className={canViewPipeline ? "lg:col-span-2" : ""}>
                    <CardHeader className="flex-row items-center justify-between pb-3">
                        <CardTitle className="text-base">Urgentné na dnes</CardTitle>
                        <Button asChild variant="ghost" size="sm">
                            <Link href="/dashboard/calls">
                                Otvoriť volania
                                <ArrowRight className="h-4 w-4" />
                            </Link>
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {urgentToShow.length === 0 ? (
                            <div className="py-10 text-center text-sm text-muted-foreground">
                                Na dnes nič naplánované. 🎉
                            </div>
                        ) : (
                            <ul className="divide-y">
                                {urgentToShow.map((item) => (
                                    <UrgentRow key={`${item.kind}-${item.id}`} item={item} canViewPipeline={canViewPipeline} />
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>

                {canViewPipeline && (
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                Kalendár volaní
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <TodayCalendar counts={board.calendar} todayKey={dateKey(new Date())} />
                        </CardContent>
                    </Card>
                )}
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
                <Button asChild variant="outline">
                    <Link href="/dashboard/contacts/new">
                        <Plus className="h-4 w-4" />
                        Pridať kontakty
                    </Link>
                </Button>
                <Button asChild variant="outline">
                    <Link href="/dashboard/calls">
                        <Phone className="h-4 w-4" />
                        Volania
                    </Link>
                </Button>
                {canViewPipeline && (
                    <Button asChild variant="outline">
                        <Link href="/dashboard/pipeline">Pipeline</Link>
                    </Button>
                )}
            </div>
        </DashboardShell>
    );
}

function UrgentRow({ item, canViewPipeline }: { item: TodayUrgentItem; canViewPipeline: boolean }) {
    const href = item.kind === "pipeline" && canViewPipeline ? `/dashboard/pipeline/${item.id}` : null;
    return (
        <li className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    {href ? (
                        <Link href={href} className="truncate font-medium hover:underline">
                            {item.name}
                        </Link>
                    ) : (
                        <span className="truncate font-medium">{item.name}</span>
                    )}
                    <Badge variant={item.kind === "callback" ? "outline" : "secondary"}>
                        {item.kind === "callback" ? "Spätné volanie" : "Pipeline"}
                    </Badge>
                    {item.overdue && <Badge variant="destructive">Po termíne</Badge>}
                </div>
                {item.note && <p className="truncate text-xs text-muted-foreground">{item.note}</p>}
            </div>
            <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs tabular-nums text-muted-foreground">
                    {formatWhen(item.at, item.overdue)}
                </span>
                {item.phone && (
                    <Button asChild size="icon" variant="ghost" className="h-8 w-8">
                        <a href={`tel:${item.phone}`} aria-label={`Zavolať ${item.name}`}>
                            <Phone className="h-4 w-4" />
                        </a>
                    </Button>
                )}
            </div>
        </li>
    );
}
