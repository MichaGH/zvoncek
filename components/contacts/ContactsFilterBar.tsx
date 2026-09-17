"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type User = { id: string; firstName: string; lastName: string };
type Team = { id: string; name: string };

type Props = {
    query?: string;
    createdBy?: string;
    assignedTo?: string;
    owner?: string;
    team?: string;
    users?: User[];
    teams?: Team[];
    // Ktoré filtre zobraziť. Manager: created+owner+team. Vedúci: len created (jeho tím).
    showCreatedByFilter?: boolean;
    showOwnerFilter?: boolean;
    createdByLabel?: string;
};

export default function ContactsFilterBar({
    query = "",
    createdBy = "",
    assignedTo = "",
    owner = "",
    team = "",
    users = [],
    teams = [],
    showCreatedByFilter = false,
    showOwnerFilter = false,
    createdByLabel = "Všetci (od koho)",
}: Props) {
    const router = useRouter();
    const [searchValue, setSearchValue] = useState(query);
    const [createdByValue, setCreatedByValue] = useState(createdBy);
    const [assignedToValue, setAssignedToValue] = useState(assignedTo);
    const [ownerValue, setOwnerValue] = useState(owner);
    const [teamValue, setTeamValue] = useState(team);

    function push(
        overrides: { q?: string; createdBy?: string; assignedTo?: string; owner?: string; team?: string } = {},
    ) {
        const q = overrides.q !== undefined ? overrides.q : searchValue;
        const cb = overrides.createdBy !== undefined ? overrides.createdBy : createdByValue;
        const ao = overrides.assignedTo !== undefined ? overrides.assignedTo : assignedToValue;
        const tm = overrides.team !== undefined ? overrides.team : teamValue;
        const ow = overrides.owner !== undefined ? overrides.owner : ownerValue;
        const params = new URLSearchParams();
        if (q.trim()) params.set("q", q.trim());
        if (cb) params.set("createdBy", cb);
        if (ao) params.set("assignedTo", ao);
        if (tm) params.set("team", tm);
        if (ow) params.set("owner", ow);
        router.push(`/dashboard/contacts?${params.toString()}`);
    }

    return (
        <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); push(); }}
        >
            <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={searchValue}
                    onChange={(e) => setSearchValue(e.target.value)}
                    placeholder="Hľadať firmu, web, telefón…"
                    className="pl-8"
                />
                {searchValue && (
                    <button
                        type="button"
                        aria-label="Vymazať hľadanie"
                        onClick={() => { setSearchValue(""); push({ q: "" }); }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                )}
            </div>

            {teams.length > 0 && (
                <Select
                    value={teamValue || "all-teams"}
                    onValueChange={(value) => {
                        const nextTeam = value === "all-teams" ? "" : value;
                        setTeamValue(nextTeam);
                        // výber tímu zruší filter na konkrétneho človeka
                        setCreatedByValue("");
                        push({ team: nextTeam, createdBy: "" });
                    }}
                >
                    <SelectTrigger className="h-9">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all-teams">Všetky tímy</SelectItem>
                        {teams.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                                {t.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            {showCreatedByFilter && (
                <Select
                    value={createdByValue || "all-creators"}
                    onValueChange={(value) => {
                        const nextCreatedBy = value === "all-creators" ? "" : value;
                        setCreatedByValue(nextCreatedBy);
                        push({ createdBy: nextCreatedBy });
                    }}
                >
                    <SelectTrigger className="h-9">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all-creators">{createdByLabel}</SelectItem>
                        {users.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                                {u.firstName} {u.lastName}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            {showOwnerFilter && (
                <Select
                    value={assignedToValue || "all-assignees"}
                    onValueChange={(value) => {
                        const nextAssignedTo = value === "all-assignees" ? "" : value;
                        setAssignedToValue(nextAssignedTo);
                        push({ assignedTo: nextAssignedTo });
                    }}
                >
                    <SelectTrigger className="h-9">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all-assignees">Volá: všetci</SelectItem>
                        {users.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                                Volá: {u.firstName} {u.lastName}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            {showOwnerFilter && (
                <Select
                    value={ownerValue || "all-owners"}
                    onValueChange={(value) => {
                        const nextOwner = value === "all-owners" ? "" : value;
                        setOwnerValue(nextOwner);
                        push({ owner: nextOwner });
                    }}
                >
                    <SelectTrigger className="h-9">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all-owners">Rieši obchod: všetci</SelectItem>
                        {users.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                                Rieši obchod: {u.firstName} {u.lastName}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            <Button type="submit" size="sm" variant="outline">
                Hľadať
            </Button>
        </form>
    );
}
