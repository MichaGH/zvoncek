"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import type { NextActionKind, NextActionMode } from "@/app/generated/prisma/enums";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import UrgencyLabel from "@/components/shared/UrgencyLabel";
import type { ActionError } from "@/lib/access/errors";
import { businessInputParts } from "@/lib/domain/businessTime";
import type { Schedule } from "@/lib/domain/schedule";
import { NEXT_ACTION_LABEL } from "@/lib/dictionaries";

export type NextActionSaveInput = {
    kind: NextActionKind | null;
    schedule?: Schedule | null;
    note?: string | null;
    mode?: NextActionMode;
};

type SaveFn = (input: NextActionSaveInput, expectedRevision: number) => Promise<{ success: true } | ActionError>;

// Editor „Ďalší krok" – spoločný pre pipeline (manažér) aj moji klienti (vlastník). Dátum/čas ide na server ako
// Schedule v Europe/Bratislava; uloženie vyžaduje aktuálnu revíziu (zastaraná karta → obnovenie).
export default function NextActionEditor({
    lead,
    onSave,
}: {
    lead: {
        revision: number;
        nextActionKind: NextActionKind | null;
        nextActionAt: string | null;
        nextActionHasTime: boolean;
        nextActionMode: NextActionMode;
        nextActionNote: string | null;
    };
    onSave: SaveFn;
}) {
    const router = useRouter();
    const [kind, setKind] = useState<NextActionKind>("CALL");
    const [date, setDate] = useState("");
    const [time, setTime] = useState("");
    const [inProgress, setInProgress] = useState(false);
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(false);

    const hasNextAction = Boolean(lead.nextActionKind || lead.nextActionAt || lead.nextActionNote);
    const showEditor = editing || !hasNextAction;

    function reset() {
        setKind("CALL");
        setDate("");
        setTime("");
        setInProgress(false);
        setNote("");
        setEditing(false);
    }

    function startEdit() {
        const parts = lead.nextActionAt ? businessInputParts(new Date(lead.nextActionAt)) : { date: "", time: "" };
        setKind(lead.nextActionKind ?? "CALL");
        setDate(parts.date);
        setTime(lead.nextActionHasTime ? parts.time : "");
        setInProgress(lead.nextActionMode === "IN_PROGRESS");
        setNote(lead.nextActionNote ?? "");
        setEditing(true);
    }

    function startNew() {
        reset();
        setEditing(true);
    }

    async function save() {
        let schedule: Schedule | null = null;
        if (!inProgress && date) schedule = time ? { kind: "dayTime", date, time } : { kind: "day", date };
        setSaving(true);
        const r = await onSave(
            { kind, schedule, note: note.trim() || null, mode: inProgress ? "IN_PROGRESS" : "SCHEDULED" },
            lead.revision,
        );
        setSaving(false);
        if ("error" in r) {
            toast.error(r.code === "STALE" ? "Obchod sa medzitým zmenil – obnovujem" : r.error);
        } else {
            reset();
        }
        router.refresh();
    }

    return (
        <Card>
            <CardHeader className="flex items-center justify-between">
                <CardTitle className="text-base">Ďalší krok</CardTitle>
                <div className="flex items-center gap-1">
                    <Button size="sm" variant="outline" onClick={startNew}>
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Nový
                    </Button>
                    {hasNextAction && !editing && (
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={startEdit} aria-label="Upraviť ďalší krok">
                            <Pencil className="h-3.5 w-3.5" />
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                {hasNextAction && !editing && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span className="text-sm font-semibold">
                            {lead.nextActionKind ? NEXT_ACTION_LABEL[lead.nextActionKind] : "Ďalší krok"}
                        </span>
                        {(lead.nextActionAt || lead.nextActionMode === "IN_PROGRESS") && (
                            <UrgencyLabel
                                at={lead.nextActionAt}
                                hasTime={lead.nextActionHasTime}
                                mode={lead.nextActionMode}
                                className="text-sm"
                            />
                        )}
                        {lead.nextActionNote && <span className="text-sm text-muted-foreground">{lead.nextActionNote}</span>}
                    </div>
                )}

                {showEditor && (
                    <div className="space-y-2">
                        {hasNextAction && (
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Zmeniť ďalší krok</p>
                        )}
                        <div className="grid gap-2 sm:grid-cols-2">
                            <div className="grid gap-1.5">
                                <Label className="text-xs text-muted-foreground">Typ</Label>
                                <Select value={kind} onValueChange={(value) => setKind(value as NextActionKind)}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(NEXT_ACTION_LABEL).map(([key, label]) => (
                                            <SelectItem key={key} value={key}>
                                                {label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid gap-1.5">
                                <Label className="text-xs text-muted-foreground">Kedy</Label>
                                {inProgress ? (
                                    <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                                        Rozpracované – bez termínu. Zobrazí sa „trvá X dní“.
                                    </p>
                                ) : (
                                    <>
                                        <div className="flex gap-2">
                                            <Input
                                                type="date"
                                                value={date}
                                                onChange={(event) => setDate(event.target.value)}
                                                onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
                                                className="flex-1 [color-scheme:light_dark]"
                                            />
                                            <Input
                                                type="time"
                                                value={time}
                                                onChange={(event) => setTime(event.target.value)}
                                                onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
                                                className="w-28 [color-scheme:light_dark]"
                                            />
                                        </div>
                                        <p className="text-xs text-muted-foreground">Čas nechaj prázdny, ak nie je dohodnutý presný čas.</p>
                                    </>
                                )}
                                <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm">
                                    <Checkbox checked={inProgress} onCheckedChange={(v) => setInProgress(v === true)} />
                                    <span>Rozpracované (bez termínu, počíta dni)</span>
                                </label>
                            </div>
                        </div>
                        <div className="grid gap-1.5">
                            <Label className="text-xs text-muted-foreground">Poznámka</Label>
                            <Input
                                placeholder="Čo treba urobiť alebo na čo čakáme…"
                                value={note}
                                onChange={(event) => setNote(event.target.value)}
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button size="sm" onClick={save} disabled={saving}>
                                {saving ? "Ukladám…" : "Uložiť ďalší krok"}
                            </Button>
                            {editing && (
                                <Button size="sm" variant="ghost" onClick={reset}>
                                    Zrušiť
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
