import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import RefreshButton from "@/components/dashboard/RefreshButton";
import ClientsBoard from "@/components/clients/ClientsBoard";
import ClientsSearch from "@/components/clients/ClientsSearch";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/access/user";
import { can } from "@/lib/permissions";
import { ARCHIVE_PAGE, getClientsArchive, getClientsBoard, SEARCH_PAGE } from "@/lib/queries/clients";

export default async function ClientsPage({
    searchParams,
}: {
    searchParams: Promise<{ q?: string; archive?: string; limit?: string }>;
}) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "clients.view")) redirect("/dashboard");
    const { q, archive, limit } = await searchParams;
    const isArchive = archive === "1";

    if (isArchive) {
        const take = Number(limit) > 0 ? Number(limit) : ARCHIVE_PAGE;
        const { rows, hasMore } = await getClientsArchive(viewer, { q, take });
        const more = new URLSearchParams({ archive: "1", limit: String(take + ARCHIVE_PAGE) });
        if (q) more.set("q", q);
        return (
            <DashboardPage>
                <DashboardPageHeader
                    title="Archív klientov"
                    description="Uzavreté obchody staršie ako 90 dní"
                    backHref="/dashboard/clients"
                    backLabel="Moji klienti"
                    actions={<ClientsSearch query={q} archive />}
                />
                <ClientsBoard board={{ mode: "search", results: rows }} canWork={can(viewer, "clients.work")} />
                {hasMore && (
                    <div className="mt-4 flex justify-center">
                        <Button asChild variant="outline">
                            <Link href={`/dashboard/clients?${more.toString()}`}>Načítať ďalších {ARCHIVE_PAGE}</Link>
                        </Button>
                    </div>
                )}
            </DashboardPage>
        );
    }

    const searchTake = Number(limit) > 0 ? Number(limit) : SEARCH_PAGE;
    const board = await getClientsBoard(viewer, { q, take: searchTake });
    const moreSearch = new URLSearchParams({ q: q ?? "", limit: String(searchTake + SEARCH_PAGE) });
    const description =
        board.mode === "board"
            ? `${board.counts.open} otvorených · ${board.counts.today} na dnes · ${board.counts.overdue} po termíne`
            : `Výsledky hľadania: ${board.results.length}`;

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Moji klienti"
                description={description}
                actions={
                    <>
                        <ClientsSearch query={q} />
                        <RefreshButton />
                    </>
                }
            />
            <ClientsBoard board={board} canWork={can(viewer, "clients.work")} />
            {board.mode === "search" && board.hasMore && (
                <div className="mt-4 flex justify-center">
                    <Button asChild variant="outline">
                        <Link href={`/dashboard/clients?${moreSearch.toString()}`}>Načítať ďalších {SEARCH_PAGE}</Link>
                    </Button>
                </div>
            )}
            <div className="mt-8 flex justify-center">
                <Button asChild variant="ghost" size="sm">
                    <Link href="/dashboard/clients?archive=1">Archív</Link>
                </Button>
            </div>
        </DashboardPage>
    );
}
