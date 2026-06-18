"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveQuote, setPriceDisclosed, setQuoteSent } from "@/lib/actions/pipeline";

function fmtDate(iso: string | null) {
    if (!iso) return "";
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
    priceDisclosed,
    quoteSentAt,
}: {
    leadId: string;
    price: number | null;
    priceNote: string | null;
    priceDisclosed: boolean;
    quoteSentAt: string | null;
}) {
    const router = useRouter();
    const quoteSent = Boolean(quoteSentAt);
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

    async function toggleDisclosed(next: boolean) {
        setBusy(true);
        await setPriceDisclosed(leadId, next);
        setBusy(false);
        router.refresh();
    }

    async function markQuoteSent() {
        setBusy(true);
        await setQuoteSent(leadId, true);
        setBusy(false);
        router.refresh();
    }

    async function revertQuoteSent() {
        setBusy(true);
        await setQuoteSent(leadId, false);
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
            <CardHeader className="flex items-center justify-between">
                <CardTitle className="text-base">Cena</CardTitle>
                {!editing && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 shrink-0 p-0"
                        onClick={startEdit}
                        aria-label="Upraviť cenu"
                    >
                        <Pencil className="h-3.5 w-3.5" />
                    </Button>
                )}
            </CardHeader>
            <CardContent>
                {!editing ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                        {/* Ľavá polovica – cena + klient pozná */}
                        <div className="space-y-2">
                            <div className="flex items-baseline gap-3">
                                <p className={`text-2xl font-medium tabular-nums${price == null ? " text-muted-foreground" : ""}`}>
                                    {price != null ? `${price} €` : "— €"}
                                </p>
                                <label className={`flex items-center gap-1.5 text-sm text-muted-foreground${price == null ? " opacity-40" : " cursor-pointer"}`}>
                                    <Checkbox
                                        checked={priceDisclosed}
                                        disabled={busy || price == null}
                                        onCheckedChange={(v) => toggleDisclosed(v === true)}
                                    />
                                    <span>Klient pozná cenu</span>
                                </label>
                            </div>
                            {price == null && (
                                <p className="text-xs text-muted-foreground">Najprv nastav cenu.</p>
                            )}
                            {priceNote && (
                                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                                    {priceNote}
                                </p>
                            )}
                        </div>

                        {/* Pravá polovica – cenová ponuka (email) */}
                        <div className="flex flex-col justify-center gap-1.5">
                            {quoteSent ? (
                                <>
                                    <Badge variant="secondary" className="w-fit font-normal">
                                        <Check className="mr-1 h-3 w-3" />
                                        CP odoslaná {fmtDate(quoteSentAt)}
                                    </Badge>
                                    <button
                                        className="w-fit text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
                                        disabled={busy}
                                        onClick={revertQuoteSent}
                                    >
                                        zrušiť
                                    </button>
                                </>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="w-fit"
                                    disabled={busy || price == null}
                                    onClick={markQuoteSent}
                                >
                                    CP bola odoslaná
                                </Button>
                            )}
                        </div>
                    </div>
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
