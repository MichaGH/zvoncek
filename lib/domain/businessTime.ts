// Obchodný kalendár: všetko, čo znamená „deň" (dnes, zajtra, +7 dní, ďalší pracovný deň, po termíne),
// sa počíta v Europe/Bratislava – nezávisle od časovej zóny servera či prehliadača. Bez závislostí, DST-safe.
//
// Konvencia ukladania:
// - len deň (*HasTime = false): ukladá sa businessDayStart(date); pri čítaní sa porovnáva LEN businessDate(at)
//   (staré hodnoty o 09:00 lokálne alebo o polnoci UTC tak padnú na správny deň)
// - presný čas (*HasTime = true): ukladá sa okamih; porovnávajú sa okamihy

export const BUSINESS_TZ = "Europe/Bratislava";

const DAY_MS = 86_400_000;

const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

const partsFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});

function wallParts(instant: Date) {
    const parts: Record<string, number> = {};
    for (const p of partsFmt.formatToParts(instant)) {
        if (p.type !== "literal") parts[p.type] = Number(p.value);
    }
    return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

// Posun zóny v ms pre daný okamih (wall time − UTC).
function zoneOffsetMs(instantMs: number): number {
    const p = wallParts(new Date(instantMs));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(instantMs / 1000) * 1000;
}

function parseDate(date: string): { y: number; m: number; d: number } {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error(`Neplatný dátum: ${date}`);
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
        throw new Error(`Neplatný dátum: ${date}`);
    }
    return { y, m, d };
}

function fmtDate(y: number, m: number, d: number): string {
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function isValidBusinessDate(date: string): boolean {
    try {
        parseDate(date);
        return true;
    } catch {
        return false;
    }
}

export function isValidWallTime(time: string): boolean {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
}

// "YYYY-MM-DD" v obchodnej zóne.
export function businessDate(instant: Date): string {
    return dateFmt.format(instant);
}

// Wall time v obchodnej zóne → okamih.
export function wallTimeToInstant(date: string, time: string): Date {
    const { y, m, d } = parseDate(date);
    if (!isValidWallTime(time)) throw new Error(`Neplatný čas: ${time}`);
    const [hh, mm] = time.split(":").map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const first = guess - zoneOffsetMs(guess);
    const second = guess - zoneOffsetMs(first);
    return new Date(second);
}

// Okamih 00:00 obchodnej zóny v daný deň.
export function businessDayStart(date: string): Date {
    return wallTimeToInstant(date, "00:00");
}

export function addBusinessCalendarDays(date: string, n: number): string {
    const { y, m, d } = parseDate(date);
    const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
    return fmtDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// Posledná ms obchodného dňa, do ktorého patrí okamih.
export function businessDayEnd(instant: Date): Date {
    return new Date(businessDayStart(addBusinessCalendarDays(businessDate(instant), 1)).getTime() - 1);
}

export function businessTodayStart(now: Date = new Date()): Date {
    return businessDayStart(businessDate(now));
}

// 31.1. + 1 mesiac → 28./29.2.
export function addBusinessCalendarMonths(date: string, n: number): string {
    const { y, m, d } = parseDate(date);
    const totalMonths = y * 12 + (m - 1) + n;
    const ny = Math.floor(totalMonths / 12);
    const nm = totalMonths - ny * 12 + 1;
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return fmtDate(ny, nm, Math.min(d, lastDay));
}

// 0 = nedeľa … 6 = sobota
export function businessWeekday(date: string): number {
    const { y, m, d } = parseDate(date);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Ďalší pracovný deň (Po–Pi) po dnešku. Sviatky sa v v1 ignorujú.
export function nextBusinessWorkingDayStart(now: Date = new Date()): Date {
    let date = addBusinessCalendarDays(businessDate(now), 1);
    while ([0, 6].includes(businessWeekday(date))) date = addBusinessCalendarDays(date, 1);
    return businessDayStart(date);
}

// Počet kalendárnych dní medzi obchodnými dátumami (b − a).
export function businessDaysBetween(a: Date, b: Date): number {
    const pa = parseDate(businessDate(a));
    const pb = parseDate(businessDate(b));
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

// „Na dnes": deň-only podľa obchodného dátumu; presný čas kedykoľvek do konca dnešného obchodného dňa.
export function isDueByBusinessDay(at: Date, hasTime: boolean, now: Date = new Date()): boolean {
    if (hasTime) return at.getTime() <= businessDayEnd(now).getTime();
    return businessDate(at) <= businessDate(now);
}

// Po termíne: deň-only keď je obchodný dátum pred dneškom; presný čas keď okamih uplynul.
export function isOverdue(at: Date, hasTime: boolean, now: Date = new Date()): boolean {
    if (hasTime) return at.getTime() < now.getTime();
    return businessDate(at) < businessDate(now);
}

// Zobrazenie v obchodnej zóne (server aj klient vypíšu to isté).
export function businessHm(instant: Date): string {
    const p = wallParts(instant);
    return `${p.hour}:${String(p.minute).padStart(2, "0")}`;
}

export function businessDayMonth(instant: Date): string {
    const p = wallParts(instant);
    return `${p.day}.${p.month}.`;
}

export function formatBusinessDateTime(instant: Date, hasTime = true): string {
    const p = wallParts(instant);
    const date = `${p.day}. ${p.month}. ${p.year}`;
    return hasTime ? `${date} ${p.hour}:${String(p.minute).padStart(2, "0")}` : date;
}

// Hodnoty pre <input type="date"> / <input type="time"> v obchodnej zóne.
export function businessInputParts(instant: Date): { date: string; time: string } {
    const p = wallParts(instant);
    return { date: businessDate(instant), time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` };
}
