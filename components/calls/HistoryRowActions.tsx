"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateLeadContact } from "@/lib/actions/calls";
import { revertCallResult } from "@/lib/actions/calls/history";

export default function HistoryRowActions({
    activityId,
    leadId,
    leadRevision,
    canRevert,
    canEdit,
    reverted,
    phone,
    email,
}: {
    activityId: string;
    leadId: string;
    leadRevision: number;
    canRevert: boolean;
    canEdit: boolean;
    reverted: boolean;
    phone: string | null;
    email: string | null;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const [phoneV, setPhoneV] = useState(phone ?? "");
    const [emailV, setEmailV] = useState(email ?? "");

    if (reverted) {
        return <span className="text-xs text-muted-foreground">vrátené</span>;
    }

    // Server všetko overí znova – tlačidlá sú len pohodlie.
    if (!canRevert && !canEdit) {
        return (
            <span
                className="flex items-center gap-1 text-xs text-muted-foreground"
                title="Kontakt už nemáš na starosti alebo sa od hovoru zmenil"
            >
                <Lock className="h-3.5 w-3.5" /> len na čítanie
            </span>
        );
    }

    async function revert() {
        if (!window.confirm("Vrátiť výsledok hovoru? Kontakt sa vráti do „Skúsiť znova“ a zaznamenáš správny výsledok.")) return;
        setBusy(true);
        const r = await revertCallResult(activityId, leadRevision);
        setBusy(false);
        if ("error" in r) toast.error(r.error);
        else toast.success("Výsledok vrátený – kontakt je v „Skúsiť znova“");
        router.refresh();
    }

    async function saveEdit() {
        setBusy(true);
        const r = await updateLeadContact(leadId, {
            phone: phoneV.trim() || null,
            email: emailV.trim() || null,
        });
        setBusy(false);
        if ("error" in r) {
            toast.error(r.error);
            router.refresh();
        } else {
            setEditing(false);
            toast.success("Upravené");
            router.refresh();
        }
    }

    if (editing) {
        return (
            <div className="flex flex-col gap-1">
                <Input value={phoneV} onChange={(e) => setPhoneV(e.target.value)} placeholder="Telefón" className="h-7 text-xs" />
                <Input value={emailV} onChange={(e) => setEmailV(e.target.value)} placeholder="Email" className="h-7 text-xs" />
                <div className="flex gap-1">
                    <Button size="sm" className="h-7" onClick={saveEdit} disabled={busy}>
                        Uložiť
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)}>
                        Zrušiť
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-1">
            {canRevert && (
                <Button size="sm" variant="outline" className="h-7" onClick={revert} disabled={busy}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" /> Vrátiť
                </Button>
            )}
            {canEdit && (
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => {
                        setPhoneV(phone ?? "");
                        setEmailV(email ?? "");
                        setEditing(true);
                    }}
                    disabled={busy}
                >
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Upraviť
                </Button>
            )}
        </div>
    );
}
