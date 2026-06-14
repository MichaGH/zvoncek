import { auth } from "@/auth";
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
import { getCallHistory, getCallHistoryUsers } from "@/lib/queries/calls/history";
import { can } from "@/lib/permissions";
import HistoryRowActions from "@/components/calls/HistoryRowActions";
import Link from "next/link";

export default async function CallsHistoryPage({
    searchParams,
}: {
    searchParams: Promise<{ userId?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) return null;

    const { userId } = await searchParams;
    const canFilterUsers = can(session.user, "callHistory.viewAll");
    const canViewPipeline = can(session.user, "pipeline.view");
    // Manageri: konkrétny user alebo „Všetci" (null). Ostatní vždy len svoje.
    const selectedUserId = canFilterUsers
        ? userId && userId !== "all"
            ? userId
            : null
        : session.user.id;
    const [rows, users] = await Promise.all([
        getCallHistory(selectedUserId),
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

            <div className="overflow-hidden rounded-lg border">
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
                        {rows.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                                    Žiadne hovory v histórii.
                                </TableCell>
                            </TableRow>
                        ) : (
                            rows.map((row) => (
                                <TableRow key={row.id}>
                                    <TableCell className="whitespace-nowrap text-muted-foreground">
                                        {new Date(row.createdAt).toLocaleString("sk-SK")}
                                    </TableCell>
                                    <TableCell>
                                        {canViewPipeline ? (
                                            <Link
                                                href={`/dashboard/pipeline/${row.lead.id}`}
                                                className="font-medium hover:underline"
                                            >
                                                #{row.lead.number}{" "}
                                                {row.lead.companyName ?? row.lead.website ?? "Bez mena"}
                                            </Link>
                                        ) : (
                                            <span className="font-medium">
                                                #{row.lead.number}{" "}
                                                {row.lead.companyName ?? row.lead.website ?? "Bez mena"}
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        {row.outcome && (
                                            <Badge variant="secondary">{OUTCOME_LABEL[row.outcome]}</Badge>
                                        )}
                                    </TableCell>
                                    <TableCell className="max-w-sm whitespace-normal text-muted-foreground">
                                        {row.note ?? "—"}
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap">
                                        {row.user.firstName} {row.user.lastName}
                                    </TableCell>
                                    <TableCell>
                                        <HistoryRowActions
                                            leadId={row.lead.id}
                                            locked={row.lead.locked}
                                            phone={row.lead.phone}
                                            email={row.lead.email}
                                        />
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
        </DashboardPage>
    );
}
