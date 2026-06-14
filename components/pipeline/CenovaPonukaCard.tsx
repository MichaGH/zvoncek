"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveQuote, setQuoteSent } from "@/lib/actions/pipeline";

function fmtDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("sk-SK", {
        day: "numeric",
        month: "numeric",
        year: "numeric",
    });
}

export default function CenovaPonukaCard({
    leadId,
    price,
    priceNote,
    quoteSentAt,
}: {
    leadId: string;
    price: number | null;
    priceNote: string | null;
    quoteSentAt: string | null;
}) {
    const router = useRouter();
    const sent = Boolean(quoteSentAt);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [priceInput, setPriceInput] = useState(price != null ? String(price) : "");
    const [noteInput, setNoteInput] = useState(priceNote ?? "");

    async function save() {
        setBusy(true);
        const trimmed = priceInput.trim();
        const parsed = trimmed === "" ? null : Number(trimmed);
        await saveQuote(leadId, {
            price: parsed != null && Number.isFinite(parsed) ? parsed : null,
            priceNote: noteInput,
        });
        setBusy(false);
        setEditing(false);
        router.refresh();
    }

    async function toggleSent(next: boolean) {
        setBusy(true);
        await setQuoteSent(leadId, next);
        setBusy(false);
        router.refresh();
    }

    function startEdit() {
        setPriceInput(price != null ? String(price) : "");
        setNoteInput(priceNote ?? "");
        setEditing(true);
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <div className="flex items-center gap-2">
                    <CardTitle className="text-base">Cenová ponuka</CardTitle>
                    {sent && (
                        <Badge variant="default" className="font-normal">
                            Odoslané {fmtDate(quoteSentAt)}
                        </Badge>
                    )}
                </div>
                {!editing && (
                    <Button size="sm" variant="outline" onClick={startEdit}>
                        <Pencil className="mr-1.5 h-3.5 w-3.5" />
                        {price != null || priceNote ? "Upraviť" : "Zadať cenu / poznámku"}
                    </Button>
                )}
            </CardHeader>
            <CardContent className="space-y-3">
                {!editing ? (
                    <>
                        {price != null ? (
                            <div>
                                <p className="text-2xl font-medium tabular-nums">{price} €</p>
                                <p className="text-xs text-muted-foreground">
                                    {sent
                                        ? "Klient videl túto cenu"
                                        : "Interná cena · klientovi ešte neodoslaná"}
                                </p>
                            </div>
                        ) : (
                            <p className="text-sm text-muted-foreground">Cena ešte nezadaná</p>
                        )}
                        {priceNote && (
                            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                                {priceNote}
                            </p>
                        )}
                        <label className="flex cursor-pointer items-center gap-2 rounded-md border bg-muted/30 p-2.5 text-sm">
                            <Checkbox
                                checked={sent}
                                disabled={busy}
                                onCheckedChange={(v) => toggleSent(v === true)}
                            />
                            <span>
                                Cena bola klientovi odoslaná
                                {sent && quoteSentAt ? ` · ${fmtDate(quoteSentAt)}` : ""}
                            </span>
                        </label>
                        <p className="text-xs text-muted-foreground">
                            Zaškrtni keď si cenu klientovi reálne poslal (email/SMS/aj ústne).
                            Dá sa kedykoľvek odškrtnúť.
                        </p>
                    </>
                ) : (
                    <div className="space-y-2">
                        <div className="grid gap-1.5">
                            <Label className="text-xs text-muted-foreground">
                                Cena (€) — nepovinné, dá sa nechať prázdne
                            </Label>
                            <Input
                                type="number"
                                value={priceInput}
                                onChange={(e) => setPriceInput(e.target.value)}
                                placeholder="napr. 399"
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label className="text-xs text-muted-foreground">
                                Poznámka / rozpis
                            </Label>
                            <Textarea
                                value={noteInput}
                                onChange={(e) => setNoteInput(e.target.value)}
                                placeholder="napr. 499 → zľava 399, +admin 199, očakávaná finálna ~700"
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button size="sm" onClick={save} disabled={busy}>
                                {busy ? "Ukladám…" : "Uložiť"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                                Zrušiť
                            </Button>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
