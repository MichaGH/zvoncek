"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, Lock, Pencil, Phone, PhoneCall, Send, UserCheck, XCircle } from "lucide-react";
import { LeadStatus, ProjectType } from "@/app/generated/prisma/enums";
import { DashboardContent, DashboardPageHeader } from "@/components/dashboard/DashboardPage";
import AskManagerDialog from "@/components/pipeline/AskManagerDialog";
import CenovaPonukaCard from "@/components/pipeline/CenovaPonukaCard";
import { outstandingLabel, REQUEST_CONTENT_LABEL, type OutstandingRow } from "@/lib/domain/clientRequests";
import DesignTrackingCard from "@/components/pipeline/DesignTrackingCard";
import FinishTaskDialog from "@/components/pipeline/FinishTaskDialog";
import TakeoverDialog from "@/components/pipeline/TakeoverDialog";
import TaskCard from "@/components/pipeline/TaskCard";
import UrgencyLabel from "@/components/shared/UrgencyLabel";
import InteractionSheet, { type InteractionTarget } from "@/components/pipeline/InteractionSheet";
import OfferSentDialog from "@/components/pipeline/OfferSentDialog";
import ResponsiveSheet from "@/components/shared/ResponsiveSheet";
import { copyEmailLink } from "@/components/shared/copyEmailLink";
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
import { correctRecord, updateDealContact } from "@/lib/actions/pipeline";
import { changeOwner, changeStatus, markLost, reopenDeal, setProjectType, updateLead } from "@/lib/actions/pipeline";
import {
    ACTIVITY_CATEGORY_LABEL,
    ACTIVITY_LABEL,
    ACTIVITY_SOURCE_LABEL,
    CONFIDENCE_LABEL,
    CONFIDENCE_VARIANT,
    NEXT_ACTION_LABEL,
    OUTCOME_LABEL,
    PROJECT_TYPE_LABEL,
    STATUS_LABEL,
} from "@/lib/dictionaries";
import { BUSINESS_TZ, businessDate, businessDayMonth, businessDayStart, businessInputParts } from "@/lib/domain/businessTime";
import { CLIENT_SECTION_LABEL } from "@/lib/domain/clientSections";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";
import type { DealStatus } from "@/lib/domain/dealMutations";
import { FOLLOW_UP_NEXT_KINDS, type FollowUpNextKind } from "@/lib/domain/leadFlow";
import type { DealDetailData, DealTaskView, DealUserOption } from "@/lib/queries/pipeline";
import type { DesignView } from "@/lib/queries/tracking";
import { fmtAgo } from "@/lib/utils";

// Jeden detail obchodu pre obchodníka aj manažéra (round 2, D-01). Rozdiel je v `caps`:
// manažérske ovládanie (stav, vlastník, typ projektu, WON/reopen, návrhy, vybavenie požiadaviek) sa iba nevykreslí,
// ale rozhoduje o ňom server – každý príkaz má vlastný guard pod zámkom Lead riadku.

// Záznamy, ktoré sa dajú prečiarknuť (round 2 §2c 5.4) – autor alebo manažér, s dôvodom.
const CORRECTABLE = new Set(["OFFER_SENT", "SMS_SENT", "CLIENT_REPLIED"]);

const DEAL_STATUS_OPTIONS: DealStatus[] = ["ACTIVE", "SNOOZED", "WON", "LOST", "UNREACHABLE"];
const CLOSED: LeadStatus[] = ["WON", "LOST", "UNREACHABLE"];

function newKey() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

export default function DealDetail({
    lead,
    caps,
    viewerId,
    users,
    designs,
    resolvers,
}: {
    lead: DealDetailData;
    caps: DealCapabilities;
    viewerId: string;
    users: DealUserOption[];
    designs: DesignView[];
    resolvers: { id: string; firstName: string; lastName: string }[];
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();

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
    const [showAllHistory, setShowAllHistory] = useState(caps.manage);
    const [lostReason, setLostReason] = useState(lead.lostReason ?? "");
    const [savingLost, setSavingLost] = useState(false);
    // Akčné okno: „contact" = Zaznamenať kontakt, „replan" = Zmeniť krok (rovno obrazovka ďalšieho kroku),
    // „cancel" = Zrušiť úlohu (to isté okno, uloženie úlohu zruší – wave 3 §6.7).
    const [interaction, setInteraction] = useState<null | "contact" | "replan" | "cancel">(null);
    // Úlohy pre manažéra (wave 3): zadanie, vybavenie, prevzatie.
    const [ask, setAsk] = useState<null | "HELP" | "HANDOVER">(null);
    const [finish, setFinish] = useState<null | { task: DealTaskView; send: boolean }>(null);
    const [takingOver, setTakingOver] = useState(false);
    // Zmena stavu / vlastníka s otvorenou úlohou alebo neposlaným výsledkom sa najprv potvrdí (menuje, čo sa stane).
    const [statusConfirm, setStatusConfirm] = useState<DealStatus | null>(null);
    const [ownerConfirm, setOwnerConfirm] = useState<string | null | undefined>(undefined);
    const [taskAssignee, setTaskAssignee] = useState("");
    const [cancelNote, setCancelNote] = useState("");
    const [actionKey, setActionKey] = useState(newKey);
    // Z akčného okna v zozname sa „Poslali sme ponuku" otvára tu (?zaznam=ponuka), lebo dialóg potrebuje návrhy a cenu.
    const [offerDialog, setOfferDialog] = useState<null | { historical: boolean; designId?: string }>(null);
    const [correcting, setCorrecting] = useState<string | null>(null);
    const [correctionReason, setCorrectionReason] = useState("");
    const [copiedDesign, setCopiedDesign] = useState<string | null>(null);

    const isClosed = CLOSED.includes(lead.status);
    const editable = caps.work && (caps.manage || !isClosed);
    const businessActivities = lead.activities.filter((a) => a.category === "BUSINESS");
    const visibleActivities = showAllHistory ? lead.activities : businessActivities;
    const openTask = lead.tasks.find((t) => t.status === "OPEN") ?? null;
    const isOwner = lead.owner?.id === viewerId;
    // Zamknutý krok mení len vlastník – zrušením úlohy (D5); manažér na cudzom obchode úlohu vybaví alebo prevezme klienta.
    const canReplan = editable && (!openTask || isOwner);
    const phoneHref = lead.phone ? `tel:${lead.phone.replace(/\s/g, "")}` : null;

    // Manažér smie meniť aj uzavretý obchod (requireDealManage), vlastník len otvorený (requireDealWork).
    const api = caps.manage
        ? { updateContact: (data: typeof form) => updateLead(lead.id, data), quoteMode: "pipeline" as const }
        : { updateContact: (data: typeof form) => updateDealContact(lead.id, data), quoteMode: "clients" as const };

    function report(r: { success: true } | ActionError | { success: true; created: boolean }) {
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
        const r = await api.updateContact({
            companyName: form.companyName.trim() || null,
            website: form.website.trim() || null,
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            note: form.note.trim() || null,
        } as typeof form);
        setSavingData(false);
        if (report(r)) setEditingData(false);
        router.refresh();
    }

    async function runBusiness(fn: () => Promise<{ success: true } | ActionError>) {
        setBusy(true);
        report(await fn());
        setActionKey(newKey());
        setBusy(false);
        router.refresh();
    }

    // Zmena stavu z výberu: uzavretie / uspanie s otvorenou úlohou ju výslovne zruší; uzavretie odmietne neposlané výsledky.
    function pickStatus(value: DealStatus) {
        const closing = CLOSED.includes(value);
        if ((openTask && (closing || value === "SNOOZED")) || (closing && lead.pending.length > 0)) {
            setCancelNote("");
            setStatusConfirm(value);
            return;
        }
        void runBusiness(() => changeStatus(lead.id, { status: value, expectedRevision: lead.revision, idempotencyKey: actionKey }));
    }

    function confirmStatus() {
        if (!statusConfirm) return;
        const value = statusConfirm;
        setStatusConfirm(null);
        void runBusiness(() =>
            changeStatus(lead.id, {
                status: value,
                expectedRevision: lead.revision,
                idempotencyKey: actionKey,
                ...(openTask ? { cancelTask: { taskId: openTask.id, reason: cancelNote.trim() || null } } : {}),
            }),
        );
    }

    // Zmena vlastníka ide cez spoločný prechod (§6.10); s otvorenou úlohou sa najprv ukáže, čo sa s ňou stane.
    function pickOwner(value: string | null) {
        if (openTask) {
            setTaskAssignee("");
            setOwnerConfirm(value);
            return;
        }
        void runBusiness(() => changeOwner(lead.id, { ownerId: value, expectedRevision: lead.revision, idempotencyKey: actionKey }));
    }

    function confirmOwner() {
        if (ownerConfirm === undefined) return;
        const value = ownerConfirm;
        setOwnerConfirm(undefined);
        void runBusiness(() =>
            changeOwner(lead.id, {
                ownerId: value,
                expectedRevision: lead.revision,
                idempotencyKey: actionKey,
                ...(taskAssignee ? { taskAssigneeId: taskAssignee } : {}),
            }),
        );
    }

    const ownerTarget = ownerConfirm === undefined ? undefined : ownerConfirm === null ? null : users.find((u) => u.id === ownerConfirm);
    const ownerTargetIsResolver = ownerTarget ? resolvers.some((r) => r.id === ownerTarget.id) : false;

    const interactionTarget: InteractionTarget = {
        id: lead.id,
        number: lead.number,
        name: lead.name,
        phone: lead.phone,
        status: lead.status,
        revision: lead.revision,
        ownerId: lead.owner?.id ?? null,
        noAnswerStreak: lead.noAnswerStreak,
        price: lead.price,
        priceNote: lead.priceNote,
        nextActionKind: lead.nextActionKind,
        nextActionNote: lead.nextActionNote,
        lastOffer: lead.lastOffer,
        lastActivity: lead.lastTouch,
        task: lead.openTask,
        pending: lead.pending,
        clientPrice: lead.offers.lastPrice,
        gotPricelist: lead.offers.offerPricelistAt !== null,
        outstanding: lead.outstanding,
    };

    // Predvyplnenie „Zmeniť krok" z aktuálneho kroku (druh mimo ponuky akčného okna → „Zavolať").
    const replan = (() => {
        const kind = (FOLLOW_UP_NEXT_KINDS as readonly string[]).includes(lead.nextActionKind ?? "")
            ? (lead.nextActionKind as FollowUpNextKind)
            : "CALL";
        const parts =
            lead.nextActionAt && lead.nextActionMode === "SCHEDULED" ? businessInputParts(new Date(lead.nextActionAt)) : { date: "", time: "" };
        return { kind, date: parts.date, time: lead.nextActionHasTime ? parts.time : "", note: lead.nextActionNote ?? "" };
    })();

    function saveCorrection(activityId: string) {
        startTransition(async () => {
            if (report(await correctRecord(lead.id, activityId, correctionReason))) {
                toast.success("Záznam opravený – skontroluj ďalší krok");
                setCorrecting(null);
                setCorrectionReason("");
            }
            router.refresh();
        });
    }

    async function copyDesignLink(id: string, url: string | null, tracked: string | null) {
        if (!url || !tracked) return;
        if (await copyEmailLink(url, tracked)) {
            setCopiedDesign(id);
            setTimeout(() => setCopiedDesign((c) => (c === id ? null : c)), 1500);
        } else toast.error("Schránka nie je dostupná");
    }

    return (
        <>
            <DashboardPageHeader
                backHref="/dashboard/pipeline"
                backLabel="Späť na pipeline"
                title={
                    <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">#{lead.number}</span>
                        <span className="truncate">{lead.name}</span>
                    </span>
                }
                badge={
                    <>
                        <Badge variant="outline">{CLIENT_SECTION_LABEL[lead.section]}</Badge>
                        {isClosed && <Badge variant="secondary">{STATUS_LABEL[lead.status]}</Badge>}
                    </>
                }
                description={
                    lead.handedOffBy
                        ? `Obchod od ${formatDate(lead.pipelineEnteredAt)} · hovor: ${lead.handedOffBy.firstName} ${lead.handedOffBy.lastName}`
                        : `Obchod od ${formatDate(lead.pipelineEnteredAt)}`
                }
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        {caps.manage && (
                            <>
                                <Select
                                    key={`status-${lead.status}-${lead.revision}`}
                                    defaultValue={lead.status}
                                    disabled={busy}
                                    onValueChange={(value) => pickStatus(value as DealStatus)}
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
                                    key={`owner-${lead.owner?.id ?? "none"}-${lead.revision}`}
                                    defaultValue={lead.owner?.id ?? "none"}
                                    disabled={busy}
                                    onValueChange={(value) => pickOwner(value === "none" ? null : value)}
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
                                            <SelectItem key={key} value={key}>
                                                {label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </>
                        )}
                        {caps.manage && !isClosed && !isOwner && (
                            <Button size="sm" variant="outline" onClick={() => setTakingOver(true)}>
                                <UserCheck className="mr-1.5 h-4 w-4" />
                                Preberám klienta
                            </Button>
                        )}
                        {!caps.manage && lead.projectType && (
                            <Badge variant="outline">{PROJECT_TYPE_LABEL[lead.projectType]}</Badge>
                        )}
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
                    {/* HLAVNÝ STĹPEC — priebeh obchodu */}
                    <div className="order-2 space-y-6 lg:order-none lg:col-span-2">
                        <TaskCard
                            lead={lead}
                            caps={caps}
                            viewerId={viewerId}
                            resolvers={resolvers}
                            onAsk={(type) => setAsk(type)}
                            onCancel={() => setInteraction("cancel")}
                            onFinish={(task, send) => setFinish({ task, send })}
                            onTakeover={() => setTakingOver(true)}
                            onSend={editable ? () => setOfferDialog({ historical: false }) : undefined}
                        />

                        {/* Ďalší krok · Naposledy – jedna karta, jedno tlačidlo na záznam kontaktu (round 2 §2d) */}
                        <Card>
                            <CardHeader className="flex items-center justify-between">
                                <CardTitle className="text-base">Ďalší krok · Naposledy</CardTitle>
                                {editable && (
                                    <Button size="sm" onClick={() => setInteraction("contact")}>
                                        <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
                                        Zaznamenať kontakt
                                    </Button>
                                )}
                            </CardHeader>
                            <CardContent className="grid gap-3 sm:grid-cols-2">
                                <div className="space-y-1.5 rounded-lg border p-3 text-sm">
                                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ďalší krok</p>
                                    {lead.nextActionKind ? (
                                        <>
                                            {/* Wave 5 (§3.7): nadpis vymenuje všetko, čo treba poslať; uložený druh kroku
                                                ostáva jedna kategória pre filtre a „Na dnes". */}
                                            <p className="flex items-center gap-1.5 font-medium">
                                                {openTask && <Lock className="h-3.5 w-3.5 text-amber-600" />}
                                                {lead.stepHeadline ?? NEXT_ACTION_LABEL[lead.nextActionKind]}
                                            </p>
                                            {openTask ? (
                                                <p className="text-xs text-amber-700 dark:text-amber-400">⏳ čaká na {openTask.assignee.firstName}</p>
                                            ) : (
                                                <UrgencyLabel at={lead.nextActionAt} hasTime={lead.nextActionHasTime} mode={lead.nextActionMode} />
                                            )}
                                            {lead.nextActionNote && (
                                                <p className="whitespace-pre-wrap text-muted-foreground">{lead.nextActionNote}</p>
                                            )}
                                        </>
                                    ) : (
                                        <p className="text-muted-foreground">Bez ďalšieho kroku.</p>
                                    )}
                                    {lead.askWarning && (
                                        <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                            {lead.askWarning}
                                        </p>
                                    )}
                                    <OutstandingChecklist rows={lead.outstandingRows} maker={openTask?.assignee.firstName ?? null} />
                                    {lead.pendingText && (
                                        <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{lead.pendingText}</p>
                                    )}
                                    {canReplan && (
                                        <Button size="sm" variant="ghost" className="-ml-2 h-7" onClick={() => setInteraction(openTask ? "cancel" : "replan")}>
                                            <Pencil className="mr-1.5 h-3.5 w-3.5" />
                                            {openTask ? "Zmeniť krok (zruší úlohu)" : "Zmeniť krok"}
                                        </Button>
                                    )}
                                </div>
                                <div className="space-y-1.5 rounded-lg border p-3 text-sm">
                                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Naposledy</p>
                                    {lead.lastTouch ? (
                                        <>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-medium">{ACTIVITY_LABEL[lead.lastTouch.type]}</span>
                                                {lead.lastTouch.outcome && (
                                                    <span className="text-xs text-muted-foreground">{OUTCOME_LABEL[lead.lastTouch.outcome]}</span>
                                                )}
                                                {lead.noAnswerStreak > 1 && (
                                                    <Badge variant="outline" className="font-normal">
                                                        {lead.noAnswerStreak}. pokus
                                                    </Badge>
                                                )}
                                            </div>
                                            <p className="text-xs text-muted-foreground tabular-nums">{formatDateTime(lead.lastTouch.at)}</p>
                                            {lead.lastTouch.note && (
                                                <p className="whitespace-pre-wrap text-muted-foreground">{lead.lastTouch.note}</p>
                                            )}
                                        </>
                                    ) : (
                                        <p className="text-muted-foreground">Zatiaľ žiadny kontakt.</p>
                                    )}
                                    {/* Čo sme poslali naposledy ostáva viditeľné aj po ďalšom hovore (round 2 §2d). */}
                                    {lead.lastOffer && lead.lastTouch?.type !== "OFFER_SENT" && (
                                        <p className="border-t pt-1.5 text-xs text-muted-foreground">
                                            Odoslané: <span className="text-foreground">{lead.lastOffer.text}</span> ·{" "}
                                            {formatDate(lead.lastOffer.at)}
                                        </p>
                                    )}
                                </div>
                            </CardContent>
                        </Card>

                        {/* Cena */}
                        <CenovaPonukaCard
                            leadId={lead.id}
                            revision={lead.revision}
                            price={lead.price}
                            priceNote={lead.priceNote}
                            offers={lead.offers}
                            askHistory={lead.askHistory}
                            outstandingRows={lead.outstandingRows}
                            openTaskAssignee={openTask?.assignee.firstName ?? null}
                            mode={api.quoteMode}
                            readOnly={!editable}
                            isManager={caps.manage}
                            onRecord={() => setOfferDialog({ historical: false })}
                            onHistorical={() => setOfferDialog({ historical: true })}
                        />

                        {/* Návrh & sledovanie – správa len pre manažéra, súhrn pre každého */}
                        {caps.manageDesigns ? (
                            <div id="design" className="scroll-mt-20">
                                <DesignTrackingCard
                                    leadId={lead.id}
                                    designs={designs}
                                    priceSent={lead.offers.offerPriceAt !== null}
                                    onRecordSend={editable ? (designId) => setOfferDialog({ historical: false, designId }) : undefined}
                                />
                            </div>
                        ) : (
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-base">Návrh</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2 text-sm">
                                    {lead.designs.length === 0 && <p className="text-muted-foreground">Zatiaľ žiadny návrh.</p>}
                                    {lead.designs.map((d) => (
                                        <div key={d.id} className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium">{d.label ?? "Návrh"}</span>
                                            <span className="text-muted-foreground">
                                                {d.sentAt ? `poslaný ${formatDate(d.sentAt)}` : "neposlaný"}
                                            </span>
                                            {d.sentAt && (
                                                <Badge variant={CONFIDENCE_VARIANT[d.confidence]}>
                                                    {CONFIDENCE_LABEL[d.confidence]}
                                                    {d.views > 0 ? ` · ${d.views}×` : ""}
                                                    {d.lastViewedAt ? ` · naposledy ${fmtAgo(d.lastViewedAt)}` : ""}
                                                </Badge>
                                            )}
                                            {/* Sledovaný odkaz sa nikdy nezobrazuje ako klikateľný – len sa skopíruje hotový do emailu. */}
                                            {d.trackedUrl && d.url && (
                                                <Button size="sm" variant="outline" className="h-7" onClick={() => copyDesignLink(d.id, d.url, d.trackedUrl)}>
                                                    {copiedDesign === d.id ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                                                    Odkaz do emailu
                                                </Button>
                                            )}
                                            {editable && (
                                                <Button size="sm" variant="ghost" className="h-7" onClick={() => setOfferDialog({ historical: false, designId: d.id })}>
                                                    <Send className="mr-1 h-3.5 w-3.5" />
                                                    Odoslané
                                                </Button>
                                            )}
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                        )}

                        {/* Výsledok – zatvorenie/otvorenie robí manažér */}
                        {caps.manage && (
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
                                            {lead.lostReason && <p className="text-sm text-muted-foreground">{lead.lostReason}</p>}
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={busy}
                                                onClick={() => runBusiness(() => reopenDeal(lead.id, { expectedRevision: lead.revision, idempotencyKey: actionKey }))}
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
                                            {openTask && (
                                                <p className="text-xs text-muted-foreground">
                                                    Zruší sa aj otvorená úloha pre {openTask.assignee.firstName} (obchod uzavretý).
                                                </p>
                                            )}
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                disabled={savingLost}
                                                onClick={async () => {
                                                    setSavingLost(true);
                                                    report(
                                                        await markLost(lead.id, {
                                                            reason: lostReason || null,
                                                            expectedRevision: lead.revision,
                                                            idempotencyKey: actionKey,
                                                            ...(openTask ? { cancelTask: { taskId: openTask.id, reason: null } } : {}),
                                                        }),
                                                    );
                                                    setActionKey(newKey());
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
                        )}
                        {!caps.manage && isClosed && (
                            <Card>
                                <CardContent className="pt-6 text-sm text-muted-foreground">
                                    Obchod je uzavretý ({STATUS_LABEL[lead.status]}){lead.lostReason ? ` – ${lead.lostReason}` : ""}. Úpravy robí manažér –
                                    ak ho treba znovu otvoriť, povedz mu.
                                </CardContent>
                            </Card>
                        )}

                        {/* História */}
                        <Card>
                            <CardHeader className="flex items-center justify-between">
                                <CardTitle className="text-base">História</CardTitle>
                                {caps.manage && (
                                    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                                        <Checkbox checked={showAllHistory} onCheckedChange={(value) => setShowAllHistory(value === true)} />
                                        Zobraziť celú históriu
                                    </label>
                                )}
                            </CardHeader>
                            <CardContent>
                                {visibleActivities.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">Zatiaľ žiadny obchodný krok.</p>
                                ) : (
                                    <div>
                                        {visibleActivities.map((activity, index) => (
                                            <div key={activity.id}>
                                                {index > 0 && <Separator />}
                                                <div className={`space-y-1 py-3 text-sm${activity.revertedAt ? " opacity-60" : ""}`}>
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className={`font-medium${activity.revertedAt ? " line-through" : ""}`}>
                                                            {activity.offer?.channel === "PHONE" ? "↳ Cena povedaná v hovore" : ACTIVITY_LABEL[activity.type]}
                                                        </span>
                                                        {activity.offer?.historical && (
                                                            <Badge variant="outline" className="font-normal">
                                                                doplnené spätne
                                                            </Badge>
                                                        )}
                                                        {caps.manage && (
                                                            <span className="text-xs text-muted-foreground">
                                                                {ACTIVITY_SOURCE_LABEL[activity.source]}
                                                                {" · "}
                                                                {ACTIVITY_CATEGORY_LABEL[activity.category]}
                                                            </span>
                                                        )}
                                                        <span className="ml-auto text-xs text-muted-foreground">
                                                            {activity.offer && activity.offer.sentOn !== businessDate(new Date(activity.createdAt))
                                                                ? `poslané ${businessDayMonth(businessDayStart(activity.offer.sentOn))} · zaznamenané `
                                                                : ""}
                                                            {formatDateTime(activity.createdAt)} · {activity.userName}
                                                        </span>
                                                    </div>
                                                    {activity.outcome && (
                                                        <p className="text-xs text-muted-foreground">{OUTCOME_LABEL[activity.outcome]}</p>
                                                    )}
                                                    {activity.note && (
                                                        <p className={`whitespace-pre-wrap text-muted-foreground${activity.revertedAt ? " line-through" : ""}`}>
                                                            {activity.note}
                                                        </p>
                                                    )}
                                                    {activity.revertedAt && (
                                                        <p className="text-xs text-muted-foreground">
                                                            Opravené {formatDateTime(activity.revertedAt)}
                                                            {activity.correctionReason ? ` – ${activity.correctionReason}` : ""}
                                                        </p>
                                                    )}
                                                    {!activity.revertedAt &&
                                                        CORRECTABLE.has(activity.type) &&
                                                        caps.work &&
                                                        (caps.manage || (!isClosed && activity.userId === viewerId)) &&
                                                        (correcting === activity.id ? (
                                                            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                                                                <Input
                                                                    autoFocus
                                                                    value={correctionReason}
                                                                    onChange={(e) => setCorrectionReason(e.target.value)}
                                                                    placeholder="Dôvod opravy (napr. neodoslané, iný obsah)"
                                                                />
                                                                <Button
                                                                    size="sm"
                                                                    variant="destructive"
                                                                    disabled={pending || correctionReason.trim().length < 3}
                                                                    onClick={() => saveCorrection(activity.id)}
                                                                >
                                                                    Prečiarknuť
                                                                </Button>
                                                                <Button size="sm" variant="ghost" onClick={() => setCorrecting(null)}>
                                                                    Zrušiť
                                                                </Button>
                                                            </div>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                                                                onClick={() => {
                                                                    setCorrecting(activity.id);
                                                                    setCorrectionReason("");
                                                                }}
                                                            >
                                                                Opraviť
                                                            </button>
                                                        ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <p className="mt-3 text-xs text-muted-foreground">Pridaný {formatDate(lead.createdAt)}</p>
                            </CardContent>
                        </Card>
                    </div>

                    {/* BOČNÝ STĹPEC — kto je klient */}
                    <div className="order-1 space-y-6 lg:order-none">
                        <Card>
                            <CardHeader className="flex items-center justify-between">
                                <CardTitle className="text-base">Údaje</CardTitle>
                                {editable && !editingData && (
                                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={startEditData} aria-label="Upraviť údaje">
                                        <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                )}
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {!editingData ? (
                                    <div className="@container">
                                        <div className="grid grid-cols-2 gap-4 @lg:grid-cols-4">
                                            <ReadRow label="Firma" value={lead.companyName} />
                                            <ReadRow label="Web" value={lead.website} href={lead.website ? normalizeUrl(lead.website) : null} external />
                                            <ReadRow label="Telefón" value={lead.phone} href={phoneHref} />
                                            <ReadRow label="Email" value={lead.email} href={lead.email ? `mailto:${lead.email}` : null} />
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
                                            <Textarea value={form.note} onChange={(event) => set("note", event.target.value)} />
                                        </div>
                                        <div className="flex gap-2">
                                            <Button size="sm" onClick={saveData} disabled={savingData}>
                                                {savingData ? "Ukladám…" : "Uložiť"}
                                            </Button>
                                            <Button size="sm" variant="ghost" onClick={() => setEditingData(false)}>
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

            {interaction && (
                <InteractionSheet
                    key={`interaction-${lead.revision}-${interaction}`}
                    target={interactionTarget}
                    caps={caps}
                    viewerId={viewerId}
                    replan={interaction === "replan" ? replan : interaction === "cancel" ? { ...replan, cancel: true } : undefined}
                    onClose={() => setInteraction(null)}
                    onRecordOffer={() => {
                        setInteraction(null);
                        setOfferDialog({ historical: false });
                    }}
                    onAsk={(type) => {
                        setInteraction(null);
                        setAsk(type);
                    }}
                />
            )}
            {ask && (
                <AskManagerDialog
                    key={`ask-${lead.revision}-${ask}`}
                    target={{
                        id: lead.id,
                        revision: lead.revision,
                        name: lead.name,
                        status: lead.status,
                        nextActionKind: lead.nextActionKind,
                        nextActionNote: lead.nextActionNote,
                        pending: lead.pending,
                        outstanding: lead.outstanding,
                    }}
                    type={ask}
                    resolvers={resolvers}
                    onClose={() => setAsk(null)}
                />
            )}
            {finish && (
                <FinishTaskDialog
                    key={`finish-${lead.revision}-${finish.task.id}-${finish.send}`}
                    lead={lead}
                    task={finish.task}
                    send={finish.send}
                    onClose={() => setFinish(null)}
                />
            )}
            {takingOver && <TakeoverDialog key={`takeover-${lead.revision}`} lead={lead} onClose={() => setTakingOver(false)} />}
            {statusConfirm && (
                <ResponsiveSheet open onOpenChange={(o) => !o && setStatusConfirm(null)} title={`Stav: ${STATUS_LABEL[statusConfirm]}`}>
                    <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6 text-sm md:max-w-none md:px-0 md:pb-0">
                        {openTask && (
                            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                                Zruší sa otvorená úloha od {openTask.requestedBy.firstName} ({openTask.text}).
                            </p>
                        )}
                        {CLOSED.includes(statusConfirm) && lead.pending.length > 0 && (
                            <p className="text-muted-foreground">Neposlané výsledky ({lead.pendingText}) sa zapíšu ako neposielané – obchod uzavretý.</p>
                        )}
                        {openTask && (
                            <Input value={cancelNote} onChange={(e) => setCancelNote(e.target.value)} placeholder="Dôvod (nepovinné)" />
                        )}
                        <Button className="h-11 w-full" disabled={busy} onClick={confirmStatus}>
                            Potvrdiť
                        </Button>
                    </div>
                </ResponsiveSheet>
            )}
            {ownerConfirm !== undefined && openTask && (
                <ResponsiveSheet
                    open
                    onOpenChange={(o) => !o && setOwnerConfirm(undefined)}
                    title={`Vlastník: ${ownerTarget ? `${ownerTarget.firstName} ${ownerTarget.lastName}` : "nepriradené"}`}
                >
                    <div className="mx-auto w-full max-w-md space-y-3 px-4 pb-6 text-sm md:max-w-none md:px-0 md:pb-0">
                        {ownerTarget === null ? (
                            <p className="rounded-lg border p-3">Úloha sa zruší (obchod bez vlastníka); krok ostane ako bežný krok na dnes.</p>
                        ) : ownerTargetIsResolver ? (
                            <p className="rounded-lg border p-3">
                                {openTask.type === "HANDOVER"
                                    ? "Odovzdanie sa prijme – manažér preberá klienta."
                                    : `Úloha sa zruší (klienta prevezme ${ownerTarget?.firstName}); krok ostane ako jeho bežný krok na dnes.`}
                            </p>
                        ) : (
                            <>
                                <p className="rounded-lg border p-3">Úloha ostáva otvorená a krok zamknutý – nový vlastník ju zdedí.</p>
                                <label className="flex items-center gap-3">
                                    <span className="shrink-0 text-muted-foreground">Úlohy pôjdu</span>
                                    <select
                                        value={taskAssignee}
                                        onChange={(e) => setTaskAssignee(e.target.value)}
                                        className="h-10 flex-1 rounded-md border bg-background px-2"
                                    >
                                        <option value="">{openTask.assignee.firstName} (ostáva)</option>
                                        {resolvers
                                            .filter((r) => r.id !== openTask.assignee.id)
                                            .map((r) => (
                                                <option key={r.id} value={r.id}>
                                                    {r.firstName} {r.lastName}
                                                </option>
                                            ))}
                                    </select>
                                </label>
                            </>
                        )}
                        <Button className="h-11 w-full" disabled={busy} onClick={confirmOwner}>
                            Potvrdiť
                        </Button>
                    </div>
                </ResponsiveSheet>
            )}
            {offerDialog && (
                <OfferSentDialog
                    key={`offer-${lead.revision}-${offerDialog.historical}-${offerDialog.designId ?? ""}`}
                    deal={lead}
                    viewerId={viewerId}
                    isManager={caps.manage}
                    historical={offerDialog.historical}
                    preselectDesignId={offerDialog.designId}
                    onClose={() => setOfferDialog(null)}
                />
            )}
        </>
    );
}

function ReadRow({ label, value, href, external }: { label: string; value: string | null; href?: string | null; external?: boolean }) {
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

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    return (
        <div className="grid gap-1.5">
            <Label>{label}</Label>
            <Input value={value} onChange={(event) => onChange(event.target.value)} />
        </div>
    );
}

// Zoznam toho, čo ešte treba poslať (§3.7). Zelená ✓ patrí len tomu, čo klient naozaj dostal – „pripravené" od
// manažéra nie je „prijaté", preto tu ostáva prázdny krúžok.
function OutstandingChecklist({ rows, maker }: { rows: OutstandingRow[]; maker: string | null }) {
    if (rows.length === 0) return null;
    return (
        <ul className="space-y-0.5 border-t pt-1.5 text-xs text-muted-foreground">
            {rows.map((row) => (
                <li key={row.content}>
                    <span aria-hidden>○</span> <span className="text-foreground">{REQUEST_CONTENT_LABEL[row.content]}</span> –{" "}
                    {outstandingLabel(row, maker)}
                </li>
            ))}
        </ul>
    );
}
