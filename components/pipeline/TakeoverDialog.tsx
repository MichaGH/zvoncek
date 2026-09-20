"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { takeover } from "@/lib/actions/pipeline";
import { NEXT_ACTION_LABEL } from "@/lib/dictionaries";
import { businessDate } from "@/lib/domain/businessTime";
import { FOLLOW_UP_NEXT_KINDS, type FollowUpNextKind } from "@/lib/domain/leadFlow";
import { defaultStepNote } from "@/lib/domain/nextStepOptions";
import { requiredStepKinds } from "@/lib/domain/tasks";
import type { DealDetailData } from "@/lib/queries/pipeline";

// „Preberám klienta" (wave 3 §6.9) a „Preberám" pri odovzdaní (§6.8) – ten istý príkaz a ten istý prechod vlastníka:
// manažér sa stane vlastníkom a nastaví si vlastný krok (predvolene aktuálny krok, dnes). Otvorená úloha skončí:
// pomoc sa zruší („klienta prevzal …"), odovzdanie sa prijme. Obchodník stratí prístup, obchod mu ostane v Histórii.

const REFRESH_CODES = new Set(["NOT_FOUND", "STALE", "DEAL_CLOSED", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED"]);

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function TakeoverDialog({ lead, onClose }: { lead: DealDetailData; onClose: () => void }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const open = lead.tasks.find((t) => t.status === "OPEN") ?? null;
    const required = requiredStepKinds(lead.pending);
    const kinds = FOLLOW_UP_NEXT_KINDS.filter((k) => !required || required.includes(k));
    const current = (FOLLOW_UP_NEXT_KINDS as readonly string[]).includes(lead.nextActionKind ?? "")
        ? (lead.nextActionKind as FollowUpNextKind)
        : "CALL";
    const [kind, setKind] = useState<FollowUpNextKind>(kinds.includes(current) ? current : kinds[0]);
    const [date, setDate] = useState(businessDate(new Date()));
    const [stepNote, setStepNote] = useState<string | null>(lead.nextActionKind === kind ? lead.nextActionNote : null);
    const [note, setNote] = useState("");
    const [idempotencyKey, setIdempotencyKey] = useState(newKey);
    const shownNote = stepNote ?? defaultStepNote(kind) ?? "";

    const consequence = !open
        ? null
        : open.type === "HANDOVER"
          ? `Odovzdanie od ${open.requestedBy.firstName} sa prijme.`
          : `Úloha od ${open.requestedBy.firstName} (${open.text}) sa zruší – klienta preberáš ty.`;

    function save() {
        start(async () => {
            const r = await takeover({
                leadId: lead.id,
                expectedRevision: lead.revision,
                idempotencyKey,
                note: note.trim() || null,
                step: { kind, schedule: date ? { kind: "day", date } : null, note: shownNote.trim() || null },
            });
            if (!("error" in r)) {
                toast.success("Klient je tvoj");
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

    return (
        <ResponsiveSheet
            open
            onOpenChange={(o) => !o && onClose()}
            title={open?.type === "HANDOVER" ? "Preberám klienta (odovzdanie)" : "Preberám klienta"}
            description={`${lead.name}${lead.owner ? ` · teraz ${lead.owner.firstName}` : " · bez vlastníka"}`}
        >
            <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6 md:max-w-none md:px-0 md:pb-0">
                {consequence && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{consequence}</p>}
                {lead.owner && (
                    <p className="text-xs text-muted-foreground">
                        {lead.owner.firstName} stratí prístup k obchodu; uvidí ho len v Histórii. Vrátiť ho môžeš neskôr zmenou vlastníka.
                    </p>
                )}
                <Textarea
                    data-vaul-no-drag
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Poznámka (nepovinné)"
                    className="min-h-[60px] text-[16px]"
                />
                <p className="text-sm text-muted-foreground">Tvoj ďalší krok</p>
                <div className="grid gap-2 md:grid-cols-2">
                    {kinds.map((k) => (
                        <Button
                            key={k}
                            variant={kind === k ? "default" : "outline"}
                            className="h-11 justify-start"
                            onClick={() => {
                                setKind(k);
                                setStepNote(k === lead.nextActionKind ? lead.nextActionNote : null);
                            }}
                        >
                            {NEXT_ACTION_LABEL[k]}
                        </Button>
                    ))}
                </div>
                <input
                    type="date"
                    data-vaul-no-drag
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    onClick={(e) => e.currentTarget.showPicker?.()}
                    className="h-11 w-full rounded-md border px-3 text-[16px] [color-scheme:light_dark]"
                />
                <Input
                    data-vaul-no-drag
                    value={shownNote}
                    onChange={(e) => setStepNote(e.target.value)}
                    placeholder="Poznámka ku kroku"
                    className="text-[16px]"
                />
                {required && <p className="text-xs text-muted-foreground">Ešte neposlané: {lead.pendingText} – krok ostáva „Poslať…“.</p>}
                <Button className="h-12 w-full" disabled={pending} onClick={save}>
                    Preberám
                </Button>
            </div>
        </ResponsiveSheet>
    );
}
