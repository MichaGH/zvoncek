import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { OUTCOME_LABEL } from "@/lib/dictionaries";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";
import { getCallHistory, getCallHistoryUsers } from "@/lib/queries/calls/history";
import { can } from "@/lib/permissions";
import { requireUser } from "@/lib/access/user";
import { redirect } from "next/navigation";
import HistoryRowActions from "@/components/calls/HistoryRowActions";
import Link from "next/link";

export default async function CallsHistoryPage({
    searchParams,
}: {
    searchParams: Promise<{ userId?: string }>;
}) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "callHistory.access")) redirect("/dashboard");

    const { userId } = await searchParams;
    const canFilterUsers = can(viewer, "callHistory.viewAll");
    // Manageri: konkrétny user alebo „Všetci" (null). Ostatní vždy len svoje.
    const selectedUserId = canFilterUsers
        ? userId && userId !== "all"
            ? userId
            : null
        : viewer.id;
    const [rows, users] = await Promise.all([
        getCallHistory(viewer, selectedUserId),
        canFilterUsers ? getCallHistoryUsers() : Promise.resolve([]),
    ]);

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="História volaní"
                description="Iba marketingové hovory zaznamenané z fronty volaní"
                backHref="/dashboard/calls"
            />

            {canFilterUsers && (
                <div className="mb-4 flex flex-wrap gap-2">
                    <Button asChild size="sm" variant={selectedUserId === null ? "default" : "outline"}>
                        <Link href="/dashboard/calls/history?userId=all">Všetci</Link>
                    </Button>
                    {users.map((user) => (
                        <Button
                            key={user.id}
                            asChild
                            size="sm"
                            variant={selectedUserId === user.id ? "default" : "outline"}
                        >
                            <Link href={`/dashboard/calls/history?userId=${user.id}`}>
                                {user.firstName} {user.lastName}
                            </Link>
                        </Button>
                    ))}
                </div>
            )}

            {rows.length === 0 ? (
                <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                    Žiadne hovory v histórii.
                </div>
            ) : (
                <>
                    {/* POZOR: dve rozloženia z jedného `rows` – mobilné karty (md:hidden)
                        a desktop tabuľka (hidden md:block). Zmenu obsahu/formátu rob v OBOCH. */}

                    {/* MOBILE: karty */}
                    <div className="flex flex-col gap-3 md:hidden">
                        {rows.map((row) => (
                            <div key={row.id} className="rounded-xl border bg-card p-4 shadow-sm">
                                <div className="flex items-start justify-between gap-3">
                                    <LeadName row={row} />
                                    {row.outcome && (
                                        <Badge variant={row.reverted ? "outline" : "secondary"} className={row.reverted ? "shrink-0 line-through" : "shrink-0"}>
                                            {OUTCOME_LABEL[row.outcome]}
                                        </Badge>
                                    )}
                                </div>
                                {/* Wave 5, Q2: čo chceli, sa nedá vyčítať z výsledku – je to samostatný riadok. */}
                                {row.asked && <div className="mt-1 text-xs text-muted-foreground">Chceli: {row.asked}</div>}
                                <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                                    {new Date(row.createdAt).toLocaleString("sk-SK", { timeZone: BUSINESS_TZ })} · {row.user.firstName}{" "}
                                    {row.user.lastName}
                                </div>
                                {row.note && (
                                    <p className="mt-2 text-sm text-muted-foreground">{row.note}</p>
                                )}
                                <div className="mt-3 border-t pt-3">
                                    <HistoryRowActions
                                        activityId={row.id}
                                        leadId={row.lead.id}
                                        leadRevision={row.lead.revision}
                                        canRevert={row.canRevert}
                                        canEdit={row.canEdit}
                                        reverted={row.reverted}
                                        phone={row.lead.phone}
                                        email={row.lead.email}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* DESKTOP: tabuľka */}
                    <div className="hidden overflow-hidden rounded-lg border md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Kedy</TableHead>
                                    <TableHead>Firma</TableHead>
                                    <TableHead>Výsledok</TableHead>
                                    <TableHead>Poznámka</TableHead>
                                    <TableHead>Volal</TableHead>
                                    <TableHead>Akcie</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row) => (
                                    <TableRow key={row.id}>
                                        <TableCell className="whitespace-nowrap text-muted-foreground">
                                            {new Date(row.createdAt).toLocaleString("sk-SK", { timeZone: BUSINESS_TZ })}
                                        </TableCell>
                                        <TableCell>
                                            <LeadName row={row} />
                                        </TableCell>
                                        <TableCell>
                                            {row.outcome && (
                                                <Badge variant={row.reverted ? "outline" : "secondary"} className={row.reverted ? "line-through" : undefined}>
                                                    {OUTCOME_LABEL[row.outcome]}
                                                </Badge>
                                            )}
                                            {row.reverted && (
                                                <Badge variant="outline" className="ml-1">vrátené</Badge>
                                            )}
                                            {row.asked && <div className="mt-1 text-xs text-muted-foreground">Chceli: {row.asked}</div>}
                                        </TableCell>
                                        <TableCell className="max-w-sm whitespace-normal text-muted-foreground">
                                            {row.note ?? "—"}
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap">
                                            {row.user.firstName} {row.user.lastName}
                                        </TableCell>
                                        <TableCell>
                                            <HistoryRowActions
                                                activityId={row.id}
                                                leadId={row.lead.id}
                                                leadRevision={row.lead.revision}
                                                canRevert={row.canRevert}
                                                canEdit={row.canEdit}
                                                reverted={row.reverted}
                                                phone={row.lead.phone}
                                                email={row.lead.email}
                                            />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </>
            )}
        </DashboardPage>
    );
}

type HistoryRow = Awaited<ReturnType<typeof getCallHistory>>[number];

// Názov firmy – odkaz na detail obchodu (/dashboard/pipeline/[id]) podľa práv, inak text. Zdieľané
// medzi mobilnou kartou a desktop tabuľkou.
function LeadName({ row }: { row: HistoryRow }) {
    const label = `#${row.lead.number} ${row.lead.companyName ?? row.lead.website ?? "Bez mena"}`;
    return row.lead.href ? (
        <Link href={row.lead.href} className="min-w-0 font-medium hover:underline">
            {label}
        </Link>
    ) : (
        <span className="min-w-0 font-medium">{label}</span>
    );
}
