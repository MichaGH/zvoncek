import type { LeadStatus } from "@/app/generated/prisma/enums";

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

// Pilulky pohľadov. „today", „waiting_manager", „inbox" a „unverified" platia naprieč stavmi (stavová záložka sa pri
// nich ignoruje). Každá pilulka má počet, ktorý počíta ten istý predikát ako jej zoznam (lib/queries/pipeline – wave 3 §7).
// Žije tu (nie v queries), aby to mohli importovať klientske komponenty bez ťahania Prisma klienta.
export const DEAL_VIEWS = [
    // Úlohy pre manažéra (wave 3): „Pre mňa" = moja schránka (len manažér), „Čakám na manažéra" = moje obchody so zámkom.
    { key: "inbox", label: "Pre mňa", group: "tasks" },
    { key: "waiting_manager", label: "Čakám na manažéra", group: "tasks" },
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

export type DealViewKey = (typeof DEAL_VIEWS)[number]["key"];

const VIEW_KEYS = new Set<string>(DEAL_VIEWS.map((v) => v.key));
const CROSS_STATUS_VIEWS = new Set<string>(["today", "unverified", "waiting_manager", "inbox"]);
// Pilulky podľa druhu kroku – zamknutý obchod v nich nie je (je v „Čakám na manažéra", §5.3).
export const STEP_KIND_VIEWS = new Set<string>(["call", "quote", "email", "design", "waiting"]);

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
    limit?: number;
};

type RawParams = {
    filter?: string;
    view?: string;
    owner?: string;
    q?: string;
    from?: string;
    limit?: string;
};

const STATUS_KEYS = new Set<string>(DEAL_STATUS_TABS.map((t) => t.key));

export function parseDealParams(raw: RawParams): DealFilterParams {
    const limit = Number(raw.limit);
    return {
        filter: raw.filter && STATUS_KEYS.has(raw.filter) ? raw.filter : DEFAULT_STATUS_KEY,
        view: raw.view ?? DEFAULT_VIEW,
        owner: raw.owner ?? DEFAULT_OWNER,
        q: raw.q?.trim() || undefined,
        from: raw.from || undefined,
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
    if (next.limit) params.set("limit", String(next.limit));
    const qs = params.toString();
    return qs ? `/dashboard/pipeline?${qs}` : "/dashboard/pipeline";
}

// „Pre mňa" je schránka, nie výsek mojich obchodov: odkaz výslovne ruší filtre, ktoré schránka ignoruje – vlastníka,
// stav, „Od:" aj stránkovanie (W3-R3-10). Hľadanie ostáva.
export function inboxHref(current: DealFilterParams): string {
    return dealsHref(current, { view: "inbox", owner: DEFAULT_OWNER, filter: DEFAULT_STATUS_KEY, from: undefined });
}
