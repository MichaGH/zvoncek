"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Pencil, Send } from "lucide-react";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmLegacyReviewed, saveDealQuote, saveQuote, setClientAsks } from "@/lib/actions/pipeline";
import type { ActionError } from "@/lib/access/errors";
import type { RequestContent } from "@/app/generated/prisma/enums";
import { businessDayMonth } from "@/lib/domain/businessTime";
import {
    ASK_REASON_MAX,
    outstandingLabel,
    REQUEST_CONTENT_LABEL,
    REQUEST_CONTENTS,
    type HistoryRow,
    type OutstandingRow,
} from "@/lib/domain/clientRequests";
import {
    clientKnowledge,
    formatMoney,
    legacyUnreviewed,
    OFFER_CONTENT_LABEL,
    OFFER_CONTENTS,
    type KnowledgeState,
} from "@/lib/domain/offers";
import type { DealDetailData } from "@/lib/queries/pipeline";

// „Cena & ponuky" (round 2, wave 3a – §2c 5.5): aktuálna cena obchodu + čo klient naozaj dostal.
// Rovnaká karta pre manažéra aj vlastníka; uloženie ceny ide cez tú úroveň príkazov, ktorú dovoľujú práva
// ("pipeline" = manažérske príkazy, "clients" = práca vlastníka cez lib/commands/dealWork.ts).
// Staré údaje (spred wave 3a) nikdy nehovoria „áno" – na neoverenom obchode je namiesto „nie" otáznik.

const SAVE = { pipeline: saveQuote, clients: saveDealQuote };

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function Known({ label, state, extra }: { label: string; state: KnowledgeState; extra?: string }) {
    if (state.state === "yes") {
        return (
            <span>
                {label}
                {extra ? ` ${extra}` : ""} <span className="text-muted-foreground">{businessDayMonth(new Date(state.at))}</span>
            </span>
        );
    }
    if (state.state === "unknown") return <span className="text-muted-foreground">{label} ?</span>;
    return <span className="text-muted-foreground line-through decoration-muted-foreground/40">{label}</span>;
}

export default function CenovaPonukaCard({
    leadId,
    revision,
    price,
    priceNote,
    priceHistory = [],
    offers,
    askHistory,
    outstandingRows,
    openTaskAssignee = null,
    mode = "pipeline",
    readOnly = false,
    isManager,
    onRecord,
    onHistorical,
}: {
    leadId: string;
    revision: number;
    price: number | null;
    priceNote: string | null;
    // D5: posledné zmeny ceny – obchodník ich vidí, takže si pamätá, že cena rástla a prečo.
    priceHistory?: DealDetailData["priceHistory"];
    offers: DealDetailData["offers"];
    askHistory: HistoryRow[];
    outstandingRows: OutstandingRow[];
    openTaskAssignee?: string | null;
    mode?: "pipeline" | "clients";
    readOnly?: boolean;
    isManager: boolean;
    onRecord: () => void;
    onHistorical: () => void;
}) {
    const router = useRouter();
    const [editing, setEditing] = useState(false);
    const [editingAsks, setEditingAsks] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmingReview, setConfirmingReview] = useState(false);

    const knows = clientKnowledge(offers);
    const unreviewed = legacyUnreviewed(offers);
    const last = offers.lastPrice;
    const priceDiffers = last !== null && price !== null && Number(last.amount) !== price;

    function report(r: { success: true } | ActionError) {
        if ("error" in r) toast.error(r.error);
    }

    async function confirmReviewed() {
        setBusy(true);
        report(await confirmLegacyReviewed(leadId));
        setBusy(false);
        setConfirmingReview(false);
        router.refresh();
    }

    return (
        <Card>
            <CardHeader className="flex items-center justify-between">
                <CardTitle className="text-base">Cena &amp; ponuky</CardTitle>
                {!editing && !readOnly && (
                    <Button size="sm" variant="ghost" className="h-8 w-8 shrink-0 p-0" onClick={() => setEditing(true)} aria-label="Upraviť cenu">
                        <Pencil className="h-3.5 w-3.5" />
                    </Button>
                )}
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-1">
                    <p className={`text-2xl font-medium tabular-nums${price == null ? " text-muted-foreground" : ""}`}>
                        {price != null ? formatMoney(price) : "— €"}
                    </p>
                    {priceNote && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{priceNote}</p>}
                    {priceHistory.length > 0 && (
                        <ul className="space-y-0.5 pt-1 text-xs text-muted-foreground">
                            {priceHistory.map((h) => (
                                <li key={h.id}>
                                    {h.from?.amount != null ? formatMoney(h.from.amount) : "—"} → {h.to?.amount != null ? formatMoney(h.to.amount) : "—"}
                                    {h.from?.amount === h.to?.amount ? " (upravený rozpis)" : ""} · {businessDayMonth(new Date(h.at))} · {h.by}
                                    {h.reason ? ` – ${h.reason}` : ""}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* Wave 5 (§3.2): čo klient pýtal – udalosti, nie trvalá nálepka. Druhá žiadosť o to isté je nový riadok. */}
                <div className="space-y-1 text-sm">
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Chceli</p>
                        {!readOnly && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 shrink-0 p-0"
                                onClick={() => setEditingAsks(true)}
                                aria-label="Upraviť, čo klient chce"
                            >
                                <Pencil className="h-3.5 w-3.5" />
                            </Button>
                        )}
                    </div>
                    {askHistory.length === 0 ? (
                        <p className="text-muted-foreground">Nič si výslovne nepýtali.</p>
                    ) : (
                        <ul className="space-y-0.5">
                            {askHistory.map((row) => (
                                <li key={row.id} className="flex flex-wrap items-baseline gap-x-1.5">
                                    <span className={row.state === "WITHDRAWN" ? "line-through decoration-muted-foreground/40" : undefined}>
                                        {REQUEST_CONTENT_LABEL[row.content]}
                                    </span>
                                    <span className="text-xs text-muted-foreground">{businessDayMonth(new Date(row.requestedAt))}</span>
                                    {row.state === "SENT" && <span className="text-xs text-emerald-700 dark:text-emerald-400">✓ dostali</span>}
                                    {row.state === "OPEN" && <span className="text-xs text-amber-700 dark:text-amber-400">ešte neposlané</span>}
                                    {row.state === "WITHDRAWN" && (
                                        <span className="text-xs text-muted-foreground">už nechcú{row.reason ? ` – ${row.reason}` : ""}</span>
                                    )}
                                    {row.origin !== "LIVE" && <span className="text-xs text-muted-foreground">(zo starých dát)</span>}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="space-y-1 text-sm">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Klient dostal</p>
                    <p className="flex flex-wrap gap-x-3 gap-y-1">
                        {OFFER_CONTENTS.map((c) => (
                            <Known
                                key={c}
                                label={OFFER_CONTENT_LABEL[c]}
                                state={knows[c]}
                                extra={c === "PRICE" && last ? `${formatMoney(last.amount)}${last.channel === "PHONE" ? (last.via === "SMS" ? " (SMS)" : " (telefonicky)") : ""}` : undefined}
                            />
                        ))}
                    </p>
                    {priceDiffers && last && (
                        <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            Aktuálna cena sa líši od poslanej ({formatMoney(last.amount)}).
                        </p>
                    )}
                </div>

                {unreviewed && (
                    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                        <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            Staré záznamy – over, čo klient dostal.
                        </p>
                        <p className="text-xs text-muted-foreground">
                            Starý systém tvrdí:{" "}
                            {[
                                offers.legacy.aboutUsSentAt ? `email o nás ${businessDayMonth(new Date(offers.legacy.aboutUsSentAt))}` : null,
                                offers.legacy.quoteSentAt ? `CP ${businessDayMonth(new Date(offers.legacy.quoteSentAt))} (suma neznáma)` : null,
                                offers.legacy.priceDisclosed ? "„klient pozná cenu“" : null,
                            ]
                                .filter(Boolean)
                                .join(" · ") || "odoslaný návrh"}
                        </p>
                        {isManager && !confirmingReview && (
                            <div className="flex flex-wrap gap-2">
                                <Button size="sm" variant="outline" disabled={busy} onClick={onHistorical}>
                                    Doplniť starý záznam
                                </Button>
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingReview(true)}>
                                    Hotovo – toto je všetko
                                </Button>
                            </div>
                        )}
                        {isManager && confirmingReview && (
                            <div className="space-y-2 border-t border-amber-500/30 pt-2">
                                <p className="text-xs">
                                    Je doplnené všetko, čo klient zo starého systému dostal? Prázdne potom znamená „nie“.
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    <Button size="sm" disabled={busy} onClick={confirmReviewed}>
                                        Áno, potvrdiť
                                    </Button>
                                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingReview(false)}>
                                        Späť
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {!readOnly && (
                    <Button size="sm" onClick={onRecord}>
                        <Send className="mr-1.5 h-3.5 w-3.5" />
                        Zaznamenať odoslanie
                    </Button>
                )}
            </CardContent>
            {editingAsks && (
                <ClientAsksSheet
                    leadId={leadId}
                    revision={revision}
                    rows={outstandingRows}
                    maker={openTaskAssignee}
                    onClose={() => setEditingAsks(false)}
                />
            )}
            {editing && (
                <PriceEditSheet
                    price={price}
                    priceNote={priceNote}
                    onClose={() => setEditing(false)}
                    onSave={async (input) => {
                        const r = await SAVE[mode](leadId, input);
                        report(r);
                        if (!("error" in r)) {
                            toast.success("Cena uložená");
                            setEditing(false);
                        }
                        router.refresh();
                    }}
                />
            )}
        </Card>
    );
}

// Úprava aktuálnej ceny obchodu – len cena a rozpis, nič sa tým neposiela ani neplánuje (round 2 §2d).
// Hodnoty sa berú z aktuálnych údajov pri každom otvorení.
function PriceEditSheet({
    price,
    priceNote,
    onClose,
    onSave,
}: {
    price: number | null;
    priceNote: string | null;
    onClose: () => void;
    onSave: (input: { price: number | null; priceNote: string | null; reason?: string | null }) => Promise<void>;
}) {
    const [priceInput, setPriceInput] = useState(price != null ? String(price) : "");
    const [noteInput, setNoteInput] = useState(priceNote ?? "");
    const [reasonInput, setReasonInput] = useState("");
    const [saving, setSaving] = useState(false);
    const trimmed = priceInput.trim();
    const parsed = trimmed === "" ? null : Number(trimmed.replace(",", "."));
    const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0);

    return (
        <ResponsiveSheet open onOpenChange={(o) => !o && onClose()} title="Upraviť cenu" description="Aktuálna cena obchodu. Neposiela sa tým nič klientovi.">
            <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6 md:max-w-none md:px-0 md:pb-0">
                <div className="grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">Cena (€) — prázdne = bez ceny</Label>
                    <Input
                        data-vaul-no-drag
                        inputMode="decimal"
                        value={priceInput}
                        onChange={(e) => setPriceInput(e.target.value)}
                        placeholder="napr. 1285"
                        className="text-[16px]"
                    />
                </div>
                <div className="grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">Rozpis</Label>
                    <Textarea
                        data-vaul-no-drag
                        value={noteInput}
                        onChange={(e) => setNoteInput(e.target.value)}
                        placeholder="Web 550 € · admin 250 € · jazyk 100 € · SEO 350 € · správa 35 €/mes."
                        className="min-h-[88px] text-[16px]"
                    />
                </div>
                {/* D5: krátky dôvod, aby história ceny bola príbeh, nie zoznam rozdielov. Nepovinný – preklep formulár nepotrebuje. */}
                <div className="grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">Prečo sa mení (nepovinné)</Label>
                    <Input
                        data-vaul-no-drag
                        value={reasonInput}
                        maxLength={500}
                        onChange={(e) => setReasonInput(e.target.value)}
                        placeholder="napr. pridali sme EN jazyk"
                        className="text-[16px]"
                    />
                </div>
                <Button
                    className="h-12 w-full"
                    disabled={saving || invalid}
                    onClick={async () => {
                        setSaving(true);
                        await onSave({ price: parsed, priceNote: noteInput, reason: reasonInput.trim() || null });
                        setSaving(false);
                    }}
                >
                    {invalid ? "Neplatná suma" : saving ? "Ukladám…" : "Uložiť cenu"}
                </Button>
            </div>
        </ResponsiveSheet>
    );
}

// Ceruzka pri „Chceli" (§3.2, §6.4): pridať, čo klient chce, alebo stiahnuť otvorenú požiadavku s dôvodom.
// Vybavenú požiadavku stiahnuť nemožno – klient to naozaj dostal a odkaz na odoslanie sa nesmie stratiť.
// Otvorenej úlohy sa to nedotkne; tú ruší „Zmeniť krok (zruší úlohu)".
function ClientAsksSheet({
    leadId,
    revision,
    rows,
    maker,
    onClose,
}: {
    leadId: string;
    revision: number;
    rows: OutstandingRow[];
    maker: string | null;
    onClose: () => void;
}) {
    const router = useRouter();
    const [add, setAdd] = useState<RequestContent[]>([]);
    const [withdraw, setWithdraw] = useState<string[]>([]);
    const [reason, setReason] = useState("");
    const [saving, setSaving] = useState(false);
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);

    const openRows = rows.filter((r) => r.openIds.length > 0);
    const nothing = add.length === 0 && withdraw.length === 0;
    const needsReason = withdraw.length > 0 && !reason.trim();
    const working = rows.find((r) => r.making || r.prepared.length > 0);

    function toggleWithdraw(row: OutstandingRow, on: boolean) {
        setWithdraw((cur) => (on ? [...new Set([...cur, ...row.openIds])] : cur.filter((id) => !row.openIds.includes(id))));
    }

    async function save() {
        setSaving(true);
        const r = await setClientAsks({
            leadId,
            expectedRevision: revision,
            idempotencyKey,
            add,
            withdraw,
            reason: reason.trim() || null,
        });
        setSaving(false);
        if ("error" in r) {
            toast.error(r.error);
            setIdempotencyKey(newKey());
        } else {
            toast.success("Uložené, čo klient chce");
            onClose();
        }
        router.refresh();
    }

    return (
        <ResponsiveSheet
            open
            onOpenChange={(o) => !o && onClose()}
            title="Čo klient chce"
            description="Oprava záznamu – neposiela sa tým nič klientovi."
        >
            <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6 md:max-w-none md:px-0 md:pb-0">
                <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Chcú aj</p>
                    {REQUEST_CONTENTS.map((content) => (
                        <label key={content} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                            <Checkbox
                                data-vaul-no-drag
                                checked={add.includes(content)}
                                onCheckedChange={(v) => setAdd((cur) => (v === true ? [...cur, content] : cur.filter((c) => c !== content)))}
                            />
                            {REQUEST_CONTENT_LABEL[content]}
                        </label>
                    ))}
                </div>

                {openRows.length > 0 && (
                    <div className="space-y-2 border-t pt-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Už to nechcú</p>
                        {openRows.map((row) => (
                            <label key={row.content} className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                                <Checkbox
                                    data-vaul-no-drag
                                    checked={row.openIds.every((id) => withdraw.includes(id))}
                                    onCheckedChange={(v) => toggleWithdraw(row, v === true)}
                                />
                                <span className="min-w-0">
                                    {REQUEST_CONTENT_LABEL[row.content]}
                                    <span className="block text-xs text-muted-foreground">{outstandingLabel(row, maker)}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                )}

                {withdraw.length > 0 && (
                    <div className="grid gap-1.5">
                        <Label className="text-xs text-muted-foreground">Prečo to už nechcú</Label>
                        <Input
                            data-vaul-no-drag
                            value={reason}
                            maxLength={ASK_REASON_MAX}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="napr. rozmysleli si to"
                            className="text-[16px]"
                        />
                    </div>
                )}

                {withdraw.length > 0 && working && (
                    <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                        Úloha pre manažéra ostáva otvorená – zruš ju cez „Zmeniť krok (zruší úlohu)“.
                    </p>
                )}

                <Button className="h-12 w-full" disabled={saving || nothing || needsReason} onClick={save}>
                    {nothing ? "Nič sa nemení" : needsReason ? "Napíš, prečo to už nechcú" : saving ? "Ukladám…" : "Uložiť"}
                </Button>
            </div>
        </ResponsiveSheet>
    );
}
