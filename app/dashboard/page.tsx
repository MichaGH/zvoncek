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

    const board = await getTodayBoard(session.user.id);
    const todayLabel = new Date().toLocaleDateString("sk-SK", {
        weekday: "long",
        day: "numeric",
        month: "long",
    });

    const hello = board.firstName ? `${greeting()}, ${board.firstName}` : greeting();

    return (
        <DashboardShell>
            <DashboardPageHeader title="Dnes" description={`${hello} · ${todayLabel}`} actions={<RefreshButton />} />

            <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard label="Voľné na volanie" value={board.newCount} hint="ešte sa nevolalo" />
                <StatCard label="Naplánované dnes" value={board.scheduledTodayCount} hint="spätné volania a kroky" />
                <StatCard
                    label="Po termíne"
                    value={board.overdueCount}
                    hint={board.overdueCount > 0 ? "vyriešiť čo najskôr" : "všetko stíhané"}
                    className={board.overdueCount > 0 ? "ring-destructive/30" : undefined}
                />
                <StatCard label="V krátkodobej fronte" value={board.callbackQueueCount} hint="stav „Volá sa“" />
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2">
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
                        {board.urgent.length === 0 ? (
                            <div className="py-10 text-center text-sm text-muted-foreground">
                                Na dnes nič naplánované. 🎉
                            </div>
                        ) : (
                            <ul className="divide-y">
                                {board.urgent.map((item) => (
                                    <UrgentRow key={`${item.kind}-${item.id}`} item={item} />
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>

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
                <Button asChild variant="outline">
                    <Link href="/dashboard/pipeline">Pipeline</Link>
                </Button>
            </div>
        </DashboardShell>
    );
}

function UrgentRow({ item }: { item: TodayUrgentItem }) {
    return (
        <li className="flex items-center justify-between gap-3 py-2.5">
            <Link href={`/dashboard/pipeline/${item.id}`} className="min-w-0 flex-1 group">
                <div className="flex items-center gap-2">
                    <span className="truncate font-medium group-hover:underline">{item.name}</span>
                    <Badge variant={item.kind === "callback" ? "outline" : "secondary"}>
                        {item.kind === "callback" ? "Spätné volanie" : "Pipeline"}
                    </Badge>
                    {item.overdue && <Badge variant="destructive">Po termíne</Badge>}
                </div>
                {item.note && <p className="truncate text-xs text-muted-foreground">{item.note}</p>}
            </Link>
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
