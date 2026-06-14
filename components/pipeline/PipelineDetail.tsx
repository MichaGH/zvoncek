"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, Globe, Mail, Pencil } from "lucide-react";
import { LeadStatus, NextActionKind } from "@/app/generated/prisma/enums";
import { DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export default function PipelineDetail({
    lead,
    users,
}: {
    lead: PipelineDetailData;
    users: PipelineUserOption[];
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

    // Editor for the NEXT action starts empty on purpose: a new next action should
    // never silently carry over the previously saved note. The current saved next
    // action is shown read-only above the editor; "Upraviť" loads it for editing.
    const [nextKind, setNextKind] = useState<NextActionKind>("CALL");
    const [nextAt, setNextAt] = useState("");
    const [nextNote, setNextNote] = useState("");
    const [savingNext, setSavingNext] = useState(false);

    const [businessNote, setBusinessNote] = useState("");
    const [showAllHistory, setShowAllHistory] = useState(false);

    const hasNextAction = Boolean(lead.nextActionKind || lead.nextActionAt || lead.nextActionNote);
    const businessActivities = lead.activities.filter((a) => a.category === "BUSINESS");
    const visibleActivities = showAllHistory ? lead.activities : businessActivities;

    function set<K extends keyof typeof form>(key: K, value: string) {
        setForm((current) => ({ ...current, [key]: value }));
        setDirty(true);
    }

    function resetNextEditor() {
        setNextKind("CALL");
        setNextAt("");
        setNextNote("");
    }

    function loadCurrentIntoEditor() {
        setNextKind(lead.nextActionKind ?? "CALL");
        setNextAt(lead.nextActionAt ? lead.nextActionAt.slice(0, 16) : "");
        setNextNote(lead.nextActionNote ?? "");
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
        await setNextAction(lead.id, null, null, null);
        resetNextEditor();
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
                        <span className="truncate">
                            {lead.companyName ?? lead.website ?? "Bez mena"}
                        </span>
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

            <div className="space-y-6">
                {/* A. Prehľad */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Prehľad</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 sm:grid-cols-2">
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

                        <div className="flex flex-wrap gap-2 sm:col-span-2">
                            <QuickLink icon={<Phone className="h-3.5 w-3.5" />} href={phoneHref} text={lead.phone} />
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

                {/* B. Ďalší krok */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Ďalší krok</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="rounded-lg border bg-muted/40 p-3">
                            {hasNextAction ? (
                                <div className="flex flex-wrap items-start justify-between gap-2">
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
                                    <div className="flex shrink-0 gap-2">
                                        <Button size="sm" variant="outline" onClick={loadCurrentIntoEditor}>
                                            <Pencil className="mr-1.5 h-3.5 w-3.5" />
                                            Upraviť
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={clearNextAction}>
                                            Vymazať
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    Žiadny naplánovaný ďalší krok.
                                </p>
                            )}
                        </div>

                        <Separator />

                        <div className="space-y-2">
                            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                                Nastaviť ďalší krok
                            </Label>
                            <div className="grid gap-2 sm:grid-cols-[200px_1fr]">
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
                                <Input
                                    type="datetime-local"
                                    value={nextAt}
                                    onChange={(event) => setNextAt(event.target.value)}
                                />
                            </div>
                            <Input
                                placeholder="Čo treba urobiť alebo na čo čakáme…"
                                value={nextNote}
                                onChange={(event) => setNextNote(event.target.value)}
                            />
                            <div className="flex gap-2">
                                <Button size="sm" onClick={saveNextAction} disabled={savingNext}>
                                    {savingNext ? "Ukladám…" : "Uložiť ďalší krok"}
                                </Button>
                                {(nextAt || nextNote) && (
                                    <Button size="sm" variant="ghost" onClick={resetNextEditor}>
                                        Zrušiť
                                    </Button>
                                )}
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* C. Obchodné kroky */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Obchodné kroky</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid gap-3 sm:grid-cols-3">
                            <SentItem label="Cenová ponuka" at={lead.quoteSentAt} onLog={async () => {
                                await logSent(lead.id, "QUOTE_SENT");
                                router.refresh();
                            }} />
                            <SentItem label="Dizajnový návrh" at={lead.designSentAt} onLog={async () => {
                                await logSent(lead.id, "DESIGN_SENT");
                                router.refresh();
                            }} />
                            <SentItem label="Email / o nás" at={lead.aboutUsSentAt} onLog={async () => {
                                await logSent(lead.id, "EMAIL_SENT");
                                router.refresh();
                            }} />
                        </div>
                        <Separator />
                        <div className="grid gap-2">
                            <Label>Zaznamenať obchodný krok</Label>
                            <p className="text-xs text-muted-foreground">
                                Pridá záznam do obchodnej histórie – napr. „Klient sľúbil poslať podklady“,
                                „Podklady neprišli“, „Máme sa ozvať po porade“. Nezávisí od poslania CP/návrhu/emailu.
                            </p>
                            <Textarea
                                value={businessNote}
                                onChange={(event) => setBusinessNote(event.target.value)}
                                placeholder="Klient sľúbil poslať logo do piatku"
                            />
                            <Button
                                className="w-fit"
                                size="sm"
                                disabled={!businessNote.trim()}
                                onClick={saveBusinessNote}
                            >
                                Pridať do histórie
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* D. Údaje */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Údaje</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 sm:grid-cols-2">
                        <Field label="Firma" value={form.companyName} onChange={(value) => set("companyName", value)} />
                        <Field label="Web" value={form.website} onChange={(value) => set("website", value)} />
                        <Field label="Telefón" value={form.phone} onChange={(value) => set("phone", value)} />
                        <Field label="Email" value={form.email} onChange={(value) => set("email", value)} />
                        <Field label="Cena (€)" value={form.price} onChange={(value) => set("price", value)} type="number" />
                        <Field
                            label="Rozpis ceny"
                            value={form.priceNote}
                            onChange={(value) => set("priceNote", value)}
                            placeholder="499 stránka + 299 admin"
                        />
                        <Field
                            label="Link na návrh"
                            value={form.designUrl}
                            onChange={(value) => set("designUrl", value)}
                            className="sm:col-span-2"
                        />
                        <div className="grid gap-1.5 sm:col-span-2">
                            <Label>Interná poznámka</Label>
                            <Textarea value={form.note} onChange={(event) => set("note", event.target.value)} />
                        </div>
                        {dirty && (
                            <div className="sm:col-span-2">
                                <Button onClick={save} disabled={saving}>
                                    {saving ? "Ukladám…" : "Uložiť zmeny"}
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* E. História */}
                <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                        <CardTitle className="text-base">
                            {showAllHistory ? "Celá história" : "Obchodná história"}
                        </CardTitle>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowAllHistory((v) => !v)}
                        >
                            {showAllHistory ? "Len obchodné" : "Zobraziť všetko"}
                        </Button>
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
                                                <span className="font-medium">{ACTIVITY_LABEL[activity.type]}</span>
                                                <Badge variant={activity.category === "BUSINESS" ? "default" : "outline"}>
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
                                                <Badge variant="secondary">{OUTCOME_LABEL[activity.outcome]}</Badge>
                                            )}
                                            {activity.note && <p className="text-muted-foreground">{activity.note}</p>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        <p className="mt-3 text-xs text-muted-foreground">Pridaný {formatDate(lead.createdAt)}</p>
                    </CardContent>
                </Card>
            </div>
        </>
    );
}

function normalizeUrl(url: string) {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
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
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
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
    className,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: string;
    placeholder?: string;
    className?: string;
}) {
    return (
        <div className={`grid gap-1.5 ${className ?? ""}`}>
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

function SentItem({
    label,
    at,
    onLog,
}: {
    label: string;
    at: string | null;
    onLog: () => Promise<void>;
}) {
    return (
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div className="min-w-0">
                <p className="truncate text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{at ? formatDateTime(at) : "neposlané"}</p>
            </div>
            <Button size="sm" variant={at ? "ghost" : "outline"} onClick={onLog}>
                {at ? "Znova" : "Označiť"}
            </Button>
        </div>
    );
}
