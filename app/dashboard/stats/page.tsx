import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import StatsPeriodPicker from "@/components/stats/StatsPeriodPicker";
import { StatBar, StatCard } from "@/components/stats/StatCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    getCallStats,
    getCallStatsByUser,
    getCallsDaily,
    getDemandStats,
    getContactPoolStats,
    getContactsAddedStats,
    getContactsAddedDaily,
    getContactsAddingLog,
    getStatsUsers,
    type AddingByUser,
} from "@/lib/queries/stats";
import { getTeamOptions, getTeamPeople, getTeamScopeForLeader } from "@/lib/queries/teams";
import ActivityHeatmap from "@/components/stats/ActivityHeatmap";
import { OUTCOME_LABEL, STATUS_LABEL } from "@/lib/dictionaries";
import { REQUEST_CONTENT_LABEL, REQUEST_CONTENTS } from "@/lib/domain/clientRequests";
import { resolveRange, toDateInput } from "@/lib/stats/range";
import { can } from "@/lib/permissions";
import { requireUser } from "@/lib/access/user";
import { redirect } from "next/navigation";
import type { CallOutcome, LeadStatus } from "@/app/generated/prisma/enums";
import Link from "next/link";

// Order outcomes as a rough funnel for the breakdown.
const OUTCOME_ORDER: CallOutcome[] = [
    "INTERESTED",
    "WANTS_QUOTE",
    "WANTS_DESIGN",
    "WANTS_EMAIL",
    "POSITIVE",
    "WANTS_TO_ORDER",
    "CALL_AGAIN",
    "SNOOZE",
    "NOT_INTERESTED",
    "NO_ANSWER",
    "BAD_NUMBER",
];

const GOOD: CallOutcome[] = ["INTERESTED", "WANTS_QUOTE", "WANTS_DESIGN", "WANTS_EMAIL", "POSITIVE", "WANTS_TO_ORDER"];
const BAD: CallOutcome[] = ["NOT_INTERESTED", "BAD_NUMBER"];

const STATUS_ORDER: LeadStatus[] = [
    "NEW",
    "CALLING",
    "ACTIVE",
    "SNOOZED",
    "WON",
    "LOST",
    "UNREACHABLE",
];

export default async function StatsPage({
    searchParams,
}: {
    searchParams: Promise<{
        period?: string;
        from?: string;
        to?: string;
        userId?: string;
        team?: string;
    }>;
}) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "stats.view")) redirect("/dashboard");

    const { period, from, to, userId, team } = await searchParams;
    const canViewAll = can(viewer, "stats.viewAll"); // manager/admin – všetko
    const canViewTeam = can(viewer, "stats.viewTeam"); // vedúci – len jeho tím
    const isLeaderView = canViewTeam && !canViewAll;
    const range = resolveRange({ period, from, to });

    // ── Scope (vždy server-side). Presne jedno z scopeUserId / scopeUserIds. ──
    let scopeUserId: string | undefined;
    let scopeUserIds: string[] | undefined;
    let statsUsers: { id: string; firstName: string; lastName: string }[] = [];
    let teamOptions: { id: string; name: string }[] = [];
    let leaderPeople: { id: string; name: string; isLeader: boolean }[] = [];
    let teamName: string | undefined;

    if (canViewAll) {
        const [users, teams] = await Promise.all([getStatsUsers(), getTeamOptions()]);
        statsUsers = users;
        teamOptions = teams;
        if (userId) {
            scopeUserId = userId;
        } else if (team) {
            const tp = await getTeamPeople(team);
            scopeUserIds = tp?.ids ?? [];
            teamName = tp?.name;
        }
    } else if (canViewTeam) {
        const scope = await getTeamScopeForLeader(viewer.id);
        const ids = scope?.ids ?? [viewer.id];
        leaderPeople = scope?.people ?? [];
        teamName = scope?.name;
        if (userId && ids.includes(userId)) {
            scopeUserId = userId;
        } else {
            scopeUserIds = ids;
        }
    } else {
        // Fallback: len vlastné čísla.
        scopeUserId = viewer.id;
    }

    const showCallSections = canViewAll;
    const showPool = canViewAll;
    const effectiveIds = scopeUserId ? [scopeUserId] : (scopeUserIds ?? []);
    const showAddingLog = isLeaderView || (canViewAll && effectiveIds.length > 0);
    const showPerUserBreakdown = !scopeUserId; // agregát (všetci / tím)

    // Okno heatmapy = zvolené obdobie hore (heatmapa sa naň „zoomne").
    // Pri „Všetko" (bez from) fallback na 26 týždňov; strop ~53 týždňov.
    const DAY_MS = 86_400_000;
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const hmTo = range.to ?? new Date(startToday.getTime() + DAY_MS); // vrátane dneška
    let hmFrom = range.from ?? new Date(startToday.getTime() - DAY_MS * (7 * 26 - 1));
    const HM_MAX_MS = DAY_MS * 7 * 53;
    if (hmTo.getTime() - hmFrom.getTime() > HM_MAX_MS) {
        hmFrom = new Date(hmTo.getTime() - HM_MAX_MS);
    }
    const heatmapLabel = range.key === "all" ? "posledných 26 týždňov" : range.label;

    const [callStats, demand, perUser, pool, contactsAdded, addingLog, addsDaily, callsDaily] =
        await Promise.all([
            showCallSections
                ? getCallStats({ range, userId: scopeUserId, userIds: scopeUserIds })
                : Promise.resolve(null),
            showCallSections
                ? getDemandStats({ range, userId: scopeUserId, userIds: scopeUserIds })
                : Promise.resolve(null),
            canViewAll && !scopeUserId && !scopeUserIds
                ? getCallStatsByUser({ range })
                : Promise.resolve([]),
            showPool ? getContactPoolStats() : Promise.resolve(null),
            getContactsAddedStats({ range, userId: scopeUserId, userIds: scopeUserIds }),
            showAddingLog
                ? getContactsAddingLog({ range, userIds: effectiveIds })
                : Promise.resolve([]),
            // Heatmapa pridávania – vidia všetci s prístupom na štatistiky (kontaktové dáta).
            getContactsAddedDaily({ userId: scopeUserId, userIds: scopeUserIds, from: hmFrom, to: hmTo }),
            // Heatmapa volaní – LEN manager/admin (lídrovi sa ani nefetchne).
            showCallSections
                ? getCallsDaily({ userId: scopeUserId, userIds: scopeUserIds, from: hmFrom, to: hmTo })
                : Promise.resolve([]),
        ]);

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Štatistiky"
                description={
                    isLeaderView
                        ? `Tím ${teamName ?? "—"} · ${range.label}`
                        : `Volania marketingu · ${range.label}`
                }
            >
                <StatsPeriodPicker
                    current={range.key}
                    userId={scopeUserId}
                    team={team}
                    from={toDateInput(range.from)}
                    to={range.to ? toDateInput(new Date(range.to.getTime() - 1)) : ""}
                />
            </DashboardPageHeader>

            {/* Výber (manager/admin): kto + tím */}
            {canViewAll && (
                <div className="mb-6 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground w-12">Kto</span>
                        <Button asChild size="sm" variant={!scopeUserId && !team ? "default" : "outline"}>
                            <Link href={periodHref({ period: range.key, from, to })}>Všetci</Link>
                        </Button>
                        {statsUsers.map((user) => (
                            <Button
                                key={user.id}
                                asChild
                                size="sm"
                                variant={scopeUserId === user.id ? "default" : "outline"}
                            >
                                <Link href={periodHref({ period: range.key, from, to, userId: user.id })}>
                                    {user.firstName} {user.lastName}
                                </Link>
                            </Button>
                        ))}
                    </div>
                    {teamOptions.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground w-12">Tím</span>
                            {teamOptions.map((t) => (
                                <Button
                                    key={t.id}
                                    asChild
                                    size="sm"
                                    variant={team === t.id ? "default" : "outline"}
                                >
                                    <Link href={periodHref({ period: range.key, from, to, team: t.id })}>
                                        {t.name}
                                    </Link>
                                </Button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Výber (vedúci): celý tím / konkrétny člen */}
            {isLeaderView && leaderPeople.length > 0 && (
                <div className="mb-6 flex flex-wrap gap-2">
                    <Button asChild size="sm" variant={!scopeUserId ? "default" : "outline"}>
                        <Link href={periodHref({ period: range.key, from, to })}>Celý tím</Link>
                    </Button>
                    {leaderPeople.map((p) => (
                        <Button
                            key={p.id}
                            asChild
                            size="sm"
                            variant={scopeUserId === p.id ? "default" : "outline"}
                        >
                            <Link href={periodHref({ period: range.key, from, to, userId: p.id })}>
                                {p.name}
                                {p.isLeader ? " (vedúci)" : ""}
                            </Link>
                        </Button>
                    ))}
                </div>
            )}

            <section className="space-y-6">
                {/* Call overview – len manager/admin */}
                {showCallSections && callStats && (
                    <>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <StatCard label="Hovory" value={callStats.totalCalls} hint="zaznamenané vo fronte" />
                            <StatCard
                                label="Dovolané"
                                value={callStats.reached}
                                hint={`${callStats.reachRate} % z hovorov`}
                            />
                            <StatCard
                                label="Záujem"
                                value={callStats.interested}
                                hint="CP / návrh / email / pozitívne"
                            />
                            <StatCard label="Bez záujmu" value={callStats.notInterested} />
                        </div>

                        <div className="grid gap-6 lg:grid-cols-2">
                            <Card>
                                <CardHeader className="pb-3">
                                    <CardTitle className="text-base">Výsledky hovorov</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {callStats.totalCalls === 0 ? (
                                        <p className="text-sm text-muted-foreground">
                                            Žiadne hovory v tomto období.
                                        </p>
                                    ) : (
                                        OUTCOME_ORDER.map((outcome) => (
                                            <StatBar
                                                key={outcome}
                                                label={OUTCOME_LABEL[outcome]}
                                                count={callStats.byOutcome[outcome]}
                                                total={callStats.totalCalls}
                                                accent={
                                                    GOOD.includes(outcome)
                                                        ? "good"
                                                        : BAD.includes(outcome)
                                                          ? "bad"
                                                          : "muted"
                                                }
                                            />
                                        ))
                                    )}
                                </CardContent>
                            </Card>

                            {/* Počíta sa z toho, čo klienti naozaj pýtali (LeadRequest), nie z výsledku hovoru –
                                jeden hovor môže počítať vo viacerých obsahoch (wave 5 §6.5, R01-11). */}
                            <Card>
                                <CardHeader className="pb-3">
                                    <CardTitle className="text-base">Čo chceli</CardTitle>
                                </CardHeader>
                                <CardContent className="grid grid-cols-3 gap-4">
                                    {REQUEST_CONTENTS.map((c) => (
                                        <Mini key={c} label={REQUEST_CONTENT_LABEL[c]} value={demand?.byContent[c] ?? 0} />
                                    ))}
                                </CardContent>
                            </Card>
                        </div>

                        <div className="grid items-start gap-6 lg:grid-cols-2">
                            <Card>
                                <CardHeader className="pb-3">
                                    <CardTitle className="text-base">Heatmapa volaní</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <ActivityHeatmap
                                        data={callsDaily}
                                        palette="sky"
                                        noun="hovory"
                                        label={`Koľko hovorov sa uskutočnilo v ktorý deň · ${heatmapLabel}`}
                                    />
                                </CardContent>
                            </Card>

                            {perUser.length > 0 && (
                                <Card>
                                    <CardHeader className="pb-3">
                                        <CardTitle className="text-base">Výkon podľa volajúceho</CardTitle>
                                    </CardHeader>
                                    <CardContent className="px-0">
                                        <Table>
                                            <TableHeader>
                                                <TableRow>
                                                    <TableHead className="pl-(--card-spacing)">Volajúci</TableHead>
                                                    <TableHead className="text-right">Hovory</TableHead>
                                                    <TableHead className="text-right">Dovolané</TableHead>
                                                    <TableHead className="text-right">Záujem</TableHead>
                                                    <TableHead className="pr-(--card-spacing) text-right">Bez záujmu</TableHead>
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {perUser.map((u) => (
                                                    <TableRow key={u.userId}>
                                                        <TableCell className="pl-(--card-spacing) font-medium">{u.name}</TableCell>
                                                        <TableCell className="text-right tabular-nums">{u.calls}</TableCell>
                                                        <TableCell className="text-right tabular-nums">{u.reached}</TableCell>
                                                        <TableCell className="text-right tabular-nums">{u.interested}</TableCell>
                                                        <TableCell className="pr-(--card-spacing) text-right tabular-nums">
                                                            {u.notInterested}
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    </>
                )}

                {/* Pridané kontakty – vidia všetci s prístupom na štatistiky */}
                <div>
                    <h2 className="mb-1 text-lg font-semibold tracking-tight">Pridané kontakty</h2>
                    <p className="mb-4 text-sm text-muted-foreground">
                        {isLeaderView
                            ? `Nové firmy pridané tímom${teamName ? ` ${teamName}` : ""} · ${range.label}.`
                            : `Nové firmy pridané do databázy · ${range.label}.`}
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <StatCard label="Pridané" value={contactsAdded.total} hint={range.label} />
                    </div>

                    <div className="mt-4 grid items-start gap-6 lg:grid-cols-2">
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Heatmapa pridávania</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ActivityHeatmap
                                    data={addsDaily}
                                    palette="emerald"
                                    noun="pridané"
                                    label={`Koľko kontaktov sa pridalo v ktorý deň · ${heatmapLabel}`}
                                />
                            </CardContent>
                        </Card>

                        {showPerUserBreakdown && contactsAdded.perUser.length > 0 && (
                            <Card>
                                <CardHeader className="pb-3">
                                    <CardTitle className="text-base">Podľa používateľa</CardTitle>
                                </CardHeader>
                                <CardContent className="px-0">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead className="pl-(--card-spacing)">Používateľ</TableHead>
                                                <TableHead className="pr-(--card-spacing) text-right">Pridané</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {contactsAdded.perUser.map((u) => (
                                                <TableRow key={u.userId}>
                                                    <TableCell className="pl-(--card-spacing) font-medium">{u.name}</TableCell>
                                                    <TableCell className="pr-(--card-spacing) text-right tabular-nums">
                                                        {u.count}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </div>

                {/* História pridávania – prvý/posledný kontakt za deň */}
                {showAddingLog && (
                    <div>
                        <h2 className="mb-1 text-lg font-semibold tracking-tight">História pridávania</h2>
                        <p className="mb-4 text-sm text-muted-foreground">
                            Prvý a posledný pridaný kontakt v daný deň + počet · {range.label}.
                        </p>
                        {addingLog.length === 0 ? (
                            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                                {scopeUserId
                                    ? "Vybraná osoba v tomto období nepridala žiadny kontakt."
                                    : "V tomto období nikto z tímu nepridal kontakt."}
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {addingLog.map((u) => (
                                    <AddingLogCard key={u.userId} user={u} />
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Contact pool – len manager/admin */}
                {showPool && pool && (
                    <div>
                        <h2 className="mb-1 text-lg font-semibold tracking-tight">Databáza kontaktov</h2>
                        <p className="mb-4 text-sm text-muted-foreground">
                            Aktuálny stav – nezávislé od zvoleného obdobia.
                        </p>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <StatCard label="Všetky kontakty" value={pool.total} />
                            <StatCard
                                label="Ešte nevolané"
                                value={pool.uncalled}
                                hint={`${pool.unassignedUncalled} nepriradených`}
                            />
                            <StatCard label="Vyhrané" value={pool.byStatus.WON} />
                            <StatCard
                                label="Hodnota vyhraných"
                                value={`${pool.wonValue.toLocaleString("sk-SK")} €`}
                            />
                        </div>

                        <div className="mt-4 grid gap-6 lg:grid-cols-2">
                            <Card>
                                <CardHeader className="pb-3">
                                    <CardTitle className="text-base">Podľa stavu</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {STATUS_ORDER.map((status) => (
                                        <StatBar
                                            key={status}
                                            label={STATUS_LABEL[status]}
                                            count={pool.byStatus[status]}
                                            total={pool.total}
                                            accent="muted"
                                        />
                                    ))}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader className="pb-3">
                                    <CardTitle className="text-base">Nevolané – priradenie</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2 text-sm">
                                    <div className="flex items-center justify-between">
                                        <span className="text-muted-foreground">Nepriradené (spoločný fond)</span>
                                        <span className="font-medium tabular-nums">{pool.unassignedUncalled}</span>
                                    </div>
                                    {pool.assignedUncalled.length > 0 ? (
                                        pool.assignedUncalled.map((u) => (
                                            <div key={u.userId} className="flex items-center justify-between">
                                                <span>{u.name}</span>
                                                <span className="font-medium tabular-nums">{u.count}</span>
                                            </div>
                                        ))
                                    ) : (
                                        <p className="text-xs text-muted-foreground">
                                            Kontakty zatiaľ nie sú priradené konkrétnym volajúcim. Pripravené na
                                            neskôr, keď bude volať viac ľudí.
                                        </p>
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                )}

                {canViewAll && (
                    <p className="text-xs text-muted-foreground">
                        TODO: štatistiky z pipeline (konverzia záujem → vyhraté, reálne platby) pribudnú neskôr.
                    </p>
                )}
            </section>
        </DashboardPage>
    );
}

function periodHref({
    period,
    from,
    to,
    userId,
    team,
}: {
    period: string;
    from?: string;
    to?: string;
    userId?: string;
    team?: string;
}) {
    const sp = new URLSearchParams({ period });
    if (period === "custom") {
        if (from) sp.set("from", from);
        if (to) sp.set("to", to);
    }
    if (userId) sp.set("userId", userId);
    if (team) sp.set("team", team);
    return `/dashboard/stats?${sp.toString()}`;
}

function Mini({ label, value }: { label: string; value: number }) {
    return (
        <div className="space-y-0.5">
            <p className="text-2xl font-semibold tabular-nums">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
        </div>
    );
}

function fmtDay(dateKey: string) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("sk-SK", {
        weekday: "short",
        day: "numeric",
        month: "numeric",
    });
}

function fmtTime(iso: string) {
    return new Date(iso).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
}

function AddingLogCard({ user }: { user: AddingByUser }) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base">{user.name}</CardTitle>
                <span className="text-sm text-muted-foreground tabular-nums">{user.total} pridaných</span>
            </CardHeader>
            <CardContent className="px-0">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="pl-(--card-spacing)">Deň</TableHead>
                            <TableHead className="text-right">Počet</TableHead>
                            <TableHead className="text-right">Prvý</TableHead>
                            <TableHead className="pr-(--card-spacing) text-right">Posledný</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {user.days.map((d) => (
                            <TableRow key={d.date}>
                                <TableCell className="pl-(--card-spacing)">{fmtDay(d.date)}</TableCell>
                                <TableCell className="text-right tabular-nums">{d.count}</TableCell>
                                <TableCell className="text-right tabular-nums text-muted-foreground">
                                    {fmtTime(d.firstAt)}
                                </TableCell>
                                <TableCell className="pr-(--card-spacing) text-right tabular-nums text-muted-foreground">
                                    {fmtTime(d.lastAt)}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}
