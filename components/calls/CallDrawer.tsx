"use client";

import { useState } from "react";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import type { QueueLead } from "@/lib/queries/calls";
import type { FirstCallOutcome } from "@/lib/domain/leadFlow";
import type { OutcomeOpts } from "./CallQueue";

type Step = "main" | "scheduled" | "interested" | "email" | "snooze";

// Po výbere záujmu uložíme pending outcome, potom prejdeme na email step
type PendingOutcome = { outcome: FirstCallOutcome; label: string } | null;

// Trieda pre natívne date/datetime inputy:
// text-[16px] – zabraňuje iOS auto-zoom pri focuse
// [color-scheme:light_dark] – zabezpečí viditeľnosť ikonky kalendára v dark mode
const nativeDateCls = "h-12 flex-1 rounded-md border px-3 text-[16px] [color-scheme:light_dark]";

// Termíny posielame ako Schedule (dátum „YYYY-MM-DD" / čas „HH:mm"); deň a hodinu prepočíta server v Europe/Bratislava.
export default function CallDrawer({
    lead, recipientPreview, onClose, onOutcome,
}: {
    lead: QueueLead | null;
    recipientPreview: string | null;
    onClose: () => void;
    onOutcome: (lead: QueueLead, outcome: FirstCallOutcome, label: string, opts: OutcomeOpts) => void;
}) {
    const [step, setStep] = useState<Step>("main");
    const [note, setNote] = useState(lead?.note ?? "");
    const [callbackNote, setCallbackNote] = useState("");
    const [customDate, setCustomDate] = useState("");
    const [customTime, setCustomTime] = useState("");
    const [pendingOutcome, setPendingOutcome] = useState<PendingOutcome>(null);
    const [email, setEmail] = useState(lead?.email ?? "");

    if (!lead) return <Drawer open={false} />;
    const L = lead;
    const name = L.companyName ?? L.website ?? "—";
    const cbNote = () => callbackNote.trim() || undefined;

    // Poznámka ide vždy (aj prázdna) – server ju uloží ku kontaktu, ak sa zmenila, a ako poznámku hovoru.
    function fire(outcome: FirstCallOutcome, label: string, opts: Omit<OutcomeOpts, "note"> = {}) {
        onOutcome(L, outcome, label, { note, ...opts });
    }

    function selectInterest(outcome: FirstCallOutcome, label: string) {
        setPendingOutcome({ outcome, label });
        setStep("email");
    }

    // Vlastný termín: dátum povinný, čas voliteľný. Čas vyplnený = presný dohodnutý čas, prázdny = len deň.
    function fireScheduledCustom() {
        if (!customDate) return;
        if (customTime) {
            fire("CALL_AGAIN", "Dohodnutý čas", {
                schedule: { kind: "dayTime", date: customDate, time: customTime },
                callbackNote: cbNote(),
            });
        } else {
            fire("CALL_AGAIN", "Dohodnutý deň", { schedule: { kind: "day", date: customDate }, callbackNote: cbNote() });
        }
    }

    function fireWithEmail() {
        if (!pendingOutcome) return;
        fire(pendingOutcome.outcome, pendingOutcome.label, {
            callbackNote: cbNote(),
            email: email.trim() || undefined,
        });
    }

    const big = "h-12 w-full justify-start text-base";

    return (
        // repositionInputs={false}: vaul defaultne presúva drawer hore keď sa focusne input
        // → na iOS to spôsobí, že drawer vyletí mimo obrazovky. Vypneme to.
        <Drawer open={!!lead} onOpenChange={(o) => !o && onClose()} repositionInputs={false}>
            {/* max-h-[90dvh]: dvh sa aktualizuje s klávesnicou na Androide; na iOS dáva aspoň buffer */}
            <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[90dvh]">
                <DrawerHeader className="flex-none pb-2">
                    <DrawerTitle className="text-lg">
                        {name}
                        {L.attempts > 0 && (
                            <span className="ml-2 text-sm font-normal text-muted-foreground">· {L.attempts}. pokus</span>
                        )}
                    </DrawerTitle>
                    <DrawerDescription className="sr-only">Výsledok hovoru</DrawerDescription>
                </DrawerHeader>

                {/* flex-1 + overflow-y-auto: drawer má pevnú výšku, obsah scrolluje interne */}
                <div className="flex-1 overflow-y-auto overscroll-contain">
                    <div className="mx-auto w-full max-w-md space-y-2 px-4 pb-6">

                        {/* ── HLAVNÉ MENU ── */}
                        {step === "main" && (
                            <>
                                <Button variant="outline" className={big} onClick={() => setStep("interested")}>
                                    ⭐ Majú záujem…
                                </Button>
                                <Button variant="outline" className={big} onClick={() => fire("NO_ANSWER", "Nezdvihli")}>
                                    📵 Nezdvihli
                                </Button>
                                <Button variant="outline" className={big} onClick={() => setStep("scheduled")}>
                                    🕐 Dohodnúť presný čas…
                                </Button>
                                <Button variant="outline" className={big} onClick={() => setStep("snooze")}>
                                    💤 Ozvať sa o pár mesiacov…
                                </Button>
                                <Button variant="destructive" className="mt-2 h-12 w-full justify-start text-base"
                                    onClick={() => fire("NOT_INTERESTED", "Nemajú záujem")}>
                                    ✕ Nemajú záujem
                                </Button>
                                <Button variant="ghost" className="w-full text-muted-foreground"
                                    onClick={() => fire("BAD_NUMBER", "Zlé číslo")}>
                                    Zlé / nefunkčné číslo
                                </Button>
                            </>
                        )}

                        {/* ── DOHODNUTÝ ČAS ── */}
                        {step === "scheduled" && (
                            <>
                                <p className="px-1 pb-1 text-sm text-muted-foreground">Kedy sa s ňou dohodla?</p>
                                <Input
                                    data-vaul-no-drag
                                    placeholder="Poznámka – napr. „chce poobede“"
                                    value={callbackNote}
                                    onChange={(e) => setCallbackNote(e.target.value)}
                                    className="mb-2 text-base"
                                />
                                <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "O hodinu", { schedule: { kind: "inHours", hours: 1 }, callbackNote: cbNote() })}>O hodinu</Button>
                                <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "Zajtra", { schedule: { kind: "daysFromToday", days: 1 }, callbackNote: cbNote() })}>Zajtra</Button>
                                <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "O týždeň", { schedule: { kind: "daysFromToday", days: 7 }, callbackNote: cbNote() })}>O týždeň</Button>
                                <div className="flex gap-2">
                                    <input
                                        type="date"
                                        data-vaul-no-drag
                                        value={customDate}
                                        onChange={(e) => setCustomDate(e.target.value)}
                                        onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLInputElement).showPicker?.(); }}
                                        className={nativeDateCls}
                                    />
                                    <input
                                        type="time"
                                        data-vaul-no-drag
                                        value={customTime}
                                        onChange={(e) => setCustomTime(e.target.value)}
                                        onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLInputElement).showPicker?.(); }}
                                        className="h-12 w-28 rounded-md border px-3 text-[16px] [color-scheme:light_dark]"
                                    />
                                    <Button className="h-12" disabled={!customDate} onClick={fireScheduledCustom}>
                                        OK
                                    </Button>
                                </div>
                                <p className="px-1 text-xs text-muted-foreground">
                                    Čas nechaj prázdny, ak nie je dohodnutý presný čas (napr. „v piatok“).
                                </p>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                            </>
                        )}

                        {/* ── TYP ZÁUJMU ── */}
                        {step === "interested" && (
                            <>
                                <p className="px-1 pb-1 text-xs text-muted-foreground">
                                    {recipientPreview
                                        ? `Pravdepodobne odovzdá: ${recipientPreview} (náhľad)`
                                        : "Pravdepodobne nepriradené – obchod priradí manažér (náhľad)"}
                                </p>
                                <Button variant="outline" className={big} onClick={() => selectInterest("WANTS_DESIGN", "Chcú návrh")}>
                                    🎨 Chcú návrh zdarma
                                </Button>
                                <Button variant="outline" className={big} onClick={() => selectInterest("WANTS_QUOTE", "Chcú cenovú ponuku")}>
                                    💶 Chcú cenovú ponuku
                                </Button>
                                <Button variant="outline" className={big} onClick={() => selectInterest("WANTS_EMAIL", "Máme napísať")}>
                                    ✉️ Máme im napísať
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                            </>
                        )}

                        {/* ── EMAIL STEP (po výbere záujmu) ── */}
                        {step === "email" && (
                            <>
                                <p className="px-1 pb-1 text-sm text-muted-foreground">
                                    Dali špecifický kontaktný email? (nepovinné)
                                </p>
                                <Input
                                    type="email"
                                    data-vaul-no-drag
                                    placeholder={L.email ?? "email@firma.sk"}
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="mb-2 text-base"
                                />
                                <Button className="h-12 w-full" onClick={fireWithEmail}>
                                    Uložiť
                                </Button>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("interested")}>← Späť</Button>
                            </>
                        )}

                        {/* ── SNOOZE ── */}
                        {step === "snooze" && (
                            <>
                                <Input
                                    data-vaul-no-drag
                                    placeholder="Poznámka – napr. „ozvať sa na jar, teraz nemajú rozpočet“"
                                    value={callbackNote}
                                    onChange={(e) => setCallbackNote(e.target.value)}
                                    className="mb-2 text-base"
                                />
                                <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 2 mesiace", { schedule: { kind: "monthsFromToday", months: 2 }, callbackNote: cbNote() })}>O 2 mesiace</Button>
                                <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 4 mesiace", { schedule: { kind: "monthsFromToday", months: 4 }, callbackNote: cbNote() })}>O 4 mesiace</Button>
                                <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 6 mesiacov", { schedule: { kind: "monthsFromToday", months: 6 }, callbackNote: cbNote() })}>O 6 mesiacov</Button>
                                <div className="flex gap-2">
                                    <input
                                        type="date"
                                        data-vaul-no-drag
                                        value={customDate}
                                        onChange={(e) => setCustomDate(e.target.value)}
                                        onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLInputElement).showPicker?.(); }}
                                        className={nativeDateCls}
                                    />
                                    <Button className="h-12" disabled={!customDate}
                                        onClick={() => fire("SNOOZE", "Vlastný termín", { schedule: { kind: "day", date: customDate }, callbackNote: cbNote() })}>
                                        OK
                                    </Button>
                                </div>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                            </>
                        )}

                        <Textarea
                            data-vaul-no-drag
                            placeholder="Poznámka k firme (nepovinné)"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            className="mt-1 min-h-[60px] text-base"
                        />
                    </div>
                </div>
            </DrawerContent>
        </Drawer>
    );
}
