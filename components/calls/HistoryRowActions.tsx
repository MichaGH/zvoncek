"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resetLeadToCalls, updateLeadContact } from "@/lib/actions/calls";

export default function HistoryRowActions({
    leadId,
    locked,
    phone,
    email,
}: {
    leadId: string;
    locked: boolean;
    phone: string | null;
    email: string | null;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const [phoneV, setPhoneV] = useState(phone ?? "");
    const [emailV, setEmailV] = useState(email ?? "");

    // Zamknuté = kontaktu sa už dotkol manažér → marketing s ním nič nerobí.
    if (locked) {
        return (
            <span
                className="flex items-center gap-1 text-xs text-muted-foreground"
                title="Kontakt už rieši manažér – nedá sa vrátiť ani upraviť"
            >
                <Lock className="h-3.5 w-3.5" /> uzamknuté
            </span>
        );
    }

    async function reset() {
        if (!window.confirm("Vrátiť kontakt späť do volaní ako nový?")) return;
        setBusy(true);
        const r = await resetLeadToCalls(leadId);
        setBusy(false);
        if (r?.error) {
            toast.error(r.error);
            router.refresh();
        } else {
            toast.success("Vrátené do volaní");
            router.refresh();
        }
    }

    async function saveEdit() {
        setBusy(true);
        const r = await updateLeadContact(leadId, {
            phone: phoneV.trim() || null,
            email: emailV.trim() || null,
        });
        setBusy(false);
        if (r?.error) {
            toast.error(r.error);
        } else {
            setEditing(false);
            toast.success("Upravené");
            router.refresh();
        }
    }

    if (editing) {
        return (
            <div className="flex flex-col gap-1">
                <Input
                    value={phoneV}
                    onChange={(e) => setPhoneV(e.target.value)}
                    placeholder="Telefón"
                    className="h-7 text-xs"
                />
                <Input
                    value={emailV}
                    onChange={(e) => setEmailV(e.target.value)}
                    placeholder="Email"
                    className="h-7 text-xs"
                />
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
            <Button size="sm" variant="outline" className="h-7" onClick={reset} disabled={busy}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" /> Vrátiť
            </Button>
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
        </div>
    );
}
