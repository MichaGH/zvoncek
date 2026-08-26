"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type User = { id: string; firstName: string; lastName: string };
type Team = { id: string; name: string };

type Props = {
    query?: string;
    createdBy?: string;
    assignedTo?: string;
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
    const [teamValue, setTeamValue] = useState(team);

    function push(
        overrides: { q?: string; createdBy?: string; assignedTo?: string; team?: string } = {},
    ) {
        const q = overrides.q !== undefined ? overrides.q : searchValue;
        const cb = overrides.createdBy !== undefined ? overrides.createdBy : createdByValue;
        const ao = overrides.assignedTo !== undefined ? overrides.assignedTo : assignedToValue;
        const tm = overrides.team !== undefined ? overrides.team : teamValue;
        const params = new URLSearchParams();
        if (q.trim()) params.set("q", q.trim());
        if (cb) params.set("createdBy", cb);
        if (ao) params.set("assignedTo", ao);
        if (tm) params.set("team", tm);
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
                <select
                    value={teamValue}
                    onChange={(e) => {
                        setTeamValue(e.target.value);
                        // výber tímu zruší filter na konkrétneho človeka
                        setCreatedByValue("");
                        push({ team: e.target.value, createdBy: "" });
                    }}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                    <option value="">Všetky tímy</option>
                    {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                            {t.name}
                        </option>
                    ))}
                </select>
            )}

            {showCreatedByFilter && (
                <select
                    value={createdByValue}
                    onChange={(e) => { setCreatedByValue(e.target.value); push({ createdBy: e.target.value }); }}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                    <option value="">{createdByLabel}</option>
                    {users.map((u) => (
                        <option key={u.id} value={u.id}>
                            {u.firstName} {u.lastName}
                        </option>
                    ))}
                </select>
            )}

            {showOwnerFilter && (
                <select
                    value={assignedToValue}
                    onChange={(e) => { setAssignedToValue(e.target.value); push({ assignedTo: e.target.value }); }}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                    <option value="">Všetci (assigned)</option>
                    {users.map((u) => (
                        <option key={u.id} value={u.id}>
                            {u.firstName} {u.lastName}
                        </option>
                    ))}
                </select>
            )}

            <Button type="submit" size="sm" variant="outline">
                Hľadať
            </Button>
        </form>
    );
}
