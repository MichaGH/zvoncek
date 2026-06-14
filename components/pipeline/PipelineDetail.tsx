"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, Globe, Mail, Pencil, Check } from "lucide-react";
import { LeadStatus, NextActionKind } from "@/app/generated/prisma/enums";
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
    STATUS_VARIANT,
} from "@/lib/dictionaries";
import type { PipelineDetailData, PipelineUserOption } from "@/lib/queries/pipeline";
import type { TrackedLinkView } from "@/lib/queries/tracking";
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
    trackedLinks,
}: {
    lead: PipelineDetailData;
    users: PipelineUserOption[];
    trackedLinks: TrackedLinkView[];
}) {
    const router = useRouter();
    const [form, setForm] = useState({
        companyName: lead.companyName ?? "",
        website: lead.website ?? "",
        phone: lead.phone ?? "",
        email: lead.email ?? "",
        note: lead.note ?? "",
        price: lead.price?.toString() ?? "",
        priceNote: lead.priceNote ?? "",
        designUrl: lead.designUrl ?? "",
    });
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);

    // The next-action editor starts empty on purpose: setting a new next action must
    // never silently carry over the previously saved note. The current saved action
    // is shown read-only above; "Upraviť" loads it into the editor when you want it.
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
        setDirty(true);
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

    async function save() {
        setSaving(true);
        await updateLead(lead.id, {
            companyName: form.companyName.trim() || null,
            website: form.website.trim() || null,
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            note: form.note.trim() || null,
            price: form.price ? Number(form.price) : null,
            priceNote: form.priceNote.trim() || null,
            designUrl: form.designUrl.trim() || null,
        });
        setSaving(false);
        setDirty(false);
        router.refresh();
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
                badge={
                    <Badge variant={STATUS_VARIANT[lead.status]} className="font-normal">
                        {STATUS_LABEL[lead.status]}
                    </Badge>
                }
                description="Detail príležitosti v pipeline"
                actions={
                    phoneHref && (
                        <Button asChild size="sm">
                            <a href={phoneHref}>
                                <Phone className="mr-1.5 h-4 w-4" />
                                {lead.phone}
                            </a>
                        </Button>
                    )
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

                        {/* Obchodné kroky — proper action section */}
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Obchodné kroky</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                <div className="space-y-2">
                                    <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        Označiť ako poslané
                                    </Label>
                                    <div className="grid gap-2 sm:grid-cols-3">
                                        <SentButton
                                            label="Cenová ponuka"
                                            at={lead.quoteSentAt}
                                            disabled={busy}
                                            onLog={() => runBusiness(() => logSent(lead.id, "QUOTE_SENT"))}
                                        />
                                        <SentButton
                                            label="Dizajnový návrh"
                                            at={lead.designSentAt}
                                            disabled={busy}
                                            onLog={() => runBusiness(() => logSent(lead.id, "DESIGN_SENT"))}
                                        />
                                        <SentButton
                                            label="Email / o nás"
                                            at={lead.aboutUsSentAt}
                                            disabled={busy}
                                            onLog={() => runBusiness(() => logSent(lead.id, "EMAIL_SENT"))}
                                        />
                                    </div>
                                </div>

                                <Separator />

                                <div className="space-y-2">
                                    <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        Zaznamenať udalosť
                                    </Label>
                                    <p className="text-xs text-muted-foreground">
                                        Pridá krok do obchodnej histórie. Nezávisí od poslania CP/návrhu/emailu.
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

                        {/* Dizajn & sledovanie */}
                        <DesignTrackingCard
                            leadId={lead.id}
                            links={trackedLinks}
                            designSentAt={lead.designSentAt}
                            quoteSentAt={lead.quoteSentAt}
                        />

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
                                                        <Badge
                                                            variant={
                                                                activity.category === "BUSINESS"
                                                                    ? "default"
                                                                    : "outline"
                                                            }
                                                        >
                                                            {ACTIVITY_CATEGORY_LABEL[activity.category]}
                                                        </Badge>
                                                        <span className="text-xs text-muted-foreground">
                                                            {ACTIVITY_SOURCE_LABEL[activity.source]}
                                                        </span>
                                                        <span className="ml-auto text-xs text-muted-foreground">
                                                            {formatDateTime(activity.createdAt)} · {activity.userName}
                                                        </span>
                                                    </div>
                                                    {activity.outcome && (
                                                        <Badge variant="secondary">
                                                            {OUTCOME_LABEL[activity.outcome]}
                                                        </Badge>
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

                    {/* SIDEBAR — status & reference */}
                    <div className="space-y-6">
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Stav</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid gap-1.5">
                                    <Label>Stav</Label>
                                    <Select
                                        defaultValue={lead.status}
                                        onValueChange={async (value) => {
                                            await changeStatus(lead.id, value as LeadStatus);
                                            router.refresh();
                                        }}
                                    >
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {Object.entries(STATUS_LABEL).map(([key, label]) => (
                                                <SelectItem key={key} value={key}>{label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label>Rieši</Label>
                                    <Select
                                        defaultValue={lead.owner?.id ?? "none"}
                                        onValueChange={async (value) => {
                                            await changeOwner(lead.id, value === "none" ? null : value);
                                            router.refresh();
                                        }}
                                    >
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">— nikto —</SelectItem>
                                            {users.map((user) => (
                                                <SelectItem key={user.id} value={user.id}>
                                                    {user.firstName} {user.lastName}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-1.5">
                                    <QuickLink
                                        icon={<Phone className="h-3.5 w-3.5" />}
                                        href={phoneHref}
                                        text={lead.phone}
                                    />
                                    <QuickLink
                                        icon={<Mail className="h-3.5 w-3.5" />}
                                        href={lead.email ? `mailto:${lead.email}` : null}
                                        text={lead.email}
                                    />
                                    <QuickLink
                                        icon={<Globe className="h-3.5 w-3.5" />}
                                        href={lead.website ? normalizeUrl(lead.website) : null}
                                        text={lead.website}
                                        external
                                    />
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">Údaje</CardTitle>
                            </CardHeader>
                            <CardContent className="grid gap-4">
                                <Field label="Firma" value={form.companyName} onChange={(v) => set("companyName", v)} />
                                <Field label="Web" value={form.website} onChange={(v) => set("website", v)} />
                                <Field label="Telefón" value={form.phone} onChange={(v) => set("phone", v)} />
                                <Field label="Email" value={form.email} onChange={(v) => set("email", v)} />
                                <Field label="Cena (€)" value={form.price} onChange={(v) => set("price", v)} type="number" />
                                <Field
                                    label="Rozpis ceny"
                                    value={form.priceNote}
                                    onChange={(v) => set("priceNote", v)}
                                    placeholder="499 stránka + 299 admin"
                                />
                                <Field label="Link na návrh" value={form.designUrl} onChange={(v) => set("designUrl", v)} />
                                <div className="grid gap-1.5">
                                    <Label>Interná poznámka</Label>
                                    <Textarea
                                        value={form.note}
                                        onChange={(event) => set("note", event.target.value)}
                                    />
                                </div>
                                {dirty && (
                                    <Button onClick={save} disabled={saving}>
                                        {saving ? "Ukladám…" : "Uložiť zmeny"}
                                    </Button>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </DashboardContent>
        </>
    );
}

function QuickLink({
    icon,
    href,
    text,
    external,
}: {
    icon: React.ReactNode;
    href: string | null;
    text: string | null;
    external?: boolean;
}) {
    if (!href || !text) return null;
    return (
        <a
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
            {icon}
            <span className="truncate">{text}</span>
        </a>
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

function SentButton({
    label,
    at,
    onLog,
    disabled,
}: {
    label: string;
    at: string | null;
    onLog: () => void;
    disabled?: boolean;
}) {
    return (
        <Button
            type="button"
            variant={at ? "secondary" : "outline"}
            onClick={onLog}
            disabled={disabled}
            className="h-auto flex-col items-start gap-0.5 px-3 py-2 text-left"
        >
            <span className="flex items-center gap-1.5 text-sm font-medium">
                {at && <Check className="h-3.5 w-3.5" />}
                {label}
            </span>
            <span className="text-xs font-normal text-muted-foreground">
                {at ? formatDateTime(at) : "neposlané"}
            </span>
        </Button>
    );
}
