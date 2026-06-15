import Link from "next/link";
import { auth } from "@/auth";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import ContactsFilterBar from "@/components/contacts/ContactsFilterBar";
import ContactRowActions from "@/components/contacts/ContactRowActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { CONTACTS_PAGE_SIZE, getContactsList, getContactsOverview } from "@/lib/queries/contacts";
import { STATUS_LABEL, STATUS_VARIANT } from "@/lib/dictionaries";
import { can } from "@/lib/permissions";
import { getUserOptions } from "@/lib/queries/users";
import { Plus, StickyNote } from "lucide-react";

function toHref(website: string): string {
    return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("sk-SK", {
        day: "numeric",
        month: "numeric",
        year: "numeric",
    });
}

export default async function ContactsPage({
    searchParams,
}: {
    searchParams: Promise<{ q?: string; limit?: string; createdBy?: string; assignedTo?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) return null;

    const { q, limit, createdBy, assignedTo } = await searchParams;
    const parsedLimit = Number(limit);
    const take =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : CONTACTS_PAGE_SIZE;

    const isManager = can(session.user, "contacts.viewAll");
    const scopeToOwn = !isManager;
    const effectiveCreatedById = scopeToOwn ? session.user.id : (createdBy || undefined);
    const effectiveOwnerId = isManager ? (assignedTo || undefined) : undefined;

    const fetchUsers = isManager ? getUserOptions() : Promise.resolve([]);
    const [{ rows, hasMore }, overview, users] = await Promise.all([
        getContactsList({ query: q, take, createdById: effectiveCreatedById, ownerId: effectiveOwnerId }),
        getContactsOverview(effectiveCreatedById),
        fetchUsers,
    ]);

    const moreParams = new URLSearchParams();
    if (q) moreParams.set("q", q);
    if (createdBy) moreParams.set("createdBy", createdBy);
    if (assignedTo) moreParams.set("assignedTo", assignedTo);
    moreParams.set("limit", String(take + CONTACTS_PAGE_SIZE));

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Kontakty"
                description={`${overview.callable} voľných na volanie · ${overview.total} v databáze · dnes pridaných ${overview.addedToday}`}
                actions={
                    <>
                        <RefreshButton />
                        <Button asChild>
                            <Link href="/dashboard/contacts/new">
                                <Plus className="h-4 w-4" />
                                Pridať kontakty
                            </Link>
                        </Button>
                    </>
                }
            >
                <ContactsFilterBar
                    query={q}
                    createdBy={createdBy}
                    assignedTo={assignedTo}
                    users={users}
                    showFilters={isManager}
                />
            </DashboardPageHeader>

            <div className="mb-3 text-sm text-muted-foreground">
                {rows.length} {hasMore ? "+ záznamov" : "záznamov"}
            </div>

            <div className="overflow-x-auto rounded-lg border">
                <Table className="min-w-[760px]">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-10">#</TableHead>
                            <TableHead>Firma</TableHead>
                            <TableHead className="w-36">Telefón</TableHead>
                            <TableHead className="w-28">Stav</TableHead>
                            <TableHead className="w-28">Pridal</TableHead>
                            <TableHead className="w-28 text-right">Pridané</TableHead>
                            <TableHead className="w-20 text-center">Akcie</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                                    {q ? "Nič sa nenašlo." : "Zatiaľ žiadne kontakty."}
                                </TableCell>
                            </TableRow>
                        ) : (
                            rows.map((row) => (
                                <TableRow key={row.id} className={row.callable ? "" : "opacity-60"}>
                                    <TableCell className="text-muted-foreground tabular-nums">
                                        {row.number}
                                    </TableCell>
                                    <TableCell className="max-w-0">
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {row.website ? (
                                                <a
                                                    href={toHref(row.website)}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="truncate font-medium hover:underline"
                                                >
                                                    {row.website}
                                                </a>
                                            ) : (
                                                <span className="truncate font-medium">{row.companyName ?? "—"}</span>
                                            )}
                                            {row.note && (
                                                <StickyNote className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                                            )}
                                        </div>
                                        {row.website && row.companyName && (
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {row.companyName}
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="tabular-nums">{row.phone ?? "—"}</TableCell>
                                    <TableCell>
                                        <Badge variant={STATUS_VARIANT[row.status]}>
                                            {STATUS_LABEL[row.status]}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">{row.addedBy ?? "—"}</TableCell>
                                    <TableCell className="text-right text-muted-foreground tabular-nums">
                                        {formatDate(row.createdAt)}
                                    </TableCell>
                                    <TableCell className="text-center">
                                        <ContactRowActions
                                            contact={{
                                                id: row.id,
                                                number: row.number,
                                                companyName: row.companyName,
                                                website: row.website,
                                                phone: row.phone,
                                                note: row.note,
                                            }}
                                            locked={!row.callable}
                                        />
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>

            {hasMore && (
                <div className="mt-4 flex justify-center">
                    <Button asChild variant="outline">
                        <Link href={`/dashboard/contacts?${moreParams.toString()}`}>
                            Načítať ďalších {CONTACTS_PAGE_SIZE}
                        </Link>
                    </Button>
                </div>
            )}
        </DashboardPage>
    );
}
