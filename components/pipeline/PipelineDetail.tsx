"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Phone } from "lucide-react";
import { LeadStatus, NextActionKind } from "@/app/generated/prisma/enums";
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
    const [nextKind, setNextKind] = useState<NextActionKind>(lead.nextActionKind ?? "CUSTOM");
    const [nextAt, setNextAt] = useState(lead.nextActionAt ? lead.nextActionAt.slice(0, 16) : "");
    const [nextNote, setNextNote] = useState(lead.nextActionNote ?? "");
    const [businessNote, setBusinessNote] = useState("");

    function set<K extends keyof typeof form>(key: K, value: string) {
        setForm((current) => ({ ...current, [key]: value }));
        setDirty(true);
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
        await setNextAction(
            lead.id,
            nextKind,
            nextAt ? new Date(nextAt).toISOString() : null,
            nextNote.trim() || null,
        );
        router.refresh();
    }

    async function clearNextAction() {
        await setNextAction(lead.id, null, null, null);
        setNextAt("");
        setNextNote("");
        router.refresh();
    }

    async function saveBusinessNote() {
        const result = await addBusinessNote(lead.id, businessNote);
        if (!result.error) {
            setBusinessNote("");
            router.refresh();
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <Button asChild variant="ghost" size="sm">
                    <Link href="/dashboard/pipeline">
                        <ArrowLeft className="mr-1 h-4 w-4" />
                        Späť
                    </Link>
                </Button>
                <h1 className="text-xl font-semibold">
                    <span className="mr-2 text-muted-foreground">#{lead.number}</span>
                    {lead.companyName ?? lead.website ?? "Bez mena"}
                </h1>
                {lead.phone && (
                    <a
                        href={`tel:${lead.phone.replace(/\s/g, "")}`}
                        className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                    >
                        <Phone className="h-3.5 w-3.5" />
                        {lead.phone}
                    </a>
                )}
            </div>

            <Card>
                <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
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

                    <div className="grid gap-2 rounded-lg border p-3 sm:col-span-2">
                        <Label>Ďalší krok</Label>
                        <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
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
                            <Button size="sm" onClick={saveNextAction}>Uložiť ďalší krok</Button>
                            <Button size="sm" variant="ghost" onClick={clearNextAction}>Vymazať</Button>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Obchodné kroky</CardTitle></CardHeader>
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
                        <Label>Vlastná obchodná poznámka</Label>
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

            <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Údaje</CardTitle></CardHeader>
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

            <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Celá história</CardTitle></CardHeader>
                <CardContent>
                    {lead.activities.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Zatiaľ žiadna aktivita.</p>
                    ) : (
                        <div>
                            {lead.activities.map((activity, index) => (
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
            <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{at ? formatDateTime(at) : "neposlané"}</p>
            </div>
            <Button size="sm" variant={at ? "ghost" : "outline"} onClick={onLog}>
                {at ? "Poslať znova" : "Označiť ako poslané"}
            </Button>
        </div>
    );
}
