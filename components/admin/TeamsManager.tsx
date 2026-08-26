"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { createTeam, renameTeam, deleteTeam, setTeamLeader } from "@/lib/actions/teams";
import type { TeamRow } from "@/lib/queries/teams";
import type { UserOption } from "@/lib/queries/users";
import { Pencil, Trash2, Check, X, Plus, Users } from "lucide-react";

type Props = { teams: TeamRow[]; userOptions: UserOption[] };

export default function TeamsManager({ teams, userOptions }: Props) {
    const router = useRouter();
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [editingId, setEditingId] = useState<string | null>(null);

    function handleCreate(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!name.trim()) return;
        const fd = new FormData();
        fd.set("name", name);
        startTransition(async () => {
            const res = await createTeam(fd);
            if (!res.ok) { setError(res.error); return; }
            setName("");
            setError(null);
            router.refresh();
        });
    }

    function handleRename(id: string, value: string) {
        const fd = new FormData();
        fd.set("name", value);
        startTransition(async () => {
            const res = await renameTeam(id, fd);
            if (!res.ok) { setError(res.error); return; }
            setEditingId(null);
            setError(null);
            router.refresh();
        });
    }

    function handleDelete(id: string, teamName: string, members: number) {
        const warn = members > 0
            ? `Zmazať tím „${teamName}"? ${members} členom sa zruší priradenie (kontakty zostanú).`
            : `Zmazať tím „${teamName}"?`;
        if (!confirm(warn)) return;
        startTransition(async () => {
            const res = await deleteTeam(id);
            if (!res.ok) { setError(res.error); return; }
            router.refresh();
        });
    }

    function handleLeader(teamId: string, leaderId: string) {
        startTransition(async () => {
            const res = await setTeamLeader(teamId, leaderId || null);
            if (!res.ok) { setError(res.error); return; }
            setError(null);
            router.refresh();
        });
    }

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Nový tím</CardTitle>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleCreate} className="flex gap-2">
                        <Input
                            placeholder="Názov tímu (napr. Tím Bratislava)"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            maxLength={60}
                        />
                        <Button type="submit" disabled={pending || !name.trim()}>
                            <Plus className="h-4 w-4" />
                            Vytvoriť
                        </Button>
                    </form>
                </CardContent>
            </Card>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {teams.length === 0 ? (
                <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                    Zatiaľ žiadne tímy. Vytvor prvý vyššie.
                </div>
            ) : (
                <div className="space-y-3">
                    {teams.map((team) => (
                        <Card key={team.id}>
                            <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0 flex-1">
                                    {editingId === team.id ? (
                                        <RenameField
                                            initial={team.name}
                                            pending={pending}
                                            onCancel={() => setEditingId(null)}
                                            onSave={(v) => handleRename(team.id, v)}
                                        />
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <span className="truncate font-medium">{team.name}</span>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() => setEditingId(team.id)}
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                            </Button>
                                            <Badge variant="outline" className="gap-1">
                                                <Users className="h-3 w-3" />
                                                {team._count.members}
                                            </Badge>
                                        </div>
                                    )}
                                </div>

                                <div className="flex items-center gap-2">
                                    <label className="text-xs text-muted-foreground">Vedúci</label>
                                    <select
                                        value={team.leader?.id ?? ""}
                                        onChange={(e) => handleLeader(team.id, e.target.value)}
                                        disabled={pending}
                                        className="h-9 max-w-[12rem] rounded-md border border-input bg-background px-3 text-sm"
                                    >
                                        <option value="">— žiadny —</option>
                                        {userOptions.map((u) => (
                                            <option key={u.id} value={u.id}>
                                                {u.firstName} {u.lastName}
                                            </option>
                                        ))}
                                    </select>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-9 w-9 text-destructive"
                                        onClick={() => handleDelete(team.id, team.name, team._count.members)}
                                        disabled={pending}
                                        aria-label="Zmazať tím"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}

function RenameField({
    initial,
    pending,
    onSave,
    onCancel,
}: {
    initial: string;
    pending: boolean;
    onSave: (value: string) => void;
    onCancel: () => void;
}) {
    const [value, setValue] = useState(initial);
    return (
        <div className="flex items-center gap-2">
            <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={60}
                className="max-w-xs"
                autoFocus
            />
            <Button size="icon" variant="ghost" className="h-8 w-8" disabled={pending || !value.trim()} onClick={() => onSave(value)}>
                <Check className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onCancel}>
                <X className="h-4 w-4" />
            </Button>
        </div>
    );
}
