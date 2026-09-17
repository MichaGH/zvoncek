"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Pencil, Phone } from "lucide-react";
import type { DealRequestKind } from "@/app/generated/prisma/enums";
import { DashboardContent, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import NextActionEditor from "@/components/deals/NextActionEditor";
import CenovaPonukaCard from "@/components/pipeline/CenovaPonukaCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { ActionError } from "@/lib/access/errors";
import {
    cancelOwnDealRequest,
    createDealRequest,
    logClientEmailSent,
    setClientNextAction,
    updateClientContact,
} from "@/lib/actions/clients";
import {
    ACTIVITY_LABEL,
    CONFIDENCE_LABEL,
    CONFIDENCE_VARIANT,
    OUTCOME_LABEL,
    REQUEST_KIND_LABEL,
    REQUEST_STATUS_LABEL,
    STATUS_LABEL,
} from "@/lib/dictionaries";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";
import { CLIENT_SECTION_LABEL } from "@/lib/domain/clientSections";
import type { ClientDetailData } from "@/lib/queries/clients";
import { fmtAgo } from "@/lib/utils";

const REP_REQUEST_KINDS: DealRequestKind[] = ["PRICE", "DESIGN", "EMAIL", "ORDER", "OTHER"];

function fmtDateTime(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("sk-SK", {
        timeZone: BUSINESS_TZ,
        day: "numeric",
        month: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function fmtDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("sk-SK", { timeZone: BUSINESS_TZ });
}

// Detail vlastného obchodu (plán §7.7). Bez stavu, vlastníka, WON a správy návrhov – to robí manažér.
export default function ClientDetail({ deal, viewerId, canWork }: { deal: ClientDetailData; viewerId: string; canWork: boolean }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const closed = deal.status === "WON" || deal.status === "LOST" || deal.status === "UNREACHABLE";
    const editable = canWork && !closed;

    const [editingData, setEditingData] = useState(false);
    const [form, setForm] = useState({
        companyName: deal.companyName ?? "",
        website: deal.website ?? "",
        phone: deal.phone ?? "",
        email: deal.email ?? "",
        note: deal.note ?? "",
    });
    const [requestKind, setRequestKind] = useState<DealRequestKind>(closed ? "REOPEN" : "PRICE");
    const [requestNote, setRequestNote] = useState("");

    function run(fn: () => Promise<{ success: true } | ActionError | { success: true; created: boolean }>, ok: string, after?: () => void) {
        start(async () => {
            const r = await fn();
            if ("error" in r) toast.error(r.error);
            else {
                toast.success("created" in r && !r.created ? "Požiadavka už existuje – doplnená poznámka" : ok);
                after?.();
            }
            router.refresh();
        });
    }

    const phoneHref = deal.phone ? `tel:${deal.phone.replace(/\s/g, "")}` : null;
    const openRequests = deal.requests.filter((r) => r.status === "OPEN");
    const resolvedRequests = deal.requests.filter((r) => r.status !== "OPEN");

    return (
        <>
            <DashboardPageHeader
                backHref="/dashboard/clients"
                backLabel="Moji klienti"
                title={
                    <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">#{deal.number}</span>
                        <span className="truncate">{deal.name}</span>
                    </span>
                }
                badge={
                    <>
                        <Badge variant="outline">{CLIENT_SECTION_LABEL[deal.section]}</Badge>
                        {closed && <Badge variant="secondary">{STATUS_LABEL[deal.status]}</Badge>}
                    </>
                }
                description={closed ? `Uzavreté ${fmtDate(deal.closedAt)} – len na čítanie` : undefined}
                actions={
                    phoneHref && (
                        <Button asChild size="sm">
                            <a href={phoneHref}>
                                <Phone className="mr-1.5 h-4 w-4" />
                                {deal.phone}
                            </a>
                        </Button>
                    )
                }
            />

            <DashboardContent width="default" className="space-y-6">
                {/* 1. Ďalší krok */}
                {editable && <NextActionEditor lead={deal} onSave={(input, rev) => setClientNextAction(deal.id, input, rev)} />}

                {/* 2. Požiadavky */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Požiadavky</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {deal.requests.length === 0 && <p className="text-sm text-muted-foreground">Žiadne požiadavky.</p>}
                        {[...openRequests, ...resolvedRequests].map((r) => (
                            <div key={r.id} className="space-y-1 rounded-lg border p-3 text-sm">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant={r.status === "OPEN" ? "destructive" : "outline"}>{REQUEST_KIND_LABEL[r.kind]}</Badge>
                                    <span className="text-muted-foreground">
                                        {REQUEST_STATUS_LABEL[r.status]} · {r.createdBy} · {fmtAgo(r.createdAt)}
                                    </span>
                                    {r.status === "OPEN" && r.createdById === viewerId && canWork && (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="ml-auto h-7"
                                            disabled={pending}
                                            onClick={() => run(() => cancelOwnDealRequest(r.id, null), "Požiadavka zrušená")}
                                        >
                                            Zrušiť
                                        </Button>
                                    )}
                                </div>
                                {r.note && <p className="whitespace-pre-wrap text-muted-foreground">{r.note}</p>}
                                {r.resolutionNote && (
                                    <p className="text-muted-foreground">
                                        <span className="font-medium text-foreground">{r.resolvedBy ?? "Manažér"}:</span> {r.resolutionNote}
                                    </p>
                                )}
                            </div>
                        ))}
                        {canWork && (
                            <div className="space-y-2 border-t pt-3">
                                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Nová požiadavka</p>
                                {!closed && (
                                    <div className="flex flex-wrap gap-1">
                                        {REP_REQUEST_KINDS.map((k) => (
                                            <Button key={k} size="sm" variant={requestKind === k ? "default" : "outline"} onClick={() => setRequestKind(k)}>
                                                {REQUEST_KIND_LABEL[k]}
                                            </Button>
                                        ))}
                                    </div>
                                )}
                                <Textarea
                                    placeholder={closed ? "Prečo znovu otvoriť?" : "Čo potrebuješ od manažéra?"}
                                    value={requestNote}
                                    onChange={(e) => setRequestNote(e.target.value)}
                                />
                                <Button
                                    size="sm"
                                    disabled={pending}
                                    onClick={() =>
                                        run(
                                            () => createDealRequest(deal.id, closed ? "REOPEN" : requestKind, requestNote.trim() || null),
                                            "Požiadavka odoslaná",
                                            () => setRequestNote(""),
                                        )
                                    }
                                >
                                    {closed ? "Požiadať o znovuotvorenie" : "Požiadať manažéra"}
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* 3. Údaje */}
                <Card>
                    <CardHeader className="flex items-center justify-between">
                        <CardTitle className="text-base">Údaje</CardTitle>
                        {editable && !editingData && (
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingData(true)} aria-label="Upraviť údaje">
                                <Pencil className="h-3.5 w-3.5" />
                            </Button>
                        )}
                    </CardHeader>
                    <CardContent>
                        {!editingData ? (
                            <dl className="grid grid-cols-2 gap-4 text-sm">
                                <Read label="Firma" value={deal.companyName} />
                                <Read label="Web" value={deal.website} />
                                <Read label="Telefón" value={deal.phone} />
                                <Read label="Email" value={deal.email} />
                                <div className="col-span-2">
                                    <Read label="Poznámka" value={deal.note} />
                                </div>
                            </dl>
                        ) : (
                            <div className="grid gap-3">
                                {(["companyName", "website", "phone", "email"] as const).map((key) => (
                                    <div key={key} className="grid gap-1.5">
                                        <Label>{{ companyName: "Firma", website: "Web", phone: "Telefón", email: "Email" }[key]}</Label>
                                        <Input value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
                                    </div>
                                ))}
                                <div className="grid gap-1.5">
                                    <Label>Poznámka</Label>
                                    <Textarea value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        disabled={pending}
                                        onClick={() => run(() => updateClientContact(deal.id, form), "Uložené", () => setEditingData(false))}
                                    >
                                        Uložiť
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => setEditingData(false)}>
                                        Zrušiť
                                    </Button>
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* 4. Cena */}
                <CenovaPonukaCard
                    leadId={deal.id}
                    price={deal.price}
                    priceNote={deal.priceNote}
                    priceDisclosed={deal.priceDisclosed}
                    quoteSentAt={deal.quoteSentAt}
                    mode="clients"
                    readOnly={!editable}
                />

                {/* 5. Email „O nás" */}
                <Card>
                    <CardHeader className="flex items-center justify-between">
                        <CardTitle className="text-base">Email „O nás“</CardTitle>
                        {deal.aboutUsSentAt && <Badge variant="secondary">Poslané {fmtDate(deal.aboutUsSentAt)}</Badge>}
                    </CardHeader>
                    <CardContent>
                        <Button
                            size="sm"
                            variant={deal.aboutUsSentAt ? "secondary" : "default"}
                            disabled={pending || !editable || Boolean(deal.aboutUsSentAt)}
                            onClick={() => run(() => logClientEmailSent(deal.id), "Email označený ako odoslaný")}
                        >
                            {deal.aboutUsSentAt && <Check className="mr-1.5 h-3.5 w-3.5" />}
                            {deal.aboutUsSentAt ? "Označené ako poslané" : "Označiť ako poslané"}
                        </Button>
                    </CardContent>
                </Card>

                {/* 6. Návrh – len na čítanie */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Návrh</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                        {deal.designs.length === 0 && <p className="text-muted-foreground">Zatiaľ žiadny návrh.</p>}
                        {deal.designs.map((d) => (
                            <div key={d.id} className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{d.label ?? "Návrh"}</span>
                                <span className="text-muted-foreground">{d.sentAt ? `poslaný ${fmtDate(d.sentAt)}` : "neposlaný"}</span>
                                {d.sentAt && (
                                    <Badge variant={CONFIDENCE_VARIANT[d.confidence]}>
                                        {CONFIDENCE_LABEL[d.confidence]}
                                        {d.views > 0 ? ` · ${d.views}×` : ""}
                                        {d.lastViewedAt ? ` · naposledy ${fmtAgo(d.lastViewedAt)}` : ""}
                                    </Badge>
                                )}
                            </div>
                        ))}
                    </CardContent>
                </Card>

                {/* 7. História – len obchodné kroky */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">História</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {deal.activities.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Zatiaľ žiadny obchodný krok.</p>
                        ) : (
                            deal.activities.map((a, i) => (
                                <div key={a.id}>
                                    {i > 0 && <Separator />}
                                    <div className="space-y-1 py-3 text-sm">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium">{ACTIVITY_LABEL[a.type]}</span>
                                            {a.outcome && <span className="text-xs text-muted-foreground">{OUTCOME_LABEL[a.outcome]}</span>}
                                            <span className="ml-auto text-xs text-muted-foreground">
                                                {fmtDateTime(a.createdAt)} · {a.userName}
                                            </span>
                                        </div>
                                        {a.note && <p className="whitespace-pre-wrap text-muted-foreground">{a.note}</p>}
                                    </div>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>
            </DashboardContent>
        </>
    );
}

function Read({ label, value }: { label: string; value: string | null }) {
    return (
        <div>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="break-words">{value || "—"}</dd>
        </div>
    );
}
