"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, Pencil, Check } from "lucide-react";
import { LeadStatus, NextActionKind } from "@/app/generated/prisma/enums";
import { DashboardContent, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
    addBusinessNote,
    changeOwner,
    changeStatus,
    logSent,
    setNextAction,
    updateLead,
} from "@/lib/actions/pipeline";
import {
    ACTIVITY_CATEGORY_LABEL,
    ACTIVITY_LABEL,
    ACTIVITY_SOURCE_LABEL,
    NEXT_ACTION_LABEL,
    OUTCOME_LABEL,
    STATUS_LABEL,
} from "@/lib/dictionaries";
import type { PipelineDetailData, PipelineUserOption } from "@/lib/queries/pipeline";
import type { DesignView } from "@/lib/queries/tracking";
import CenovaPonukaCard from "@/components/pipeline/CenovaPonukaCard";
import DesignTrackingCard from "@/components/pipeline/DesignTrackingCard";

const QUICK_EVENTS = [
    "Klient sľúbil poslať podklady",
    "Podklady neprišli",
    "Návrh si ešte nepozreli",
    "Máme sa ozvať po porade",
];

function formatDateTime(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("sk-SK", {
        day: "numeric",
        month: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("sk-SK");
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

    const [nextKind, setNextKind] = useState<NextActionKind>("CALL");
    const [nextAt, setNextAt] = useState("");
    const [nextNote, setNextNote] = useState("");
    const [savingNext, setSavingNext] = useState(false);
    const [editingNext, setEditingNext] = useState(false);

    const [busy, setBusy] = useState(false);
    const [businessNote, setBusinessNote] = useState("");
    const [showAllHistory, setShowAllHistory] = useState(true);

    const hasNextAction = Boolean(lead.nextActionKind || lead.nextActionAt || lead.nextActionNote);
    const businessActivities = lead.activities.filter((a) => a.category === "BUSINESS");
    const visibleActivities = showAllHistory ? lead.activities : businessActivities;
    const showEditor = editingNext || !hasNextAction;

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
        await updateLead(lead.id, {
            companyName: form.companyName.trim() || null,
            website: form.website.trim() || null,
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            note: form.note.trim() || null,
        });
        setSavingData(false);
        setEditingData(false);
        router.refresh();
    }

    function resetNextEditor() {
        setNextKind("CALL");
        setNextAt("");
        setNextNote("");
        setEditingNext(false);
    }

    function startEditNext() {
        setNextKind(lead.nextActionKind ?? "CALL");
        setNextAt(lead.nextActionAt ? lead.nextActionAt.slice(0, 16) : "");
        setNextNote(lead.nextActionNote ?? "");
        setEditingNext(true);
    }

    async function saveNextAction() {
        setSavingNext(true);
        await setNextAction(
            lead.id,
            nextKind,
            nextAt ? new Date(nextAt).toISOString() : null,
            nextNote.trim() || null,
        );
        setSavingNext(false);
        resetNextEditor();
        router.refresh();
    }

    async function clearNextAction() {
        setSavingNext(true);
        await setNextAction(lead.id, null, null, null);
        setSavingNext(false);
        resetNextEditor();
        router.refresh();
    }

    async function runBusiness(fn: () => Promise<unknown>) {
        setBusy(true);
        await fn();
        setBusy(false);
        router.refresh();
    }

    async function saveBusinessNote() {
        const result = await addBusinessNote(lead.id, businessNote);
        if (!result.error) {
            setBusinessNote("");
            router.refresh();
        }
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
                description="Detail príležitosti v pipeline"
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            defaultValue={lead.status}
                            onValueChange={async (value) => {
                                await changeStatus(lead.id, value as LeadStatus);
                                router.refresh();
                            }}
                        >
                            <SelectTrigger size="sm" className="w-auto gap-1.5 rounded-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {Object.entries(STATUS_LABEL).map(([key, label]) => (
                                    <SelectItem key={key} value={key}>{label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            defaultValue={lead.owner?.id ?? "none"}
                            onValueChange={async (value) => {
                                await changeOwner(lead.id, value === "none" ? null : value);
                                router.refresh();
                            }}
                        >
                            <SelectTrigger size="sm" className="w-auto gap-1.5 rounded-full">
                                <SelectValue placeholder="Rieši" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">— nikto —</SelectItem>
                                {users.map((user) => (
                                    <SelectItem key={user.id} value={user.id}>
                                        {user.firstName} {user.lastName}
                                    </SelectItem>
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

            <DashboardContent width="wide">
                <div className="grid items-start gap-6 lg:grid-cols-3">
                    {/* MAIN COLUMN — the workflow */}
                    <div className="space-y-6 lg:col-span-2">
                        {/* Ďalší krok */}
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Ďalší krok</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {hasNextAction && (
                                    <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border bg-muted/40 p-3">
                                        <div className="min-w-0 space-y-0.5 text-sm">
                                            <p className="font-medium">
                                                {lead.nextActionKind
                                                    ? NEXT_ACTION_LABEL[lead.nextActionKind]
                                                    : "Ďalší krok"}
                                                {lead.nextActionAt && (
                                                    <span className="ml-2 font-normal text-muted-foreground tabular-nums">
                                                        {formatDateTime(lead.nextActionAt)}
                                                    </span>
                                                )}
                                            </p>
                                            {lead.nextActionNote && (
                                                <p className="text-muted-foreground">{lead.nextActionNote}</p>
                                            )}
                                        </div>
                                        {!editingNext && (
                                            <div className="flex shrink-0 gap-1">
                                                <Button size="sm" variant="outline" onClick={startEditNext}>
                                                    <Pencil className="mr-1.5 h-3.5 w-3.5" />
                                                    Upraviť
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="text-destructive"
                                                    onClick={clearNextAction}
                                                    disabled={savingNext}
                                                >
                                                    Vymazať
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {showEditor && (
                                    <div className="space-y-2">
                                        {hasNextAction && (
                                            <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                                Zmeniť ďalší krok
                                            </Label>
                                        )}
                                        <div className="grid gap-2 sm:grid-cols-2">
                                            <div className="grid gap-1.5">
                                                <Label className="text-xs text-muted-foreground">Typ</Label>
                                                <Select
                                                    value={nextKind}
                                                    onValueChange={(value) => setNextKind(value as NextActionKind)}
                                                >
                                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                                    <SelectContent>
                                                        {Object.entries(NEXT_ACTION_LABEL).map(([key, label]) => (
                                                            <SelectItem key={key} value={key}>{label}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="grid gap-1.5">
                                                <Label className="text-xs text-muted-foreground">Kedy</Label>
                                                <Input
                                                    type="datetime-local"
                                                    value={nextAt}
                                                    onChange={(event) => setNextAt(event.target.value)}
                                                />
                                            </div>
                                        </div>
                                        <div className="grid gap-1.5">
                                            <Label className="text-xs text-muted-foreground">Poznámka</Label>
                                            <Input
                                                placeholder="Čo treba urobiť alebo na čo čakáme…"
                                                value={nextNote}
                                                onChange={(event) => setNextNote(event.target.value)}
                                            />
                                        </div>
                                        <div className="flex gap-2">
                                            <Button size="sm" onClick={saveNextAction} disabled={savingNext}>
                                                {savingNext ? "Ukladám…" : "Uložiť ďalší krok"}
                                            </Button>
                                            {editingNext && (
                                                <Button size="sm" variant="ghost" onClick={resetNextEditor}>
                                                    Zrušiť
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Cenová ponuka */}
                        <CenovaPonukaCard
                            leadId={lead.id}
                            price={lead.price}
                            priceNote={lead.priceNote}
                            quoteSentAt={lead.quoteSentAt}
                        />

                        {/* Dizajn & sledovanie */}
                        <DesignTrackingCard
                            leadId={lead.id}
                            designs={designs}
                            quoteSentAt={lead.quoteSentAt}
                        />

                        {/* Ďalšie kroky */}
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Ďalšie kroky</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        Email „o nás&quot;
                                    </Label>
                                    <Button
                                        type="button"
                                        variant={lead.aboutUsSentAt ? "secondary" : "outline"}
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => runBusiness(() => logSent(lead.id, "EMAIL_SENT"))}
                                    >
                                        {lead.aboutUsSentAt && <Check className="mr-1.5 h-3.5 w-3.5" />}
                                        {lead.aboutUsSentAt
                                            ? `Poslané ${formatDate(lead.aboutUsSentAt)}`
                                            : "Označiť ako poslané"}
                                    </Button>
                                </div>

                                <Separator />

                                <div className="space-y-2">
                                    <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        Zaznamenať udalosť
                                    </Label>
                                    <p className="text-xs text-muted-foreground">
                                        Pridá krok do obchodnej histórie.
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {QUICK_EVENTS.map((text) => (
                                            <Button
                                                key={text}
                                                size="sm"
                                                variant="outline"
                                                disabled={busy}
                                                onClick={() => runBusiness(() => addBusinessNote(lead.id, text))}
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

                        {/* História */}
                        <Card>
                            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
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
                                                        <p className="text-muted-foreground">{activity.note}</p>
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
                    <div className="space-y-6">
                        <Card>
                            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                                <CardTitle className="text-base">Údaje</CardTitle>
                                {!editingData && (
                                    <Button size="sm" variant="outline" onClick={startEditData}>
                                        <Pencil className="mr-1.5 h-3.5 w-3.5" />
                                        Upraviť
                                    </Button>
                                )}
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {!editingData ? (
                                    <div className="space-y-3">
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
                                        <ReadRow label="Poznámka" value={lead.note} />
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
