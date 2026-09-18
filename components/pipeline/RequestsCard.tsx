"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ActionError } from "@/lib/access/errors";
import { changeStatus, reopenDeal, resolveDealRequest, saveQuote } from "@/lib/actions/pipeline";
import { REQUEST_KIND_LABEL } from "@/lib/dictionaries";
import { fmtAgo } from "@/lib/utils";
import type { DealRequestView } from "@/lib/queries/pipeline";

// „Požiadavky" na detaile obchodu (manažér). Každá požiadavka ukazuje akciu, ktorá ju reálne vybaví (§7.6/§8.2).
// Ručné „Vybavené" má len OTHER; zamietnutie vyžaduje dôvod, ktorý uvidí obchodník.
export default function RequestsCard({ leadId, requests }: { leadId: string; requests: DealRequestView[] }) {
    const open = requests.filter((r) => r.status === "OPEN");
    if (open.length === 0) return null;
    return (
        <Card className="border-destructive/40">
            <CardHeader>
                <CardTitle className="text-base">Požiadavky ({open.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {open.map((r) => (
                    <RequestRow key={r.id} leadId={leadId} request={r} />
                ))}
            </CardContent>
        </Card>
    );
}

function RequestRow({ leadId, request }: { leadId: string; request: DealRequestView }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [price, setPrice] = useState("");
    const [priceNote, setPriceNote] = useState("");
    const [declining, setDeclining] = useState(false);
    const [reason, setReason] = useState("");
    const [otherNote, setOtherNote] = useState("");

    function run(fn: () => Promise<{ success: true } | ActionError>, ok: string) {
        start(async () => {
            const r = await fn();
            if ("error" in r) toast.error(r.error);
            else toast.success(ok);
            router.refresh();
        });
    }

    return (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">{REQUEST_KIND_LABEL[request.kind]}</Badge>
                <span className="text-muted-foreground">
                    {request.createdBy} · {fmtAgo(request.createdAt)}
                </span>
            </div>
            {request.note && <p className="whitespace-pre-wrap text-muted-foreground">{request.note}</p>}

            <div className="flex flex-wrap items-center gap-2">
                {request.kind === "PRICE" && (
                    <>
                        <Input
                            type="number"
                            placeholder="Cena €"
                            value={price}
                            onChange={(e) => setPrice(e.target.value)}
                            className="h-8 w-28"
                        />
                        <Input
                            placeholder="Rozpis (nepovinné)"
                            value={priceNote}
                            onChange={(e) => setPriceNote(e.target.value)}
                            className="h-8 w-48"
                        />
                        <Button
                            size="sm"
                            disabled={pending || price.trim() === "" || !Number.isFinite(Number(price))}
                            onClick={() => run(() => saveQuote(leadId, { price: Number(price), priceNote }), "Cena uložená")}
                        >
                            Uložiť cenu
                        </Button>
                    </>
                )}
                {request.kind === "DESIGN" && (
                    <Button size="sm" variant="outline" asChild>
                        <a href="#design">Prejsť na Dizajn &amp; Tracking</a>
                    </Button>
                )}
                {request.kind === "EMAIL" && (
                    <span className="text-xs text-muted-foreground">Vybaví sa zaznamenaním odoslania („Cena &amp; ponuky“).</span>
                )}
                {request.kind === "ORDER" && (
                    <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                            if (!window.confirm("Označiť obchod ako vyhratý?")) return;
                            run(() => changeStatus(leadId, "WON"), "Obchod vyhraný");
                        }}
                    >
                        Označiť ako vyhraté
                    </Button>
                )}
                {request.kind === "REOPEN" && (
                    <Button size="sm" disabled={pending} onClick={() => run(() => reopenDeal(leadId), "Obchod znovu otvorený")}>
                        Znovu otvoriť
                    </Button>
                )}
                {request.kind === "OTHER" && (
                    <>
                        <Input
                            placeholder="Poznámka (nepovinné)"
                            value={otherNote}
                            onChange={(e) => setOtherNote(e.target.value)}
                            className="h-8 w-48"
                        />
                        <Button
                            size="sm"
                            disabled={pending}
                            onClick={() => run(() => resolveDealRequest(request.id, "DONE", otherNote || null), "Vybavené")}
                        >
                            Vybavené
                        </Button>
                    </>
                )}
                {!declining ? (
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => setDeclining(true)}>
                        Zamietnuť
                    </Button>
                ) : (
                    <>
                        <Input
                            placeholder="Dôvod (uvidí obchodník)"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            className="h-8 w-56"
                        />
                        <Button
                            size="sm"
                            variant="destructive"
                            disabled={pending || !reason.trim()}
                            onClick={() => run(() => resolveDealRequest(request.id, "CANCELLED", reason), "Požiadavka zamietnutá")}
                        >
                            Zamietnuť
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>
                            Zrušiť
                        </Button>
                    </>
                )}
            </div>
        </div>
    );
}
