import type { DealRequestKind, LeadStatus } from "@/app/generated/prisma/enums";

// Jeden model filtrov obrazovky obchodov – používa ho stránka (server) aj ovládacie prvky (klient),
// takže odkazy a dotaz sa nemôžu rozísť. Rozsah (koho obchody vôbec vidím) tu NIE JE – ten rieši dealScope().

export const DEAL_STATUS_TABS = [
    { key: "active", label: "Aktívne", status: "ACTIVE" },
    { key: "snoozed", label: "Spiace", status: "SNOOZED" },
    { key: "won", label: "Vyhraté", status: "WON" },
    { key: "lost", label: "Stratené", status: "LOST" },
    { key: "unreachable", label: "Nedostupné", status: "UNREACHABLE" },
    { key: "all", label: "Všetky", status: undefined },
] as const satisfies readonly { key: string; label: string; status?: LeadStatus }[];

export const DEFAULT_STATUS_KEY = "active";
export const DEFAULT_VIEW = "today"; // „Na dnes" je to, s čím sa ráno začína – pre obchodníka aj manažéra
export const DEFAULT_OWNER = "me"; // vždy najprv moja práca; prepnutie na iných rieši filter (v rámci rozsahu)
export const NO_VIEW = "all";

// Pilulky pohľadov. „today" a „requests" platia naprieč stavmi (stavová záložka sa pri nich ignoruje).
// Žije tu (nie v queries), aby to mohli importovať klientske komponenty bez ťahania Prisma klienta.
export const DEAL_VIEWS = [
    { key: "today", label: "Na dnes", group: "focus" },
    { key: "call", label: "Volať", group: "todo" },
    { key: "quote", label: "Poslať cenu", group: "todo" },
    { key: "email", label: "Poslať email", group: "todo" },
    { key: "design", label: "Návrh v procese", group: "todo" },
    { key: "waiting", label: "Čaká na klienta", group: "running" },
    // Čo klient už má (round 2 §2c) – podľa nových záznamov OFFER_SENT, nie podľa starých polí.
    { key: "got_pricelist", label: "Dostali cenník", group: "running" },
    { key: "got_price", label: "Dostali cenu", group: "running" },
    { key: "got_design", label: "Dostali návrh", group: "running" },
    // Staré obchody, ktorých odoslania ešte manažér neoveril (zobrazuje sa len manažérovi).
    { key: "unverified", label: "Neoverené", group: "legacy" },
] as const;

export type DealViewKey = (typeof DEAL_VIEWS)[number]["key"] | "requests";

const VIEW_KEYS = new Set<string>([...DEAL_VIEWS.map((v) => v.key), "requests"]);
const CROSS_STATUS_VIEWS = new Set<string>(["requests", "today", "unverified"]);

export function isDealView(value: string | undefined): value is DealViewKey {
    return Boolean(value && VIEW_KEYS.has(value));
}

export function viewIgnoresStatus(view: string | undefined): boolean {
    return Boolean(view && CROSS_STATUS_VIEWS.has(view));
}

export type DealFilterParams = {
    filter: string;
    view: string;
    owner: string;
    q?: string;
    from?: string; // handedOffById – „od koho obchod prišiel"
    kind?: string; // druh požiadavky (len pri view=requests)
    limit?: number;
};

type RawParams = {
    filter?: string;
    view?: string;
    owner?: string;
    q?: string;
    from?: string;
    kind?: string;
    limit?: string;
};

const STATUS_KEYS = new Set<string>(DEAL_STATUS_TABS.map((t) => t.key));
const REQUEST_KINDS = new Set<string>(["PRICE", "DESIGN", "EMAIL", "ORDER", "REOPEN", "OTHER"]);

export function parseDealParams(raw: RawParams): DealFilterParams {
    const limit = Number(raw.limit);
    return {
        filter: raw.filter && STATUS_KEYS.has(raw.filter) ? raw.filter : DEFAULT_STATUS_KEY,
        view: raw.view ?? DEFAULT_VIEW,
        owner: raw.owner ?? DEFAULT_OWNER,
        q: raw.q?.trim() || undefined,
        from: raw.from || undefined,
        kind: raw.kind && REQUEST_KINDS.has(raw.kind) ? raw.kind : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    };
}

export function statusOf(params: DealFilterParams): LeadStatus | undefined {
    return DEAL_STATUS_TABS.find((t) => t.key === params.filter)?.status;
}

// „all" = bez pohľadu; do dotazu ide undefined.
export function viewOf(params: DealFilterParams): string | undefined {
    return params.view === NO_VIEW ? undefined : params.view;
}

export function requestKindOf(params: DealFilterParams): DealRequestKind | undefined {
    return params.kind as DealRequestKind | undefined;
}

// Odkaz na obrazovku obchodov so zmenenými parametrami. Zmena filtra vždy ruší stránkovanie (limit).
export function dealsHref(current: DealFilterParams, patch: Partial<DealFilterParams> = {}): string {
    const next = { ...current, ...patch };
    if (!("limit" in patch)) next.limit = undefined;
    const params = new URLSearchParams();
    if (next.filter !== DEFAULT_STATUS_KEY) params.set("filter", next.filter);
    if (next.view !== DEFAULT_VIEW) params.set("view", next.view);
    if (next.owner !== DEFAULT_OWNER) params.set("owner", next.owner);
    if (next.q) params.set("q", next.q);
    if (next.from) params.set("from", next.from);
    if (next.kind && next.view === "requests") params.set("kind", next.kind);
    if (next.limit) params.set("limit", String(next.limit));
    const qs = params.toString();
    return qs ? `/dashboard/pipeline?${qs}` : "/dashboard/pipeline";
}
