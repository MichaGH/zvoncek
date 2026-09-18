"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import type { NextActionKind } from "@/app/generated/prisma/enums";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { copyEmailLink } from "@/components/shared/copyEmailLink";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { recordOfferSent } from "@/lib/actions/pipeline";
import { NEXT_ACTION_LABEL } from "@/lib/dictionaries";
import { addBusinessCalendarDays, businessDate, businessDayMonth, businessDayStart } from "@/lib/domain/businessTime";
import { displayUrl } from "@/lib/domain/designLinks";
import { formatMoney, legacyUnreviewed, type OfferContent } from "@/lib/domain/offers";
import type { DealDetailData } from "@/lib/queries/pipeline";

// „Čo sme poslali" (round 2, wave 3a – §2c 5.2/5.3). Jedno miesto pre každé odoslanie ponukových materiálov.
// Predvyplnenie je len návrh: „o nás" a „cenník" sa zaškrtnú, len ak ešte nešli (na neoverenom starom obchode nikdy),
// „cena" pri kroku „Poslať cenu". Ďalší krok sa nikdy nenahradí potichu – voľba je vždy viditeľná.
// Režim „historical" = doplnenie starého odoslania s pôvodným dátumom: bez ďalšieho kroku a bez vybavenia požiadaviek.

const REFRESH_CODES = new Set(["NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED"]);
const SEND_STEPS: NextActionKind[] = ["SEND_EMAIL", "SEND_QUOTE", "SEND_DESIGN"];

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type OfferDialogDeal = Pick<
    DealDetailData,
    "id" | "revision" | "owner" | "price" | "priceNote" | "nextActionKind" | "nextActionAt" | "offers" | "designs"
>;

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

    const [sentOn, setSentOn] = useState(historical ? "" : today);
    const [aboutUs, setAboutUs] = useState(!historical && !deal.offers.offerAboutUsAt && !unknownLegacy);
    const [pricelist, setPricelist] = useState(!historical && !deal.offers.offerPricelistAt && !unknownLegacy);
    const [withPrice, setWithPrice] = useState(!historical && deal.nextActionKind === "SEND_QUOTE" && deal.price != null);
    const [designIds, setDesignIds] = useState<string[]>(
        preselectDesignId ? [preselectDesignId] : !historical && deal.nextActionKind === "SEND_DESIGN" ? unsentDesigns : [],
    );
    const [editPrice, setEditPrice] = useState(historical || deal.price == null);
    const [amount, setAmount] = useState(historical || deal.price == null ? "" : String(deal.price));
    const [priceNote, setPriceNote] = useState(historical ? "" : (deal.priceNote ?? ""));
    // Nahradiť krok len vtedy, keď toto odoslanie dokončuje aktuálnu úlohu „poslať…" (alebo žiadny krok nie je).
    const completesStep = !deal.nextActionKind || SEND_STEPS.includes(deal.nextActionKind);
    const [followUp, setFollowUp] = useState(completesStep);
    const [copied, setCopied] = useState<string | null>(null);
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);

    const contents: OfferContent[] = [
        ...(aboutUs ? (["ABOUT_US"] as const) : []),
        ...(pricelist ? (["PRICELIST"] as const) : []),
        ...(withPrice ? (["PRICE"] as const) : []),
        ...(designIds.length ? (["DESIGN"] as const) : []),
    ];
    const amountNumber = amount.trim() === "" ? null : Number(amount.replace(",", "."));
    const amountValid = amountNumber !== null && Number.isFinite(amountNumber) && amountNumber >= 0;
    const priceMissing = withPrice && editPrice && !amountValid;
    const dateInvalid = !sentOn || sentOn > today || (historical && sentOn >= today);
    const followUpDate = businessDayMonth(businessDayStart(addBusinessCalendarDays(sentOn || today, 7)));
    const current = deal.nextActionKind
        ? `${NEXT_ACTION_LABEL[deal.nextActionKind]}${deal.nextActionAt ? ` · ${businessDayMonth(new Date(deal.nextActionAt))}` : ""}`
        : "bez ďalšieho kroku";
    const legacy = deal.offers.legacy;

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

    function save() {
        if (isManager && deal.owner && deal.owner.id !== viewerId && !historical) {
            const ok = window.confirm(
                `Tento obchod vlastní ${deal.owner.firstName}. Poslal/a si to klientovi naozaj ty?\n\nAk chceš ${deal.owner.firstName} len dať vedieť, že je to hotové, vybav požiadavku.`,
            );
            if (!ok) return;
        }
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

                <label className={row}>
                    <Checkbox data-vaul-no-drag checked={aboutUs} onCheckedChange={(v) => setAboutUs(v === true)} />
                    <span className="text-sm">O nás</span>
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
                    </div>
                </div>

                {deal.designs.map((d) => (
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
                        </div>
                        {!historical && d.trackedUrl && d.url && (
                            <Button type="button" size="sm" variant="outline" onClick={() => copy(d.id, d.url, d.trackedUrl)}>
                                {copied === d.id ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                                Odkaz do emailu
                            </Button>
                        )}
                    </div>
                ))}

                {!historical && (
                    <div className="space-y-2 pt-1">
                        <p className="px-1 text-sm text-muted-foreground">Ďalší krok</p>
                        <div className="grid gap-2 md:grid-cols-2">
                            <Button type="button" variant={followUp ? "default" : "outline"} className="h-auto min-h-11 whitespace-normal" onClick={() => setFollowUp(true)}>
                                Zavolať, či prišlo · {followUpDate}
                            </Button>
                            <Button type="button" variant={!followUp ? "default" : "outline"} className="h-auto min-h-11 whitespace-normal" onClick={() => setFollowUp(false)}>
                                Ponechať: {current}
                            </Button>
                        </div>
                    </div>
                )}

                <Button className="h-12 w-full" disabled={pending || contents.length === 0 || priceMissing || dateInvalid} onClick={save}>
                    {contents.length === 0
                        ? "Zaškrtni, čo sme poslali"
                        : priceMissing
                          ? "Doplň sumu"
                          : dateInvalid
                            ? historical
                                ? "Vyber pôvodný dátum"
                                : "Neplatný dátum"
                            : "Uložiť"}
                </Button>
            </div>
        </ResponsiveSheet>
    );
}
