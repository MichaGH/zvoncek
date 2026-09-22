// Chybové kódy akcií (plán §10.2). Klient obnoví stránku pri NOT_ASSIGNED / NOT_FOUND / STALE / DEAL_CLOSED /
// IDEMPOTENCY_CONFLICT / STEP_LOCKED a ponúkne „Skúsiť znova" len pri RETRYABLE a chybe siete.
// Wave 3: STEP_LOCKED = krok čaká na úlohu pre manažéra; TASK_OVERLAP = odoslanie sa kryje s otvorenou úlohou a chýba
// voľba; RESULT_PENDING = vrátená cena / návrh ešte nie je poslaná ani odmietnutá, krok musí ostať „Poslať …".
export type ActionCode =
    | "UNAUTHENTICATED"
    | "NOT_ASSIGNED"
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "STALE"
    | "DEAL_CLOSED"
    | "IDEMPOTENCY_CONFLICT"
    | "RETRYABLE"
    | "STEP_LOCKED"
    | "TASK_OVERLAP"
    | "RESULT_PENDING";

export type ActionError = { error: string; code?: ActionCode };

const DEFAULT_MESSAGE: Record<ActionCode, string> = {
    UNAUTHENTICATED: "Nie si prihlásený.",
    NOT_ASSIGNED: "Kontakt sa medzitým zmenil – obnovujem.",
    NOT_FOUND: "Nenašlo sa.",
    FORBIDDEN: "Nemáš oprávnenie.",
    STALE: "Kontakt sa medzitým zmenil – obnovujem.",
    DEAL_CLOSED: "Obchod je uzavretý.",
    IDEMPOTENCY_CONFLICT: "Kontakt sa medzitým zmenil – obnovujem.",
    RETRYABLE: "Niekto práve pracuje s tými istými dátami – skús znova o chvíľu.",
    STEP_LOCKED: "Krok čaká na úlohu pre manažéra.",
    TASK_OVERLAP: "Toto sa kryje s otvorenou úlohou pre manažéra – vyber, čo s ňou.",
    RESULT_PENDING: "Vrátená cena / návrh ešte nie je poslaná – krok ostáva „Poslať…“, kým ju nepošleš alebo neodmietneš.",
};

export class AccessError extends Error {
    constructor(
        public code: ActionCode,
        message?: string,
    ) {
        super(message ?? DEFAULT_MESSAGE[code]);
        this.name = "AccessError";
    }
}

export const UNAUTHENTICATED: ActionError = { error: DEFAULT_MESSAGE.UNAUTHENTICATED, code: "UNAUTHENTICATED" };
export const FORBIDDEN: ActionError = { error: DEFAULT_MESSAGE.FORBIDDEN, code: "FORBIDDEN" };

// Postgres: 40P01 deadlock, 55P03 lock_not_available (lock_timeout), 40001 serialization failure.
// Prisma: P2034 write conflict/deadlock, P2028 transaction API error (napr. maxWait/timeout).
const RETRYABLE_CODES = new Set(["40P01", "55P03", "40001", "P2034", "P2028"]);
const RETRYABLE_TEXT = /deadlock detected|lock timeout|canceling statement due to lock timeout|could not obtain lock|Transaction already closed|Unable to start a transaction/i;

export function isRetryableDbError(error: unknown, depth = 0): boolean {
    if (!error || typeof error !== "object" || depth > 5) return false;
    const e = error as Record<string, unknown>;
    for (const key of ["code", "originalCode"]) {
        if (typeof e[key] === "string" && RETRYABLE_CODES.has(e[key] as string)) return true;
    }
    if (typeof e.message === "string" && RETRYABLE_TEXT.test(e.message)) return true;
    for (const key of ["cause", "meta", "error"]) {
        if (e[key] && isRetryableDbError(e[key], depth + 1)) return true;
    }
    return false;
}

export function isUniqueViolation(error: unknown, depth = 0): boolean {
    if (!error || typeof error !== "object" || depth > 5) return false;
    const e = error as Record<string, unknown>;
    if (e.code === "P2002" || e.code === "23505" || e.originalCode === "23505") return true;
    for (const key of ["cause", "meta", "error"]) {
        if (e[key] && isUniqueViolation(e[key], depth + 1)) return true;
    }
    return false;
}

// Premapuje výnimku z transakcie na odpoveď akcie. Neznáme chyby zaloguje a vráti generickú správu.
export function toActionError(error: unknown, fallback: string, label: string): ActionError {
    if (error instanceof AccessError) return { error: error.message, code: error.code };
    if (isRetryableDbError(error)) return { error: DEFAULT_MESSAGE.RETRYABLE, code: "RETRYABLE" };
    console.error(`${label} failed:`, error);
    return { error: fallback };
}
