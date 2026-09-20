"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { finishAndSend, finishTask } from "@/lib/actions/pipeline";
import { NEXT_ACTION_LABEL, TASK_CONTENT_LABEL } from "@/lib/dictionaries";
import { addBusinessCalendarDays, businessDate } from "@/lib/domain/businessTime";
import { displayUrl } from "@/lib/domain/designLinks";
import type { DealDetailData, DealTaskView } from "@/lib/queries/pipeline";

// „Hotovo" (wave 3 §6.3) a „Poslal som to klientovi sám" (§6.5) – ten istý formulár výsledku: cena (uloží sa aj na
// obchod), návrhy s odkazom, odpoveď. Pri „sám" pribudne odoslanie klientovi a hovor po ňom; všetko je jeden príkaz.

const REFRESH_CODES = new Set(["NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED"]);
const LABEL = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function FinishTaskDialog({
    lead,
    task,
    send,
    onClose,
}: {
    lead: DealDetailData;
    task: DealTaskView;
    send: boolean;
    onClose: () => void;
}) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const today = businessDate(new Date());
    const wants = (c: "PRICE" | "DESIGN" | "OTHER") => task.contents.includes(c);
    const [amount, setAmount] = useState(lead.price != null ? String(lead.price) : "");
    const [priceNote, setPriceNote] = useState(lead.priceNote ?? "");
    const [designIds, setDesignIds] = useState<string[]>([]);
    const [answer, setAnswer] = useState("");
    const [aboutUs, setAboutUs] = useState(false);
    const [pricelist, setPricelist] = useState(false);
    const [sentOn, setSentOn] = useState(today);
    const [followUpOn, setFollowUpOn] = useState("");
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);

    const amountNumber = amount.trim() === "" ? null : Number(amount.replace(",", "."));
    const amountValid = amountNumber !== null && Number.isFinite(amountNumber) && amountNumber >= 0;
    const owner = lead.owner?.firstName ?? "Vlastník";
    const stepLabel = lead.nextActionKind ? NEXT_ACTION_LABEL[lead.nextActionKind] : "bez kroku";
    const defaultFollowUp = addBusinessCalendarDays(sentOn || today, 7);
    // Iný vrátený a ešte neposlaný výsledok (staršia úloha) drží krok „Poslať…" (I10) – hovor sa vtedy neplánuje.
    const otherPending = lead.pending.filter((i) => i.taskId !== task.id && (i.kind === "PRICE" || i.kind === "DESIGN"));
    // [WAVE 4] Čiastočné vybavenie (wave-4-proposal.md §2.4): „Hotovo – len cena" pri úlohe cena + návrh; dnes treba všetko.
    const missing =
        wants("PRICE") && !amountValid
            ? "Doplň cenu"
            : wants("DESIGN") && designIds.length === 0
              ? "Vyber návrh s odkazom"
              : wants("OTHER") && !answer.trim()
                ? "Napíš odpoveď"
                : send && (!sentOn || sentOn > today)
                  ? "Neplatný dátum"
                  : null;

    function save() {
        if (missing) return;
        const designs = designIds.map((id) => ({ id, version: lead.designs.find((d) => d.id === id)?.version ?? 1 }));
        const result = {
            taskId: task.id,
            expectedRevision: lead.revision,
            idempotencyKey,
            ...(wants("PRICE") && amountNumber !== null ? { price: { amount: amountNumber, note: priceNote.trim() || null } } : {}),
            ...(wants("DESIGN") ? { designs } : {}),
            ...(wants("OTHER") ? { answer: answer.trim() } : {}),
        };
        start(async () => {
            const r = send
                ? await finishAndSend({
                      ...result,
                      extraContents: [...(aboutUs ? (["ABOUT_US"] as const) : []), ...(pricelist ? (["PRICELIST"] as const) : [])],
                      sentOn,
                      ...(otherPending.length === 0 && followUpOn ? { followUpOn } : {}),
                  })
                : await finishTask(result);
            if (!("error" in r)) {
                toast.success(send ? "Vybavené a poslané klientovi" : `Vybavené – ${owner} to má na dnes`);
                onClose();
                router.refresh();
                return;
            }
            toast.error(r.error);
            if (r.code && REFRESH_CODES.has(r.code)) {
                setIdempotencyKey(newKey());
                onClose();
                router.refresh();
            }
        });
    }

    const row = "flex items-start gap-3 rounded-lg border p-3";
    const dateInput = "h-11 rounded-md border bg-background px-3 text-[16px] [color-scheme:light_dark] md:text-sm";
    return (
        <ResponsiveSheet
            open
            onOpenChange={(o) => !o && onClose()}
            title={send ? "Poslal som to klientovi sám" : "Hotovo"}
            description={lead.name}
            contentClassName="sm:max-w-lg"
        >
            <div className="mx-auto w-full max-w-md space-y-5 px-4 pb-6 md:max-w-none md:px-0 md:pb-0">
                <div className="space-y-2">
                    <p className={LABEL}>
                        {task.requestedBy.firstName} žiada · {task.contents.map((c) => TASK_CONTENT_LABEL[c]).join(" + ")}
                    </p>
                    <p className="whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 text-sm">{task.text}</p>
                </div>

                {wants("PRICE") && (
                    <div className="space-y-2">
                        <label htmlFor="finish-amount" className={LABEL}>
                            Cena
                        </label>
                        <div className="relative">
                            <Input
                                id="finish-amount"
                                data-vaul-no-drag
                                inputMode="decimal"
                                placeholder="Suma"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                className="pr-8 text-[16px] md:text-sm"
                            />
                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                        </div>
                        <Textarea
                            data-vaul-no-drag
                            placeholder="Rozpis (nepovinné), napr. Web 550 € · admin 250 €"
                            value={priceNote}
                            onChange={(e) => setPriceNote(e.target.value)}
                            className="min-h-[64px] text-[16px] md:text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                            {lead.price != null ? "Predvyplnené aktuálnou cenou obchodu. " : ""}Uloží sa aj ako aktuálna cena obchodu (nová
                            suma bez rozpisu zmaže starý rozpis).
                        </p>
                    </div>
                )}

                {wants("DESIGN") && (
                    <div className="space-y-2">
                        <p className={LABEL}>Návrh</p>
                        {lead.designs.length === 0 && (
                            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                                Obchod zatiaľ nemá návrh. Vytvor ho v karte Návrh (aj s odkazom) a vráť sa sem.
                            </p>
                        )}
                        {lead.designs.map((d) => (
                            <label key={d.id} className={row}>
                                <Checkbox
                                    data-vaul-no-drag
                                    disabled={!d.url}
                                    checked={designIds.includes(d.id)}
                                    onCheckedChange={(v) => setDesignIds((ids) => (v === true ? [...ids, d.id] : ids.filter((x) => x !== d.id)))}
                                />
                                <span className="text-sm">
                                    {d.label ?? "Návrh"} {d.url ? <span className="text-muted-foreground">{displayUrl(d.url)}</span> : null}
                                    {!d.url && <span className="block text-xs text-destructive">Bez odkazu – doplň URL v karte Návrh.</span>}
                                </span>
                            </label>
                        ))}
                    </div>
                )}

                {wants("OTHER") && (
                    <div className="space-y-2">
                        <label htmlFor="finish-answer" className={LABEL}>
                            Odpoveď pre obchodníka
                        </label>
                        <Textarea
                            id="finish-answer"
                            data-vaul-no-drag
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            placeholder="Čo má vedieť"
                            className="min-h-[88px] text-[16px] md:text-sm"
                        />
                    </div>
                )}

                {send ? (
                    <div className="space-y-3 rounded-lg border p-3">
                        <p className="text-sm font-medium">Poslal som klientovi</p>
                        <label className="flex items-center gap-3 text-sm">
                            <span className="w-20 shrink-0 text-muted-foreground">Poslané</span>
                            <input
                                type="date"
                                data-vaul-no-drag
                                value={sentOn}
                                max={today}
                                onChange={(e) => setSentOn(e.target.value)}
                                onClick={(e) => e.currentTarget.showPicker?.()}
                                className={`${dateInput} flex-1`}
                            />
                        </label>
                        <div className="flex flex-wrap gap-4 text-sm">
                            <label className="flex items-center gap-2">
                                <Checkbox data-vaul-no-drag checked={aboutUs} onCheckedChange={(v) => setAboutUs(v === true)} />
                                aj o nás
                            </label>
                            <label className="flex items-center gap-2">
                                <Checkbox data-vaul-no-drag checked={pricelist} onCheckedChange={(v) => setPricelist(v === true)} />
                                aj cenník
                            </label>
                        </div>
                        {otherPending.length === 0 ? (
                            <label className="flex items-center gap-3 text-sm">
                                <span className="w-20 shrink-0 text-muted-foreground">Zavolať</span>
                                <input
                                    type="date"
                                    data-vaul-no-drag
                                    value={followUpOn || defaultFollowUp}
                                    min={today}
                                    onChange={(e) => setFollowUpOn(e.target.value)}
                                    onClick={(e) => e.currentTarget.showPicker?.()}
                                    className={`${dateInput} flex-1`}
                                />
                            </label>
                        ) : null}
                        <p className="text-xs text-muted-foreground">
                            {otherPending.length === 0
                                ? `${owner} potom zavolá, či to prišlo (ďalší krok obchodu).`
                                : `Ešte neposlané zo staršej úlohy: ${otherPending.map((i) => i.label).join(", ")} – krok ostáva „Poslať…“.`}
                        </p>
                    </div>
                ) : (
                    <p className="rounded-lg bg-muted/50 p-3 text-sm">
                        {owner} to dostane na dnes s krokom <span className="font-medium">{stepLabel}</span>.
                    </p>
                )}

                <div className="space-y-2">
                    <Button className="h-12 w-full text-base" disabled={pending || Boolean(missing)} onClick={save}>
                        {pending ? "Ukladám…" : send ? "Uložiť – vybavené a poslané" : "Hotovo – odoslať výsledok"}
                    </Button>
                    {missing && <p className="text-center text-xs text-muted-foreground">{missing}</p>}
                </div>
            </div>
        </ResponsiveSheet>
    );
}
