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

    // Keď vyberú typ záujmu, uloží pending a prejde na email step
    function selectInterest(outcome: CallOutcome, label: string, when?: string) {
        setPendingOutcome({ outcome, label, when });
        setStep("email");
    }

    // Finalizuje po email stepe
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
        <Drawer open={!!lead} onOpenChange={(o) => !o && onClose()}>
            <DrawerContent>
                <DrawerHeader className="pb-2">
                    <DrawerTitle className="text-lg">
                        {name}
                        {L.attempts > 0 && (
                            <span className="ml-2 text-sm font-normal text-muted-foreground">· {L.attempts}. pokus</span>
                        )}
                    </DrawerTitle>
                    <DrawerDescription className="sr-only">Výsledok hovoru</DrawerDescription>
                </DrawerHeader>

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
                                placeholder="Poznámka – napr. „chce poobede"
                                value={callbackNote}
                                onChange={(e) => setCallbackNote(e.target.value)}
                                className="mb-2"
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
                                    className="h-12 flex-1 rounded-md border bg-background px-3 text-sm"
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
                                placeholder={L.email ?? "email@firma.sk"}
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="mb-2"
                                autoFocus
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
                            <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 2 mesiace", { when: inMonths(2) })}>O 2 mesiace</Button>
                            <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 4 mesiace", { when: inMonths(4) })}>O 4 mesiace</Button>
                            <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 6 mesiacov", { when: inMonths(6) })}>O 6 mesiacov</Button>
                            <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                        </>
                    )}

                    <Textarea
                        placeholder="Poznámka k firme (nepovinné)"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="mt-1 min-h-[60px] text-sm"
                    />
                </div>
            </DrawerContent>
        </Drawer>
    );
}
