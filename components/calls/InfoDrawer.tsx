"use client";

import { useState } from "react";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { QueueLead } from "@/lib/queries/calls";
import { Phone, Globe, StickyNote, History, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateLeadContact } from "@/lib/actions/calls";
import { toast } from "sonner";

export default function InfoDrawer({ lead, onClose }: { lead: QueueLead | null; onClose: () => void }) {
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);

    // Lokálny stav pre editáciu
    const [companyName, setCompanyName] = useState("");
    const [website, setWebsite] = useState("");
    const [phone, setPhone] = useState("");
    const [email, setEmail] = useState("");

    function startEdit() {
        if (!lead) return;
        setCompanyName(lead.companyName ?? "");
        setWebsite(lead.website ?? "");
        setPhone(lead.phone ?? "");
        setEmail(lead.email ?? "");
        setEditing(true);
    }

    function cancelEdit() {
        setEditing(false);
    }

    async function saveEdit() {
        if (!lead) return;
        setSaving(true);
        const r = await updateLeadContact(lead.id, {
            companyName: companyName.trim() || null,
            website: website.trim() || null,
            phone: phone.trim() || null,
            email: email.trim() || null,
        });
        setSaving(false);
        if (r?.error) {
            toast.error(r.error);
        } else {
            toast.success("Kontakt uložený");
            setEditing(false);
        }
    }

    // Keď sa drawer zatvára, resetujeme edit stav
    function handleOpenChange(open: boolean) {
        if (!open) {
            setEditing(false);
            onClose();
        }
    }

    if (!lead) return <Drawer open={false} repositionInputs={false} />;
    const L = lead;
    const name = L.companyName ?? L.website ?? "—";

    return (
        // repositionInputs={false}: vaul defaultne presúva drawer hore keď sa focusne
        // input → na mobile drawer vyletí mimo obrazovky. Vypneme to (rovnako ako CallDrawer).
        <Drawer open={!!lead} onOpenChange={handleOpenChange} repositionInputs={false}>
            <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[90dvh]">
                <DrawerHeader className="flex-none pb-2">
                    <div className="mx-auto flex w-full max-w-md items-center justify-between">
                        <DrawerTitle className="flex min-w-0 items-center gap-2">
                            <span className="shrink-0 text-muted-foreground tabular-nums">#{L.number}</span>
                            {!editing && <span className="truncate">{name}</span>}
                        </DrawerTitle>
                        {!editing ? (
                            <Button variant="ghost" size="sm" onClick={startEdit} className="h-8 shrink-0 gap-1.5 text-muted-foreground">
                                <Pencil className="h-3.5 w-3.5" />
                                Upraviť
                            </Button>
                        ) : (
                            <div className="flex shrink-0 gap-1">
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={cancelEdit} disabled={saving}>
                                    <X className="h-4 w-4" />
                                </Button>
                                <Button size="icon" className="h-8 w-8" onClick={saveEdit} disabled={saving}>
                                    <Check className="h-4 w-4" />
                                </Button>
                            </div>
                        )}
                    </div>
                    <DrawerDescription className="sr-only">Detaily firmy</DrawerDescription>
                </DrawerHeader>

                {/* flex-1 + overflow-y-auto: drawer má pevnú výšku, obsah scrolluje interne */}
                <div className="flex-1 overflow-y-auto overscroll-contain">
                    <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6">
                        {editing ? (
                            /* ── EDIT MODE ── */
                            <div className="space-y-2">
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Názov firmy</label>
                                    <Input data-vaul-no-drag value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Názov firmy" className="text-base" />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Web</label>
                                    <Input data-vaul-no-drag value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="www.firma.sk" className="text-base" />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Telefón</label>
                                    <Input data-vaul-no-drag value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+421 900 000 000" type="tel" className="text-base" />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Email</label>
                                    <Input data-vaul-no-drag value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@firma.sk" type="email" className="text-base" />
                                </div>
                                <Button className="mt-2 w-full" onClick={saveEdit} disabled={saving}>
                                    {saving ? "Ukladám…" : "Uložiť zmeny"}
                                </Button>
                            </div>
                        ) : (
                            /* ── VIEW MODE ── */
                            <>
                                {L.phone && (
                                    <Row icon={<Phone className="h-4 w-4" />}>
                                        <a href={`tel:${L.phone.replace(/\s/g, "")}`} className="font-medium tabular-nums">{L.phone}</a>
                                    </Row>
                                )}
                                {L.website && (
                                    <Row icon={<Globe className="h-4 w-4" />}>
                                        <span className="break-all">{L.website}</span>
                                    </Row>
                                )}
                                {L.email && (
                                    <Row icon={<span className="text-xs font-medium">@</span>}>
                                        <a href={`mailto:${L.email}`} className="break-all text-sm">{L.email}</a>
                                    </Row>
                                )}
                                {L.attempts > 0 && (
                                    <Row icon={<History className="h-4 w-4" />}>
                                        <span>{L.attempts}× volané</span>
                                    </Row>
                                )}
                                {L.note ? (
                                    <div className="rounded-lg border bg-muted/30 p-3">
                                        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                            <StickyNote className="h-3.5 w-3.5" />Poznámka
                                        </div>
                                        <p className="text-sm">{L.note}</p>
                                    </div>
                                ) : (
                                    <p className="text-sm text-muted-foreground">Žiadna poznámka.</p>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </DrawerContent>
        </Drawer>
    );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{icon}</span>
            {children}
        </div>
    );
}