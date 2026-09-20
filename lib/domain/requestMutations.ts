import type { ActivityType, RequestContent, RequestOrigin } from "@/app/generated/prisma/enums";
import type { PrismaClient } from "@/app/generated/prisma/client";
import { AccessError } from "@/lib/access/errors";
import type { Tx } from "@/lib/access/locks";
import {
    clientRequestState,
    outstandingContents,
    resolutionChanged,
    resolveRequests,
    type ClientRequestState,
    type ManagerWork,
    type ReceiptRow,
    type RequestHistoryInput,
    type RequestLink,
} from "@/lib/domain/clientRequests";
import { offerInstant, parseOfferMeta } from "@/lib/domain/offers";
import { bumpLeadOnce } from "@/lib/domain/revision";
import { loadPending, openTaskOf } from "@/lib/domain/taskMutations";

// Zápisy „čo klient pýtal" (wave 5 §6.2, §6.7). Volajú ich príkazy pod zámkom Lead riadku; revízia sa zvýši raz.
// Pravidlo: stav riadku sa NIKDY neprepína lokálne – každá operácia, ktorá sa dotkne požiadaviek alebo odoslaní,
// skončí prepočtom reconcileRequests(). Prečiarknuté odoslanie tak riadok znova otvorí len vtedy, keď ho nespĺňa
// žiadne iné platné odoslanie.

type Db = Pick<PrismaClient, "leadRequest" | "activity" | "dealTask"> | Tx;

const REQUEST_SELECT = {
    id: true,
    content: true,
    state: true,
    origin: true,
    requestedAt: true,
    requestedById: true,
    sourceActivityId: true,
    resolvedAt: true,
    resolvedById: true,
    resolvedActivityId: true,
    reason: true,
} as const;

// ── Načítanie ────────────────────────────────────────────────────────────────

export async function requestsByLead(db: Db, leadIds: string[]): Promise<Map<string, RequestHistoryInput[]>> {
    const out = new Map<string, RequestHistoryInput[]>();
    if (leadIds.length === 0) return out;
    const rows = await db.leadRequest.findMany({
        where: { leadId: { in: leadIds } },
        select: { ...REQUEST_SELECT, leadId: true, requestedBy: { select: { firstName: true } } },
        orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    });
    for (const r of rows) {
        const list = out.get(r.leadId) ?? [];
        list.push({ ...r, requestedBy: r.requestedBy?.firstName ?? null });
        out.set(r.leadId, list);
    }
    return out;
}

export async function loadRequests(db: Db, leadId: string): Promise<RequestHistoryInput[]> {
    return (await requestsByLead(db, [leadId])).get(leadId) ?? [];
}

// Platné (neprečiarknuté) odoslania ako okamihy – spätný záznam nesie historický deň, dnešný čas zápisu (§5).
export async function loadReceipts(db: Db, leadId: string): Promise<ReceiptRow[]> {
    const rows = await db.activity.findMany({
        where: { leadId, type: "OFFER_SENT", revertedAt: null },
        select: { id: true, userId: true, createdAt: true, meta: true },
    });
    const out: ReceiptRow[] = [];
    for (const a of rows) {
        const meta = parseOfferMeta(a.meta);
        if (meta) out.push({ id: a.id, userId: a.userId, instant: offerInstant(meta, a.createdAt), contents: meta.contents });
    }
    return out;
}

// Čo práve robí / už vrátil manažér (§6.9). Wave 4 sem dodá tie isté dva zoznamy z taskPartState.
export async function managerWorkOf(db: Db, leadId: string): Promise<ManagerWork> {
    const [open, prepared] = await Promise.all([openTaskOf(db, leadId), loadPending(db, leadId)]);
    return {
        making: open && open.type === "HELP" ? open.contents : [],
        prepared: prepared.filter((i) => i.kind === "PRICE" || i.kind === "DESIGN"),
    };
}

export async function requestStateOf(db: Db, leadId: string): Promise<ClientRequestState> {
    const [requests, work] = await Promise.all([loadRequests(db, leadId), managerWorkOf(db, leadId)]);
    return clientRequestState(requests, work);
}

// Čo je nevybavené – vstup do predvoľby kroku (§6.8) aj do varovaní.
export async function outstandingOf(db: Db, leadId: string): Promise<RequestContent[]> {
    return outstandingContents(await requestStateOf(db, leadId));
}

// ── Prepočet (§6.7) ──────────────────────────────────────────────────────────

export async function reconcileRequests(tx: Tx, leadId: string, opts: { links?: readonly RequestLink[] } = {}): Promise<void> {
    const rows = await tx.leadRequest.findMany({ where: { leadId }, select: REQUEST_SELECT });
    if (rows.length === 0) return;
    const next = resolveRequests(rows, await loadReceipts(tx, leadId), opts.links ?? []);
    for (const row of rows) {
        const resolution = next.get(row.id);
        if (!resolution || !resolutionChanged(row, resolution)) continue;
        await tx.leadRequest.update({
            where: { id: row.id },
            data: {
                state: resolution.state,
                resolvedAt: resolution.resolvedAt,
                resolvedById: resolution.resolvedById,
                resolvedActivityId: resolution.resolvedActivityId,
            },
        });
    }
    await bumpLeadOnce(tx, leadId);
}

// ── Zápisy ───────────────────────────────────────────────────────────────────

// Cudzí kľúč nedokáže overiť, že aktivita patrí TOMU ISTÉMU obchodu (R02-7) – preto to robí každý príkaz pod zámkom.
export async function assertLeadActivity(tx: Tx, leadId: string, activityId: string, types: readonly ActivityType[]): Promise<void> {
    const row = await tx.activity.findUnique({ where: { id: activityId }, select: { leadId: true, type: true, revertedAt: true } });
    if (!row || row.leadId !== leadId) throw new AccessError("NOT_FOUND", "Záznam sa nenašiel.");
    if (!types.includes(row.type)) throw new AccessError("FORBIDDEN", "Neplatný záznam.");
    if (row.revertedAt) throw new AccessError("STALE", "Záznam bol medzitým opravený – obnovujem.");
}

export type AddRequestsInput = {
    leadId: string;
    contents: readonly RequestContent[];
    requestedAt: Date;
    requestedById: string | null;
    sourceActivityId?: string | null;
    sourceTypes?: readonly ActivityType[];
    origin?: RequestOrigin;
    reason?: string | null;
};

// Nová požiadavka je VŽDY nový riadok – aj keď ten istý obsah už raz otvorený je (§6.2). Zoskupenie do jedného
// riadku práce robí až projekcia (§6.9), takže štatistika vidí dve požiadania a obchodník jednu prácu.
export async function addRequests(tx: Tx, input: AddRequestsInput): Promise<{ id: string; content: RequestContent }[]> {
    if (input.contents.length === 0) return [];
    if (input.sourceActivityId) {
        await assertLeadActivity(tx, input.leadId, input.sourceActivityId, input.sourceTypes ?? ["CALL", "CLIENT_REPLIED"]);
    }
    const created: { id: string; content: RequestContent }[] = [];
    for (const content of input.contents) {
        const row = await tx.leadRequest.create({
            data: {
                leadId: input.leadId,
                content,
                state: "OPEN",
                origin: input.origin ?? "LIVE",
                requestedAt: input.requestedAt,
                requestedById: input.requestedById,
                sourceActivityId: input.sourceActivityId ?? null,
                reason: input.reason ?? null,
            },
            select: { id: true, content: true },
        });
        created.push(row);
    }
    return created;
}

// Ručné stiahnutie („už to nechcú"): len OTVORENÉ riadky toho istého obchodu, menované id-čkami. Vybavený riadok
// sa stiahnuť nedá – inak by stratil odkaz na odoslanie, ktoré ho splnilo (R03-5).
export async function withdrawRequests(
    tx: Tx,
    input: { leadId: string; ids: readonly string[]; actorId: string; reason: string },
): Promise<{ id: string; content: RequestContent }[]> {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) return [];
    const rows = await tx.leadRequest.findMany({
        where: { id: { in: ids }, leadId: input.leadId, state: "OPEN" },
        select: { id: true, content: true },
    });
    if (rows.length !== ids.length) throw new AccessError("STALE", "Požiadavka sa medzitým zmenila – obnovujem.");
    const now = new Date();
    await tx.leadRequest.updateMany({
        where: { id: { in: ids }, leadId: input.leadId, state: "OPEN" },
        data: { state: "WITHDRAWN", resolvedAt: now, resolvedById: input.actorId, resolvedActivityId: null, reason: input.reason },
    });
    return rows;
}

// Vrátenie výsledku prvého hovoru zmaže riadky, ktoré ten hovor vytvoril; splnenú požiadavku už vrátiť nemožno
// (R01-9) – klient to naozaj dostal a odoslanie o tom ostáva.
export async function deleteRequestsOfActivity(tx: Tx, leadId: string, activityId: string): Promise<number> {
    const rows = await tx.leadRequest.findMany({
        where: { leadId, sourceActivityId: activityId },
        select: { id: true, state: true },
    });
    if (rows.some((r) => r.state === "SENT")) {
        throw new AccessError("STALE", "Klient už niečo z toho dostal – hovor sa nedá vrátiť.");
    }
    if (rows.length === 0) return 0;
    const { count } = await tx.leadRequest.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return count;
}
