"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Phone, Pencil, Check, XCircle } from "lucide-react";
import { LeadStatus, ProjectType } from "@/app/generated/prisma/enums";
import { DashboardContent, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { ActionError } from "@/lib/access/errors";
import {
    addBusinessNote,
    changeOwner,
    changeStatus,
    logSent,
    markLost,
    reopenDeal,
    setNextAction,
    setProjectType,
    updateLead,
} from "@/lib/actions/pipeline";
import {
    ACTIVITY_CATEGORY_LABEL,
    ACTIVITY_LABEL,
    ACTIVITY_SOURCE_LABEL,
    OUTCOME_LABEL,
    PROJECT_TYPE_LABEL,
    STATUS_LABEL,
} from "@/lib/dictionaries";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";
import type { PipelineDetailData, PipelineUserOption } from "@/lib/queries/pipeline";
import type { DesignView } from "@/lib/queries/tracking";
import CenovaPonukaCard from "@/components/pipeline/CenovaPonukaCard";
import DesignTrackingCard from "@/components/pipeline/DesignTrackingCard";
import RequestsCard from "@/components/pipeline/RequestsCard";
import NextActionEditor from "@/components/deals/NextActionEditor";

const QUICK_EVENTS = [
    "Klient sľúbil poslať podklady",
    "Podklady neprišli",
    "Návrh si ešte nepozreli",
    "Máme sa ozvať po porade",
];

// Stavový select ponúka len stavy obchodu (§8.2).
const DEAL_STATUS_OPTIONS: LeadStatus[] = ["ACTIVE", "SNOOZED", "WON", "LOST", "UNREACHABLE"];
const CLOSED: LeadStatus[] = ["WON", "LOST", "UNREACHABLE"];

function formatDateTime(iso: string | null) {
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

function formatDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("sk-SK", { timeZone: BUSINESS_TZ });
}

function normalizeUrl(url: string) {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export default function PipelineDetail({
    lead,
    users,
    designs,
}: {
    lead: PipelineDetailData;
    users: PipelineUserOption[];
    designs: DesignView[];
}) {
    const router = useRouter();

    const [editingData, setEditingData] = useState(false);
    const [form, setForm] = useState({
        companyName: lead.companyName ?? "",
        website: lead.website ?? "",
        phone: lead.phone ?? "",
        email: lead.email ?? "",
        note: lead.note ?? "",
    });
    const [savingData, setSavingData] = useState(false);

    const [busy, setBusy] = useState(false);
    const [businessNote, setBusinessNote] = useState("");
    const [showAllHistory, setShowAllHistory] = useState(true);

    const [lostReason, setLostReason] = useState(lead.lostReason ?? "");
    const [savingLost, setSavingLost] = useState(false);

    const businessActivities = lead.activities.filter((a) => a.category === "BUSINESS");
    const visibleActivities = showAllHistory ? lead.activities : businessActivities;
    const isClosed = CLOSED.includes(lead.status);

    function report(r: { success: true } | ActionError) {
        if ("error" in r) toast.error(r.error);
        return !("error" in r);
    }

    function set<K extends keyof typeof form>(key: K, value: string) {
        setForm((current) => ({ ...current, [key]: value }));
    }

    function startEditData() {
        setForm({
            companyName: lead.companyName ?? "",
            website: lead.website ?? "",
            phone: lead.phone ?? "",
            email: lead.email ?? "",
            note: lead.note ?? "",
        });
        setEditingData(true);
    }

    async function saveData() {
        setSavingData(true);
        const r = await updateLead(lead.id, {
            companyName: form.companyName.trim() || null,
            website: form.website.trim() || null,
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            note: form.note.trim() || null,
        });
        setSavingData(false);
        if (report(r)) setEditingData(false);
        router.refresh();
    }

    async function runBusiness(fn: () => Promise<{ success: true } | ActionError>) {
        setBusy(true);
        report(await fn());
        setBusy(false);
        router.refresh();
    }

    async function saveBusinessNote() {
        const result = await addBusinessNote(lead.id, businessNote);
        if (report(result)) setBusinessNote("");
        router.refresh();
    }

    const phoneHref = lead.phone ? `tel:${lead.phone.replace(/\s/g, "")}` : null;

    return (
        <>
            <DashboardPageHeader
                backHref="/dashboard/pipeline"
                backLabel="Späť na pipeline"
                title={
                    <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">#{lead.number}</span>
                        <span className="truncate">{lead.companyName ?? lead.website ?? "Bez mena"}</span>
                    </span>
                }
                description={
                    lead.handedOffBy
                        ? `Obchod od ${formatDate(lead.pipelineEnteredAt)} · hovor: ${lead.handedOffBy.firstName} ${lead.handedOffBy.lastName}`
                        : "Detail obchodu v pipeline"
                }
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            key={`status-${lead.status}`}
                            defaultValue={lead.status}
                            onValueChange={async (value) => {
                                report(await changeStatus(lead.id, value as LeadStatus));
                                router.refresh();
                            }}
                        >
                            <SelectTrigger size="sm" className="w-auto gap-1.5 rounded-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {DEAL_STATUS_OPTIONS.map((key) => (
                                    <SelectItem key={key} value={key}>
                                        {STATUS_LABEL[key]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            key={`owner-${lead.owner?.id ?? "none"}`}
                            defaultValue={lead.owner?.id ?? "none"}
                            onValueChange={async (value) => {
                                report(await changeOwner(lead.id, value === "none" ? null : value));
                                router.refresh();
                            }}
                        >
                            <SelectTrigger size="sm" className="w-auto gap-1.5 rounded-full">
                                <SelectValue placeholder="Rieši" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">— nepriradené —</SelectItem>
                                {lead.owner && !users.some((u) => u.id === lead.owner?.id) && (
                                    <SelectItem value={lead.owner.id} disabled>
                                        {lead.owner.firstName} {lead.owner.lastName} (neaktívny)
                                    </SelectItem>
                                )}
                                {users.map((user) => (
                                    <SelectItem key={user.id} value={user.id}>
                                        {user.firstName} {user.lastName}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            defaultValue={lead.projectType ?? "none"}
                            onValueChange={async (value) => {
                                report(await setProjectType(lead.id, value === "none" ? null : (value as ProjectType)));
                                router.refresh();
                            }}
                        >
                            <SelectTrigger size="sm" className="w-auto gap-1.5 rounded-full">
                                <SelectValue placeholder="Typ projektu" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">— typ projektu —</SelectItem>
                                {Object.entries(PROJECT_TYPE_LABEL).map(([key, label]) => (
                                    <SelectItem key={key} value={key}>{label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {phoneHref && (
                            <Button asChild size="sm">
                                <a href={phoneHref}>
                                    <Phone className="mr-1.5 h-4 w-4" />
                                    {lead.phone}
                                </a>
                            </Button>
                        )}
                    </div>
                }
            />

            <DashboardContent width="full">
                <div className="grid items-start gap-6 lg:grid-cols-3">
                    {/* MAIN COLUMN — the workflow. order-2: na one-column layoute (split screen,
                        manager bez fullscreenu) nech je Údaje vidno hned, nie uplne dole. */}
                    <div className="order-2 space-y-6 lg:order-none lg:col-span-2">
                        <RequestsCard leadId={lead.id} requests={lead.requests} />

                        <NextActionEditor lead={lead} onSave={(input, revision) => setNextAction(lead.id, input, revision)} />

                        {/* Posledný krok & zaznamenať udalosť */}
                        <Card>
                            <CardHeader className="flex items-center justify-between">
                                <CardTitle className="text-base">Posledný krok</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {businessActivities[0] ? (
                                    <div className="space-y-1 text-sm">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium">
                                                {ACTIVITY_LABEL[businessActivities[0].type]}
                                            </span>
                                            {businessActivities[0].outcome && (
                                                <span className="text-xs text-muted-foreground">
                                                    {OUTCOME_LABEL[businessActivities[0].outcome]}
                                                </span>
                                            )}
                                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                                                {formatDateTime(businessActivities[0].createdAt)}
                                            </span>
                                        </div>
                                        {businessActivities[0].note && (
                                            <p className="text-muted-foreground">{businessActivities[0].note}</p>
                                        )}
                                    </div>
                                ) : (
                                    <p className="text-sm text-muted-foreground">Zatiaľ žiadny krok.</p>
                                )}

                                <div className="space-y-2">
                                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        Zaznamenať udalosť
                                    </p>
                                    <div className="grid grid-cols-2 gap-2">
                                        {QUICK_EVENTS.map((text) => (
                                            <Button
                                                key={text}
                                                size="sm"
                                                variant="outline"
                                                disabled={busy}
                                                onClick={() => runBusiness(() => addBusinessNote(lead.id, text))}
                                                className="h-auto min-h-8 justify-start whitespace-normal py-1.5 text-left leading-snug"
                                            >
                                                {text}
                                            </Button>
                                        ))}
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={businessNote}
                                            onChange={(event) => setBusinessNote(event.target.value)}
                                            placeholder="Vlastná udalosť / poznámka…"
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" && businessNote.trim()) {
                                                    event.preventDefault();
                                                    saveBusinessNote();
                                                }
                                            }}
                                        />
                                        <Button
                                            size="sm"
                                            className="shrink-0"
                                            disabled={!businessNote.trim()}
                                            onClick={saveBusinessNote}
                                        >
                                            Pridať
                                        </Button>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Cena */}
                        <CenovaPonukaCard
                            leadId={lead.id}
                            price={lead.price}
                            priceNote={lead.priceNote}
                            priceDisclosed={lead.priceDisclosed}
                            quoteSentAt={lead.quoteSentAt}
                            mode="pipeline"
                        />

                        {/* Dizajn & sledovanie */}
                        <div id="design" className="scroll-mt-20">
                            <DesignTrackingCard
                                leadId={lead.id}
                                designs={designs}
                                quoteSentAt={lead.quoteSentAt}
                            />
                        </div>

                        {/* Email „o nás" – samostatná vec (jedna z 3, čo si klient môže vypýtať) */}
                        <Card>
                            <CardHeader className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <CardTitle className="text-base">Email „o nás“</CardTitle>
                                    {lead.aboutUsSentAt && (
                                        <Badge variant="secondary" className="font-normal">
                                            Poslané {formatDate(lead.aboutUsSentAt)}
                                        </Badge>
                                    )}
                                </div>
                            </CardHeader>
                            <CardContent>
                                <Button
                                    type="button"
                                    variant={lead.aboutUsSentAt ? "secondary" : "default"}
                                    size="sm"
                                    disabled={busy || Boolean(lead.aboutUsSentAt)}
                                    onClick={() => runBusiness(() => logSent(lead.id, "EMAIL_SENT"))}
                                >
                                    {lead.aboutUsSentAt && <Check className="mr-1.5 h-3.5 w-3.5" />}
                                    {lead.aboutUsSentAt ? "Označené ako poslané" : "Označiť ako poslané"}
                                </Button>
                            </CardContent>
                        </Card>

                        {/* Výsledok */}
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Výsledok</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                {isClosed ? (
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2 text-sm">
                                            <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                                            <span className="font-medium">
                                                {STATUS_LABEL[lead.status]}
                                                {lead.closedAt ? ` · ${formatDate(lead.closedAt)}` : ""}
                                            </span>
                                        </div>
                                        {lead.lostReason && (
                                            <p className="text-sm text-muted-foreground">{lead.lostReason}</p>
                                        )}
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={busy}
                                            onClick={() => runBusiness(() => reopenDeal(lead.id))}
                                        >
                                            Znovu otvoriť
                                        </Button>
                                    </div>
                                ) : (
                                    <>
                                        <Textarea
                                            placeholder="Dôvod (nepovinné) – napr. „cena príliš vysoká“, „vybrali konkurenciu“"
                                            value={lostReason}
                                            onChange={(e) => setLostReason(e.target.value)}
                                            className="min-h-[72px]"
                                        />
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                            disabled={savingLost}
                                            onClick={async () => {
                                                setSavingLost(true);
                                                report(await markLost(lead.id, lostReason || null));
                                                setSavingLost(false);
                                                router.refresh();
                                            }}
                                        >
                                            <XCircle className="mr-1.5 h-3.5 w-3.5" />
                                            {savingLost ? "Ukladám…" : "Nemajú záujem"}
                                        </Button>
                                    </>
                                )}
                            </CardContent>
                        </Card>

                        {/* História */}
                        <Card>
                            <CardHeader className="flex items-center justify-between">
                                <CardTitle className="text-base">História</CardTitle>
                                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                                    <Checkbox
                                        checked={showAllHistory}
                                        onCheckedChange={(value) => setShowAllHistory(value === true)}
                                    />
                                    Zobraziť celú históriu
                                </label>
                            </CardHeader>
                            <CardContent>
                                {visibleActivities.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">
                                        {showAllHistory ? "Zatiaľ žiadna aktivita." : "Zatiaľ žiadny obchodný krok."}
                                    </p>
                                ) : (
                                    <div>
                                        {visibleActivities.map((activity, index) => (
                                            <div key={activity.id}>
                                                {index > 0 && <Separator />}
                                                <div className="space-y-1 py-3 text-sm">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="font-medium">
                                                            {ACTIVITY_LABEL[activity.type]}
                                                        </span>
                                                        <span className="text-xs text-muted-foreground">
                                                            {ACTIVITY_SOURCE_LABEL[activity.source]}
                                                            {" · "}
                                                            {ACTIVITY_CATEGORY_LABEL[activity.category]}
                                                        </span>
                                                        <span className="ml-auto text-xs text-muted-foreground">
                                                            {formatDateTime(activity.createdAt)} · {activity.userName}
                                                        </span>
                                                    </div>
                                                    {activity.outcome && (
                                                        <p className="text-xs text-muted-foreground">
                                                            {OUTCOME_LABEL[activity.outcome]}
                                                        </p>
                                                    )}
                                                    {activity.note && (
                                                        <p className="whitespace-pre-wrap text-muted-foreground">{activity.note}</p>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <p className="mt-3 text-xs text-muted-foreground">
                                    Pridaný {formatDate(lead.createdAt)}
                                </p>
                            </CardContent>
                        </Card>
                    </div>

                    {/* SIDEBAR — who the client is */}
                    <div className="order-1 space-y-6 lg:order-none">
                        <Card>
                            <CardHeader className="flex items-center justify-between">
                                <CardTitle className="text-base">Údaje</CardTitle>
                                {!editingData && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-8 w-8 p-0"
                                        onClick={startEditData}
                                        aria-label="Upraviť údaje"
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                )}
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {!editingData ? (
                                    // @container: rozloženie podľa skutočnej šírky karty, nie
                                    // šírky obrazovky — funguje rovnako či je karta na šírku
                                    // celej stránky (one-column layout) alebo v úzkom sidebari.
                                    <div className="@container">
                                        <div className="grid grid-cols-2 gap-4 @lg:grid-cols-4">
                                            <ReadRow label="Firma" value={lead.companyName} />
                                            <ReadRow
                                                label="Web"
                                                value={lead.website}
                                                href={lead.website ? normalizeUrl(lead.website) : null}
                                                external
                                            />
                                            <ReadRow
                                                label="Telefón"
                                                value={lead.phone}
                                                href={phoneHref}
                                            />
                                            <ReadRow
                                                label="Email"
                                                value={lead.email}
                                                href={lead.email ? `mailto:${lead.email}` : null}
                                            />
                                            <div className="col-span-2 @lg:col-span-4">
                                                <ReadRow label="Poznámka" value={lead.note} />
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="grid gap-4">
                                        <Field label="Firma" value={form.companyName} onChange={(v) => set("companyName", v)} />
                                        <Field label="Web" value={form.website} onChange={(v) => set("website", v)} />
                                        <Field label="Telefón" value={form.phone} onChange={(v) => set("phone", v)} />
                                        <Field label="Email" value={form.email} onChange={(v) => set("email", v)} />
                                        <div className="grid gap-1.5">
                                            <Label>Poznámka</Label>
                                            <Textarea
                                                value={form.note}
                                                onChange={(event) => set("note", event.target.value)}
                                            />
                                        </div>
                                        <div className="flex gap-2">
                                            <Button size="sm" onClick={saveData} disabled={savingData}>
                                                {savingData ? "Ukladám…" : "Uložiť"}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => setEditingData(false)}
                                            >
                                                Zrušiť
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </DashboardContent>
        </>
    );
}

function ReadRow({
    label,
    value,
    href,
    external,
}: {
    label: string;
    value: string | null;
    href?: string | null;
    external?: boolean;
}) {
    return (
        <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            {value && href ? (
                <a
                    href={href}
                    target={external ? "_blank" : undefined}
                    rel={external ? "noopener noreferrer" : undefined}
                    className="break-words text-sm text-primary underline-offset-2 hover:underline"
                >
                    {value}
                </a>
            ) : (
                <p className="break-words text-sm">{value || "—"}</p>
            )}
        </div>
    );
}

function Field({
    label,
    value,
    onChange,
    type = "text",
    placeholder,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: string;
    placeholder?: string;
}) {
    return (
        <div className="grid gap-1.5">
            <Label>{label}</Label>
            <Input
                type={type}
                value={value}
                placeholder={placeholder}
                onChange={(event) => onChange(event.target.value)}
            />
        </div>
    );
}
