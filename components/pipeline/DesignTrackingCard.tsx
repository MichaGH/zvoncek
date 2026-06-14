"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertTriangle,
    Check,
    Clock,
    Copy,
    ExternalLink,
    Pencil,
    Plus,
    Power,
    PowerOff,
    RefreshCw,
    Send,
    Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import { CONFIDENCE_LABEL, CONFIDENCE_VARIANT } from "@/lib/dictionaries";
import {
    addDesignVersion,
    createDesign,
    removeDesign,
    setDesignSent,
    updateDesignMeta,
} from "@/lib/actions/tracking";
import type { DesignView, TrackedEventRow } from "@/lib/queries/tracking";

function normalizeUrl(u: string) {
    return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function trackedUrl(design: DesignView): string | null {
    if (!design.targetUrl || !design.token) return null;
    const base = normalizeUrl(design.targetUrl);
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}p=${design.token}`;
}

function fmtDateTime(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("sk-SK", {
        day: "numeric",
        month: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function fmtDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("sk-SK", { day: "numeric", month: "numeric" });
}

function fmtDuration(ms: number | null): string | null {
    if (ms == null) return null;
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

type FormState = { id: string; mode: "version" | "meta" } | null;

export default function DesignTrackingCard({
    leadId,
    designs,
    quoteSentAt,
}: {
    leadId: string;
    designs: DesignView[];
    quoteSentAt: string | null;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    const [showCreate, setShowCreate] = useState(() => designs.length === 0);
    const [newUrl, setNewUrl] = useState("");
    const [newLabel, setNewLabel] = useState("");
    const [newRepo, setNewRepo] = useState("");

    const [form, setForm] = useState<FormState>(null);
    const [vUrl, setVUrl] = useState("");
    const [vNote, setVNote] = useState("");
    const [mLabel, setMLabel] = useState("");
    const [mRepo, setMRepo] = useState("");

    const [copiedId, setCopiedId] = useState<string | null>(null);

    const anySent = designs.some((d) => d.sentAt);
    const designNoPrice = anySent && !quoteSentAt;

    async function run(fn: () => Promise<unknown>) {
        setBusy(true);
        await fn();
        setBusy(false);
        router.refresh();
    }

    async function create() {
        await run(() =>
            createDesign({
                leadId,
                label: newLabel.trim() || null,
                url: newUrl.trim() || null,
                repoUrl: newRepo.trim() || null,
            }),
        );
        setNewUrl("");
        setNewLabel("");
        setNewRepo("");
        setShowCreate(false);
    }

    async function saveVersion(id: string) {
        await run(() => addDesignVersion(id, { url: vUrl.trim() || null, note: vNote.trim() || null }));
        setForm(null);
    }

    async function saveMeta(id: string) {
        await run(() =>
            updateDesignMeta(id, { label: mLabel.trim() || null, repoUrl: mRepo.trim() || null }),
        );
        setForm(null);
    }

    async function copyPlain(design: DesignView) {
        if (!design.targetUrl) return;
        try {
            await navigator.clipboard.writeText(normalizeUrl(design.targetUrl));
            setCopiedId(design.id);
            setTimeout(() => setCopiedId((c) => (c === design.id ? null : c)), 1500);
        } catch {
            // clipboard blocked (non-https) — ignore
        }
    }

    return (
        <Card>
            <CardHeader className="flex items-center justify-between">
                <CardTitle className="text-base">Dizajn</CardTitle>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowCreate((s) => !s)}
                    disabled={busy}
                >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Pridať návrh
                </Button>
            </CardHeader>
            <CardContent className="space-y-4">
                {designNoPrice && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            Návrh bol poslaný, ale cena ešte nie. Over, či klient dostal cenu.
                        </span>
                    </div>
                )}

                {designs.length === 0 && !showCreate && (
                    <p className="text-sm text-muted-foreground">
                        Zatiaľ žiadny návrh. Klikni „Pridať návrh&quot;.
                    </p>
                )}

                {designs.map((design) => {
                    const tracked = trackedUrl(design);
                    const s = design.summary;
                    const isSent = Boolean(design.sentAt);
                    return (
                        <div key={design.id} className="space-y-2 rounded-lg border p-3">
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">{design.label || "Návrh"}</span>
                                    <Badge variant="outline" className="font-normal">
                                        v{design.currentVersion}
                                    </Badge>
                                    <Badge variant={CONFIDENCE_VARIANT[s.confidence]} className="font-normal">
                                        {CONFIDENCE_LABEL[s.confidence]}
                                    </Badge>
                                    {s.viewedAfterUpdate && design.currentVersion > 1 && (
                                        <Badge variant="secondary" className="font-normal">
                                            Videli po update
                                        </Badge>
                                    )}
                                    {isSent && (
                                        <Badge variant="secondary" className="font-normal">
                                            Poslané {fmtDate(design.sentAt)}
                                        </Badge>
                                    )}
                                    {!design.isLive && (
                                        <Badge variant="destructive" className="font-normal">
                                            Stránka vypnutá
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex shrink-0 gap-0.5">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-8 w-8 p-0"
                                        aria-label="Upraviť repo / označenie"
                                        disabled={busy}
                                        onClick={() => {
                                            setMLabel(design.label ?? "");
                                            setMRepo(design.repoUrl ?? "");
                                            setForm({ id: design.id, mode: "meta" });
                                        }}
                                    >
                                        <Pencil className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-8 w-8 p-0 text-destructive"
                                        aria-label="Odstrániť návrh"
                                        disabled={busy}
                                        onClick={() => run(() => removeDesign(design.id))}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>

                            {/* Odkaz pre manažéra — klikateľný + kopírovanie */}
                            {design.targetUrl ? (
                                <div className="flex items-center gap-2">
                                    <span className="w-16 shrink-0 text-xs text-muted-foreground">odkaz</span>
                                    <a
                                        href={normalizeUrl(design.targetUrl)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="truncate text-sm text-primary underline-offset-2 hover:underline"
                                    >
                                        {design.targetUrl}
                                    </a>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="ml-auto shrink-0"
                                        onClick={() => copyPlain(design)}
                                    >
                                        {copiedId === design.id ? (
                                            <Check className="h-3.5 w-3.5" />
                                        ) : (
                                            <Copy className="h-3.5 w-3.5" />
                                        )}
                                    </Button>
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Bez URL — pridaj adresu cez „Aktualizovať&quot;.
                                </p>
                            )}

                            {/* Sledovaný odkaz — len text, nie link, bez kopírovacieho tlačidla */}
                            {tracked && (
                                <div className="flex items-start gap-2">
                                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                                        sledovaný
                                    </span>
                                    <code className="select-all break-all font-mono text-xs text-muted-foreground">
                                        {tracked}
                                    </code>
                                </div>
                            )}

                            {design.repoUrl && (
                                <div className="flex items-center gap-2">
                                    <span className="w-16 shrink-0 text-xs text-muted-foreground">repo</span>
                                    <a
                                        href={normalizeUrl(design.repoUrl)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-1 truncate text-xs text-primary underline-offset-2 hover:underline"
                                    >
                                        <ExternalLink className="h-3 w-3 shrink-0" />
                                        {design.repoUrl}
                                    </a>
                                </div>
                            )}

                            <div className="flex items-center justify-between gap-2">
                                <p className="text-xs text-muted-foreground">
                                    {s.totalViews === 0
                                        ? "Zatiaľ neotvorené"
                                        : `${s.engagedViews}× reálne pozretie · naposledy ${fmtDateTime(s.lastViewedAt)}`}
                                </p>
                                <TrackerHistory events={design.events} />
                            </div>

                            {form?.id === design.id && form.mode === "version" ? (
                                <div className="space-y-2 rounded-md bg-muted/40 p-2">
                                    <div className="grid gap-1.5">
                                        <Label className="text-xs text-muted-foreground">
                                            Nová URL (nepovinné)
                                        </Label>
                                        <Input
                                            value={vUrl}
                                            onChange={(e) => setVUrl(e.target.value)}
                                            placeholder={design.targetUrl ?? "https://…"}
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <Label className="text-xs text-muted-foreground">
                                            Poznámka (nepovinné)
                                        </Label>
                                        <Input
                                            value={vNote}
                                            onChange={(e) => setVNote(e.target.value)}
                                            placeholder="napr. opravené čo chcel klient"
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={() => saveVersion(design.id)} disabled={busy}>
                                            {busy ? "Ukladám…" : "Uložiť verziu"}
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                                            Zrušiť
                                        </Button>
                                    </div>
                                </div>
                            ) : form?.id === design.id && form.mode === "meta" ? (
                                <div className="space-y-2 rounded-md bg-muted/40 p-2">
                                    <div className="grid gap-1.5">
                                        <Label className="text-xs text-muted-foreground">Označenie</Label>
                                        <Input
                                            value={mLabel}
                                            onChange={(e) => setMLabel(e.target.value)}
                                            placeholder="napr. Variant A"
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <Label className="text-xs text-muted-foreground">GitHub repo</Label>
                                        <Input
                                            value={mRepo}
                                            onChange={(e) => setMRepo(e.target.value)}
                                            placeholder="https://github.com/…"
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={() => saveMeta(design.id)} disabled={busy}>
                                            {busy ? "Ukladám…" : "Uložiť"}
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                                            Zrušiť
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-wrap items-center gap-1">
                                    <Button
                                        size="sm"
                                        variant={isSent ? "secondary" : "default"}
                                        onClick={() => run(() => setDesignSent(design.id, !isSent))}
                                        disabled={busy}
                                    >
                                        <Send className="mr-1.5 h-3.5 w-3.5" />
                                        {isSent ? "Neposlaný" : "Označiť poslaný"}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            setVUrl("");
                                            setVNote("");
                                            setForm({ id: design.id, mode: "version" });
                                        }}
                                        disabled={busy}
                                    >
                                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                                        Aktualizovať
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                            run(() => updateDesignMeta(design.id, { isLive: !design.isLive }))
                                        }
                                        disabled={busy}
                                    >
                                        {design.isLive ? (
                                            <PowerOff className="mr-1.5 h-3.5 w-3.5" />
                                        ) : (
                                            <Power className="mr-1.5 h-3.5 w-3.5" />
                                        )}
                                        {design.isLive ? "Vypnutá" : "Živá"}
                                    </Button>
                                </div>
                            )}

                            {design.versions.length > 1 && (
                                <div className="space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
                                    {design.versions.map((v) => (
                                        <div key={v.version} className="flex gap-2">
                                            <span className="tabular-nums">v{v.version}</span>
                                            <span>{fmtDateTime(v.markedAt)}</span>
                                            {v.note && <span className="truncate">· {v.note}</span>}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}

                {showCreate && (
                    <div className="space-y-2 rounded-lg border border-dashed p-3">
                        <div className="grid gap-1.5">
                            <Label className="text-xs text-muted-foreground">URL návrhu</Label>
                            <Input
                                value={newUrl}
                                onChange={(e) => setNewUrl(e.target.value)}
                                placeholder="https://atp.thegrandpoints.com/"
                                className="h-8 text-xs"
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label className="text-xs text-muted-foreground">
                                Označenie (nepovinné)
                            </Label>
                            <Input
                                value={newLabel}
                                onChange={(e) => setNewLabel(e.target.value)}
                                placeholder="napr. Variant A"
                                className="h-8 text-xs"
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label className="text-xs text-muted-foreground">
                                GitHub repo (nepovinné)
                            </Label>
                            <Input
                                value={newRepo}
                                onChange={(e) => setNewRepo(e.target.value)}
                                placeholder="https://github.com/…"
                                className="h-8 text-xs"
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button size="sm" onClick={create} disabled={busy}>
                                <Plus className="mr-1.5 h-3.5 w-3.5" />
                                {busy ? "Vytváram…" : "Vytvoriť návrh"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
                                Zrušiť
                            </Button>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function eventTypeLabel(t: TrackedEventRow["type"]) {
    return t === "ENGAGED_VIEW" ? "Reálne pozretie" : "Otvorenie";
}

function TrackerHistory({ events }: { events: TrackedEventRow[] }) {
    return (
        <Drawer>
            <DrawerTrigger asChild>
                <Button size="sm" variant="ghost" className="shrink-0">
                    <Clock className="mr-1.5 h-3.5 w-3.5" />
                    História otvorení
                </Button>
            </DrawerTrigger>
            <DrawerContent>
                <DrawerHeader>
                    <DrawerTitle>História otvorení</DrawerTitle>
                    <DrawerDescription>
                        Každý záznam = jedno načítanie sledovaného odkazu. „možno skener&quot;
                        sú pravdepodobne automatické (nie klient).
                    </DrawerDescription>
                </DrawerHeader>
                <div className="max-h-[60vh] space-y-2 overflow-y-auto px-4 pb-6">
                    {events.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Zatiaľ žiadne otvorenia.</p>
                    ) : (
                        events.map((e) => (
                            <div
                                key={e.id}
                                className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                            >
                                <span className="font-medium">{eventTypeLabel(e.type)}</span>
                                <Badge variant="outline" className="font-normal">
                                    v{e.versionAtView}
                                </Badge>
                                {fmtDuration(e.durationMs) && (
                                    <span className="text-xs text-muted-foreground">
                                        {fmtDuration(e.durationMs)}
                                    </span>
                                )}
                                {e.uaShort && (
                                    <span className="text-xs text-muted-foreground">{e.uaShort}</span>
                                )}
                                {e.botFlag && (
                                    <Badge variant="secondary" className="font-normal">
                                        možno skener
                                    </Badge>
                                )}
                                <span className="ml-auto text-xs text-muted-foreground">
                                    {fmtDateTime(e.occurredAt)}
                                </span>
                                {e.ip && (
                                    <span className="w-full text-xs text-muted-foreground/70">{e.ip}</span>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </DrawerContent>
        </Drawer>
    );
}
