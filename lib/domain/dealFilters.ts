import type { LeadStatus } from "@/app/generated/prisma/enums";

// Jeden model filtrov obrazovky obchodov – používa ho stránka (server) aj ovládacie prvky (klient),
// takže odkazy a dotaz sa nemôžu rozísť. Rozsah (koho obchody vôbec vidím) tu NIE JE – ten rieši dealScope().
//
// Stav hore, pod ním dve úrovne, ktoré sa SKLADAJÚ (nie sú to alternatívy):
//   0. stav obchodu (`filter`) – Aktívne (predvolené) · Spiace · Vyhraté · Stratené · Nedostupné · Všetky.
//      Rady a kroky existujú LEN pri „Aktívne" – obchod, ktorý sa už nerieši, nemá čo „volať" ani „poslať".
//      Ostatné stavy sú obyčajný zoznam (`view` = all, bez `step`).
//   1. rad práce (`view`)  – Čakám na manažéra · Na spracovanie · Na dnes · Všetko (manažér navyše „Pre mňa")
//   2. druh ďalšieho kroku (`step`) – Volať · Poslať cenu · Poslať návrh · Poslať email · Čaká na klienta; zužuje rad z 1.
//      „Všetko → Volať" = všetky obchody s krokom Volať, „Na dnes → Volať" = tie, ktoré treba volať dnes.

export const DEAL_STATUS_TABS = [
    { key: "active", label: "Aktívne", status: "ACTIVE" },
    { key: "snoozed", label: "Spiace", status: "SNOOZED" },
    { key: "won", label: "Vyhraté", status: "WON" },
    { key: "lost", label: "Stratené", status: "LOST" },
    { key: "unreachable", label: "Nedostupné", status: "UNREACHABLE" },
    { key: "all", label: "Všetky", status: undefined },
] as const satisfies readonly { key: string; label: string; status?: LeadStatus }[];

export const DEFAULT_STATUS_KEY = "active";
// Bez `view` v adrese sa rad vyberie podľa práce: „Na spracovanie", kým je čo spracovať, inak „Na dnes"
// (pozri resolveView). Odkazy z ovládacích prvkov nesú vždy konkrétny rad.
export const AUTO_VIEW = "auto";
export const DEFAULT_VIEW = AUTO_VIEW;
export const DEFAULT_OWNER = "me"; // vždy najprv moja práca; prepnutie na iných rieši filter (v rámci rozsahu)
export const NO_VIEW = "all";

// Pilulky pohľadov. „work", „today", „waiting_manager", „inbox" a „unverified" platia naprieč stavmi (stavová záložka sa pri
// nich ignoruje). Každá pilulka má počet, ktorý počíta ten istý predikát ako jej zoznam (lib/queries/pipeline – wave 3 §7).
// Žije tu (nie v queries), aby to mohli importovať klientske komponenty bez ťahania Prisma klienta.
export const DEAL_VIEWS = [
    // Úlohy pre manažéra (wave 3): „Pre mňa" = moja schránka (len manažér), „Čakám na manažéra" = moje obchody so zámkom.
    { key: "inbox", label: "Pre mňa", group: "tasks" },
    { key: "waiting_manager", label: "Čakám na manažéra", group: "tasks" },
    // Otvorené sľuby klientovi, ktoré vlastník vie riešiť teraz. Po otvorení manažérskej úlohy sa obchod
    // presunie do „Čakám na manažéra"; po vrátení ceny / návrhu sa sem vráti, kým ich klient nedostane.
    { key: "work", label: "Na spracovanie", group: "focus" },
    { key: "today", label: "Na dnes", group: "focus" },
    // Druh kroku – vo filtri je to úroveň 2 (`step`), staré adresy `?view=call` ostávajú platné a znamenajú „Všetko + krok".
    { key: "call", label: "Volať", group: "todo" },
    { key: "quote", label: "Poslať cenu", group: "todo" },
    { key: "design", label: "Poslať návrh", group: "todo" },
    { key: "email", label: "Poslať email", group: "todo" },
    { key: "waiting", label: "Čaká na klienta", group: "todo" },
    // Čo klient už má (round 2 §2c) – podľa nových záznamov OFFER_SENT, nie podľa starých polí.
    { key: "got_pricelist", label: "Dostali cenník", group: "running" },
    { key: "got_price", label: "Dostali cenu", group: "running" },
    { key: "got_design", label: "Dostali návrh", group: "running" },
    // Staré obchody, ktorých odoslania ešte manažér neoveril (zobrazuje sa len manažérovi).
    { key: "unverified", label: "Neoverené", group: "legacy" },
] as const;

export type DealViewKey = (typeof DEAL_VIEWS)[number]["key"];

// Úroveň 2: druh ďalšieho kroku, v poradí, v akom sa ukazuje.
export const DEAL_STEPS = [
    { key: "call", label: "Volať" },
    { key: "quote", label: "Poslať cenu" },
    { key: "design", label: "Poslať návrh" },
    { key: "email", label: "Poslať email" },
    { key: "waiting", label: "Čaká na klienta" },
] as const;
export type DealStepKey = (typeof DEAL_STEPS)[number]["key"];

const VIEW_KEYS = new Set<string>(DEAL_VIEWS.map((v) => v.key));
const CROSS_STATUS_VIEWS = new Set<string>(["work", "today", "unverified", "waiting_manager", "inbox"]);
// Druhy kroku – zamknutý obchod v nich nie je (je v „Čakám na manažéra", §5.3).
export const STEP_KIND_VIEWS = new Set<string>(DEAL_STEPS.map((s) => s.key));
// Rady, v ktorých druh kroku nedáva zmysel: zamknutý obchod nemá krok a schránka nie je výsek mojich obchodov.
const NO_STEP_VIEWS = new Set<string>(["waiting_manager", "inbox"]);

export function isDealView(value: string | undefined): value is DealViewKey {
    return Boolean(value && VIEW_KEYS.has(value));
}

export function isDealStep(value: string | undefined): value is DealStepKey {
    return Boolean(value && STEP_KIND_VIEWS.has(value));
}

export function viewIgnoresStatus(view: string | undefined): boolean {
    return Boolean(view && CROSS_STATUS_VIEWS.has(view));
}

export function viewAllowsStep(view: string | undefined): boolean {
    return !view || !NO_STEP_VIEWS.has(view);
}

// Rady a kroky sú len pri „Aktívne".
export function statusHasQueues(filter: string): boolean {
    return filter === DEFAULT_STATUS_KEY;
}

export type DealFilterParams = {
    filter: string;
    view: string;
    step?: string; // úroveň 2 – druh ďalšieho kroku
    owner: string;
    q?: string;
    from?: string; // handedOffById – „od koho obchod prišiel"
    limit?: number;
};

type RawParams = {
    filter?: string;
    view?: string;
    step?: string;
    owner?: string;
    q?: string;
    from?: string;
    limit?: string;
};

const STATUS_KEYS = new Set<string>(DEAL_STATUS_TABS.map((t) => t.key));

export function parseDealParams(raw: RawParams): DealFilterParams {
    const limit = Number(raw.limit);
    // Stará adresa `?view=quote` = „Všetko" s krokom „Poslať cenu".
    const filter = raw.filter && STATUS_KEYS.has(raw.filter) ? raw.filter : DEFAULT_STATUS_KEY;
    const legacyStep = isDealStep(raw.view) ? raw.view : undefined;
    // Iný stav než „Aktívne" = obyčajný zoznam, žiadny rad ani krok.
    const view = !statusHasQueues(filter) ? NO_VIEW : legacyStep ? NO_VIEW : (raw.view ?? DEFAULT_VIEW);
    const step = statusHasQueues(filter) ? (legacyStep ?? (isDealStep(raw.step) ? raw.step : undefined)) : undefined;
    return {
        filter,
        view,
        step: viewAllowsStep(view) ? step : undefined,
        owner: raw.owner ?? DEFAULT_OWNER,
        q: raw.q?.trim() || undefined,
        from: raw.from || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    };
}

// „auto" sa rozhodne podľa práce: čo je na spracovanie, to je prvé; keď nič, tak dnešné termíny.
export function resolveView(view: string, counts: { work: number }): string {
    return view === AUTO_VIEW ? (counts.work > 0 ? "work" : "today") : view;
}

export function statusOf(params: DealFilterParams): LeadStatus | undefined {
    return DEAL_STATUS_TABS.find((t) => t.key === params.filter)?.status;
}

// „all" = bez pohľadu; do dotazu ide undefined.
export function viewOf(params: DealFilterParams): string | undefined {
    return params.view === NO_VIEW ? undefined : params.view;
}

// Odkaz na obrazovku obchodov so zmenenými parametrami. Zmena filtra vždy ruší stránkovanie (limit).
// Druh kroku prežije zmenu radu (Na dnes ⇄ Všetko), ale nie prechod do radu, kde nemá zmysel.
export function dealsHref(current: DealFilterParams, patch: Partial<DealFilterParams> = {}): string {
    const next = { ...current, ...patch };
    if (!("limit" in patch)) next.limit = undefined;
    // Zmena stavu: späť na „Aktívne" sa rad vyberie znova podľa práce, iný stav je obyčajný zoznam.
    if ("filter" in patch && patch.filter !== current.filter) {
        next.view = statusHasQueues(next.filter) ? (patch.view ?? AUTO_VIEW) : NO_VIEW;
        next.step = undefined;
    }
    if (!statusHasQueues(next.filter) || !viewAllowsStep(next.view)) next.step = undefined;
    const params = new URLSearchParams();
    if (next.filter !== DEFAULT_STATUS_KEY) params.set("filter", next.filter);
    if (next.view !== DEFAULT_VIEW && statusHasQueues(next.filter)) params.set("view", next.view); // iný stav = obyčajný zoznam
    if (next.step) params.set("step", next.step);
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
    return dealsHref(current, { view: "inbox", owner: DEFAULT_OWNER, filter: DEFAULT_STATUS_KEY, from: undefined, step: undefined });
}
