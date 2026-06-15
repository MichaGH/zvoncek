"use client";

import { useState } from "react";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { updateLeadNote } from "@/lib/actions/calls";
import { inHours, tomorrow9, inDays, inMonths } from "@/lib/utils";
import { QueueLead } from "@/lib/queries/calls";
import { CallOutcome } from "@/app/generated/prisma/enums";

type Step = "main" | "scheduled" | "interested" | "email" | "snooze";
type Opts = { note?: string; callbackNote?: string; when?: string; email?: string };

// Po výbere záujmu uložíme pending outcome, potom prejdeme na email step
type PendingOutcome = { outcome: CallOutcome; label: string; when?: string } | null;

// Trieda pre natívne date/datetime inputy:
// text-[16px] – zabraňuje iOS auto-zoom pri focuse
// [color-scheme:light_dark] – zabezpečí viditeľnosť ikonky kalendára v dark mode
const nativeDateCls = "h-12 flex-1 rounded-md border px-3 text-[16px] [color-scheme:light_dark]";

export default function CallDrawer({
    lead, onClose, onOutcome,
}: {
    lead: QueueLead | null;
    onClose: () => void;
    onOutcome: (leadId: string, outcome: CallOutcome, label: string, opts?: Opts) => void;
}) {
    const [step, setStep] = useState<Step>("main");
    const [note, setNote] = useState(lead?.note ?? "");
    const [callbackNote, setCallbackNote] = useState("");
    const [customDate, setCustomDate] = useState("");
    const [pendingOutcome, setPendingOutcome] = useState<PendingOutcome>(null);
    const [email, setEmail] = useState(lead?.email ?? "");

    if (!lead) return <Drawer open={false} />;
    const L = lead;
    const name = L.companyName ?? L.website ?? "—";

    function fire(outcome: CallOutcome, label: string, opts?: Omit<Opts, "note">) {
        const trimmed = note.trim();
        if (trimmed !== (L.note ?? "")) updateLeadNote(L.id, trimmed);
        onOutcome(L.id, outcome, label, {
            note: trimmed || undefined,
            ...opts,
        });
    }

    function selectInterest(outcome: CallOutcome, label: string, when?: string) {
        setPendingOutcome({ outcome, label, when });
        setStep("email");
    }

    function fireWithEmail() {
        if (!pendingOutcome) return;
        fire(pendingOutcome.outcome, pendingOutcome.label, {
            callbackNote: callbackNote.trim() || undefined,
            when: pendingOutcome.when,
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
                                    placeholder='Poznámka – napr. „chce poobede"'
                                    value={callbackNote}
                                    onChange={(e) => setCallbackNote(e.target.value)}
                                    className="mb-2 text-base"
                                />
                                <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "O hodinu", { when: inHours(1) })}>O hodinu</Button>
                                <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "Zajtra", { when: tomorrow9() })}>Zajtra ráno</Button>
                                <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "O týždeň", { when: inDays(7) })}>O týždeň</Button>
                                <div className="flex gap-2">
                                    <input
                                        type="datetime-local"
                                        data-vaul-no-drag
                                        value={customDate}
                                        onChange={(e) => setCustomDate(e.target.value)}
                                        onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLInputElement).showPicker?.(); }}
                                        className={nativeDateCls}
                                    />
                                    <Button className="h-12" disabled={!customDate}
                                        onClick={() => fire("CALL_AGAIN", "Dohodnutý termín", { when: new Date(customDate).toISOString() })}>
                                        OK
                                    </Button>
                                </div>
                                <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                            </>
                        )}

                        {/* ── TYP ZÁUJMU ── */}
                        {step === "interested" && (
                            <>
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
                                    placeholder='Poznámka – napr. „ozvať sa na jar, teraz nemajú rozpočet"'
                                    value={callbackNote}
                                    onChange={(e) => setCallbackNote(e.target.value)}
                                    className="mb-2 text-base"
                                />
                                <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 2 mesiace", { when: inMonths(2), callbackNote: callbackNote.trim() || undefined })}>O 2 mesiace</Button>
                                <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 4 mesiace", { when: inMonths(4), callbackNote: callbackNote.trim() || undefined })}>O 4 mesiace</Button>
                                <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 6 mesiacov", { when: inMonths(6), callbackNote: callbackNote.trim() || undefined })}>O 6 mesiacov</Button>
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
                                        onClick={() => fire("SNOOZE", "Vlastný termín", { when: new Date(customDate).toISOString(), callbackNote: callbackNote.trim() || undefined })}>
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
