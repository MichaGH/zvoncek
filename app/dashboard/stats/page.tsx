import { auth } from "@/auth";
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
    getContactPoolStats,
    getContactsAddedStats,
    getStatsUsers,
} from "@/lib/queries/stats";
import { OUTCOME_LABEL, STATUS_LABEL } from "@/lib/dictionaries";
import { resolveRange, toDateInput } from "@/lib/stats/range";
import type { CallOutcome, LeadStatus } from "@/app/generated/prisma/enums";
import Link from "next/link";

// Order outcomes as a rough funnel for the breakdown.
const OUTCOME_ORDER: CallOutcome[] = [
    "WANTS_QUOTE",
    "WANTS_DESIGN",
    "WANTS_EMAIL",
    "POSITIVE",
    "CALL_AGAIN",
    "SNOOZE",
    "NOT_INTERESTED",
    "NO_ANSWER",
    "BAD_NUMBER",
];

const GOOD: CallOutcome[] = ["WANTS_QUOTE", "WANTS_DESIGN", "WANTS_EMAIL", "POSITIVE"];
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
    searchParams: Promise<{ period?: string; from?: string; to?: string; userId?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) return null;

    const { period, from, to, userId } = await searchParams;
    const role = (session.user as typeof session.user & { role?: string }).role;
    const canFilterUsers = role === "ADMIN" || role === "MANAGER";

    // Members can only ever see their own call numbers.
    const selectedUserId = canFilterUsers ? userId : session.user.id;
    const range = resolveRange({ period, from, to });

    const [callStats, perUser, pool, contactsAdded, users] = await Promise.all([
        getCallStats({ range, userId: selectedUserId }),
        canFilterUsers ? getCallStatsByUser({ range }) : Promise.resolve([]),
        getContactPoolStats(),
        getContactsAddedStats({ range, userId: selectedUserId }),
        canFilterUsers ? getStatsUsers() : Promise.resolve([]),
    ]);

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Štatistiky"
                description={`Volania marketingu · ${range.label}`}
            >
                <StatsPeriodPicker
                    current={range.key}
                    userId={selectedUserId}
                    from={toDateInput(range.from)}
                    to={range.to ? toDateInput(new Date(range.to.getTime() - 1)) : ""}
                />
            </DashboardPageHeader>

            {canFilterUsers && (
                <div className="mb-6 flex flex-wrap gap-2">
                    <Button asChild size="sm" variant={!selectedUserId ? "default" : "outline"}>
                        <Link href={periodHref({ period: range.key, from, to })}>Všetci</Link>
                    </Button>
                    {users.map((user) => (
                        <Button
                            key={user.id}
                            asChild
                            size="sm"
                            variant={selectedUserId === user.id ? "default" : "outline"}
                        >
                            <Link href={periodHref({ period: range.key, from, to, userId: user.id })}>
                                {user.firstName} {user.lastName}
                            </Link>
                        </Button>
                    ))}
                </div>
            )}

            <section className="space-y-6">
                {/* Call overview */}
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

                {/* Outcome breakdown + quick wants */}
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

                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">Čo chceli</CardTitle>
                        </CardHeader>
                        <CardContent className="grid grid-cols-3 gap-4">
                            <Mini label="Cenová ponuka" value={callStats.byOutcome.WANTS_QUOTE} />
                            <Mini label="Návrh" value={callStats.byOutcome.WANTS_DESIGN} />
                            <Mini label="Email" value={callStats.byOutcome.WANTS_EMAIL} />
                        </CardContent>
                    </Card>
                </div>

                {/* Per-user performance (managers, all users) */}
                {canFilterUsers && !selectedUserId && perUser.length > 0 && (
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

                {/* Contacts added in the selected range (data-entry productivity) */}
                <div>
                    <h2 className="mb-1 text-lg font-semibold tracking-tight">Pridané kontakty</h2>
                    <p className="mb-4 text-sm text-muted-foreground">
                        Nové firmy pridané do databázy · {range.label}.
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <StatCard label="Pridané" value={contactsAdded.total} hint={range.label} />
                    </div>

                    {canFilterUsers && !selectedUserId && contactsAdded.perUser.length > 0 && (
                        <Card className="mt-4">
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

                {/* Contact pool (company-wide, not time-bound) */}
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

                <p className="text-xs text-muted-foreground">
                    TODO: štatistiky z pipeline (konverzia záujem → vyhraté, reálne platby) pribudnú neskôr.
                </p>
            </section>
        </DashboardPage>
    );
}

function periodHref({
    period,
    from,
    to,
    userId,
}: {
    period: string;
    from?: string;
    to?: string;
    userId?: string;
}) {
    const sp = new URLSearchParams({ period });
    if (period === "custom") {
        if (from) sp.set("from", from);
        if (to) sp.set("to", to);
    }
    if (userId) sp.set("userId", userId);
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
