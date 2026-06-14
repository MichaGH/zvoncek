import Link from "next/link";
import { auth } from "@/auth";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import ContactsSearch from "@/components/contacts/ContactsSearch";
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
import { Plus } from "lucide-react";

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
    searchParams: Promise<{ q?: string; limit?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) return null;

    const { q, limit } = await searchParams;
    const parsedLimit = Number(limit);
    const take =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : CONTACTS_PAGE_SIZE;

    // Scout (bez contacts.viewAll) vidí len svoje pridané kontakty.
    const scopeToOwn = !can(session.user, "contacts.viewAll");
    const createdById = scopeToOwn ? session.user.id : undefined;
    const canViewPipeline = can(session.user, "pipeline.view");

    const [{ rows, hasMore }, overview] = await Promise.all([
        getContactsList({ query: q, take, createdById }),
        getContactsOverview(createdById),
    ]);

    const moreParams = new URLSearchParams();
    if (q) moreParams.set("q", q);
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
                <ContactsSearch query={q} />
            </DashboardPageHeader>

            <div className="mb-3 text-sm text-muted-foreground">
                {rows.length} {hasMore ? "+ záznamov" : "záznamov"}
            </div>

            <div className="overflow-x-auto rounded-lg border">
                <Table className="min-w-[760px]">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-16">#</TableHead>
                            <TableHead>Firma</TableHead>
                            <TableHead>Telefón</TableHead>
                            <TableHead>Stav</TableHead>
                            <TableHead>Pridal</TableHead>
                            <TableHead className="text-right">Pridané</TableHead>
                            <TableHead className="w-20 text-right">Akcie</TableHead>
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
                                        {canViewPipeline ? (
                                            <Link
                                                href={`/dashboard/pipeline/${row.id}`}
                                                className="block truncate font-medium hover:underline"
                                            >
                                                {row.name}
                                            </Link>
                                        ) : (
                                            <span className="block truncate font-medium">{row.name}</span>
                                        )}
                                        {row.website && (
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {row.website}
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
                                    <TableCell className="text-right">
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
