import { z } from "zod";
import type { CallbackKind, LeadStatus, RequestContent } from "@/app/generated/prisma/enums";

// Recyklácia kontaktov (feature 02, context/features/02-recycling/recycling-spec.md). Čisté pravidlá – bezpečné aj
// pre klienta. Zápis je v recycleMutations.ts, transakcia v lib/commands/recycling.ts.
//
// Pravidlo „do ktorého koša kontakt patrí" existuje dvakrát: tu (recycleBucketOf) a v SQL (RECYCLE_BUCKET_SQL
// v lib/queries/recycling). Test rc9Parity v check-concurrency.ts overuje, že sa zhodujú – meniť oboje naraz.

export const RECYCLE_BUCKETS = [
    "call_retry",
    "call_scheduled",
    "call_snoozed",
    "call_lost",
    "call_unreachable",
    "deal_active",
    "deal_snoozed",
    "deal_lost",
    "deal_unreachable",
] as const;
export type RecycleBucket = (typeof RECYCLE_BUCKETS)[number];

export const RECYCLE_BUCKET_LABEL: Record<RecycleBucket, string> = {
    call_retry: "Nezdvihli",
    call_scheduled: "Dohodnuté volanie",
    call_snoozed: "Odložené",
    call_lost: "Nemajú záujem",
    call_unreachable: "Zlé číslo",
    deal_active: "Aktívne",
    deal_snoozed: "Spiace",
    deal_lost: "Stratené",
    deal_unreachable: "Nedostupné",
};

export const CALL_BUCKETS = RECYCLE_BUCKETS.filter((b) => b.startsWith("call_"));
export const DEAL_BUCKETS = RECYCLE_BUCKETS.filter((b) => b.startsWith("deal_"));

// Predvolený výber panelu (spec §5.1, Q5): zvyšok po telesales (timea) + mŕtve obchody.
export const DEFAULT_RECYCLE_BUCKETS: RecycleBucket[] = ["call_retry", "call_lost", "deal_lost", "deal_unreachable"];

type BucketRule = { deal: boolean; status: LeadStatus; callbackKind?: CallbackKind };

export const RECYCLE_BUCKET_RULE: Record<RecycleBucket, BucketRule> = {
    call_retry: { deal: false, status: "CALLING", callbackKind: "RETRY" },
    call_scheduled: { deal: false, status: "CALLING", callbackKind: "SCHEDULED" },
    call_snoozed: { deal: false, status: "SNOOZED" },
    call_lost: { deal: false, status: "LOST" },
    call_unreachable: { deal: false, status: "UNREACHABLE" },
    deal_active: { deal: true, status: "ACTIVE" },
    deal_snoozed: { deal: true, status: "SNOOZED" },
    deal_lost: { deal: true, status: "LOST" },
    deal_unreachable: { deal: true, status: "UNREACHABLE" },
};

export type RecycleBucketInput = {
    pipelineEnteredAt: Date | string | null;
    status: LeadStatus;
    callbackKind: CallbackKind | null;
};

// Kôš kontaktu podľa fázy a stavu; null = tento stav sa nerecykluje (NEW, WON, nezmyselná kombinácia).
export function recycleBucketOf(lead: RecycleBucketInput): RecycleBucket | null {
    const deal = lead.pipelineEnteredAt !== null;
    for (const bucket of RECYCLE_BUCKETS) {
        const rule = RECYCLE_BUCKET_RULE[bucket];
        if (rule.deal !== deal || rule.status !== lead.status) continue;
        if (rule.status === "CALLING" && rule.callbackKind !== lead.callbackKind) continue;
        return bucket;
    }
    return null;
}

export type RecycleEligibilityInput = RecycleBucketInput & {
    deletedAt: Date | string | null;
    archiveOfId: string | null;
    hasOpenTask: boolean;
};

export type RecycleSkipReason = "NOT_FOUND" | "CHANGED" | "NOT_ELIGIBLE" | "OPEN_TASK";

export const RECYCLE_SKIP_LABEL: Record<RecycleSkipReason, string> = {
    NOT_FOUND: "neexistuje",
    CHANGED: "zmenil sa medzitým",
    NOT_ELIGIBLE: "tento stav sa nerecykluje",
    OPEN_TASK: "obchod má otvorenú úlohu pre manažéra",
};

// Dá sa kontakt recyklovať? null = áno. Rovnaké pravidlo kontroluje príkaz pod zámkom a SQL pri zozname.
export function recycleBlocker(lead: RecycleEligibilityInput): RecycleSkipReason | null {
    if (lead.deletedAt !== null || lead.archiveOfId !== null) return "NOT_FOUND";
    if (recycleBucketOf(lead) === null) return "NOT_ELIGIBLE";
    if (lead.hasOpenTask) return "OPEN_TASK";
    return null;
}

export const RECYCLE_MAX_ITEMS = 500;
export const RECYCLE_PAGE_SIZE = 100;

// Vstup príkazu: presne tie riadky, ktoré admin videl, s revíziou z obrazovky (spec §6).
export const recycleInputSchema = z
    .object({
        items: z
            .array(z.object({ leadId: z.string().min(1).max(64), expectedRevision: z.number().int().min(0) }).strict())
            .min(1)
            .max(RECYCLE_MAX_ITEMS)
            .refine((items) => new Set(items.map((i) => i.leadId)).size === items.length, "Duplicitný kontakt."),
    })
    .strict();
export type RecycleInput = z.infer<typeof recycleInputSchema>;

// ── Polia Lead pri recyklácii (spec §4.3) ───────────────────────────────────
// Každý skalárny stĺpec Lead je práve v jednom zozname. Test rc1Snapshot to overuje voči Prisma.LeadScalarFieldEnum,
// takže nový stĺpec sa nedá zabudnúť ani v archíve, ani pri resete.

// Živý kontakt si ich nechá.
export const RECYCLE_KEPT_FIELDS = [
    "id",
    "number",
    "companyName",
    "phone",
    "website",
    "email",
    "note",
    "origin",
    "createdById",
    "createdAt",
    "deletedAt",
    "archiveOfId",
    "archivedById",
] as const;

// Živý kontakt ich dostane ako nový kontakt.
export const RECYCLE_RESET_FIELDS = [
    "status",
    "projectType",
    "ownerId",
    "nextActionKind",
    "nextActionAt",
    "nextActionHasTime",
    "nextActionMode",
    "nextActionNote",
    "callbackKind",
    "callbackAt",
    "callbackHasTime",
    "callbackNote",
    "price",
    "priceNote",
    "designSentAt",
    "offerAboutUsAt",
    "offerPricelistAt",
    "offerPriceAt",
    "offerReviewAt",
    "lostReason",
    "assignedCallerId",
    "assignedCallerAt",
    "pipelineEnteredAt",
    "handedOffById",
    "closedAt",
] as const;

// Menia sa inak: revízia +1, kolo +1, začiatok kola = teraz; updatedAt rieši Prisma.
export const RECYCLE_COUNTED_FIELDS = ["revision", "round", "roundStartedAt", "updatedAt"] as const;

// Archívny riadok preberá všetko okrem týchto (vlastné id a číslo, skrytie, väzba na živý kontakt, updatedAt).
export const ARCHIVE_COPY_EXCEPTIONS = ["id", "number", "deletedAt", "archiveOfId", "archivedById", "updatedAt"] as const;

// ── Filtre panelu v URL (ako dealFilters.ts: odkazy a dopyt sa nemôžu rozísť) ─────────────────────────────────

export const RECYCLE_OLDER_OPTIONS = [0, 7, 30, 60, 90] as const;
export const DEFAULT_RECYCLE_OLDER = 30; // Q9: bez tvrdého pravidla, len predvolený filter
export const RECYCLE_GOT = ["info", "pricelist", "price", "design"] as const;
export const RECYCLE_GOT_LABEL: Record<(typeof RECYCLE_GOT)[number], string> = {
    info: "Dostali info",
    pricelist: "Dostali cenník",
    price: "Dostali cenu",
    design: "Dostali návrh",
};
export const RECYCLE_ASKED = ["INFO", "PRICE", "DESIGN"] as const;
export const RECYCLE_ASKED_LABEL: Record<(typeof RECYCLE_ASKED)[number], string> = {
    INFO: "Chceli info",
    PRICE: "Chceli cenu",
    DESIGN: "Chceli návrh",
};
export const RECYCLE_SORTS = ["last_asc", "last_desc", "added_asc", "added_desc", "number"] as const;
export const RECYCLE_SORT_LABEL: Record<(typeof RECYCLE_SORTS)[number], string> = {
    last_asc: "Posledný kontakt – najstaršie",
    last_desc: "Posledný kontakt – najnovšie",
    added_asc: "Pridané – najstaršie",
    added_desc: "Pridané – najnovšie",
    number: "Číslo kontaktu",
};
export const RECYCLE_HOLDER_NONE = "none";

// „Nevolať" (R02-04): appka nemá príznak, len voľný text – poznámku kontaktu a dôvod straty obchodu. Kontakt, ktorého
// text obsahuje niektoré z týchto slov, panel predvolene skryje (dnc=hide) a počet skrytých ukáže. Ten istý vzor
// beží v SQL (`~*`, lib/queries/recycling) aj tu (isDoNotCall) – paritný test rc12DoNotCall.
export const DO_NOT_CALL_PATTERN = "(nevola[tť]|nevolajte|nekontaktova|neotravova|neotravuj|do ?pi[cč]|gdpr)";
const DO_NOT_CALL_RE = new RegExp(DO_NOT_CALL_PATTERN, "i");
export function isDoNotCall(...texts: (string | null | undefined)[]): boolean {
    return texts.some((t) => Boolean(t) && DO_NOT_CALL_RE.test(t!));
}

export type RecycleParams = {
    buckets: RecycleBucket[];
    holder: string | null; // id používateľa alebo RECYCLE_HOLDER_NONE
    older: number; // posledný kontakt starší ako N dní (0 = hocikedy)
    tries: number; // aspoň N „nezdvihli"
    got: (typeof RECYCLE_GOT)[number] | null;
    asked: (typeof RECYCLE_ASKED)[number] | null; // otvorená požiadavka v aktuálnom obchode
    round: "1" | "2" | null; // 2 = druhé a ďalšie kolo
    dnc: "hide" | "show"; // kontakty s „nevolať" v poznámke: predvolene skryté (R02-04)
    q: string;
    sort: (typeof RECYCLE_SORTS)[number];
    page: number;
};

type RawParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
}

function oneOf<T extends string>(values: readonly T[], v: string | undefined): T | null {
    return v && (values as readonly string[]).includes(v) ? (v as T) : null;
}

export function parseRecycleParams(raw: RawParams): RecycleParams {
    const b = one(raw.b);
    const buckets = b === undefined
        ? DEFAULT_RECYCLE_BUCKETS
        : b.split(",").filter((x): x is RecycleBucket => (RECYCLE_BUCKETS as readonly string[]).includes(x));
    const older = Number(one(raw.older));
    const tries = Number(one(raw.tries));
    const page = Number(one(raw.page));
    const holder = one(raw.holder);
    return {
        buckets: RECYCLE_BUCKETS.filter((x) => buckets.includes(x)),
        holder: holder && holder.length <= 64 ? holder : null,
        older: (RECYCLE_OLDER_OPTIONS as readonly number[]).includes(older) ? older : DEFAULT_RECYCLE_OLDER,
        tries: Number.isInteger(tries) && tries >= 0 && tries <= 20 ? tries : 0,
        got: oneOf(RECYCLE_GOT, one(raw.got)),
        asked: oneOf(RECYCLE_ASKED, one(raw.asked)),
        round: oneOf(["1", "2"] as const, one(raw.round)),
        dnc: one(raw.dnc) === "show" ? "show" : "hide",
        q: (one(raw.q) ?? "").trim().slice(0, 100),
        sort: oneOf(RECYCLE_SORTS, one(raw.sort)) ?? "last_asc",
        page: Number.isInteger(page) && page >= 1 && page <= 2_147_483_647 ? page : 1,
    };
}

// Odkaz s upravenými filtrami; zmena filtra vždy vracia na prvú stranu.
export function recycleHref(params: RecycleParams, patch: Partial<RecycleParams> = {}): string {
    const next = { ...params, page: 1, ...patch };
    const s = new URLSearchParams();
    s.set("b", next.buckets.join(","));
    if (next.holder) s.set("holder", next.holder);
    if (next.older !== DEFAULT_RECYCLE_OLDER) s.set("older", String(next.older));
    if (next.tries > 0) s.set("tries", String(next.tries));
    if (next.got) s.set("got", next.got);
    if (next.asked) s.set("asked", next.asked);
    if (next.round) s.set("round", next.round);
    if (next.dnc === "show") s.set("dnc", "show");
    if (next.q) s.set("q", next.q);
    if (next.sort !== "last_asc") s.set("sort", next.sort);
    if (next.page > 1) s.set("page", String(next.page));
    return `/dashboard/admin/recycle?${s.toString()}`;
}

export function recyclePage(page: number, total: number): number {
    return Math.min(page, Math.max(1, Math.ceil(total / RECYCLE_PAGE_SIZE)));
}

// Snapshot shown when selected; mutations still send only id + expected revision.
export type RecycleSelection = {
    expectedRevision: number;
    bucket: RecycleBucket;
    holderId: string | null;
    holderName: string | null;
    holderActive: boolean; // R02-05: aktívny volajúci príde o prácu zo svojej fronty
    lastAt: string;
    openAsks: RequestContent[];
    doNotCall: boolean; // R02-04: poznámka / dôvod obsahuje „nevolať"
};

export function recycleSelection(row: Omit<RecycleSelection, "expectedRevision"> & { revision: number }): RecycleSelection {
    return { expectedRevision: row.revision, bucket: row.bucket, holderId: row.holderId,
        holderName: row.holderName, holderActive: row.holderActive, lastAt: row.lastAt, openAsks: row.openAsks,
        doNotCall: row.doNotCall };
}

// Recent = within the default 30-day window (Q9); a warning, never an eligibility rule.
export function summarizeRecycleSelection(items: Iterable<RecycleSelection>, now: number) {
    const buckets = new Map<RecycleBucket, number>();
    const owners = new Map<string | null, { id: string | null; name: string; active: number; snoozed: number }>();
    const asks = new Map<RequestContent, number>();
    // R02-05: práca volania, ktorú drží AKTÍVNY volajúci (recyklácia mu ju zoberie z „Opakovať" / termínov / odložených).
    const callers = new Map<string, { id: string; name: string; count: number }>();
    let recent = 0;
    let doNotCall = 0;
    for (const item of items) {
        buckets.set(item.bucket, (buckets.get(item.bucket) ?? 0) + 1);
        if (item.doNotCall) doNotCall++;
        if (item.holderId && item.holderActive && item.bucket.startsWith("call_") && item.bucket !== "call_lost" && item.bucket !== "call_unreachable") {
            const caller = callers.get(item.holderId) ?? { id: item.holderId, name: item.holderName ?? "—", count: 0 };
            caller.count++;
            callers.set(item.holderId, caller);
        }
        if (item.bucket === "deal_active" || item.bucket === "deal_snoozed") {
            const owner = owners.get(item.holderId) ?? { id: item.holderId, name: item.holderName ?? "Bez vlastníka", active: 0, snoozed: 0 };
            if (item.bucket === "deal_active") owner.active++;
            else owner.snoozed++;
            owners.set(item.holderId, owner);
        }
        for (const content of new Set(item.openAsks)) asks.set(content, (asks.get(content) ?? 0) + 1);
        if (Date.parse(item.lastAt) >= now - DEFAULT_RECYCLE_OLDER * 86_400_000) recent++;
    }
    return {
        buckets: RECYCLE_BUCKETS.filter((b) => buckets.has(b)).map((bucket) => ({ bucket, n: buckets.get(bucket)! })),
        owners: [...owners.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id ?? "").localeCompare(b.id ?? "")),
        asks: [...asks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([content, n]) => ({ content, n })),
        callers: [...callers.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        recent,
        doNotCall,
    };
}
