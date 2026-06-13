"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateLead, changeStatus, changeOwner, setNextAction, logSent } from "@/lib/actions/leads";
import { LeadStatus, ActivityType, CallOutcome } from "@/app/generated/prisma/enums";
import type { LeadDetailData, UserOption } from "@/lib/queries/leads";
import { ArrowLeft, Phone } from "lucide-react";

const STATUS_LABEL: Record<LeadStatus, string> = {
    NEW: "Nový", ACTIVE: "Aktívny", SNOOZED: "Spí", WON: "Vyhraný", LOST: "Stratený",
};

const OUTCOME_LABEL: Record<CallOutcome, string> = {
    NO_ANSWER: "nezdvihli", BAD_NUMBER: "zlé číslo", NOT_INTERESTED: "nemajú záujem",
    CALL_AGAIN: "zavolať znovu", WANTS_QUOTE: "chcú cenovú ponuku", WANTS_DESIGN: "chcú návrh",
    WANTS_EMAIL: "máme napísať", SNOOZE: "ozvať sa neskôr", POSITIVE: "pozitívny",
};

const TYPE_LABEL: Record<ActivityType, string> = {
    CALL: "📞 Hovor", QUOTE_SENT: "💶 Poslaná CP", DESIGN_SENT: "🎨 Poslaný návrh",
    EMAIL_SENT: "✉️ Poslaný email", SMS_SENT: "💬 SMS", NOTE: "📝 Poznámka",
};

function fmt(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("sk-SK", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDateOnly(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("sk-SK");
}

export default function LeadDetail({ lead, users }: { lead: LeadDetailData; users: UserOption[] }) {
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

    const [nextAt, setNextAt] = useState(lead.nextActionAt ? lead.nextActionAt.slice(0, 16) : "");
    const [nextNote, setNextNote] = useState(lead.nextActionNote ?? "");

    function set<K extends keyof typeof form>(key: K, value: string) {
        setForm((f) => ({ ...f, [key]: value }));
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

    return (
        <div className="space-y-6">
            {/* hlavička */}
            <div className="flex items-center gap-3">
                <Button asChild variant="ghost" size="sm">
                    <Link href="/dashboard/leads"><ArrowLeft className="mr-1 h-4 w-4" />Späť</Link>
                </Button>
                <h1 className="text-xl font-semibold">
                    <span className="mr-2 text-muted-foreground">#{lead.number}</span>
                    {lead.companyName ?? lead.website ?? "Bez mena"}
                </h1>
                {lead.phone && (
                    <a href={`tel:${lead.phone.replace(/\s/g, "")}`} className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
                        <Phone className="h-3.5 w-3.5" />{lead.phone}
                    </a>
                )}
            </div>

            {/* stav · vlastník · ďalší krok */}
            <Card>
                <CardContent className="grid gap-4 pt-6 sm:grid-cols-3">
                    <div className="grid gap-1.5">
                        <Label>Stav</Label>
                        <Select defaultValue={lead.status} onValueChange={(v) => { changeStatus(lead.id, v as LeadStatus); router.refresh(); }}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {Object.entries(STATUS_LABEL).map(([k, label]) => (
                                    <SelectItem key={k} value={k}>{label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid gap-1.5">
                        <Label>Rieši</Label>
                        <Select defaultValue={lead.owner?.id ?? "none"} onValueChange={(v) => { changeOwner(lead.id, v === "none" ? null : v); router.refresh(); }}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">— nikto —</SelectItem>
                                {users.map((u) => (
                                    <SelectItem key={u.id} value={u.id}>{u.firstName} {u.lastName}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid gap-1.5">
                        <Label>Ďalší krok</Label>
                        <div className="flex gap-1.5">
                            <Input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} />
                            <Button variant="outline" size="sm" className="shrink-0" onClick={() => { setNextAction(lead.id, nextAt ? new Date(nextAt).toISOString() : null, nextNote.trim() || null); router.refresh(); }}>
                                OK
                            </Button>
                        </div>
                        <Input placeholder="Čo treba urobiť…" value={nextNote} onChange={(e) => setNextNote(e.target.value)} />
                    </div>
                </CardContent>
            </Card>

            {/* poslané veci */}
            <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Poslané</CardTitle></CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-3">
                    <SentItem label="Cenová ponuka" at={lead.quoteSentAt} onLog={() => { logSent(lead.id, "QUOTE_SENT"); router.refresh(); }} />
                    <SentItem label="Dizajnový návrh" at={lead.designSentAt} onLog={() => { logSent(lead.id, "DESIGN_SENT"); router.refresh(); }} />
                    <SentItem label="Email / o nás" at={lead.aboutUsSentAt} onLog={() => { logSent(lead.id, "EMAIL_SENT"); router.refresh(); }} />
                </CardContent>
            </Card>

            {/* údaje */}
            <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Údaje</CardTitle></CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                    <Field label="Firma" value={form.companyName} onChange={(v) => set("companyName", v)} />
                    <Field label="Web" value={form.website} onChange={(v) => set("website", v)} />
                    <Field label="Telefón" value={form.phone} onChange={(v) => set("phone", v)} />
                    <Field label="Email" value={form.email} onChange={(v) => set("email", v)} />
                    <Field label="Cena (€)" value={form.price} onChange={(v) => set("price", v)} type="number" />
                    <Field label="Rozpis ceny" value={form.priceNote} onChange={(v) => set("priceNote", v)} placeholder="499 stránka + 299 admin" />
                    <Field label="Link na návrh" value={form.designUrl} onChange={(v) => set("designUrl", v)} className="sm:col-span-2" />
                    <div className="grid gap-1.5 sm:col-span-2">
                        <Label>Poznámka</Label>
                        <Textarea value={form.note} onChange={(e) => set("note", e.target.value)} className="min-h-[70px]" />
                    </div>
                    {dirty && (
                        <div className="sm:col-span-2">
                            <Button onClick={save} disabled={saving}>{saving ? "Ukladám…" : "Uložiť zmeny"}</Button>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* história */}
            <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">História</CardTitle></CardHeader>
                <CardContent>
                    {lead.activities.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Zatiaľ žiadna aktivita.</p>
                    ) : (
                        <div>
                            {lead.activities.map((a, i) => (
                                <div key={a.id}>
                                    {i > 0 && <Separator />}
                                    <div className="flex items-baseline gap-3 py-2.5 text-sm">
                                        <span className="w-32 shrink-0 text-muted-foreground tabular-nums">{fmt(a.createdAt)}</span>
                                        <span className="shrink-0 font-medium">{TYPE_LABEL[a.type]}</span>
                                        {a.outcome && <Badge variant="secondary" className="font-normal">{OUTCOME_LABEL[a.outcome]}</Badge>}
                                        {a.note && <span className="text-muted-foreground">{a.note}</span>}
                                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{a.userName}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    <p className="mt-3 text-xs text-muted-foreground">Pridaný {fmtDateOnly(lead.createdAt)}</p>
                </CardContent>
            </Card>
        </div>
    );
}

function Field({ label, value, onChange, type = "text", placeholder, className }: {
    label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; className?: string;
}) {
    return (
        <div className={`grid gap-1.5 ${className ?? ""}`}>
            <Label>{label}</Label>
            <Input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        </div>
    );
}

function SentItem({ label, at, onLog }: { label: string; at: string | null; onLog: () => void }) {
    return (
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{at ? fmt(at) : "neposlané"}</p>
            </div>
            <Button size="sm" variant={at ? "ghost" : "outline"} onClick={onLog}>
                {at ? "Poslané znova" : "Poslané ✓"}
            </Button>
        </div>
    );
}