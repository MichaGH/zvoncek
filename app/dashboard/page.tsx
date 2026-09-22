import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardPage as DashboardShell, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import TodayCalendar from "@/components/dashboard/TodayCalendar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stats/StatCard";
import Logo from "@/components/Logo";
import UrgencyLabel from "@/components/shared/UrgencyLabel";
import { requireUser } from "@/lib/access/user";
import { TASK_CONTENT_LABEL, TASK_TYPE_LABEL } from "@/lib/dictionaries";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";
import { can } from "@/lib/permissions";
import { getCallerToday, getDealsToday, todayKey, type TodayUrgentItem } from "@/lib/queries/today";
import { getManagerToday } from "@/lib/queries/today/manager";
import { fmtAgo } from "@/lib/utils";
import { ArrowRight, CalendarDays, Phone, Plus } from "lucide-react";

function greeting() {
    const h = Number(new Date().toLocaleString("en-GB", { timeZone: BUSINESS_TZ, hour: "2-digit", hour12: false }));
    if (h < 10) return "Dobré ráno";
    if (h < 18) return "Dobrý deň";
    return "Dobrý večer";
}

// Dashboard skladaný podľa práv (plán §9): volajúci vidia svoju prácu, obchodník svoje obchody,
// manažér navyše „Čaká na mňa", „Obchodníci", „Nepriradené", „Volajúci".
export default async function DashboardPage() {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");

    const todayLabel = new Date().toLocaleDateString("sk-SK", {
        timeZone: BUSINESS_TZ,
        weekday: "long",
        day: "numeric",
        month: "long",
    });
    const hello = `${greeting()}, ${viewer.firstName}`;
    const canCalls = can(viewer, "calls.view");
    const canPipeline = can(viewer, "deals.viewAll");
    // Vlastné obchody bez práva vidieť všetky – rovnaká stránka, iný rozsah (dealScope).
    const canOwnDeals = can(viewer, "deals.view") && !canPipeline;

    // Pridávači kontaktov – jednoduchá uvítacia stránka (ich práca žije v Kontaktoch a Štatistikách).
    if (!canCalls && !canPipeline && !canOwnDeals) {
        return (
            <DashboardShell>
                <DashboardPageHeader title="Dashboard" description={`${hello} · ${todayLabel}`} />
                <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
                    <Logo className="h-14 w-auto opacity-90" />
                    <h2 className="text-2xl font-semibold tracking-tight">Vitajte v Zvončeku!</h2>
                    <p className="max-w-sm text-sm text-muted-foreground">Všetko potrebné nájdete v hornom menu.</p>
                </div>
            </DashboardShell>
        );
    }

    const [calls, deals, manager] = await Promise.all([
        canCalls ? getCallerToday(viewer) : Promise.resolve(null),
        canPipeline || canOwnDeals ? getDealsToday(viewer) : Promise.resolve(null),
        canPipeline ? getManagerToday(viewer) : Promise.resolve(null),
    ]);
    const today = todayKey();

    return (
        <DashboardShell>
            <DashboardPageHeader title="Dashboard" description={`${hello} · ${todayLabel}`} actions={<RefreshButton />} />

            {manager && (
                <div className="mb-6 grid gap-6 lg:grid-cols-2">
                    {/* „Čaká na mňa" = ten istý dopyt ako pilulka „Pre mňa" (úlohy pridelené mne, wave 3 §7). */}
                    <Card className={manager.oldestTaskOverdue ? "border-destructive/50" : undefined}>
                        <CardHeader className="flex-row items-center justify-between pb-3">
                            <CardTitle className={`text-base ${manager.oldestTaskOverdue ? "text-destructive" : ""}`}>
                                Čaká na mňa ({manager.taskCount})
                            </CardTitle>
                            <Button asChild variant="ghost" size="sm">
                                <Link href="/dashboard/pipeline?view=inbox">
                                    Pre mňa <ArrowRight className="h-4 w-4" />
                                </Link>
                            </Button>
                        </CardHeader>
                        <CardContent>
                            {manager.tasks.length === 0 ? (
                                <p className="py-6 text-center text-sm text-muted-foreground">Žiadne otvorené úlohy.</p>
                            ) : (
                                <ul className="divide-y">
                                    {manager.tasks.map((t) => (
                                        <li key={t.id} className="space-y-0.5 py-2 text-sm">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge variant={t.overdue ? "destructive" : "secondary"}>
                                                    {t.type === "HANDOVER" ? TASK_TYPE_LABEL.HANDOVER : t.contents.map((c) => TASK_CONTENT_LABEL[c]).join(" + ")}
                                                </Badge>
                                                <Link href={`/dashboard/pipeline/${t.leadId}`} className="truncate font-medium hover:underline">
                                                    {t.leadName}
                                                </Link>
                                                <span className={`ml-auto text-xs ${t.overdue ? "text-destructive" : "text-muted-foreground"}`}>
                                                    {t.requester} · {fmtAgo(t.createdAt)}
                                                </span>
                                            </div>
                                            <p className="truncate text-xs text-muted-foreground">{t.text}</p>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </CardContent>
                    </Card>

                    <div className="space-y-6">
                        {manager.unassigned > 0 && (
                            <Link
                                href="/dashboard/pipeline?filter=all&owner=unassigned"
                                className="block rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive hover:bg-destructive/10"
                            >
                                <span className="font-semibold">Nepriradené:</span> {manager.unassigned} otvorených obchodov bez vlastníka →
                            </Link>
                        )}
                        {(manager.callers.staleBatches.length > 0 || manager.callers.deactivatedWithWork.length > 0) && (
                            <Link
                                href="/dashboard/calls/assignments"
                                className="block rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm hover:bg-amber-500/10"
                            >
                                <span className="font-semibold">Volajúci:</span>{" "}
                                {[
                                    ...manager.callers.staleBatches.map((c) => `${c.name} má nedokončenú dávku (${c.count}) staršiu ako 1 deň`),
                                    ...manager.callers.deactivatedWithWork.map((c) => `deaktivovaný ${c.name} drží ${c.count} kontaktov`),
                                ].join(" · ")}{" "}
                                →
                            </Link>
                        )}
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Obchodníci</CardTitle>
                            </CardHeader>
                            <CardContent className="overflow-x-auto">
                                {manager.reps.length === 0 ? (
                                    <p className="py-4 text-center text-sm text-muted-foreground">Žiadni ďalší obchodníci.</p>
                                ) : (
                                    <table className="w-full text-sm">
                                        <thead className="text-left text-xs text-muted-foreground">
                                            <tr>
                                                <th className="py-1 font-medium">Meno</th>
                                                <th className="py-1 text-right font-medium">Otvorené</th>
                                                <th className="py-1 text-right font-medium">Po termíne</th>
                                                <th className="py-1 text-right font-medium">Follow-upy dnes</th>
                                                <th className="py-1 text-right font-medium">Nové (týždeň)</th>
                                                <th className="py-1 text-right font-medium">Callbacky po termíne</th>
                                                <th className="py-1 text-right font-medium">Posl. aktivita</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y tabular-nums">
                                            {manager.reps.map((r) => (
                                                <tr key={r.id}>
                                                    <td className="py-1.5">
                                                        <Link href={`/dashboard/pipeline?filter=all&owner=${r.id}`} className="font-medium hover:underline">
                                                            {r.name}
                                                        </Link>
                                                    </td>
                                                    <td className="text-right">{r.openDeals}</td>
                                                    <td className={`text-right ${r.overdue > 0 ? "font-semibold text-destructive" : ""}`}>{r.overdue}</td>
                                                    <td className="text-right">{r.followUpsToday}</td>
                                                    <td className="text-right">{r.newThisWeek}</td>
                                                    <td className={`text-right ${r.callbacksOverdue > 0 ? "text-destructive" : ""}`}>{r.callbacksOverdue}</td>
                                                    <td className="text-right text-muted-foreground">{fmtAgo(r.lastActivityAt) ?? "—"}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {calls && (
                <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <StatCard label="Moja dávka" value={calls.batchCount} hint="nevolané nové firmy" />
                    <StatCard label="Voľné vo fronte" value={calls.poolCount} hint="dá sa zobrať ďalšia dávka" />
                    <StatCard
                        label="Dohodnuté hovory"
                        value={calls.callbacksDue + calls.callbacksOverdue}
                        hint={calls.callbacksOverdue > 0 ? `${calls.callbacksOverdue} po termíne` : "na dnes"}
                        className={calls.callbacksOverdue > 0 ? "ring-destructive/30" : undefined}
                    />
                    <StatCard label="Skúsiť znova" value={calls.retryCount} hint="moje nedovolané" />
                </div>
            )}

            {deals && (
                <div className="mb-6 grid gap-4 sm:grid-cols-3">
                    <StatCard label={deals.scope === "all" ? "Otvorené obchody" : "Moje otvorené obchody"} value={deals.openCount} />
                    <StatCard label="Ďalší krok na dnes" value={deals.dueCount} />
                    <StatCard
                        label="Po termíne"
                        value={deals.overdueCount}
                        hint={deals.overdueCount > 0 ? "vyriešiť čo najskôr" : "všetko stíhané"}
                        className={deals.overdueCount > 0 ? "ring-destructive/30" : undefined}
                    />
                </div>
            )}

            <div className="grid gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                    <CardHeader className="flex-row items-center justify-between pb-3">
                        <CardTitle className="text-base">Urgentné na dnes</CardTitle>
                        <Button asChild variant="ghost" size="sm">
                            <Link href={canCalls ? "/dashboard/calls" : "/dashboard/pipeline"}>
                                Otvoriť <ArrowRight className="h-4 w-4" />
                            </Link>
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {[...(calls?.urgent ?? []), ...(deals?.urgent ?? [])].length === 0 ? (
                            <div className="py-10 text-center text-sm text-muted-foreground">Na dnes nič naplánované. 🎉</div>
                        ) : (
                            <ul className="divide-y">
                                {[...(calls?.urgent ?? []), ...(deals?.urgent ?? [])]
                                    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.at ?? "").localeCompare(b.at ?? ""))
                                    .map((item) => (
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
                            Kalendár
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <TodayCalendar counts={mergeCalendars(calls?.calendar, deals?.calendar)} todayKey={today} />
                    </CardContent>
                </Card>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
                {can(viewer, "contacts.create") && (
                    <Button asChild variant="outline">
                        <Link href="/dashboard/contacts/new">
                            <Plus className="h-4 w-4" />
                            Pridať kontakty
                        </Link>
                    </Button>
                )}
                {canCalls && (
                    <Button asChild variant="outline">
                        <Link href="/dashboard/calls">
                            <Phone className="h-4 w-4" />
                            Volania
                        </Link>
                    </Button>
                )}
                {(canPipeline || canOwnDeals) && (
                    <Button asChild variant="outline">
                        <Link href="/dashboard/pipeline">Pipeline</Link>
                    </Button>
                )}
            </div>
        </DashboardShell>
    );
}

function mergeCalendars(...calendars: (Record<string, number> | undefined)[]) {
    const out: Record<string, number> = {};
    for (const c of calendars) for (const [k, v] of Object.entries(c ?? {})) out[k] = (out[k] ?? 0) + v;
    return out;
}

function UrgentRow({ item }: { item: TodayUrgentItem }) {
    return (
        <li className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    {item.href ? (
                        <Link href={item.href} className="truncate font-medium hover:underline">
                            {item.name}
                        </Link>
                    ) : (
                        <span className="truncate font-medium">{item.name}</span>
                    )}
                    <Badge variant={item.kind === "callback" ? "outline" : "secondary"}>
                        {item.kind === "callback" ? "Spätné volanie" : "Obchod"}
                    </Badge>
                    {item.overdue && <Badge variant="destructive">Po termíne</Badge>}
                </div>
                {item.note && <p className="truncate text-xs text-muted-foreground">{item.note}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-3">
                <UrgencyLabel at={item.at} hasTime={item.hasTime} className="text-xs" />
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
