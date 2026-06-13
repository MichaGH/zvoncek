"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateLead } from "@/lib/actions/leads";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Check, X } from "lucide-react";

type QueueLeadRow = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    note: string | null;
};

export default function QueueList({ leads }: { leads: QueueLeadRow[] }) {
    return (
        <div className="mt-8">
            <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-medium">Čakajú na obvolanie</h2>
                <Badge variant="secondary" className="tabular-nums">{leads.length}</Badge>
            </div>

            {leads.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    Fronta je prázdna.
                </p>
            ) : (
                <div className="overflow-hidden rounded-lg border">
                    {leads.map((l) => <QueueItem key={l.id} lead={l} />)}
                </div>
            )}
        </div>
    );
}

function QueueItem({ lead }: { lead: QueueLeadRow }) {
    const router = useRouter();
    const [editing, setEditing] = useState(false);
    const [pending, setPending] = useState(false);
    const [name, setName] = useState(lead.companyName ?? lead.website ?? "");
    const [phone, setPhone] = useState(lead.phone ?? "");
    const [note, setNote] = useState(lead.note ?? "");

    async function save() {
        setPending(true);
        const value = name.trim();
        const isWebsite = /\.[a-z]{2,}$/i.test(value) && !value.includes(" ");
        await updateLead(lead.id, {
            companyName: isWebsite ? null : value || null,
            website: isWebsite ? value : null,
            phone: phone.trim() || null,
            note: note.trim() || null,
        });
        setPending(false);
        setEditing(false);
        router.refresh();
    }

    if (editing) {
        return (
            <div className="space-y-2 border-b bg-muted/40 p-3 last:border-b-0">
                <div className="flex gap-2">
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Firma / web" className="h-8 text-sm" />
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Telefón" className="h-8 w-36 text-sm" inputMode="tel" />
                </div>
                <div className="flex gap-2">
                    <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Poznámka" className="h-8 text-sm" />
                    <Button size="sm" className="h-8 shrink-0" onClick={save} disabled={pending}>
                        <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 shrink-0" onClick={() => setEditing(false)}>
                        <X className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="group flex h-11 items-center gap-2 border-b px-3 last:border-b-0">
            <span className="w-10 shrink-0 text-xs text-muted-foreground tabular-nums">#{lead.number}</span>
            <span className="min-w-0 flex-1 truncate text-sm">
                {lead.companyName ?? lead.website ?? "—"}
                {lead.note && <span className="ml-1.5 text-xs text-muted-foreground">· {lead.note}</span>}
            </span>
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{lead.phone}</span>
            <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => setEditing(true)}
                title="Upraviť"
            >
                <Pencil className="h-3.5 w-3.5" />
            </Button>
        </div>
    );
}