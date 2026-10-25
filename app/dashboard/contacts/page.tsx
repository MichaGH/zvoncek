import Link from "next/link";
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
import { CONTACTS_PAGE_SIZE, getContactsList, getContactsOverview, getContactsViewCounts } from "@/lib/queries/contacts";
import {
    CONTACT_VIEWS,
    CONTACT_VIEW_LABEL,
    DEFAULT_CONTACT_ROUND,
    DEFAULT_CONTACT_VIEW,
    parseContactRound,
    parseContactView,
    type ContactRound,
    type ContactView,
} from "@/lib/domain/contactFilters";
import { STATUS_LABEL, STATUS_VARIANT } from "@/lib/dictionaries";
import { can } from "@/lib/permissions";
import { requireUser } from "@/lib/access/user";
import { redirect } from "next/navigation";
import { getUserOptions } from "@/lib/queries/users";
import { getTeamOptions, getTeamPeople, getTeamScopeForLeader } from "@/lib/queries/teams";
import { cn } from "@/lib/utils";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";
import { Plus, StickyNote } from "lucide-react";

function toHref(website: string): string {
    return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

// „2. kolo" – recyklovaný kontakt (feature 02 §15); rovnaké slovo ako na tabuli volajúceho.
function RoundBadge({ round }: { round: number }) {
    if (round < 2) return null;
    return (
        <Badge variant="secondary" className="whitespace-nowrap">
            {round}. kolo
        </Badge>
    );
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("sk-SK", {
        timeZone: BUSINESS_TZ,
        day: "numeric",
        month: "numeric",
        year: "numeric",
    });
}

export default async function ContactsPage({
    searchParams,
}: {
    searchParams: Promise<{
        q?: string;
        limit?: string;
        createdBy?: string;
        assignedTo?: string;
        owner?: string;
        team?: string;
        view?: string;
        round?: string;
    }>;
}) {
    const viewer = await requireUser();
    if (!viewer) redirect("/login?deactivated=1");
    if (!can(viewer, "contacts.access")) redirect("/dashboard");

    const { q, limit, createdBy, assignedTo, owner, team, view: rawView, round: rawRound } = await searchParams;
    const view = parseContactView(rawView);
    const round = parseContactRound(rawRound);
    const parsedLimit = Number(limit);
    const take =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : CONTACTS_PAGE_SIZE;

    const canViewAll = can(viewer, "contacts.viewAll"); // manager/admin
    const canViewTeam = can(viewer, "contacts.viewTeam"); // vedúci pridávačov

    // Scope sa vždy vyhodnotí server-side: použije sa práve jedno z
    // createdById / createdByIds. Vedúci nikdy nevidí mimo svojho tímu.
    let createdById: string | undefined;
    let createdByIds: string[] | undefined;
    let assignedCallerId: string | undefined;
    let ownerId: string | undefined;

    let filterUsers: { id: string; firstName: string; lastName: string }[] = [];
    let filterTeams: { id: string; name: string }[] = [];
    let showCreatedByFilter = false;
    let showOwnerFilter = false;
    let createdByLabel = "Všetci (od koho)";

    if (canViewAll) {
        // Manager/admin: voľný pohľad + filtre (človek, tím, assigned).
        assignedCallerId = assignedTo || undefined;
        ownerId = owner || undefined;
        if (createdBy) {
            createdById = createdBy;
        } else if (team) {
            const tp = await getTeamPeople(team);
            createdByIds = tp?.ids ?? [];
        }
        const [allUsers, allTeams] = await Promise.all([getUserOptions(), getTeamOptions()]);
        filterUsers = allUsers;
        filterTeams = allTeams;
        showCreatedByFilter = true;
        showOwnerFilter = true;
    } else if (canViewTeam) {
        // Vedúci: len jeho tím. Drill na konkrétneho člena je obmedzený na tím.
        const scope = await getTeamScopeForLeader(viewer.id);
        const teamIds = scope?.ids ?? [viewer.id];
        if (createdBy && teamIds.includes(createdBy)) {
            createdById = createdBy;
        } else {
            createdByIds = teamIds;
        }
        filterUsers = (scope?.people ?? []).map((p) => ({
            id: p.id,
            firstName: p.name,
            lastName: "",
        }));
        showCreatedByFilter = true;
        createdByLabel = "Celý tím";
    } else {
        // Scout: len vlastné pridané.
        createdById = viewer.id;
    }

    const filter = { query: q, createdById, createdByIds, assignedCallerId, ownerId, round };
    const [{ rows, hasMore }, overview, viewCounts] = await Promise.all([
        getContactsList({ ...filter, view, take }),
        getContactsOverview(createdById ? { createdById } : { createdByIds }),
        getContactsViewCounts(filter),
    ]);

    // Odkazy nesú všetky filtre; zmena pohľadu vracia stránkovanie na začiatok.
    function contactsHref(patch: { view?: ContactView; round?: ContactRound; limit?: number } = {}) {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (createdBy) params.set("createdBy", createdBy);
        if (assignedTo) params.set("assignedTo", assignedTo);
        if (owner) params.set("owner", owner);
        if (team) params.set("team", team);
        const nextView = patch.view ?? view;
        const nextRound = patch.round ?? round;
        if (nextView !== DEFAULT_CONTACT_VIEW) params.set("view", nextView);
        if (nextRound !== DEFAULT_CONTACT_ROUND) params.set("round", nextRound);
        if (patch.limit) params.set("limit", String(patch.limit));
        const qs = params.toString();
        return `/dashboard/contacts${qs ? `?${qs}` : ""}`;
    }
    const isPool = view === "pool";

    return (
        <DashboardPage>
            <DashboardPageHeader
                title="Kontakty"
                description={
                    <>
                        <Link href={contactsHref({ view: "pool" })} className="underline-offset-2 hover:underline">
                            {overview.callable} voľných na volanie
                        </Link>
                        {` · ${overview.total} v databáze · dnes pridaných ${overview.addedToday}`}
                    </>
                }
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
                    owner={owner}
                    team={team}
                    users={filterUsers}
                    teams={filterTeams}
                    showCreatedByFilter={showCreatedByFilter}
                    showOwnerFilter={showOwnerFilter}
                    createdByLabel={createdByLabel}
                    view={view}
                    round={round}
                />
            </DashboardPageHeader>

            {/* Pohľad (feature 02 §15): Pridané = podľa pridania; Na volanie = spoločná fronta v poradí volajúceho. */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
                    {CONTACT_VIEWS.map((v) => (
                        <Link
                            key={v}
                            href={contactsHref({ view: v })}
                            aria-current={v === view ? "page" : undefined}
                            className={cn(
                                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                                v === view ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                            )}
                        >
                            {CONTACT_VIEW_LABEL[v]}
                            <span className="text-xs tabular-nums text-muted-foreground">{viewCounts[v]}</span>
                        </Link>
                    ))}
                </div>
                <div className="text-sm text-muted-foreground">
                    {isPool
                        ? "V poradí, v akom ich dostane volajúci („Vziať ďalších 10“)."
                        : `${rows.length} ${hasMore ? "+ záznamov" : "záznamov"}`}
                </div>
            </div>

            {rows.length === 0 ? (
                <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                    {q ? "Nič sa nenašlo." : isPool ? "Nič nečaká na volanie." : "Zatiaľ žiadne kontakty."}
                </div>
            ) : (
                <>
                    {/* POZOR: dve rozloženia z jedného `rows` – mobilné karty (md:hidden)
                        a desktop tabuľka (hidden md:block). Zmenu obsahu rob v OBOCH. */}

                    {/* MOBILE: karty */}
                    <div className="flex flex-col gap-3 md:hidden">
                        {rows.map((row, index) => (
                            <div
                                key={row.id}
                                className={cn(
                                    "rounded-xl border bg-card p-4 shadow-sm",
                                    !row.callable && "opacity-60",
                                )}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
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
                                        <span className="mt-0.5 block text-sm text-muted-foreground tabular-nums">
                                            {row.phone ?? "—"}
                                        </span>
                                    </div>
                                    <div className="flex shrink-0 flex-col items-end gap-2">
                                        <div className="flex items-center gap-1">
                                            <RoundBadge round={row.round} />
                                            <Badge variant={STATUS_VARIANT[row.status]}>
                                                {STATUS_LABEL[row.status]}
                                            </Badge>
                                        </div>
                                        <ContactRowActions
                                            contact={{
                                                id: row.id,
                                                number: row.number,
                                                companyName: row.companyName,
                                                website: row.website,
                                                phone: row.phone,
                                                note: row.note,
                                            }}
                                            locked={!row.editable}
                                        />
                                    </div>
                                </div>
                                <div className="mt-3 border-t pt-2 text-xs text-muted-foreground tabular-nums">
                                    {isPool && <span className="font-medium text-foreground">{index + 1}. v poradí · </span>}
                                    #{row.number} · {row.addedBy ?? "—"} · {formatDate(row.createdAt)}
                                    {row.recycledAt && ` · recykl. ${formatDate(row.recycledAt)}`}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* DESKTOP: tabuľka */}
                    <div className="hidden overflow-x-auto rounded-lg border md:block">
                        <Table className="min-w-[760px]">
                            <TableHeader>
                                <TableRow>
                                    {isPool && <TableHead className="w-16 text-right">Poradie</TableHead>}
                                    <TableHead className="w-10">#</TableHead>
                                    <TableHead>Firma</TableHead>
                                    <TableHead className="w-36">Telefón</TableHead>
                                    <TableHead className="w-36">Stav</TableHead>
                                    <TableHead className="w-28">Pridal</TableHead>
                                    <TableHead className="w-28 text-right">Pridané</TableHead>
                                    <TableHead className="w-20 text-center">Akcie</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row, index) => (
                                    <TableRow key={row.id} className={row.callable ? "" : "opacity-60"}>
                                        {isPool && (
                                            <TableCell className="text-right font-medium tabular-nums">{index + 1}.</TableCell>
                                        )}
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
                                            <div className="flex items-center gap-1">
                                                <Badge variant={STATUS_VARIANT[row.status]}>
                                                    {STATUS_LABEL[row.status]}
                                                </Badge>
                                                <RoundBadge round={row.round} />
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">{row.addedBy ?? "—"}</TableCell>
                                        <TableCell className="text-right text-muted-foreground tabular-nums">
                                            {formatDate(row.createdAt)}
                                            {row.recycledAt && (
                                                <span className="block text-xs">recykl. {formatDate(row.recycledAt)}</span>
                                            )}
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
                                                locked={!row.editable}
                                            />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </>
            )}

            {hasMore && (
                <div className="mt-4 flex justify-center">
                    <Button asChild variant="outline">
                        <Link href={contactsHref({ limit: take + CONTACTS_PAGE_SIZE })}>
                            Načítať ďalších {CONTACTS_PAGE_SIZE}
                        </Link>
                    </Button>
                </div>
            )}
        </DashboardPage>
    );
}
