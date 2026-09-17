"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DealRequestKind } from "@/app/generated/prisma/enums";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionError } from "@/lib/access/errors";
import { createDealRequest, logClientEmailSent, logFollowUp, setClientQuoteSent } from "@/lib/actions/clients";
import { ACTIVITY_LABEL, OUTCOME_LABEL, REQUEST_KIND_LABEL, STATUS_LABEL } from "@/lib/dictionaries";
import type { FollowUpNextKind, FollowUpOutcome } from "@/lib/domain/leadFlow";
import type { Schedule } from "@/lib/domain/schedule";
import type { ClientRow } from "@/lib/queries/clients";

type Step = "main" | "progress" | "scheduled" | "snooze" | "notInterested" | "sent" | "request";

const REFRESH_CODES = new Set(["NOT_ASSIGNED", "NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "FORBIDDEN"]);
const nativeDateCls = "h-12 flex-1 rounded-md border px-3 text-[16px] [color-scheme:light_dark]";
const REP_REQUEST_KINDS: DealRequestKind[] = ["PRICE", "DESIGN", "EMAIL", "ORDER", "OTHER"];

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Drawer obchodu (ako CallDrawer). Uzavretý obchod je len na čítanie s jedinou akciou „Požiadať o znovuotvorenie".
export default function ClientDrawer({ deal, canWork, onClose }: { deal: ClientRow | null; canWork: boolean; onClose: () => void }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [step, setStep] = useState<Step>("main");
    const [note, setNote] = useState("");
    const [date, setDate] = useState("");
    const [time, setTime] = useState("");
    const [reason, setReason] = useState("");
    const [requestKind, setRequestKind] = useState<DealRequestKind>("PRICE");
    const [requestNote, setRequestNote] = useState("");
    // Idempotency kľúč platí, kým je drawer otvorený pre túto revíziu (opakovanie = ten istý kľúč).
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);

    if (!deal) return <Drawer open={false} />;
    const D = deal;
    const closed = D.status === "WON" || D.status === "LOST" || D.status === "UNREACHABLE";

    function handle(r: { success: true } | ActionError, ok: string, retry?: () => void) {
        if (!("error" in r)) {
            toast.success(ok);
            onClose();
            router.refresh();
            return;
        }
        if (r.code && REFRESH_CODES.has(r.code)) {
            toast.error(r.code === "FORBIDDEN" || r.code === "UNAUTHENTICATED" ? r.error : "Obchod sa medzitým zmenil – obnovujem");
            setIdempotencyKey(newKey());
            onClose();
            router.refresh();
            return;
        }
        toast.error("Nepodarilo sa uložiť", {
            description: r.error,
            ...(retry ? { action: { label: "Skúsiť znova", onClick: retry } } : {}),
        });
    }

    function followUp(
        outcome: FollowUpOutcome,
        label: string,
        extra: { schedule?: Schedule | null; nextKind?: FollowUpNextKind; lostReason?: string } = {},
    ) {
        const send = () =>
            start(async () => {
                try {
                    const r = await logFollowUp({
                        leadId: D.id,
                        outcome,
                        expectedRevision: D.revision,
                        idempotencyKey,
                        note: note.trim() || null,
                        ...extra,
                    });
                    handle(r, `Zaznamenané: ${label}`, send);
                } catch {
                    toast.error("Chyba siete", { action: { label: "Skúsiť znova", onClick: send } });
                }
            });
        send();
    }

    function scheduleFromInputs(): Schedule | null {
        if (!date) return null;
        return time ? { kind: "dayTime", date, time } : { kind: "day", date };
    }

    function request(kind: DealRequestKind, text: string | null) {
        start(async () => {
            const r = await createDealRequest(D.id, kind, text);
            if (!("error" in r) && !r.created) {
                toast.success("Požiadavka už existuje – doplnená poznámka");
                onClose();
                router.refresh();
                return;
            }
            handle(r, "Požiadavka odoslaná manažérovi");
        });
    }

    const big = "h-12 w-full justify-start text-base";

    return (
        <Drawer open onOpenChange={(o) => !o && onClose()} repositionInputs={false}>
            <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[90dvh]">
                <DrawerHeader className="flex-none pb-2">
                    <DrawerTitle className="text-lg">
                        <span className="mr-2 text-sm font-normal text-muted-foreground">#{D.number}</span>
                        {D.name}
                    </DrawerTitle>
                    <DrawerDescription className="space-x-2 text-sm">
                        {D.phone && (
                            <a href={`tel:${D.phone.replace(/\s/g, "")}`} className="font-medium text-primary tabular-nums">
                                {D.phone}
                            </a>
                        )}
                        {D.lastActivity && (
                            <span>
                                · Posledný krok: {D.lastActivity.outcome ? OUTCOME_LABEL[D.lastActivity.outcome] : ACTIVITY_LABEL[D.lastActivity.type]}
                            </span>
                        )}
                        {D.openRequests.map((r) => (
                            <span key={r.id}>· Požiadavka: {REQUEST_KIND_LABEL[r.kind]}</span>
                        ))}
                    </DrawerDescription>
                </DrawerHeader>

                <div className="flex-1 overflow-y-auto overscroll-contain">
                    <div className="mx-auto w-full max-w-md space-y-2 px-4 pb-6">
                        {closed ? (
                            <>
                                <p className="rounded-lg border bg-muted/30 p-3 text-sm">
                                    Obchod je uzavretý ({STATUS_LABEL[D.status]}){D.lostReason ? ` – ${D.lostReason}` : ""}. Úpravy robí manažér.
                                </p>
                                {canWork && (
                                    <>
                                        <Textarea
                                            data-vaul-no-drag
                                            placeholder="Prečo znovu otvoriť? (nepovinné)"
                                            value={requestNote}
                                            onChange={(e) => setRequestNote(e.target.value)}
                                            className="min-h-[60px] text-base"
                                        />
                                        <Button className="h-12 w-full" disabled={pending} onClick={() => request("REOPEN", requestNote.trim() || null)}>
                                            Požiadať o znovuotvorenie
                                        </Button>
                                    </>
                                )}
                                <Button asChild variant="ghost" className="w-full">
                                    <Link href={`/dashboard/clients/${D.id}`}>História a detail →</Link>
                                </Button>
                            </>
                        ) : (
                            <>
                                {step === "main" && (
                                    <>
                                        <Button variant="outline" className={big} disabled={pending || !canWork} onClick={() => setStep("progress")}>
                                            ✅ Dovolal/a som sa – posun…
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending || !canWork} onClick={() => followUp("NO_ANSWER", "Nezdvihli")}>
                                            📵 Nezdvihli
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending || !canWork} onClick={() => setStep("scheduled")}>
                                            🕐 Dohodnúť čas…
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending || !canWork} onClick={() => followUp("WANTS_QUOTE", "Chcú cenovú ponuku")}>
                                            💶 Chcú cenovú ponuku
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending || !canWork} onClick={() => followUp("WANTS_DESIGN", "Chcú návrh")}>
                                            🎨 Chcú návrh
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending || !canWork} onClick={() => followUp("WANTS_TO_ORDER", "Chcú objednať")}>
                                            🤝 Chcú objednať
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending || !canWork} onClick={() => setStep("snooze")}>
                                            💤 Ozvať sa neskôr…
                                        </Button>
                                        <Button variant="destructive" className="h-12 w-full justify-start text-base" disabled={pending || !canWork} onClick={() => setStep("notInterested")}>
                                            ✕ Nemajú záujem
                                        </Button>
                                        <div className="my-2 h-px bg-border" />
                                        <Button variant="ghost" className="w-full justify-start" disabled={pending || !canWork} onClick={() => setStep("sent")}>
                                            Označiť ako poslané…
                                        </Button>
                                        <Button variant="ghost" className="w-full justify-start" disabled={pending || !canWork} onClick={() => setStep("request")}>
                                            Požiadať manažéra…
                                        </Button>
                                        <Button asChild variant="ghost" className="w-full justify-start">
                                            <Link href={`/dashboard/clients/${D.id}`}>Otvoriť detail →</Link>
                                        </Button>
                                    </>
                                )}

                                {step === "progress" && (
                                    <>
                                        <p className="px-1 pb-1 text-sm text-muted-foreground">Aký je ďalší krok?</p>
                                        <div className="flex gap-2">
                                            <input type="date" data-vaul-no-drag value={date} onChange={(e) => setDate(e.target.value)} className={nativeDateCls} />
                                            <input type="time" data-vaul-no-drag value={time} onChange={(e) => setTime(e.target.value)} className="h-12 w-28 rounded-md border px-3 text-[16px] [color-scheme:light_dark]" />
                                        </div>
                                        <p className="px-1 text-xs text-muted-foreground">Dátum je povinný len pre „Zavolať“; pri čakaní je to deň kontroly.</p>
                                        <Button variant="outline" className={big} disabled={pending} onClick={() => followUp("POSITIVE", "Čakáme na klienta", { nextKind: "WAITING_FOR_CLIENT", schedule: scheduleFromInputs() })}>
                                            ⏳ Čakáme na klienta
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending} onClick={() => followUp("POSITIVE", "Poslať CP", { nextKind: "SEND_QUOTE", schedule: scheduleFromInputs() })}>
                                            💶 Poslať cenovú ponuku
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending} onClick={() => followUp("POSITIVE", "Poslať email", { nextKind: "SEND_EMAIL", schedule: scheduleFromInputs() })}>
                                            ✉️ Poslať email
                                        </Button>
                                        <Button variant="outline" className={big} disabled={pending || !date} onClick={() => followUp("POSITIVE", "Zavolať", { nextKind: "CALL", schedule: scheduleFromInputs() })}>
                                            📞 Zavolať (dátum)
                                        </Button>
                                        <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                                    </>
                                )}

                                {step === "scheduled" && (
                                    <>
                                        <p className="px-1 pb-1 text-sm text-muted-foreground">Kedy zavolať? (čas nechaj prázdny, ak nie je presný)</p>
                                        <div className="flex gap-2">
                                            <input type="date" data-vaul-no-drag value={date} onChange={(e) => setDate(e.target.value)} className={nativeDateCls} />
                                            <input type="time" data-vaul-no-drag value={time} onChange={(e) => setTime(e.target.value)} className="h-12 w-28 rounded-md border px-3 text-[16px] [color-scheme:light_dark]" />
                                            <Button className="h-12" disabled={pending || !date} onClick={() => followUp("CALL_AGAIN", "Dohodnutý hovor", { schedule: scheduleFromInputs() })}>
                                                OK
                                            </Button>
                                        </div>
                                        <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                                    </>
                                )}

                                {step === "snooze" && (
                                    <>
                                        {[2, 4, 6].map((m) => (
                                            <Button key={m} variant="outline" className={big} disabled={pending} onClick={() => followUp("SNOOZE", `O ${m} mesiace`, { schedule: { kind: "monthsFromToday", months: m } })}>
                                                O {m} {m === 6 ? "mesiacov" : "mesiace"}
                                            </Button>
                                        ))}
                                        <div className="flex gap-2">
                                            <input type="date" data-vaul-no-drag value={date} onChange={(e) => setDate(e.target.value)} className={nativeDateCls} />
                                            <Button className="h-12" disabled={pending || !date} onClick={() => followUp("SNOOZE", "Vlastný termín", { schedule: { kind: "day", date } })}>
                                                OK
                                            </Button>
                                        </div>
                                        <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                                    </>
                                )}

                                {step === "notInterested" && (
                                    <>
                                        <Input data-vaul-no-drag placeholder="Dôvod (nepovinné)" value={reason} onChange={(e) => setReason(e.target.value)} className="text-base" />
                                        <Button variant="destructive" className="h-12 w-full" disabled={pending} onClick={() => followUp("NOT_INTERESTED", "Nemajú záujem", { lostReason: reason.trim() || undefined })}>
                                            Potvrdiť – nemajú záujem
                                        </Button>
                                        <Button variant="ghost" className="w-full text-muted-foreground" disabled={pending} onClick={() => followUp("BAD_NUMBER", "Zlé číslo")}>
                                            Zlé / nefunkčné číslo
                                        </Button>
                                        <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                                    </>
                                )}

                                {step === "sent" && (
                                    <>
                                        <Button
                                            variant="outline"
                                            className={big}
                                            disabled={pending}
                                            onClick={() => start(async () => handle(await setClientQuoteSent(D.id, true), "Cenová ponuka označená ako odoslaná"))}
                                        >
                                            Cenová ponuka odoslaná
                                        </Button>
                                        <Button
                                            variant="outline"
                                            className={big}
                                            disabled={pending}
                                            onClick={() => start(async () => handle(await logClientEmailSent(D.id), "Email označený ako odoslaný"))}
                                        >
                                            Email „O nás“ odoslaný
                                        </Button>
                                        <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                                    </>
                                )}

                                {step === "request" && (
                                    <>
                                        <div className="grid grid-cols-2 gap-2">
                                            {REP_REQUEST_KINDS.map((k) => (
                                                <Button key={k} variant={requestKind === k ? "default" : "outline"} onClick={() => setRequestKind(k)}>
                                                    {REQUEST_KIND_LABEL[k]}
                                                </Button>
                                            ))}
                                        </div>
                                        <Textarea
                                            data-vaul-no-drag
                                            placeholder="Čo potrebuješ od manažéra?"
                                            value={requestNote}
                                            onChange={(e) => setRequestNote(e.target.value)}
                                            className="min-h-[60px] text-base"
                                        />
                                        <Button className="h-12 w-full" disabled={pending} onClick={() => request(requestKind, requestNote.trim() || null)}>
                                            Odoslať požiadavku
                                        </Button>
                                        <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                                    </>
                                )}

                                <Textarea
                                    data-vaul-no-drag
                                    placeholder="Poznámka k hovoru (uloží sa s výsledkom)"
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    className="mt-1 min-h-[60px] text-base"
                                />
                            </>
                        )}
                    </div>
                </div>
            </DrawerContent>
        </Drawer>
    );
}
