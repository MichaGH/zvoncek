// Zdieľaná logika "ako urgentný je naplánovaný termín".
// Používa to /dashboard/calls (callbackAt + callbackHasTime) aj pipeline
// (nextActionAt + nextActionHasTime) – cez komponent <UrgencyLabel/>.

export type Urgency = "future" | "soon" | "due" | "late";

// Koľko minút pred presným časom sa rozsvieti "blíži sa".
const SOON_WINDOW_MIN = 30;
// Koľko hodín po presnom čase ostáva "due", než prejde do "late".
const LATE_AFTER_HOURS = 1;

function startOfDay(d: Date): Date {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function sameDay(a: Date, b: Date): boolean {
    return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function urgencyOf(
    at: Date | string | null,
    hasTime: boolean,
    now: Date = new Date(),
): Urgency {
    if (!at) return "future";
    const target = typeof at === "string" ? new Date(at) : at;

    if (hasTime) {
        const diffMin = (target.getTime() - now.getTime()) / 60_000;
        if (diffMin > SOON_WINDOW_MIN) return "future";
        if (diffMin > 0) return "soon";
        const lateHours = -diffMin / 60;
        return lateHours > LATE_AFTER_HOURS ? "late" : "due";
    }

    // Len deň – čas termínu sa ignoruje, porovnávajú sa kalendárne dni.
    const today = startOfDay(now);
    const day = startOfDay(target);
    if (today < day) return "future";
    if (today.getTime() === day.getTime()) return "due"; // celý dnešný deň
    return "late"; // deň po termíne a viac
}

export const URGENCY_TEXT: Record<Urgency, string> = {
    future: "text-muted-foreground",
    soon: "font-medium text-amber-600 dark:text-amber-500",
    due: "font-semibold text-destructive",
    late: "font-semibold text-destructive",
};

// Rozpracované akcie (nextActionMode = IN_PROGRESS) – nemajú termín, ale nie sú
// ani „obyčajné". Modrá: pokojná, no viditeľná. Ráta sa, koľko dní to už trvá.
export const PROGRESS_TEXT = "font-medium text-blue-600 dark:text-blue-400";

function dayWord(n: number): string {
    if (n === 1) return "deň";
    if (n >= 2 && n <= 4) return "dni";
    return "dní";
}

// „trvá X dní" – počet dní odkedy sa akcia začala (nextActionAt = dátum začatia).
export function fmtProgress(iso: string | null, now: Date = new Date()): string | null {
    if (!iso) return "rozpracované";
    const start = new Date(iso);
    const days = Math.round(
        (startOfDay(now).getTime() - startOfDay(start).getTime()) / 86_400_000,
    );
    if (days <= 0) return "dnes";
    return `trvá ${days} ${dayWord(days)}`;
}

// Kategorické poradie pre pipeline tabuľku:
//   0 = urgentné (termín meškáš/dnes/blíži sa)
//   1 = rozpracované (IN_PROGRESS – návrhy)
//   2 = budúce naplánované (termín v budúcnosti)
//   3 = čaká sa / bez termínu (krok bez dátumu)
//   4 = žiadny ďalší krok
// Druhotne (tie-break) vraciame čas v ms: pri urgentných/budúcich najskôr najbližší
// termín, pri rozpracovaných najskôr najstaršie (najdlhšie trvá).
export function nextActionSort(
    mode: "SCHEDULED" | "IN_PROGRESS",
    kind: string | null,
    at: string | null,
    hasTime: boolean,
    now: Date = new Date(),
): { rank: number; tie: number } {
    if (!kind) return { rank: 4, tie: 0 };
    if (mode === "IN_PROGRESS") {
        // najstaršie začaté = najvyššie v rámci skupiny
        return { rank: 1, tie: at ? new Date(at).getTime() : 0 };
    }
    if (at) {
        const u = urgencyOf(at, hasTime, now);
        const tie = new Date(at).getTime();
        if (u === "future") return { rank: 2, tie };
        return { rank: 0, tie }; // soon/due/late
    }
    return { rank: 3, tie: 0 }; // krok bez dátumu (napr. WAITING_FOR_CLIENT)
}

// Textový label pre termín. Pri due/late sa presný čas (príp. dátum) ukáže v zátvorke:
//   dnes / dnes 23:50 · teraz (23:45) · včera (15.6.) / včera (15.6. 23:20)
//   meškáš 10d (10.6.) / meškáš 10d (10.6. 23:20)
export function fmtCallback(
    iso: string | null,
    hasTime: boolean,
    urgency: Urgency,
    now: Date = new Date(),
): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    const dateShort = `${d.getDate()}.${d.getMonth() + 1}.`;
    const detail = hasTime ? `${dateShort} ${time}` : dateShort;

    const dayLabel = () => {
        if (sameDay(d, now)) return "dnes";
        const tmr = new Date(now);
        tmr.setDate(tmr.getDate() + 1);
        if (sameDay(d, tmr)) return "zajtra";
        return dateShort;
    };

    if (urgency === "due") return hasTime ? `teraz (${time})` : "dnes";

    if (urgency === "late") {
        const dayDiff = Math.round(
            (startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000,
        );
        if (dayDiff <= 0) {
            // presný čas, ešte v rámci dňa termínu
            const h = Math.floor((now.getTime() - d.getTime()) / 3_600_000);
            const base = h < 1 ? "meškáš" : `meškáš ${h}h`;
            return hasTime ? `${base} (${time})` : base;
        }
        if (dayDiff === 1) return `včera (${detail})`;
        return `meškáš ${dayDiff}d (${detail})`;
    }

    // future / soon
    return hasTime ? `${dayLabel()} ${time}` : dayLabel();
}
