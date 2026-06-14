"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Ban, Check, Copy, Link2, Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    CONFIDENCE_LABEL,
    CONFIDENCE_VARIANT,
    TRACKED_LINK_KIND_LABEL,
} from "@/lib/dictionaries";
import {
    createTrackedLink,
    markTrackedLinkUpdated,
    revokeTrackedLink,
} from "@/lib/actions/tracking";
import type { TrackedLinkView } from "@/lib/queries/tracking";

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

// The link you actually send the client: proposal URL + ?p=token.
function trackedUrl(link: TrackedLinkView): string | null {
    if (!link.targetUrl) return null;
    const sep = link.targetUrl.includes("?") ? "&" : "?";
    return `${link.targetUrl}${sep}p=${link.token}`;
}

export default function DesignTrackingCard({
    leadId,
    links,
    designSentAt,
    quoteSentAt,
}: {
    leadId: string;
    links: TrackedLinkView[];
    designSentAt: string | null;
    quoteSentAt: string | null;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    const [showCreate, setShowCreate] = useState(
        () => links.filter((l) => !l.revokedAt).length === 0,
    );
    const [newUrl, setNewUrl] = useState("");
    const [newLabel, setNewLabel] = useState("");

    const [updatingId, setUpdatingId] = useState<string | null>(null);
    const [updUrl, setUpdUrl] = useState("");
    const [updNote, setUpdNote] = useState("");

    const [copiedToken, setCopiedToken] = useState<string | null>(null);

    const activeLinks = links.filter((l) => !l.revokedAt);
    const designNoPrice = Boolean(designSentAt && !quoteSentAt);

    async function run(fn: () => Promise<unknown>) {
        setBusy(true);
        await fn();
        setBusy(false);
        router.refresh();
    }

    async function create() {
        await run(() =>
            createTrackedLink({
                leadId,
                kind: "DESIGN",
                label: newLabel.trim() || null,
                url: newUrl.trim() || null,
            }),
        );
        setNewUrl("");
        setNewLabel("");
        setShowCreate(false);
    }

    async function saveUpdate(linkId: string) {
        await run(() =>
            markTrackedLinkUpdated(linkId, {
                url: updUrl.trim() || null,
                note: updNote.trim() || null,
            }),
        );
        setUpdatingId(null);
        setUpdUrl("");
        setUpdNote("");
    }

    async function copy(link: TrackedLinkView) {
        const url = trackedUrl(link);
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            setCopiedToken(link.token);
            setTimeout(
                () => setCopiedToken((t) => (t === link.token ? null : t)),
                1500,
            );
        } catch {
            // clipboard may be blocked (non-https) — silently ignore
        }
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">Dizajn &amp; sledovanie</CardTitle>
                {activeLinks.length > 0 && (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setShowCreate((s) => !s)}
                        disabled={busy}
                    >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Pridať variant
                    </Button>
                )}
            </CardHeader>
            <CardContent className="space-y-4">
                {designNoPrice && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            Návrh bol poslaný, ale cena ešte nie. Over, či klient dostal
                            cenu.
                        </span>
                    </div>
                )}

                {activeLinks.length === 0 && !showCreate && (
                    <p className="text-sm text-muted-foreground">
                        Zatiaľ žiadny tracker. Vytvor ho a pošli klientovi sledovaný
                        odkaz.
                    </p>
                )}

                {activeLinks.map((link) => {
                    const url = trackedUrl(link);
                    const s = link.summary;
                    return (
                        <div key={link.id} className="space-y-2 rounded-lg border p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">
                                    {link.label || TRACKED_LINK_KIND_LABEL[link.kind]}
                                </span>
                                <Badge variant="outline" className="font-normal">
                                    v{link.currentVersion}
                                </Badge>
                                <Badge
                                    variant={CONFIDENCE_VARIANT[s.confidence]}
                                    className="font-normal"
                                >
                                    {CONFIDENCE_LABEL[s.confidence]}
                                </Badge>
                                {s.viewedAfterUpdate && link.currentVersion > 1 && (
                                    <Badge variant="secondary" className="font-normal">
                                        Videli po update
                                    </Badge>
                                )}
                            </div>

                            {url ? (
                                <div className="flex items-center gap-2">
                                    <Input
                                        readOnly
                                        value={url}
                                        className="h-8 text-xs"
                                        onFocus={(e) => e.currentTarget.select()}
                                    />
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="shrink-0"
                                        onClick={() => copy(link)}
                                    >
                                        {copiedToken === link.token ? (
                                            <Check className="h-3.5 w-3.5" />
                                        ) : (
                                            <Copy className="h-3.5 w-3.5" />
                                        )}
                                    </Button>
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Bez URL — pridaj adresu návrhu cez „Označiť ako
                                    aktualizovaný&quot;.
                                </p>
                            )}

                            <p className="text-xs text-muted-foreground">
                                {s.totalViews === 0
                                    ? "Zatiaľ neotvorené"
                                    : `${s.engagedViews}× reálne pozretie · naposledy ${formatDateTime(s.lastViewedAt)}`}
                            </p>

                            {updatingId === link.id ? (
                                <div className="space-y-2 rounded-md bg-muted/40 p-2">
                                    <div className="grid gap-1.5">
                                        <Label className="text-xs text-muted-foreground">
                                            Nová URL (nepovinné)
                                        </Label>
                                        <Input
                                            value={updUrl}
                                            onChange={(e) => setUpdUrl(e.target.value)}
                                            placeholder={link.targetUrl ?? "https://…"}
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <Label className="text-xs text-muted-foreground">
                                            Poznámka (nepovinné)
                                        </Label>
                                        <Input
                                            value={updNote}
                                            onChange={(e) => setUpdNote(e.target.value)}
                                            placeholder="napr. opravené čo chcel klient"
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                    <div className="flex gap-2">
                                        <Button
                                            size="sm"
                                            onClick={() => saveUpdate(link.id)}
                                            disabled={busy}
                                        >
                                            {busy ? "Ukladám…" : "Uložiť verziu"}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => setUpdatingId(null)}
                                        >
                                            Zrušiť
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex gap-1">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            setUpdatingId(link.id);
                                            setUpdUrl("");
                                            setUpdNote("");
                                        }}
                                        disabled={busy}
                                    >
                                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                                        Označiť ako aktualizovaný
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => run(() => revokeTrackedLink(link.id))}
                                        disabled={busy}
                                    >
                                        <Ban className="mr-1.5 h-3.5 w-3.5" />
                                        Zrušiť
                                    </Button>
                                </div>
                            )}

                            {link.versions.length > 1 && (
                                <div className="space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
                                    {link.versions.map((v) => (
                                        <div key={v.version} className="flex gap-2">
                                            <span className="tabular-nums">v{v.version}</span>
                                            <span>{formatDateTime(v.markedAt)}</span>
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
                            <Label className="text-xs text-muted-foreground">
                                URL návrhu
                            </Label>
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
                        <div className="flex gap-2">
                            <Button size="sm" onClick={create} disabled={busy}>
                                <Link2 className="mr-1.5 h-3.5 w-3.5" />
                                {busy ? "Vytváram…" : "Vytvoriť tracker"}
                            </Button>
                            {activeLinks.length > 0 && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setShowCreate(false)}
                                >
                                    Zrušiť
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
