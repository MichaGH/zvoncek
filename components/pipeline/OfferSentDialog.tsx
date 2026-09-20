"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, Lock } from "lucide-react";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { copyEmailLink } from "@/components/shared/copyEmailLink";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { recordOfferSent } from "@/lib/actions/pipeline";
import { NEXT_ACTION_LABEL, TASK_CONTENT_LABEL } from "@/lib/dictionaries";
import { addBusinessCalendarDays, businessDate, businessDayMonth, businessDayStart } from "@/lib/domain/businessTime";
import { displayUrl } from "@/lib/domain/designLinks";
import { formatMoney, legacyUnreviewed, moneyToString, type OfferContent, type OfferDialogDeal } from "@/lib/domain/offers";
import {
    contentOfOffer,
    contentOfTask,
    isSystemStep,
    REQUEST_CONTENT_LABEL,
    sendCompletesStep,
    sortContents,
    stepKindForOutstanding,
    stepView,
} from "@/lib/domain/clientRequests";
import { overlapsTask, type PendingItem } from "@/lib/domain/tasks";

// „Čo sme poslali" (round 2, wave 3a – §2c 5.2/5.3). Jedno miesto pre každé odoslanie ponukových materiálov.
// Predvyplnenie je len návrh: „o nás" a „cenník" sa zaškrtnú, len ak ešte nešli (na neoverenom starom obchode nikdy),
// „cena" pri kroku „Poslať cenu". Ďalší krok sa nikdy nenahradí potichu – voľba je vždy viditeľná.
// Režim „historical" = doplnenie starého odoslania s pôvodným dátumom: bez ďalšieho kroku a bez úloh.
//
// Wave 3 (§5.1, §6.4): vrátené výsledky úloh sa ponúknu ako riadky („Posielam cenu od Michala") – zaškrtnuté idú do
// meta.fulfils; jedno odoslanie = jedna cena (staršia sa odmietne ako nahradená). Kým niečo vrátené ostáva neposlané,
// krok ostáva „Poslať…" (alebo sa zvyšok v tom istom uložení odmietne). Zamknutý krok: odoslanie je len fakt; ak sa
// kryje s tým, na čom manažér robí, treba vybrať, čo s úlohou.
//
// Wave 5 (§3.4): čo klient pýtal a ešte nedostal, je predzaškrtnuté (aj cenník pri kroku „Poslať cenu"); odškrtnutie
// netreba zdôvodňovať – riadok jednoducho ostane nevybavený. Pribudol obsah „Rozbor webu".

const REFRESH_CODES = new Set(["NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "STEP_LOCKED"]);
const SUPERSEDED = "nahradená novšou";

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const keyOf = (i: PendingItem) => `${i.taskId}:${i.kind}:${i.designId ?? ""}`;
const refOf = (i: PendingItem) => ({ taskId: i.taskId, kind: i.kind, ...(i.designId ? { designId: i.designId } : {}) });

export default function OfferSentDialog({
    deal,
    viewerId,
    isManager,
    historical = false,
    preselectDesignId,
    onClose,
}: {
    deal: OfferDialogDeal;
    viewerId: string;
    isManager: boolean;
    historical?: boolean;
    preselectDesignId?: string;
    onClose: () => void;
}) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const today = businessDate(new Date());
    const unknownLegacy = legacyUnreviewed(deal.offers);
    const unsentDesigns = deal.designs.filter((d) => !d.sentAt).map((d) => d.id);
    const returned = historical ? [] : deal.pending;
    const priceItems = returned.filter((i) => i.kind === "PRICE");
    const newestPrice = priceItems.at(-1) ?? null;
    const designItems = returned.filter((i) => i.kind === "DESIGN");
    const liveDesign = (id: string | undefined) => deal.designs.find((d) => d.id === id && d.url);
    // Vrátený návrh: predvolene zaškrtnutý, ak ešte existuje a má odkaz; pri dvoch vráteniach toho istého návrhu novší.
    const usableDesignItems = designItems.filter(
        (i, idx) => liveDesign(i.designId) && !designItems.slice(idx + 1).some((j) => j.designId === i.designId),
    );

    // Čo klient pýtal a ešte nedostal – predvyplní sa vždy, aj keď to už raz dostal (nová požiadavka, §3.4).
    const asked = historical ? [] : deal.asked;
    const [sentOn, setSentOn] = useState(historical ? "" : today);
    const [aboutUs, setAboutUs] = useState(!historical && (asked.includes("INFO") || (!deal.offers.offerAboutUsAt && !unknownLegacy)));
    const [pricelist, setPricelist] = useState(!historical && (asked.includes("PRICELIST") || (!deal.offers.offerPricelistAt && !unknownLegacy)));
    const [review, setReview] = useState(!historical && asked.includes("REVIEW"));
    const [withPrice, setWithPrice] = useState(
        !historical && (asked.includes("PRICE") || newestPrice !== null || (deal.nextActionKind === "SEND_QUOTE" && deal.price != null)),
    );
    const [designIds, setDesignIds] = useState<string[]>(
        preselectDesignId
            ? [preselectDesignId]
            : usableDesignItems.length
              ? [...new Set(usableDesignItems.map((i) => i.designId!))]
              : !historical && deal.nextActionKind === "SEND_DESIGN" && !deal.openTask
                ? unsentDesigns
                : [],
    );
    const [usePriceItem, setUsePriceItem] = useState(newestPrice !== null);
    const [useDesignItems, setUseDesignItems] = useState<string[]>(usableDesignItems.map(keyOf));
    const [acceptCurrentPrice, setAcceptCurrentPrice] = useState(false);
    const [dropRest, setDropRest] = useState(false);
    const [dropReason, setDropReason] = useState("");
    const [editPrice, setEditPrice] = useState(historical || deal.price == null);
    const [amount, setAmount] = useState(historical || deal.price == null ? "" : String(deal.price));
    const [priceNote, setPriceNote] = useState(historical ? "" : (deal.priceNote ?? ""));
    // Voľba používateľa; kým nevybral, predvolí sa podľa toho, či zaškrtnutý obsah naozaj dokončuje aktuálnu úlohu.
    const [followUpChoice, setFollowUp] = useState<boolean | null>(null);
    const [followUpOn, setFollowUpOn] = useState(""); // prázdne = o 7 dní od odoslania
    const [copied, setCopied] = useState<string | null>(null);
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);
    const [overlap, setOverlap] = useState<"KEEP_OPEN" | "CANCEL_TASK" | null>(null);
    const [cancelReason, setCancelReason] = useState("");
    // Manažér na cudzom obchode: najprv potvrdenie v tom istom okne (nie prehliadačový confirm).
    const [confirmOwner, setConfirmOwner] = useState(false);
    const foreignDeal = isManager && deal.owner !== null && deal.owner.id !== viewerId && !historical;
    const isOwner = deal.owner?.id === viewerId;
    // O vrátených výsledkoch („neposielam", staršia cena nahradená) rozhoduje vlastník, na obchode bez vlastníka manažér
    // (§5.2) – server to vynúti. Ostatným sa nič neodmieta: staršie / zvyšné položky ostávajú vlastníkovi.
    const decidesResults = isOwner || (deal.owner === null && isManager);

    const contents: OfferContent[] = [
        ...(aboutUs ? (["ABOUT_US"] as const) : []),
        ...(pricelist ? (["PRICELIST"] as const) : []),
        ...(review ? (["REVIEW"] as const) : []),
        ...(withPrice ? (["PRICE"] as const) : []),
        ...(designIds.length ? (["DESIGN"] as const) : []),
    ];
    const task = historical ? null : deal.openTask;
    const overlapping = overlapsTask(task, contents);
    // Voľba platí, len kým sa obsah naozaj kryje s úlohou (R02-2): po odškrtnutí ceny / návrhu sa skrytá voľba neposiela
    // (inak by server odmietal „zrušiť" bez prekryvu a dialóg by sa nedal uložiť). Opätovné zaškrtnutie ju ukáže znova.
    const choice = overlapping ? overlap : null;
    const cancelling = Boolean(task) && choice === "CANCEL_TASK";
    // Zamknutý krok: odoslanie je len fakt (krok sa nemení), pokiaľ sa úloha v tom istom uložení neruší.
    const factOnly = Boolean(task) && !cancelling;

    // Čo toto odoslanie použije z vrátených výsledkov.
    const fulfilPrice = withPrice && usePriceItem && newestPrice ? newestPrice : null;
    const fulfilDesigns = designItems.filter((i) => useDesignItems.includes(keyOf(i)) && designIds.includes(i.designId ?? ""));
    const fulfils = [...(fulfilPrice ? [fulfilPrice] : []), ...fulfilDesigns];
    // Staršia vrátená cena / staršia verzia toho istého návrhu sa pri použití novšej odmietne ako nahradená (W3-R3-03).
    const superseded = decidesResults
        ? [
              ...(fulfilPrice ? priceItems.filter((i) => i !== fulfilPrice) : []),
              ...designItems.filter((i) => !fulfils.includes(i) && fulfilDesigns.some((f) => f.designId === i.designId)),
          ]
        : [];
    const remaining = returned.filter((i) => (i.kind === "PRICE" || i.kind === "DESIGN") && !fulfils.includes(i) && !superseded.includes(i));
    const dropped = dropRest && decidesResults ? remaining : [];

    // „Poslať cenu" dokončí cena, „Poslať návrh" návrh, „Poslať úvodný email" o nás / cenník – a „Poslať…" aj posledná
    // čakajúca vrátená položka (R03-1, sendCompletesStep). Iný krok (napr. hovor) sa predvolene ponecháva; bez kroku follow-up.
    const pendingAfter = dropped.length ? [] : remaining;
    // Čo ostane nevybavené po tomto uložení (§6.9): čo klient stále nedostal, čo manažér ešte robí a čo vrátil a
    // neposiela sa. Podľa toho sa predvolí „Zavolať, či prišlo" a ukáže sa, čo ešte ostáva.
    const taskContent = (k: "PRICE" | "DESIGN" | "OTHER") => contentOfTask(k);
    const sentContents = contents.map(contentOfOffer);
    const outstandingAfter = sortContents([
        ...asked.filter((c) => !sentContents.includes(c)),
        ...pendingAfter.flatMap((i) => (i.kind === "PRICE" || i.kind === "DESIGN" ? [i.kind] : [])),
        ...(task && !cancelling ? task.contents.flatMap((c) => (taskContent(c) ? [taskContent(c)!] : [])) : []),
    ]);
    const completesStep = sendCompletesStep(deal.nextActionKind, contents, deal.outstanding, outstandingAfter);
    const pendingBlocksFollowUp = pendingAfter.length > 0 || outstandingAfter.length > 0;
    const followUp = !factOnly && !pendingBlocksFollowUp && (followUpChoice ?? completesStep);
    const amountNumber = amount.trim() === "" ? null : Number(amount.replace(",", "."));
    const amountValid = amountNumber !== null && Number.isFinite(amountNumber) && amountNumber >= 0;
    const priceMissing = withPrice && editPrice && !amountValid;
    const sentAmount = withPrice ? (editPrice ? (amountValid ? amountNumber : null) : deal.price) : null;
    const priceMismatch =
        fulfilPrice?.price && sentAmount !== null && moneyToString(sentAmount) !== fulfilPrice.price.amount && !acceptCurrentPrice;
    const dateInvalid = !sentOn || sentOn > today || (historical && sentOn >= today);
    const defaultFollowUp = addBusinessCalendarDays(sentOn || today, 7);
    const followUpDate = businessDayMonth(businessDayStart(followUpOn || defaultFollowUp));
    const followUpInvalid = followUp && followUpOn !== "" && followUpOn < today;
    // „Ponechať" nesmie klamať: po čiastočnom odoslaní krok padne na to, čo ostalo (§3.7) – tlačidlo teda ukazuje,
    // čím krok naozaj bude. Ručne zvolený krok (hovor, čakanie, vlastný) sa neprepisuje, takže ostáva, ako je.
    const keptKind = isSystemStep(deal.nextActionKind) ? (stepKindForOutstanding(outstandingAfter) ?? deal.nextActionKind) : deal.nextActionKind;
    const keptLabel = keptKind
        ? (stepView(keptKind, outstandingAfter).headline ?? NEXT_ACTION_LABEL[keptKind])
        : null;
    const current = keptLabel
        ? `${keptLabel}${keptKind === deal.nextActionKind && deal.nextActionAt ? ` · ${businessDayMonth(new Date(deal.nextActionAt))}` : ""}`
        : "bez ďalšieho kroku";
    const legacy = deal.offers.legacy;
    const blocked =
        contents.length === 0
            ? "Zaškrtni, čo sme poslali"
            : priceMissing
              ? "Doplň sumu"
              : dateInvalid
                ? historical
                    ? "Vyber pôvodný dátum"
                    : "Neplatný dátum"
                : overlapping && !choice
                  ? "Vyber, čo s úlohou"
                  : cancelling && !cancelReason.trim()
                    ? "Napíš, prečo úlohu rušíš"
                    : priceMismatch
                      ? "Potvrď, ktorú cenu posielaš"
                      : dropped.length > 0 && !dropReason.trim()
                        ? "Napíš, prečo sa zvyšok neposiela"
                        : null;

    function toggleDesign(id: string, on: boolean) {
        setDesignIds((ids) => (on ? [...new Set([...ids, id])] : ids.filter((x) => x !== id)));
    }

    async function copy(id: string, url: string | null, tracked: string | null) {
        if (!url || !tracked) return;
        if (await copyEmailLink(url, tracked)) {
            setCopied(id);
            setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
        } else toast.error("Schránka nie je dostupná");
    }

    function save(confirmed = false) {
        if (foreignDeal && !confirmed) {
            setConfirmOwner(true);
            return;
        }
        setConfirmOwner(false);
        const dismissItems = [...superseded, ...dropped];
        start(async () => {
            const r = await recordOfferSent({
                leadId: deal.id,
                expectedRevision: deal.revision,
                idempotencyKey,
                contents,
                sentOn,
                historical,
                price: withPrice && editPrice && amountNumber !== null ? { amount: amountNumber, note: priceNote.trim() || null } : null,
                designIds: designIds.length ? designIds : undefined,
                followUp: !historical && followUp,
                ...(!historical && followUp && followUpOn ? { followUpOn } : {}),
                ...(choice ? { overlap: choice } : {}),
                ...(cancelling && task ? { cancelTask: { taskId: task.id, reason: cancelReason.trim() } } : {}),
                ...(fulfils.length ? { fulfils: fulfils.map((i) => ({ taskId: i.taskId, kind: i.kind as "PRICE" | "DESIGN", ...(i.designId ? { designId: i.designId } : {}) })) } : {}),
                ...(dismissItems.length
                    ? {
                          dismiss: {
                              items: dismissItems.map(refOf),
                              reason: dropped.length ? `${dropReason.trim()}${superseded.length ? `; staršie: ${SUPERSEDED}` : ""}` : SUPERSEDED,
                          },
                      }
                    : {}),
            });
            if (!("error" in r)) {
                toast.success(historical ? "Starý záznam doplnený" : "Zaznamenané, čo klient dostal");
                onClose();
                router.refresh();
                return;
            }
            toast.error(r.code && REFRESH_CODES.has(r.code) ? "Obchod sa medzitým zmenil – obnovujem" : r.error);
            if (r.code && REFRESH_CODES.has(r.code)) {
                setIdempotencyKey(newKey());
                onClose();
                router.refresh();
            }
        });
    }

    const row = "flex items-start gap-3 rounded-lg border p-3";
    return (
        <ResponsiveSheet
            open
            onOpenChange={(o) => !o && onClose()}
            title={historical ? "Doplniť starý záznam" : "Čo sme poslali"}
            description={
                historical
                    ? `Staré: ${[
                          legacy.aboutUsSentAt ? `email o nás ${businessDayMonth(new Date(legacy.aboutUsSentAt))}` : null,
                          legacy.quoteSentAt ? `CP ${businessDayMonth(new Date(legacy.quoteSentAt))}` : null,
                          legacy.priceDisclosed ? "„klient pozná cenu“" : null,
                      ]
                          .filter(Boolean)
                          .join(", ") || "bez podrobností"}`
                    : "Zaškrtni, čo bolo v emaili. Predvyplnené je len to, čo ešte nešlo."
            }
        >
            <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6 md:max-w-none md:px-0 md:pb-0">
                {task && (
                    <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                        <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            Krok čaká na úlohu pre {task.assignee} (
                            {task.type === "HANDOVER" ? "odovzdanie" : task.contents.map((c) => TASK_CONTENT_LABEL[c].toLowerCase()).join(" + ")}).
                            Odoslanie sa zapíše, krok sa nezmení.
                        </span>
                    </p>
                )}

                <label className="flex items-center gap-3 text-sm">
                    <span className="w-20 shrink-0 text-muted-foreground">Poslané</span>
                    <input
                        type="date"
                        data-vaul-no-drag
                        value={sentOn}
                        max={historical ? addBusinessCalendarDays(today, -1) : today}
                        onChange={(e) => setSentOn(e.target.value)}
                        onClick={(e) => e.currentTarget.showPicker?.()}
                        className="h-11 flex-1 rounded-md border px-3 text-[16px] [color-scheme:light_dark]"
                    />
                </label>

                {asked.length > 0 && (
                    <p className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-sm">
                        Chceli: {asked.map((c) => REQUEST_CONTENT_LABEL[c]).join(", ")} – predvyplnené. Odškrtnuté ostane nevybavené.
                    </p>
                )}

                <label className={row}>
                    <Checkbox data-vaul-no-drag checked={aboutUs} onCheckedChange={(v) => setAboutUs(v === true)} />
                    <span className="text-sm">Info / ukážky</span>
                </label>
                <label className={row}>
                    <Checkbox data-vaul-no-drag checked={pricelist} onCheckedChange={(v) => setPricelist(v === true)} />
                    <span className="text-sm">Cenník</span>
                </label>

                <div className={row}>
                    <Checkbox data-vaul-no-drag checked={withPrice} onCheckedChange={(v) => setWithPrice(v === true)} aria-label="Cena" />
                    <div className="min-w-0 flex-1 space-y-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <span>Cena</span>
                            {!editPrice && deal.price != null && <span className="font-medium tabular-nums">{formatMoney(deal.price)}</span>}
                            {!editPrice && (
                                <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setEditPrice(true)}>
                                    upraviť
                                </button>
                            )}
                        </div>
                        {!editPrice && deal.priceNote && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{deal.priceNote}</p>}
                        {editPrice && (
                            <>
                                <Input
                                    data-vaul-no-drag
                                    inputMode="decimal"
                                    placeholder={historical ? "Suma, ktorú vtedy dostali (€)" : "Suma (€)"}
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    className="text-[16px]"
                                />
                                <Textarea
                                    data-vaul-no-drag
                                    placeholder="Rozpis, napr. Web 550 € · admin 250 € · SEO 350 €"
                                    value={priceNote}
                                    onChange={(e) => setPriceNote(e.target.value)}
                                    className="min-h-[60px] text-[16px]"
                                />
                                {!historical && <p className="text-xs text-muted-foreground">Uloží sa aj ako aktuálna cena obchodu.</p>}
                            </>
                        )}
                        {newestPrice?.price && withPrice && (
                            <div className="space-y-1.5 border-t pt-2">
                                <label className="flex items-center gap-2">
                                    <Checkbox data-vaul-no-drag checked={usePriceItem} onCheckedChange={(v) => setUsePriceItem(v === true)} />
                                    Posielam cenu od {newestPrice.by?.firstName ?? "manažéra"} ({formatMoney(newestPrice.price.amount)})
                                </label>
                                {fulfilPrice && sentAmount !== null && moneyToString(sentAmount) !== newestPrice.price.amount && (
                                    <label className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                                        <Checkbox
                                            data-vaul-no-drag
                                            checked={acceptCurrentPrice}
                                            onCheckedChange={(v) => setAcceptCurrentPrice(v === true)}
                                        />
                                        {newestPrice.by?.firstName ?? "Manažér"} vrátil {formatMoney(newestPrice.price.amount)}, posielaš{" "}
                                        {formatMoney(sentAmount)} – posielam aktuálnu cenu
                                    </label>
                                )}
                                {fulfilPrice &&
                                    priceItems
                                        .filter((i) => i !== fulfilPrice)
                                        .map((i) => (
                                            <p key={keyOf(i)} className="text-xs text-muted-foreground">
                                                Neposielam – {i.label} od {i.by?.firstName ?? "manažéra"} je nahradená novšou cenou.
                                            </p>
                                        ))}
                            </div>
                        )}
                    </div>
                </div>

                {deal.designs.map((d) => {
                    const item = designItems.filter((i) => i.designId === d.id).at(-1);
                    return (
                        <div key={d.id} className={row}>
                            <Checkbox
                                data-vaul-no-drag
                                checked={designIds.includes(d.id)}
                                onCheckedChange={(v) => toggleDesign(d.id, v === true)}
                                aria-label={`Návrh ${d.label ?? ""}`}
                            />
                            <div className="min-w-0 flex-1 space-y-1 text-sm">
                                <p>
                                    Návrh {d.label ?? ""} {d.url && <span className="text-muted-foreground">{displayUrl(d.url)}</span>}
                                </p>
                                {d.sentAt && <p className="text-xs text-muted-foreground">už poslaný {businessDayMonth(new Date(d.sentAt))}</p>}
                                {item && designIds.includes(d.id) && d.url && (
                                    <label className="flex items-center gap-2 text-xs">
                                        <Checkbox
                                            data-vaul-no-drag
                                            checked={useDesignItems.includes(keyOf(item))}
                                            onCheckedChange={(v) =>
                                                setUseDesignItems((cur) => (v === true ? [...cur, keyOf(item)] : cur.filter((x) => x !== keyOf(item))))
                                            }
                                        />
                                        Posielam návrh od {item.by?.firstName ?? "manažéra"}
                                        {item.design && item.design.version !== undefined ? ` (vrátená v${item.design.version})` : ""}
                                    </label>
                                )}
                            </div>
                            {!historical && d.trackedUrl && d.url && (
                                <Button type="button" size="sm" variant="outline" onClick={() => copy(d.id, d.url, d.trackedUrl)}>
                                    {copied === d.id ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                                    Odkaz do emailu
                                </Button>
                            )}
                        </div>
                    );
                })}
                {designItems
                    .filter((i) => !liveDesign(i.designId))
                    .map((i) => (
                        <p key={keyOf(i)} className="rounded-lg border p-3 text-xs text-muted-foreground">
                            {i.label} od {i.by?.firstName ?? "manažéra"} sa nedá poslať – návrh bol zmazaný alebo nemá odkaz.
                        </p>
                    ))}

                {/* Poradie všade rovnaké: Info · Cenník · Cena · Návrh · Rozbor webu (Michal, 2026-09-21). */}
                <label className={row}>
                    <Checkbox data-vaul-no-drag checked={review} onCheckedChange={(v) => setReview(v === true)} />
                    <span className="text-sm">Rozbor webu</span>
                </label>

                {/* [WAVE 4] Cena + návrh v jednej úlohe: poslanú cenu pri ešte otvorenej úlohe (návrh sa robí) zapíše „Úloha ostáva
                    otvorená“ – tok už funguje; s čiastočným vybavením sa tu ponúkne aj vrátená cena (wave-4-proposal.md §2). */}
                {task && overlapping && (
                    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                        <p>{task.assignee} práve robí to, čo posielaš. Čo s úlohou?</p>
                        <label className="flex items-center gap-2">
                            <input type="radio" checked={overlap === "KEEP_OPEN"} onChange={() => setOverlap("KEEP_OPEN")} />
                            Úloha ostáva otvorená ({task.assignee} robí niečo iné)
                        </label>
                        {isOwner && (
                            <label className="flex items-center gap-2">
                                <input type="radio" checked={overlap === "CANCEL_TASK"} onChange={() => setOverlap("CANCEL_TASK")} />
                                Už to netreba – zrušiť úlohu
                            </label>
                        )}
                        {isManager && !isOwner && (
                            <p className="text-xs text-muted-foreground">Vybavil si to sám? Použi v úlohe „Vybavil som to sám“ – úloha sa uzavrie spolu s odoslaním.</p>
                        )}
                        {cancelling && (
                            <Input
                                data-vaul-no-drag
                                value={cancelReason}
                                onChange={(e) => setCancelReason(e.target.value)}
                                placeholder="Prečo úlohu rušíš"
                                className="text-[16px]"
                            />
                        )}
                    </div>
                )}

                {!historical && remaining.length > 0 && (
                    <div className="space-y-2 rounded-lg border p-3 text-sm">
                        <p>
                            Ostáva neposlané: {remaining.map((i) => i.label).join(", ")} –{" "}
                            {decidesResults
                                ? "krok ostáva „Poslať…“, kým to nepošleš."
                                : `krok ostáva „Poslať…“; či sa to pošle, rozhodne ${deal.owner?.firstName ?? "vlastník"}.`}
                        </p>
                        {decidesResults && (
                            <label className="flex items-center gap-2">
                                <Checkbox data-vaul-no-drag checked={dropRest} onCheckedChange={(v) => setDropRest(v === true)} />
                                Neposielam to
                            </label>
                        )}
                        {decidesResults && dropRest && (
                            <Input
                                data-vaul-no-drag
                                value={dropReason}
                                onChange={(e) => setDropReason(e.target.value)}
                                placeholder="Prečo (napr. klient už nechce)"
                                className="text-[16px]"
                            />
                        )}
                    </div>
                )}

                {!historical && !factOnly && (
                    <div className="space-y-2 pt-1">
                        <p className="px-1 text-sm text-muted-foreground">Ďalší krok</p>
                        <div className="grid gap-2 md:grid-cols-2">
                            <Button
                                type="button"
                                variant={followUp ? "default" : "outline"}
                                className="h-auto min-h-11 whitespace-normal"
                                disabled={pendingBlocksFollowUp}
                                onClick={() => setFollowUp(true)}
                            >
                                Zavolať, či prišlo · {followUpDate}
                            </Button>
                            <Button type="button" variant={!followUp ? "default" : "outline"} className="h-auto min-h-11 whitespace-normal" onClick={() => setFollowUp(false)}>
                                Ponechať: {current}
                            </Button>
                        </div>
                        {followUp && (
                            <label className="flex items-center gap-3 text-sm">
                                <span className="shrink-0 text-muted-foreground">Kedy zavolať</span>
                                <input
                                    type="date"
                                    data-vaul-no-drag
                                    value={followUpOn || defaultFollowUp}
                                    min={today}
                                    onChange={(e) => setFollowUpOn(e.target.value)}
                                    onClick={(e) => e.currentTarget.showPicker?.()}
                                    className="h-11 flex-1 rounded-md border px-3 text-[16px] [color-scheme:light_dark]"
                                />
                            </label>
                        )}
                        {pendingBlocksFollowUp && (
                            <p className="text-xs text-muted-foreground">
                                {outstandingAfter.length > 0
                                    ? `Ostáva nevybavené: ${outstandingAfter.map((c) => REQUEST_CONTENT_LABEL[c]).join(", ")}. Dátum a poznámku kroku zmeníš cez „Zmeniť krok“.`
                                    : "Dátum a poznámku kroku zmeníš cez „Zmeniť krok“."}
                            </p>
                        )}
                    </div>
                )}

                {confirmOwner && deal.owner && (
                    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                        <p className="flex items-start gap-2 font-medium text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            Tento obchod vlastní {deal.owner.firstName}.
                        </p>
                        <p className="text-muted-foreground">
                            Poslal/a si to klientovi naozaj ty? Ak chceš {deal.owner.firstName} len dať vedieť, že je to hotové, použi
                            radšej „Hotovo“ v úlohe.
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <Button size="sm" disabled={pending} onClick={() => save(true)}>
                                Áno, poslal/a som to ja
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmOwner(false)}>
                                Späť
                            </Button>
                        </div>
                    </div>
                )}

                <Button
                    className="h-12 w-full"
                    disabled={pending || confirmOwner || Boolean(blocked) || followUpInvalid}
                    onClick={() => save()}
                >
                    {blocked ?? "Uložiť"}
                </Button>
                <Button variant="ghost" className="w-full" disabled={pending} onClick={onClose}>
                    ← Späť
                </Button>
            </div>
        </ResponsiveSheet>
    );
}
