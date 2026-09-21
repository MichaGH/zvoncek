import { z } from "zod";
import prisma from "@/lib/db";
import { Prisma } from "@/app/generated/prisma/client";
import type { AccessUser } from "@/lib/access/user";
import { BUSINESS_TZ } from "@/lib/domain/businessTime";
import { clientSection, isDealOverdue } from "@/lib/domain/clientSections";
import type { DealCapabilities } from "@/lib/domain/dealCapabilities";
import {
    dealScope,
    ownerFilterWhere,
    scopeWhere,
    type DealScope,
    type OwnerFilter,
} from "@/lib/domain/dealScope";
import { DEAL_STEPS, isDealStep, isDealView, viewAllowsStep, viewIgnoresStatus } from "@/lib/domain/dealFilters";
import { businessDaysBetween } from "@/lib/domain/businessTime";
import {
    isStepLocked,
    partMarkLabel,
    pendingSummary,
    helpFallback,
    sortTaskContents,
    taskPartState,
    waitingOnQuestionHeadline,
    TASK_AGE_ALERT_DAYS,
    type PartView,
    type PendingItem,
} from "@/lib/domain/tasks";
import { consumptionByLead, pendingByLead, PART_SELECT } from "@/lib/domain/taskMutations";
import { TASK_CONTENT_LABEL } from "@/lib/dictionaries";
import {
    clientRequestState,
    outstandingContents,
    stepView,
    warningText,
    type ClientRequestState,
    type ManagerWork,
    type RequestHistoryInput,
} from "@/lib/domain/clientRequests";
import { requestsByLead } from "@/lib/domain/requestMutations";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { summarizeEvents, type Confidence } from "@/lib/tracking/confidence";
import { trackedUrl } from "@/lib/domain/designLinks";
import { LAST_TOUCH_TYPES, lastOfferOf, migratedSourceIds, parseOfferMeta, summarizeOffers, type OfferDialogDeal, type OfferRow } from "@/lib/domain/offers";
import type {
    ActivityType,
    CallOutcome,
    DealOwnershipReason,
    DealTaskContent,
    DealTaskType,
    LeadStatus,
    NextActionKind,
    NextActionMode,
    ProjectType,
    RequestContent,
    Role,
} from "@/app/generated/prisma/enums";

// Jediný read model obrazovky obchodov (/dashboard/pipeline) pre všetky roly. Rozsah je VŽDY v dotaze
// (scopeWhere), nikdy len v UI; `owner` je filter v rámci rozsahu. Zoradenie a stránka sa počítajú v SQL
// nad celou filtrovanou množinou (nie až po orezaní strany).

export const DEAL_PAGE_SIZE = 50;

export { DEAL_VIEWS, isDealView, viewIgnoresStatus } from "@/lib/domain/dealFilters";
export type { DealViewKey } from "@/lib/domain/dealFilters";

// Obchod = lead s pozitívnym prvým hovorom (pipelineEnteredAt). Nikdy surové kontakty ani zmazané.
export const DEAL_WHERE = { deletedAt: null, pipelineEnteredAt: { not: null } } satisfies Prisma.LeadWhereInput;

const OPEN_STATUSES = ["ACTIVE", "SNOOZED"] as const;

// Zámok (wave 3 §5.3): obchod má otvorenú úlohu pre manažéra. Prisma podoba a SQL podoba sú to isté pravidlo ako
// isStepLocked() v lib/domain/tasks.ts (paritný test w3LockParity v check-concurrency.ts).
const LOCKED_WHERE = { tasks: { some: { status: "OPEN" } } } satisfies Prisma.LeadWhereInput;
const UNLOCKED_WHERE = { tasks: { none: { status: "OPEN" } } } satisfies Prisma.LeadWhereInput;
export const STEP_LOCKED_SQL = Prisma.sql`EXISTS (SELECT 1 FROM "DealTask" t WHERE t."leadId" = l.id AND t.status = 'OPEN')`;

// Pravidlo pilulky nad Lead stĺpcami (bez rozsahu a filtrov – tie pridáva pillFilter).
function viewWhere(view?: string): Prisma.LeadWhereInput {
    switch (view) {
        case "work":
            // Pracovný rad po prvých hovoroch: klientovi ešte niečo dlžíme a vlastník na tom vie konať teraz.
            // Zdroj pravdy je LeadRequest (nie druh kroku), preto sem patrí aj SEND_DESIGN / IN_PROGRESS. Otvorená
            // manažérska úloha ho presunie do samostatného pohľadu „Čakám na manažéra".
            return { status: "ACTIVE", requests: { some: { state: "OPEN" } }, ...UNLOCKED_WHERE };
        case "today":
            return { status: { in: [...OPEN_STATUSES] } }; // presné pravidlo dopĺňa TODAY_SQL v SQL časti
        case "got_pricelist":
            return { offerPricelistAt: { not: null } };
        case "got_price":
            return { offerPriceAt: { not: null } };
        case "got_design":
            return { OR: [{ designs: { some: { deletedAt: null, sentAt: { not: null } } } }, { designSentAt: { not: null } }] };
        case "waiting_manager":
            return { status: { in: [...OPEN_STATUSES] }, ...LOCKED_WHERE };
        default:
            return {};
    }
}

// Úroveň 2 filtra: druh ďalšieho kroku. Zamknutý obchod krok nemá (je v „Čakám na manažéra"), preto ho nezahŕňa.
// „Poslať návrh" je krok SEND_DESIGN – rozpracovanie u manažéra je samostatný rad „Čakám na manažéra".
const STEP_KIND_OF: Record<string, NextActionKind> = {
    call: "CALL",
    quote: "SEND_QUOTE",
    design: "SEND_DESIGN",
    email: "SEND_EMAIL",
    waiting: "WAITING_FOR_CLIENT",
};
function stepWhere(step: string): Prisma.LeadWhereInput {
    return { nextActionKind: STEP_KIND_OF[step], ...UNLOCKED_WHERE };
}

function searchWhere(q: string): Prisma.LeadWhereInput {
    return {
        OR: [
            { companyName: { contains: q, mode: "insensitive" } },
            { website: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { email: { contains: q, mode: "insensitive" } },
        ],
    };
}

// Rozsah používateľa. Tímová vetva si dotiahne členov tímu; „own"/„all" nepotrebujú dotaz.
export async function getDealScope(viewer: Pick<AccessUser, "id" | "role" | "teamId">): Promise<DealScope> {
    const shallow = dealScope(viewer);
    if (shallow.kind !== "team") return shallow;
    const members = await prisma.user.findMany({
        where: { teamId: shallow.teamId, deletedAt: null },
        select: { id: true },
    });
    return dealScope(viewer, members.map((m) => m.id));
}

// ── SQL fragmenty ────────────────────────────────────────────────────────────

// Zrkadlo nextActionSort (lib/overdue.ts): 0 urgentné (po termíne / dnes / do 30 min), 1 rozpracované,
// 2 budúce, 3 krok bez dátumu (aj zamknutý krok – radí sa s „Čaká"), 4 žiadny krok. Deň-only porovnáva obchodný
// dátum v Europe/Bratislava.
const DEAL_RANK_SQL = Prisma.sql`CASE
    WHEN ${STEP_LOCKED_SQL} THEN 3
    WHEN l."nextActionKind" IS NULL THEN 4
    WHEN l."nextActionMode" = 'IN_PROGRESS' THEN 1
    WHEN l."nextActionAt" IS NULL THEN 3
    WHEN l."nextActionHasTime" AND l."nextActionAt" > (now() AT TIME ZONE 'UTC') + interval '30 minutes' THEN 2
    WHEN NOT l."nextActionHasTime"
         AND ((l."nextActionAt" AT TIME ZONE 'UTC') AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date
             > (now() AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date THEN 2
    ELSE 0
END`;

// Zrkadlo isDueByBusinessDay: s časom = okamih padne do dnešného obchodného dňa; deň-only = dátum <= dnes.
const DUE_SQL = Prisma.sql`(
    CASE WHEN l."nextActionHasTime"
        THEN l."nextActionAt" < (((date_trunc('day', now() AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}') + interval '1 day')
             AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}') AT TIME ZONE 'UTC')
        ELSE ((l."nextActionAt" AT TIME ZONE 'UTC') AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date
             <= (now() AT TIME ZONE '${Prisma.raw(BUSINESS_TZ)}')::date
    END)`;

// Zrkadlo clientSection() pre sekciu TODAY (pozri check-client-sections.ts a paritný test v check-concurrency.ts):
// otvorený obchod bez zamknutého kroku, ktorý treba riešiť dnes – vrátane „bez kroku", „bez termínu" a „zobudený".
const TODAY_SQL = Prisma.sql`(
    l."status" IN ('ACTIVE','SNOOZED')
    AND NOT ${STEP_LOCKED_SQL}
    AND (
        (l."status" = 'SNOOZED' AND (l."nextActionAt" IS NULL OR ${DUE_SQL}))
        OR (l."status" = 'ACTIVE' AND (
                l."nextActionKind" IS NULL
                OR (l."nextActionMode" <> 'IN_PROGRESS' AND (
                        (l."nextActionKind" = 'WAITING_FOR_CLIENT' AND l."nextActionAt" IS NOT NULL AND ${DUE_SQL})
                        OR (l."nextActionKind" <> 'WAITING_FOR_CLIENT'
                            AND (l."nextActionAt" IS NULL OR ${DUE_SQL}))
                   ))
           ))
    ))`;

// ── Zoznam ───────────────────────────────────────────────────────────────────

type DealLead = {
    id: string;
    number: number;
    companyName: string | null;
    website: string | null;
    phone: string | null;
    status: LeadStatus;
    revision: number;
    projectType: ProjectType | null;
    nextActionKind: NextActionKind | null;
    nextActionAt: Date | null;
    nextActionHasTime: boolean;
    nextActionMode: NextActionMode;
    nextActionNote: string | null;
    closedAt: Date | null;
    price: { toString(): string } | null;
    priceNote: string | null;
    offerAboutUsAt: Date | null;
    offerPricelistAt: Date | null;
    offerPriceAt: Date | null;
    offerReviewAt: Date | null;
    designs: { id: string; label: string | null; targetUrl: string | null; sentAt: Date | null; tracker: { token: string } | null }[];
    designSentAt: Date | null;
    _count: { designs: number };
    owner: { id: string; firstName: string } | null;
    handedOffBy: { firstName: string; lastName: string } | null;
    activities: { type: ActivityType; outcome: CallOutcome | null; note: string | null; createdAt: Date }[];
};

// Otvorená úloha na riadku zoznamu (zámok, „⏳ čaká na Michala (2 dni)", „💬 Posledná správa: Jana").
// Wave 4: `contents` je všetko, čo úloha nesie, `openKinds` len to, čo sa ešte robí – a `progress` je jedna veta
// o tom, ako ďaleko je („Cena ✓ · Návrh robí sa").
export type RowTask = {
    id: string;
    type: DealTaskType;
    contents: DealTaskContent[];
    openKinds: DealTaskContent[];
    progress: string | null;
    text: string;
    assigneeId: string;
    assignee: string;
    // Kam sa krok vráti po zatvorení úlohy (P6) – dialóg „Čo sme poslali“ podľa toho pomenuje „Ponechať“.
    fallbackKind: NextActionKind;
    requestedBy: string;
    createdAt: string;
    ageDays: number;
    overdue: boolean; // vek po TASK_AGE_ALERT_DAYS obchodných dňoch – červený v „Pre mňa"
    lastMessageBy: string | null;
};

// „Naposledy" = posledný skutočný kontakt: bez prečiarknutých záznamov, bez ceny povedanej v hovore (tá je súčasťou
// toho hovoru) a bez spätne doplnených starých odoslaní (round 2 §2c 5.3, 5.7).
const LAST_TOUCH_WHERE = {
    type: { in: [...LAST_TOUCH_TYPES] },
    revertedAt: null,
    NOT: [
        { type: "OFFER_SENT" as const, meta: { path: ["channel"], equals: "PHONE" } },
        { type: "OFFER_SENT" as const, meta: { path: ["historical"], equals: true } },
    ],
} satisfies Prisma.ActivityWhereInput;

const LIST_SELECT = {
    id: true,
    number: true,
    companyName: true,
    website: true,
    phone: true,
    status: true,
    revision: true,
    projectType: true,
    nextActionKind: true,
    nextActionAt: true,
    nextActionHasTime: true,
    nextActionMode: true,
    nextActionNote: true,
    closedAt: true,
    price: true,
    priceNote: true,
    offerAboutUsAt: true,
    offerPricelistAt: true,
    offerPriceAt: true,
    offerReviewAt: true,
    designSentAt: true,
    _count: { select: { designs: true } }, // aj zmazané – obchod bez jediného návrhu = starý údaj z Lead.designSentAt
    // Návrhy pre dialóg „Čo sme poslali" otváraný priamo zo zoznamu (round 2 §2d) + ikonka „dostali návrh".
    designs: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" as const },
        select: { id: true, label: true, targetUrl: true, sentAt: true, tracker: { select: { token: true } } },
    },
    owner: { select: { id: true, firstName: true } },
    handedOffBy: { select: { firstName: true, lastName: true } },
    activities: {
        where: LAST_TOUCH_WHERE,
        orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
        take: 1,
        select: { type: true, outcome: true, note: true, createdAt: true },
    },
} satisfies Prisma.LeadSelect;

// Koľko hovorov po sebe (od najnovšieho) skončilo „nezdvihli". Zobrazuje sa ako „3. pokus" –
// bez toho nie je z riadku vidno, že sa už dvakrát volalo (round 2, D-05). Poradie (createdAt, id) a „iný než
// NO_ANSWER" vrátane prázdneho výsledku – rovnako ako detail (R02-3).
async function noAnswerStreaks(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.$queryRaw<{ leadId: string; streak: bigint }[]>`
        WITH calls AS (
            SELECT a."leadId",
                   a.outcome,
                   row_number() OVER (PARTITION BY a."leadId" ORDER BY a."createdAt" DESC, a.id DESC) AS rn
              FROM "Activity" a
             WHERE a."leadId" = ANY(${ids}) AND a.type IN ('CALL', 'CLIENT_REPLIED') AND a."revertedAt" IS NULL
        )
        SELECT "leadId",
               (COALESCE(min(rn) FILTER (WHERE outcome IS DISTINCT FROM 'NO_ANSWER'), max(rn) + 1) - 1)::bigint AS streak
          FROM calls
         GROUP BY "leadId"`;
    return new Map(rows.map((r) => [r.leadId, Number(r.streak)]));
}

// Posledné odoslanie pre každý obchod na strane (jeden dotaz) + cena, ktorú klient naposledy naozaj videl (§3.3).
export type LastOffer = { text: string; at: string; clientPrice: { amount: string; channel: "EMAIL" | "PHONE"; via?: "SMS"; sentOn: string } | null };

async function lastOffers(ids: string[]): Promise<Map<string, LastOffer>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.activity.findMany({
        where: { leadId: { in: ids }, type: "OFFER_SENT", revertedAt: null },
        select: { id: true, leadId: true, createdAt: true, revertedAt: true, meta: true },
    });
    const byLead = new Map<string, OfferRow[]>();
    for (const r of rows) {
        const meta = parseOfferMeta(r.meta);
        if (!meta) continue;
        const list = byLead.get(r.leadId) ?? [];
        list.push({ id: r.id, createdAt: r.createdAt, revertedAt: r.revertedAt, meta });
        byLead.set(r.leadId, list);
    }
    const out = new Map<string, LastOffer>();
    for (const [leadId, list] of byLead) {
        const last = lastOfferOf(list);
        const price = summarizeOffers(list).lastPrice;
        if (last || price) {
            out.set(leadId, {
                text: last?.text ?? "",
                at: last?.at ?? "",
                clientPrice: price ? { amount: price.amount, channel: price.channel, ...(price.via ? { via: price.via } : {}), sentOn: price.sentOn } : null,
            });
        }
    }
    return out;
}

// Otvorené úlohy pre obchody na strane (jeden dotaz) + kto napísal poslednú správu.
async function openTasksFor(ids: string[], now: Date): Promise<Map<string, RowTask>> {
    if (ids.length === 0) return new Map();
    const tasks = await prisma.dealTask.findMany({
        where: { leadId: { in: ids }, status: "OPEN" },
        select: {
            id: true,
            leadId: true,
            type: true,
            status: true,
            text: true,
            createdAt: true,
            assigneeId: true,
            fallbackKind: true,
            fallbackNote: true,
            assignee: { select: { firstName: true } },
            requestedBy: { select: { firstName: true } },
            parts: { select: PART_SELECT },
            activities: {
                where: { type: "TASK_MESSAGE" },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: 1,
                select: { user: { select: { firstName: true } } },
            },
        },
    });
    const consumed = tasks.length ? await consumptionByLead(prisma, [...new Set(tasks.map((t) => t.leadId))]) : new Map();
    return new Map(
        tasks.map((t) => {
            const ageDays = Math.max(0, businessDaysBetween(t.createdAt, now));
            const state = taskPartState(t, t.parts, consumed.get(t.leadId) ?? []);
            return [
                t.leadId,
                {
                    id: t.id,
                    type: t.type,
                    // Čo úloha nesie, je odteraz výlučne v jej častiach (S-13b) – žiadna druhá kópia.
                    contents: sortTaskContents(t.parts.map((x) => x.kind)),
                    openKinds: state.openKinds,
                    progress: taskProgress(state.parts),
                    text: t.text,
                    assigneeId: t.assigneeId,
                    assignee: t.assignee.firstName,
                    fallbackKind: helpFallback({ kind: t.fallbackKind, note: t.fallbackNote }).kind,
                    requestedBy: t.requestedBy.firstName,
                    createdAt: t.createdAt.toISOString(),
                    ageDays,
                    overdue: ageDays >= TASK_AGE_ALERT_DAYS,
                    lastMessageBy: t.activities[0]?.user.firstName ?? null,
                },
            ];
        }),
    );
}

// Čo klient pýta / čo sa robí / čo je pripravené – jedna projekcia pre riadok aj detail (§6.9), aby zoznam a detail
// nikdy nepopisovali inú prácu.
function requestViewOf(
    requests: RequestHistoryInput[],
    work: ManagerWork,
    stepKind: NextActionKind | null,
    task: { type: DealTaskType; openKinds: readonly DealTaskContent[]; assignee: string } | null = null,
): { state: ClientRequestState; outstanding: ReturnType<typeof outstandingContents>; headline: string | null; warning: string | null } {
    const state = clientRequestState(requests, work);
    const outstanding = outstandingContents(state);
    const view = stepView(stepKind, outstanding);
    // R02-1: zostala len otázka / konzultácia – nie „Poslať …“ ani konajúci „Zavolať“, ale na koho sa čaká.
    const waiting = waitingOnQuestionHeadline(task, outstanding, work.prepared);
    return { state, outstanding, headline: waiting ?? view.headline, warning: warningText(view.warn) };
}

// Otvorené požiadavky klienta po riadkoch – odloženie / uzavretie ich stiahne PRESNE menovanými id (R01-3).
function openRequestsOf(state: ClientRequestState): { id: string; content: RequestContent }[] {
    return state.outstanding.flatMap((o) => o.openIds.map((id) => ({ id, content: o.content })));
}

// „Cena ✓ · Návrh robí sa" – jedna veta na riadok zoznamu aj do schránky manažéra.
function taskProgress(parts: readonly PartView[]): string | null {
    if (parts.length === 0) return null;
    return parts.map((p) => `${TASK_CONTENT_LABEL[p.kind]} ${partMarkLabel(p)}`).join(" · ");
}

function managerWorkOfRow(task: RowTask | null, pending: PendingItem[]): ManagerWork {
    return {
        // Wave 4: „robí sa" sú len časti, ktoré manažér ešte má – dodaná cena už patrí do „pripravené".
        making: task && task.type === "HELP" ? task.openKinds : [],
        prepared: pending.filter((i) => i.kind === "PRICE" || i.kind === "DESIGN"),
    };
}

function toDealRow(
    lead: DealLead,
    now: Date,
    noAnswerStreak = 0,
    lastOffer: LastOffer | null = null,
    task: RowTask | null = null,
    pending: PendingItem[] = [],
    requests: RequestHistoryInput[] = [],
) {
    const locked = isStepLocked(task ? [{ status: "OPEN" }] : []);
    const view = requestViewOf(requests, managerWorkOfRow(task, pending), lead.nextActionKind, task);
    const cls = clientSection(
        {
            status: lead.status,
            nextActionKind: lead.nextActionKind,
            nextActionAt: lead.nextActionAt,
            nextActionHasTime: lead.nextActionHasTime,
            nextActionMode: lead.nextActionMode,
            closedAt: lead.closedAt,
            stepLocked: locked,
        },
        now,
    );
    const last = lead.activities[0];
    return {
        id: lead.id,
        number: lead.number,
        name: lead.companyName ?? lead.website ?? "—",
        phone: lead.phone,
        status: lead.status,
        revision: lead.revision,
        projectType: lead.projectType,
        section: cls.section,
        badge: cls.badge ?? null,
        overdue: isDealOverdue(lead, now),
        nextActionKind: lead.nextActionKind,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        nextActionHasTime: lead.nextActionHasTime,
        nextActionMode: lead.nextActionMode,
        nextActionNote: lead.nextActionNote,
        closedAt: lead.closedAt?.toISOString() ?? null,
        price: lead.price ? Number(lead.price) : null,
        gotPricelist: lead.offerPricelistAt !== null,
        gotPrice: lead.offerPriceAt !== null,
        hasDesignSent: legacyAwareDesignSentAt(lead) !== null,
        ownerId: lead.owner?.id ?? null,
        owner: lead.owner?.firstName ?? null,
        handedOffBy: lead.handedOffBy ? `${lead.handedOffBy.firstName} ${lead.handedOffBy.lastName}`.trim() : null,
        locked,
        task,
        pending,
        pendingText: pendingSummary(pending),
        // Wave 5: „Poslať návrh + cenu" namiesto holého druhu kroku; varovanie len pre to, čo krok nepokrýva (§6.9a).
        stepHeadline: view.headline,
        askWarning: view.warning,
        outstanding: view.outstanding,
        openRequests: openRequestsOf(view.state),
        lastActivity: last
            ? { type: last.type, outcome: last.outcome, note: last.note, at: last.createdAt.toISOString() }
            : null,
        noAnswerStreak,
        lastOffer: lastOffer && lastOffer.at ? { text: lastOffer.text, at: lastOffer.at } : null,
        clientPrice: lastOffer?.clientPrice ?? null,
        dialog: {
            ...offerDialogOf(lead),
            openTask: task ? { id: task.id, type: task.type, contents: task.contents, openKinds: task.openKinds, assignee: task.assignee, fallbackKind: task.fallbackKind } : null,
            pending,
            asked: view.state.outstanding.filter((o) => o.openIds.length > 0).map((o) => o.content),
            outstanding: view.outstanding,
        },
    };
}

export type DealRow = ReturnType<typeof toDealRow>;

// Posledný poslaný návrh; obchod, ktorý nemá ani jeden Design riadok (návrhy spred modelu Design), berie starý
// Lead.designSentAt – inak by sa odoslaný návrh tváril ako „neposlaný".
function legacyAwareDesignSentAt(lead: {
    designs: { sentAt: Date | null }[];
    designSentAt: Date | null;
    _count: { designs: number };
}): Date | null {
    const fromRows = lead.designs.reduce<Date | null>((max, d) => (d.sentAt && (!max || d.sentAt > max) ? d.sentAt : max), null);
    // R02-2: Lead.designSentAt je najnovší platný dátum zo sledovaných návrhov AJ z odoslaní bez Design riadku, takže
    // sa berie vždy a vyhráva novší – inak by obchod s neposlaným Designom zabudol na návrh poslaný mimo systému.
    if (fromRows && lead.designSentAt) return fromRows > lead.designSentAt ? fromRows : lead.designSentAt;
    return fromRows ?? lead.designSentAt ?? null;
}

function offerDialogOf(lead: DealLead): OfferDialogDeal {
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    const designSentAt = legacyAwareDesignSentAt(lead);
    return {
        id: lead.id,
        revision: lead.revision,
        owner: lead.owner,
        price: lead.price != null ? Number(lead.price) : null,
        priceNote: lead.priceNote,
        nextActionKind: lead.nextActionKind,
        nextActionAt: iso(lead.nextActionAt),
        openTask: null,
        pending: [],
        asked: [],
        outstanding: [],
        offers: {
            offerAboutUsAt: iso(lead.offerAboutUsAt),
            offerPricelistAt: iso(lead.offerPricelistAt),
            offerPriceAt: iso(lead.offerPriceAt),
            offerReviewAt: iso(lead.offerReviewAt),
            designSentAt: iso(designSentAt),
        },
        designs: lead.designs.map((d) => ({
            id: d.id,
            label: d.label,
            url: d.targetUrl,
            trackedUrl: d.targetUrl && d.tracker?.token ? trackedUrl(d.targetUrl, d.tracker.token) : null,
            sentAt: iso(d.sentAt),
        })),
    };
}

export type DealListParams = {
    scope: DealScope;
    owner: OwnerFilter;
    status?: LeadStatus;
    query?: string;
    view?: string;
    step?: string; // úroveň 2 – druh kroku, skladá sa s `view`
    handedOffBy?: string;
    viewerId?: string; // „Pre mňa" = úlohy pridelené tomuto používateľovi
    take?: number;
};

function baseWhere(params: Pick<DealListParams, "scope" | "owner" | "handedOffBy" | "query">): Prisma.LeadWhereInput {
    const q = params.query?.trim();
    return {
        ...DEAL_WHERE,
        ...scopeWhere(params.scope),
        ...ownerFilterWhere(params.owner),
        ...(params.handedOffBy ? { handedOffById: params.handedOffBy } : {}),
        ...(q ? searchWhere(q) : {}),
    };
}

type PillFilter = { where: Prisma.LeadWhereInput; sql: Prisma.Sql | null; order: "rank" | "task" };

// JEDEN predikát na pilulku (wave 3 §7) – zoznam aj počet volajú túto funkciu s tými istými vstupmi, takže sa nemôžu
// rozísť. Čo pilulka ignoruje:
//   „Pre mňa"            – všetko okrem hľadania (schránka, nie výsek mojich obchodov; rozsah ostáva)
//   „Čakám na manažéra"  – stav a „Od:" (všetky otvorené stavy)
//   „Na spracovanie", „Na dnes", „Neoverené" – stav (naprieč stavmi)
// Pilulky podľa druhu kroku nezahŕňajú zamknuté obchody (§5.3).
function pillFilter(view: string | undefined, params: Omit<DealListParams, "view" | "take">): PillFilter {
    // Stará pilulka druhu kroku (`view: "call"`) je „Všetko + krok" – rovnaký predikát ako úroveň 2.
    const legacyStep = isDealStep(view) ? view : undefined;
    const v = legacyStep ? undefined : isDealView(view) ? view : undefined;
    const step = viewAllowsStep(v) ? (legacyStep ?? (isDealStep(params.step) ? params.step : undefined)) : undefined;
    const q = params.query?.trim();
    if (v === "inbox") {
        return {
            where: {
                ...DEAL_WHERE,
                ...scopeWhere(params.scope),
                ...(q ? searchWhere(q) : {}),
                tasks: { some: { status: "OPEN", assigneeId: params.viewerId ?? "__none__" } },
            },
            sql: null,
            order: "task",
        };
    }
    const base =
        v === "waiting_manager"
            ? { ...DEAL_WHERE, ...scopeWhere(params.scope), ...ownerFilterWhere(params.owner), ...(q ? searchWhere(q) : {}) }
            : baseWhere(params);
    return {
        where: {
            ...base,
            ...(params.status && !viewIgnoresStatus(v) ? { status: params.status } : {}),
            ...viewWhere(v),
            ...(step ? stepWhere(step) : {}),
        },
        sql: v === "today" ? TODAY_SQL : null,
        order: "rank",
    };
}

async function matchingIds(filter: PillFilter): Promise<string[]> {
    const matching = await prisma.lead.findMany({ where: filter.where, select: { id: true } });
    const ids = matching.map((m) => m.id);
    if (!filter.sql || ids.length === 0) return ids;
    const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT l.id FROM "Lead" l WHERE l.id = ANY(${ids}) AND ${filter.sql}`;
    return rows.map((r) => r.id);
}

export async function getDealList(params: DealListParams): Promise<{ rows: DealRow[]; hasMore: boolean }> {
    const take = params.take && params.take > 0 ? params.take : DEAL_PAGE_SIZE;
    const filter = pillFilter(params.view, params);
    const ids = await matchingIds(filter);
    if (ids.length === 0) return { rows: [], hasMore: false };

    // Filtre ostávajú v Prisma (len id), poradie + stránka v SQL nad celou množinou.
    const ordered =
        filter.order === "task"
            ? await prisma.$queryRaw<{ id: string }[]>`
            SELECT l.id FROM "Lead" l
             WHERE l.id = ANY(${ids})
             ORDER BY (SELECT min(t."createdAt") FROM "DealTask" t WHERE t."leadId" = l.id AND t.status = 'OPEN') ASC NULLS LAST, l.id
             LIMIT ${take + 1}`
            : await prisma.$queryRaw<{ id: string }[]>`
            SELECT l.id FROM "Lead" l
             WHERE l.id = ANY(${ids})
             ORDER BY ${DEAL_RANK_SQL}, l."nextActionAt" ASC NULLS LAST, l.id
             LIMIT ${take + 1}`;
    const hasMore = ordered.length > take;
    const pageIds = ordered.slice(0, take).map((o) => o.id);
    if (pageIds.length === 0) return { rows: [], hasMore: false };

    const now = new Date();
    const [leads, streaks, offers, tasks, pending, requests] = await Promise.all([
        // Rozsah znova aj tu: obchod presunutý medzi prvým a druhým dotazom sa nezobrazí.
        prisma.lead.findMany({ where: { id: { in: pageIds }, ...DEAL_WHERE, ...scopeWhere(params.scope) }, select: LIST_SELECT }),
        noAnswerStreaks(pageIds),
        lastOffers(pageIds),
        openTasksFor(pageIds, now),
        pendingByLead(prisma, pageIds),
        requestsByLead(prisma, pageIds),
    ]);
    const byId = new Map(leads.map((l) => [l.id, l]));
    const rows = pageIds
        .map((id) => byId.get(id))
        .filter((l): l is (typeof leads)[number] => Boolean(l))
        .map((l) =>
            toDealRow(
                l,
                now,
                streaks.get(l.id) ?? 0,
                offers.get(l.id) ?? null,
                tasks.get(l.id) ?? null,
                pending.get(l.id) ?? [],
                requests.get(l.id) ?? [],
            ),
        );
    return { rows, hasMore };
}

export const COUNTED_VIEWS = [
    "work",
    "today",
    "all",
    "call",
    "quote",
    "email",
    "design",
    "waiting",
    "got_pricelist",
    "got_price",
    "got_design",
    "waiting_manager",
    "inbox",
] as const;
export type DealCounts = Record<(typeof COUNTED_VIEWS)[number], number> & { open: number; unassignedOpen: number };

// Počty do pilulek – tie isté vstupy a ten istý predikát ako zoznam, takže číslo sedí s tým, čo klik ukáže (§7).
export async function getDealCounts(params: Omit<DealListParams, "view" | "take" | "step">): Promise<DealCounts> {
    const counted = await Promise.all(
        COUNTED_VIEWS.map(async (v) => [v, (await matchingIds(pillFilter(v === "all" ? undefined : v, params))).length] as const),
    );
    const [open, unassignedOpen] = await Promise.all([
        prisma.lead.count({ where: { ...baseWhere(params), status: { in: [...OPEN_STATUSES] } } }),
        params.scope.kind === "all"
            ? prisma.lead.count({ where: { ...DEAL_WHERE, ownerId: null, status: { in: [...OPEN_STATUSES] } } })
            : Promise.resolve(0),
    ]);
    return { ...(Object.fromEntries(counted) as Record<(typeof COUNTED_VIEWS)[number], number>), open, unassignedOpen };
}

// Počty úrovne 2: koľko obchodov má daný druh kroku V AKTUÁLNOM RADE (`view`) a pri aktuálnych filtroch. `all` = rad bez kroku.
export type DealStepCounts = Record<"all" | (typeof DEAL_STEPS)[number]["key"], number>;
export async function getDealStepCounts(params: Omit<DealListParams, "view" | "take" | "step">, view: string | undefined): Promise<DealStepCounts> {
    const withStep = async (step?: string) => (await matchingIds(pillFilter(view, { ...params, step }))).length;
    const [all, ...rest] = await Promise.all([withStep(), ...DEAL_STEPS.map((s) => withStep(s.key))]);
    return { all, ...Object.fromEntries(DEAL_STEPS.map((s, i) => [s.key, rest[i]])) } as DealStepCounts;
}

// ── Detail ───────────────────────────────────────────────────────────────────

export async function getDealDetail(
    id: string,
    scope: DealScope,
    caps: Pick<DealCapabilities, "manage">,
) {
    const lead = await prisma.lead.findFirst({
        where: { id, ...DEAL_WHERE, ...scopeWhere(scope) },
        include: {
            owner: { select: { id: true, firstName: true, lastName: true } },
            handedOffBy: { select: { firstName: true, lastName: true } },
            _count: { select: { designs: true } },
            activities: {
                // Obchodník vidí obchodné kroky; audit (zmeny vlastníka, priradenia) je manažérska vec.
                where: caps.manage ? {} : { category: "BUSINESS" },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                include: { user: { select: { firstName: true } } },
            },
            tasks: {
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                include: {
                    requestedBy: { select: { id: true, firstName: true, lastName: true } },
                    assignee: { select: { id: true, firstName: true, lastName: true } },
                    closedBy: { select: { id: true, firstName: true, lastName: true } },
                    parts: { select: PART_SELECT },
                },
            },
            designs: {
                where: { deletedAt: null },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    label: true,
                    targetUrl: true,
                    currentVersion: true,
                    sentAt: true,
                    tracker: {
                        select: {
                            token: true,
                            events: {
                                select: { type: true, versionAtView: true, botFlag: true, durationMs: true, occurredAt: true },
                            },
                        },
                    },
                },
            },
        },
    });
    if (!lead) return null;
    const now = new Date();
    const stepLocked = isStepLocked(lead.tasks);
    const cls = clientSection({ ...lead, stepLocked }, now);
    const pending = (await pendingByLead(prisma, [lead.id])).get(lead.id) ?? [];
    const consumption = (await consumptionByLead(prisma, [lead.id])).get(lead.id) ?? [];
    // Wave 4: každá úloha sa číta cez JEDNU projekciu – karta, zoznam aj server hovoria o častiach to isté (§2.5).
    const partStates = new Map(lead.tasks.map((t) => [t.id, taskPartState(t, t.parts, consumption)]));
    const openTask = lead.tasks.find((t) => t.status === "OPEN") ?? null;
    const requests = (await requestsByLead(prisma, [lead.id])).get(lead.id) ?? [];
    const requestView = requestViewOf(
        requests,
        {
            making: openTask && openTask.type === "HELP" ? (partStates.get(openTask.id)?.openKinds ?? []) : [],
            prepared: pending.filter((i) => i.kind === "PRICE" || i.kind === "DESIGN"),
        },
        lead.nextActionKind,
        openTask && openTask.type === "HELP"
            ? { type: openTask.type, openKinds: partStates.get(openTask.id)?.openKinds ?? [], assignee: openTask.assignee.firstName }
            : null,
    );
    let noAnswerStreak = 0;
    for (const a of lead.activities) {
        if ((a.type !== "CALL" && a.type !== "CLIENT_REPLIED") || a.revertedAt) continue;
        if (a.outcome !== "NO_ANSWER") break;
        noAnswerStreak++;
    }

    // Čo klient dostal: súhrn z platných OFFER_SENT (posledná poslaná cena ako kotva) + staré údaje len ako „?".
    const offerRows: OfferRow[] = [];
    for (const a of lead.activities) {
        if (a.type !== "OFFER_SENT") continue;
        const meta = parseOfferMeta(a.meta);
        if (meta) offerRows.push({ id: a.id, createdAt: a.createdAt, revertedAt: a.revertedAt, meta });
    }
    const offers = summarizeOffers(offerRows);
    const replacedBySend = migratedSourceIds(lead.activities);
    // Rovnaké pravidlo ako LAST_TOUCH_WHERE v zozname.
    const lastTouch = lead.activities.find((a) => {
        if (!(LAST_TOUCH_TYPES as readonly string[]).includes(a.type) || a.revertedAt) return false;
        const offer = a.type === "OFFER_SENT" ? parseOfferMeta(a.meta) : null;
        return !offer || (offer.channel !== "PHONE" && !offer.historical);
    });

    return {
        id: lead.id,
        number: lead.number,
        name: lead.companyName ?? lead.website ?? "—",
        companyName: lead.companyName,
        website: lead.website,
        phone: lead.phone,
        email: lead.email,
        note: lead.note,
        status: lead.status,
        revision: lead.revision,
        section: cls.section,
        badge: cls.badge ?? null,
        noAnswerStreak,
        projectType: lead.projectType,
        nextActionKind: lead.nextActionKind,
        nextActionAt: lead.nextActionAt?.toISOString() ?? null,
        nextActionHasTime: lead.nextActionHasTime,
        nextActionMode: lead.nextActionMode,
        nextActionNote: lead.nextActionNote,
        price: lead.price != null ? Number(lead.price) : null,
        priceNote: lead.priceNote,
        offers: {
            offerAboutUsAt: lead.offerAboutUsAt?.toISOString() ?? null,
            offerPricelistAt: lead.offerPricelistAt?.toISOString() ?? null,
            offerPriceAt: lead.offerPriceAt?.toISOString() ?? null,
            offerReviewAt: lead.offerReviewAt?.toISOString() ?? null,
            designSentAt: legacyAwareDesignSentAt(lead)?.toISOString() ?? null,
            lastPrice: offers.lastPrice,
        },
        // Wave 4 D5: krátka história ceny na karte – čo sa zmenilo, kto a prečo. Obchodník ju vidí (BUSINESS riadok);
        // riadky spred D5 sú staršie CONTACT_UPDATED audity a do tohto zoznamu už nepatria (database-map.md).
        priceHistory: lead.activities
            .filter((a) => a.type === "PRICE_CHANGED")
            .slice(0, 6)
            .map((a) => {
                const meta = priceChangeOf(a.meta);
                return {
                    id: a.id,
                    at: a.createdAt.toISOString(),
                    by: a.user.firstName,
                    from: meta?.from ?? null,
                    to: meta?.to ?? null,
                    via: meta?.via ?? "EDIT",
                    reason: meta?.reason ?? null,
                };
            }),
        lostReason: lead.lostReason,
        closedAt: lead.closedAt?.toISOString() ?? null,
        pipelineEnteredAt: lead.pipelineEnteredAt?.toISOString() ?? null,
        createdAt: lead.createdAt.toISOString(),
        owner: lead.owner,
        handedOffBy: lead.handedOffBy,
        stepLocked,
        openTask: openTask
            ? {
                  id: openTask.id,
                  type: openTask.type,
                  contents: sortTaskContents(openTask.parts.map((p) => p.kind)),
                  // Prekryv odoslania sa rozhoduje podľa toho, čo sa EŠTE robí (§2.8) – nie podľa celého obsahu úlohy.
                  openKinds: partStates.get(openTask.id)?.openKinds ?? [],
                  assignee: openTask.assignee.firstName,
                  fallbackKind: helpFallback({ kind: openTask.fallbackKind, note: openTask.fallbackNote }).kind,
              }
            : null,
        // Wave 5 (§3.2, §3.7): „Chceli" ako história udalostí + zoskupená nevybavená práca a jej nadpis / varovanie.
        askHistory: requestView.state.history,
        outstandingRows: requestView.state.outstanding,
        outstanding: requestView.outstanding,
        openRequests: openRequestsOf(requestView.state),
        // Predvyplnenie dialógu „Čo sme poslali": len to, čo klient PÝTA a ešte nedostal (§3.4).
        asked: requestView.state.outstanding.filter((o) => o.openIds.length > 0).map((o) => o.content),
        stepHeadline: requestView.headline,
        askWarning: requestView.warning,
        // Karta úlohy: otvorená úloha (s jej správami) a uzavreté úlohy s výsledkami (wave 3 §7).
        tasks: lead.tasks.map((t) => ({
            id: t.id,
            type: t.type,
            contents: sortTaskContents(t.parts.map((p) => p.kind)),
            status: t.status,
            text: t.text,
            createdAt: t.createdAt.toISOString(),
            ageDays: Math.max(0, businessDaysBetween(t.createdAt, now)),
            closedAt: t.closedAt?.toISOString() ?? null,
            closeReason: t.closeReason,
            // Wave 4: čo úloha nesie, po častiach – vrátane osudu každej vrátenej položky (§2.3, §2.5).
            parts: partStates.get(t.id)?.parts ?? [],
            openKinds: partStates.get(t.id)?.openKinds ?? [],
            requestedBy: { id: t.requestedBy.id, name: `${t.requestedBy.firstName} ${t.requestedBy.lastName}`.trim(), firstName: t.requestedBy.firstName },
            assignee: { id: t.assignee.id, name: `${t.assignee.firstName} ${t.assignee.lastName}`.trim(), firstName: t.assignee.firstName },
            closedBy: t.closedBy ? { id: t.closedBy.id, name: `${t.closedBy.firstName} ${t.closedBy.lastName}`.trim(), firstName: t.closedBy.firstName } : null,
            events: lead.activities
                .filter((a) => a.taskId === t.id)
                .map((a) => ({ id: a.id, type: a.type, note: a.note, userName: a.user.firstName, userId: a.userId, createdAt: a.createdAt.toISOString() }))
                .reverse(),
        })),
        pending,
        pendingText: pendingSummary(pending),
        lastOffer: lastOfferOf(offerRows),
        lastTouch: lastTouch
            ? { type: lastTouch.type, outcome: lastTouch.outcome, note: lastTouch.note, at: lastTouch.createdAt.toISOString() }
            : null,
        activities: lead.activities.filter((a) => !replacedBySend.has(a.id)).map((a) => {
            const offer = a.type === "OFFER_SENT" ? parseOfferMeta(a.meta) : null;
            const correction = correctionOf(a.meta);
            return {
                id: a.id,
                type: a.type,
                category: a.category,
                source: a.source,
                outcome: a.outcome,
                note: a.note,
                userId: a.userId,
                userName: a.user.firstName,
                createdAt: a.createdAt.toISOString(),
                taskId: a.taskId,
                revertedAt: a.revertedAt?.toISOString() ?? null,
                correctionReason: correction,
                offer: offer
                    ? { sentOn: offer.sentOn, historical: offer.historical, migrated: offer.migrated === true, channel: offer.channel, via: offer.via ?? null }
                    : null,
            };
        }),
        // Súhrn sledovania návrhu – bez tokenov, URL a IP (spravovanie návrhov má manažér vo vlastnej karte).
        designs: lead.designs.map((d) => {
            const s = summarizeEvents(d.tracker?.events ?? [], d.currentVersion);
            return {
                id: d.id,
                label: d.label,
                url: d.targetUrl,
                version: d.currentVersion,
                // Sledovaný odkaz len pre tlačidlo „Skopírovať odkaz do emailu" – v UI sa nevykresľuje ako klikateľný.
                trackedUrl: d.targetUrl && d.tracker?.token ? trackedUrl(d.targetUrl, d.tracker.token) : null,
                sentAt: d.sentAt?.toISOString() ?? null,
                confidence: s.confidence as Confidence,
                views: s.totalViews,
                lastViewedAt: s.lastViewedAt?.toISOString() ?? null,
            };
        }),
    };
}

// Zmena ceny (meta – lib/domain/dealMutations.ts saveQuote).
const priceChangeSchema = z.object({
    from: z.object({ amount: z.number().nullable(), note: z.string().nullable() }),
    to: z.object({ amount: z.number().nullable(), note: z.string().nullable() }),
    via: z.enum(["EDIT", "TASK", "SEND"]),
    reason: z.string().nullable(),
});
function priceChangeOf(meta: unknown) {
    const parsed = priceChangeSchema.safeParse(meta);
    return parsed.success ? parsed.data : null;
}

// Dôvod opravy prečiarknutého záznamu (meta.correction – lib/domain/offerMutations.ts correctRecord).
const correctionSchema = z.object({ correction: z.object({ reason: z.string() }) });
function correctionOf(meta: unknown): string | null {
    const parsed = correctionSchema.safeParse(meta);
    return parsed.success ? parsed.data.correction.reason : null;
}

export type DealDetailData = NonNullable<Awaited<ReturnType<typeof getDealDetail>>>;
export type DealActivityView = DealDetailData["activities"][number];
export type DealTaskView = DealDetailData["tasks"][number];

// ── Číselníky pre filtre ─────────────────────────────────────────────────────

// Kandidáti na vlastníka (a zároveň hodnoty filtra vlastníka v rámci rozsahu).
export async function getDealOwnerOptions(scope?: DealScope) {
    const roles = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes("deals.receive"));
    const users = await prisma.user.findMany({
        where: {
            deletedAt: null,
            role: { in: roles },
            ...(scope?.kind === "team" ? { id: { in: scope.userIds } } : {}),
        },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
    return scope?.kind === "own" ? users.filter((u) => u.id === scope.userId) : users;
}

export type DealUserOption = Awaited<ReturnType<typeof getDealOwnerOptions>>[number];

// Ľudia, ktorých pozitívne hovory vytvorili obchody – filter „od koho to prišlo".
export async function getHandoffOptions(scope: DealScope) {
    return prisma.user.findMany({
        where: { handedOffLeads: { some: { ...DEAL_WHERE, ...scopeWhere(scope) } } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });
}

// Kto môže dostať úlohu (aktívni manažéri / admini – requests.resolve). Poradie podľa mena.
// Manažéri, ktorým sa dá zadať úloha. `mine` = predvolený manažér obchodníka: vedúci jeho tímu, inak ten, komu naposledy
// zadal úlohu (ak ešte môže úlohy riešiť). Dá sa zmeniť; oprávnenie aj tak overí príkaz.
export async function getResolverOptions(viewerId?: string): Promise<{ id: string; firstName: string; lastName: string; mine: boolean }[]> {
    const roles = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes("requests.resolve"));
    const [resolvers, viewer, lastTask] = await Promise.all([
        prisma.user.findMany({
            where: { deletedAt: null, role: { in: roles } },
            select: { id: true, firstName: true, lastName: true },
            orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        }),
        viewerId
            ? prisma.user.findUnique({ where: { id: viewerId }, select: { team: { select: { leaderId: true } } } })
            : Promise.resolve(null),
        viewerId
            ? prisma.dealTask.findFirst({
                  where: { requestedById: viewerId },
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  select: { assigneeId: true },
              })
            : Promise.resolve(null),
    ]);
    const ids = new Set(resolvers.map((r) => r.id));
    const leader = viewer?.team?.leaderId ?? null;
    const mine = leader && leader !== viewerId && ids.has(leader) ? leader : lastTask && ids.has(lastTask.assigneeId) ? lastTask.assigneeId : null;
    return resolvers.map((r) => ({ ...r, mine: r.id === mine }));
}

// ── História obchodníka (wave 3 §7) ─────────────────────────────────────────

// Obchody, ktoré odo mňa odišli: dopyt SÁM vynucuje, že riadok je môj odchod (fromUserId = ja), nie je to vrátenie hovoru,
// patrí do aktuálneho obdobia obchodu (createdAt >= pipelineEnteredAt), vlastník už nie som ja a lead je obchod
// (DEAL_WHERE). Jeden riadok na obchod – posledný odchod v poradí (createdAt, id). Bez odkazu na živý obchod.
export async function getHandedOverHistory(viewerId: string) {
    const rows = await prisma.$queryRaw<
        { leadId: string; number: number; name: string | null; createdAt: Date; reason: DealOwnershipReason; note: string | null; toUserId: string | null; byUserId: string }[]
    >`
        SELECT DISTINCT ON (o."leadId")
               o."leadId", l.number, COALESCE(l."companyName", l.website) AS name, o."createdAt", o.reason, o.note,
               o."toUserId", o."byUserId"
          FROM "DealOwnership" o
          JOIN "Lead" l ON l.id = o."leadId"
         WHERE o."fromUserId" = ${viewerId}
           AND o.reason <> 'REVERT'
           AND l."pipelineEnteredAt" IS NOT NULL AND l."deletedAt" IS NULL
           AND o."createdAt" >= l."pipelineEnteredAt"
           AND l."ownerId" IS DISTINCT FROM ${viewerId}
         ORDER BY o."leadId", o."createdAt" DESC, o.id DESC`;
    const userIds = [...new Set(rows.flatMap((r) => [r.toUserId, r.byUserId]).filter((id): id is string => Boolean(id)))];
    const users = userIds.length
        ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })
        : [];
    const nameOf = (id: string | null) => {
        const u = users.find((x) => x.id === id);
        return u ? `${u.firstName} ${u.lastName}`.trim() : null;
    };
    return rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.leadId.localeCompare(a.leadId))
        .map((r) => ({
            leadId: r.leadId,
            number: r.number,
            name: r.name ?? "—",
            at: r.createdAt.toISOString(),
            reason: r.reason,
            note: r.note,
            to: nameOf(r.toUserId),
            by: nameOf(r.byUserId),
        }));
}

export type HandedOverRow = Awaited<ReturnType<typeof getHandedOverHistory>>[number];
