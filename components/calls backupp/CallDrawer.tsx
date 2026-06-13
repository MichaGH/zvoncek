"use client";

import { useEffect, useState } from "react";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { updateLeadNote } from "@/lib/actions/calls";
import { inHours, tomorrow9, inDays, inMonths } from "@/lib/utils";
import { QueueLead } from "@/lib/queries/calls";
import { CallOutcome } from "@/app/generated/prisma/enums";

type Step = "main" | "scheduled" | "interested" | "snooze";
type Opts = { note?: string; callbackNote?: string; when?: string };

export default function CallDrawer({
    lead, onClose, onOutcome,
}: {
    lead: QueueLead | null;
    onClose: () => void;
    onOutcome: (leadId: string, outcome: CallOutcome, label: string, opts?: Opts) => void;
}) {
    const [step, setStep] = useState<Step>("main");
    const [note, setNote] = useState("");
    const [callbackNote, setCallbackNote] = useState("");
    const [customDate, setCustomDate] = useState("");

    useEffect(() => {
        if (lead) {
            setStep("main");
            setNote(lead.note ?? "");
            setCallbackNote("");
            setCustomDate("");
        }
    }, [lead]);

    if (!lead) return <Drawer open={false} />;
    const L = lead;
    const name = L.companyName ?? L.website ?? "—";

    function fire(outcome: CallOutcome, label: string, when?: string) {
        const trimmed = note.trim();
        if (trimmed !== (L.note ?? "")) updateLeadNote(L.id, trimmed);
        onOutcome(L.id, outcome, label, {
            note: trimmed || undefined,
            callbackNote: callbackNote.trim() || undefined,
            when,
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
                    {step === "main" && (
                        <>
                            <Button variant="outline" className={big} onClick={() => setStep("interested")}>
                                ⭐ Majú záujem…
                            </Button>
                            {/* Nezdvihli – jednoklik, padá do „Skúsiť znova" */}
                            <Button variant="outline" className={big} onClick={() => fire("NO_ANSWER", "Nezdvihli")}>
                                📵 Nezdvihli
                            </Button>
                            {/* Zdvihla, dohodli čas – urgentné */}
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

                    {step === "scheduled" && (
                        <>
                            <p className="px-1 pb-1 text-sm text-muted-foreground">Kedy sa s ňou dohodla?</p>
                            <Input placeholder="Poznámka – napr. „chce poobede"
                                value={callbackNote} onChange={(e) => setCallbackNote(e.target.value)} className="mb-2" />
                            <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "O hodinu", inHours(1))}>O hodinu</Button>
                            <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "Zajtra", tomorrow9())}>Zajtra ráno</Button>
                            <Button variant="outline" className={big} onClick={() => fire("CALL_AGAIN", "O týždeň", inDays(7))}>O týždeň</Button>
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
                                    onClick={() => fire("CALL_AGAIN", "Dohodnutý termín", new Date(customDate).toISOString())}>OK</Button>
                            </div>
                            <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                        </>
                    )}

                    {step === "interested" && (
                        <>
                            <Button variant="outline" className={big} onClick={() => fire("WANTS_DESIGN", "Chcú návrh")}>🎨 Chcú návrh zdarma</Button>
                            <Button variant="outline" className={big} onClick={() => fire("WANTS_QUOTE", "Chcú cenovú ponuku")}>💶 Chcú cenovú ponuku</Button>
                            <Button variant="outline" className={big} onClick={() => fire("WANTS_EMAIL", "Máme napísať")}>✉️ Máme im napísať</Button>
                            <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                        </>
                    )}

                    {step === "snooze" && (
                        <>
                            <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 2 mesiace", inMonths(2))}>O 2 mesiace</Button>
                            <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 4 mesiace", inMonths(4))}>O 4 mesiace</Button>
                            <Button variant="outline" className={big} onClick={() => fire("SNOOZE", "O 6 mesiacov", inMonths(6))}>O 6 mesiacov</Button>
                            <Button variant="ghost" className="w-full" onClick={() => setStep("main")}>← Späť</Button>
                        </>
                    )}

                    <Textarea placeholder="Poznámka k firme (nepovinné)"
                        value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 min-h-[60px] text-sm" />
                </div>
            </DrawerContent>
        </Drawer>
    );
}