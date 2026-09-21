"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DealTaskContent } from "@/app/generated/prisma/enums";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { finishAndSend, resolveTaskParts } from "@/lib/actions/pipeline";
import { NEXT_ACTION_LABEL, TASK_CONTENT_LABEL } from "@/lib/dictionaries";
import { addBusinessCalendarDays, businessDate } from "@/lib/domain/businessTime";
import { contentOfTask, REQUEST_SHORT_LABEL } from "@/lib/domain/clientRequests";
import { displayUrl } from "@/lib/domain/designLinks";
import type { DealDetailData, DealTaskView } from "@/lib/queries/pipeline";
import { cn } from "@/lib/utils";

// „Hotovo" (wave 3 §6.3) a „Poslal som to klientovi sám" (§6.5) – ten istý formulár výsledku, ale wave 4 ho robí
// PO ČASTIACH (§2.7, R02-4): manažér výslovne zaškrtne, čo práve odovzdáva. Predvyplnená cena je len pohodlie,
// nikdy rozhodnutie – inak by sa jedným uložením odovzdala stará suma z obchodu a zamrzla ako nemenný výsledok.
// Neoznačené časti ostávajú otvorené a dorobia sa neskôr; úloha sa zavrie až vtedy, keď na nej nič neostane.

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
    // Odovzdať sa dá len to, čo manažér ešte má; dodané a zamietnuté časti sa už neprepisujú (Q11).
    const open = task.parts.filter((p) => p.status === "REQUESTED");
    const [picked, setPicked] = useState<DealTaskContent[]>(open.length === 1 ? [open[0].kind] : []);
    const [amount, setAmount] = useState(lead.price != null ? String(lead.price) : "");
    const [priceNote, setPriceNote] = useState(lead.priceNote ?? "");
    const [designIds, setDesignIds] = useState<string[]>([]);
    const [answer, setAnswer] = useState("");
    const [aboutUs, setAboutUs] = useState(false);
    const [pricelist, setPricelist] = useState(false);
    const [sentOn, setSentOn] = useState(today);
    const [followUpOn, setFollowUpOn] = useState("");
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);

    const on = (kind: DealTaskContent) => picked.includes(kind);
    const toggle = (kind: DealTaskContent, next: boolean) =>
        setPicked((ids) => (next ? [...new Set([...ids, kind])] : ids.filter((k) => k !== kind)));

    const amountNumber = amount.trim() === "" ? null : Number(amount.replace(",", "."));
    const amountValid = amountNumber !== null && Number.isFinite(amountNumber) && amountNumber >= 0;
    const owner = lead.owner?.firstName ?? "Vlastník";
    const stepLabel = lead.nextActionKind ? NEXT_ACTION_LABEL[lead.nextActionKind] : "bez kroku";
    const defaultFollowUp = addBusinessCalendarDays(sentOn || today, 7);

    const staysOpen = open.filter((p) => !on(p.kind));
    // Čo z toho, čo klient čaká, týmto uložením naozaj odíde – podľa toho sa ponúkne hovor „či prišlo" (§7 P1).
    const sentContents = send
        ? [
              ...(aboutUs ? (["INFO"] as const) : []),
              ...(pricelist ? (["PRICELIST"] as const) : []),
              ...picked.map(contentOfTask).filter((c): c is NonNullable<ReturnType<typeof contentOfTask>> => c !== null),
          ]
        : [];
    const outstandingAfter = lead.outstanding.filter((c) => !sentContents.includes(c));
    const sendable = picked.includes("PRICE") || picked.includes("DESIGN");

    const missing =
        picked.length === 0
            ? "Vyber, čo odovzdávaš"
            : on("PRICE") && !amountValid
              ? "Doplň cenu"
              : on("DESIGN") && designIds.length === 0
                ? "Vyber návrh s odkazom"
                : on("OTHER") && !answer.trim()
                  ? "Napíš odpoveď"
                  : send && !sendable
                    ? "Poslať sa dá cena alebo návrh"
                    : send && (!sentOn || sentOn > today)
                      ? "Neplatný dátum"
                      : null;

    function save() {
        if (missing) return;
        const parts = picked.map((kind) => ({
            kind,
            op: "DELIVER" as const,
            ...(kind === "PRICE" && amountNumber !== null ? { price: { amount: amountNumber, note: priceNote.trim() || null } } : {}),
            ...(kind === "DESIGN"
                ? { designs: designIds.map((id) => ({ id, version: lead.designs.find((d) => d.id === id)?.version ?? 1 })) }
                : {}),
            ...(kind === "OTHER" ? { answer: answer.trim() } : {}),
        }));
        const common = { taskId: task.id, expectedRevision: lead.revision, idempotencyKey, parts };
        start(async () => {
            const r = send
                ? await finishAndSend({
                      ...common,
                      extraContents: [...(aboutUs ? (["ABOUT_US"] as const) : []), ...(pricelist ? (["PRICELIST"] as const) : [])],
                      sentOn,
                      ...(outstandingAfter.length === 0 && followUpOn ? { followUpOn } : {}),
                  })
                : await resolveTaskParts(common);
            if (!("error" in r)) {
                toast.success(send ? "Odovzdané a poslané klientovi" : staysOpen.length ? "Odovzdané – zvyšok ostáva na tebe" : `Vybavené – ${owner} to má na dnes`);
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
    const partBox = (kind: DealTaskContent, body: React.ReactNode) => (
        <div key={kind} className={cn("space-y-3 rounded-lg border p-3", on(kind) ? "border-primary/60 bg-primary/5" : "bg-muted/20")}>
            <label className="flex items-center gap-3 text-sm font-medium">
                <Checkbox data-vaul-no-drag checked={on(kind)} onCheckedChange={(v) => toggle(kind, v === true)} />
                {TASK_CONTENT_LABEL[kind]}
                <span className="font-normal text-muted-foreground">{on(kind) ? "odovzdávam teraz" : "ostáva otvorené"}</span>
            </label>
            {on(kind) && body}
        </div>
    );

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
                        {task.requestedBy.firstName} žiada · {open.map((p) => TASK_CONTENT_LABEL[p.kind]).join(" + ")}
                    </p>
                    <p className="whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 text-sm">{task.text}</p>
                </div>

                {open.some((p) => p.kind === "PRICE") &&
                    partBox(
                        "PRICE",
                        <div className="space-y-2">
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
                                {lead.price != null ? "Predvyplnené aktuálnou cenou obchodu – skontroluj ju. " : ""}Uloží sa aj ako aktuálna cena
                                obchodu (nová suma bez rozpisu zmaže starý rozpis).
                            </p>
                        </div>,
                    )}

                {open.some((p) => p.kind === "DESIGN") &&
                    partBox(
                        "DESIGN",
                        <div className="space-y-2">
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
                        </div>,
                    )}

                {open.some((p) => p.kind === "OTHER") &&
                    partBox(
                        "OTHER",
                        <Textarea
                            id="finish-answer"
                            data-vaul-no-drag
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            placeholder="Čo má obchodník vedieť"
                            className="min-h-[88px] text-[16px] md:text-sm"
                        />,
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
                        {outstandingAfter.length === 0 ? (
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
                            {outstandingAfter.length === 0
                                ? `${owner} potom zavolá, či to prišlo (ďalší krok obchodu).`
                                : `Klient ešte nedostal: ${outstandingAfter.map((c) => REQUEST_SHORT_LABEL[c]).join(", ")} – krok ostáva „Poslať…“.`}
                        </p>
                    </div>
                ) : (
                    <p className="rounded-lg bg-muted/50 p-3 text-sm">
                        {staysOpen.length
                            ? `${staysOpen.map((p) => TASK_CONTENT_LABEL[p.kind]).join(" + ")} ostáva na tebe – úloha sa nezavrie a krok ${owner} ostáva zamknutý.`
                            : `${owner} to dostane na dnes s krokom ${stepLabel}.`}
                    </p>
                )}

                <div className="space-y-2">
                    <Button className="h-12 w-full text-base" disabled={pending || Boolean(missing)} onClick={save}>
                        {pending
                            ? "Ukladám…"
                            : send
                              ? `Odovzdať a poslať (${picked.length} z ${open.length})`
                              : `Odovzdať vybrané (${picked.length} z ${open.length})`}
                    </Button>
                    {missing && <p className="text-center text-xs text-muted-foreground">{missing}</p>}
                </div>
            </div>
        </ResponsiveSheet>
    );
}
