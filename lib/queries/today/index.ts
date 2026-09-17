import prisma from "@/lib/db";
import type { AccessUser } from "@/lib/access/user";
import {
    addBusinessCalendarDays,
    addBusinessCalendarMonths,
    businessDate,
    businessDayEnd,
    businessDayStart,
    isOverdue,
} from "@/lib/domain/businessTime";
import { can } from "@/lib/permissions";
import { POOL_WHERE, callWorkWhere } from "@/lib/queries/calls";

// Dashboard „Dnes" – všetko rozdelené podľa zodpovednosti (plán §9). Dni v obchodnom kalendári Europe/Bratislava.

export type TodayUrgentItem = {
    id: string;
    number: number;
    name: string;
    phone: string | null;
    kind: "callback" | "deal";
    href: string | null;
    at: string | null;
    hasTime: boolean;
    note: string | null;
    overdue: boolean;
};

function name(l: { companyName: string | null; website: string | null }) {
    return l.companyName ?? l.website ?? "—";
}

// Okno kalendára: predošlý mesiac … +3 mesiace (obchodné dátumy).
function calendarWindow(now: Date) {
    const today = businessDate(now);
    const firstOfMonth = `${today.slice(0, 8)}01`;
    const start = businessDayStart(addBusinessCalendarMonths(firstOfMonth, -1));
    const end = businessDayStart(addBusinessCalendarMonths(firstOfMonth, 4));
    return { start, end };
}

// ── Volajúci: vlastná dávka, fronta, callbacky, retry ────────────────────────
export async function getCallerToday(user: Pick<AccessUser, "id">) {
    const now = new Date();
    const end = businessDayEnd(now);
    const mine = callWorkWhere(user.id);
    const { start, end: calEnd } = calendarWindow(now);

    const [batchCount, poolCount, retryCount, callbacks, planned] = await Promise.all([
        prisma.lead.count({ where: { ...mine, status: "NEW" } }),
        prisma.lead.count({ where: POOL_WHERE }),
        prisma.lead.count({ where: { ...mine, status: "CALLING", callbackKind: "RETRY" } }),
        prisma.lead.findMany({
            where: {
                ...mine,
                OR: [
                    { status: "CALLING", callbackKind: "SCHEDULED", callbackAt: { lte: end } },
                    { status: "SNOOZED", callbackAt: { lte: end } },
                ],
            },
            select: { id: true, number: true, companyName: true, website: true, phone: true, callbackAt: true, callbackHasTime: true, callbackNote: true },
            orderBy: { callbackAt: "asc" },
            take: 50,
        }),
        prisma.lead.findMany({
            where: { ...mine, status: { in: ["CALLING", "SNOOZED"] }, callbackAt: { gte: start, lt: calEnd } },
            select: { callbackAt: true },
        }),
    ]);

    const urgent: TodayUrgentItem[] = callbacks.map((l) => ({
        id: l.id,
        number: l.number,
        name: name(l),
        phone: l.phone,
        kind: "callback",
        href: null,
        at: l.callbackAt?.toISOString() ?? null,
        hasTime: l.callbackHasTime,
        note: l.callbackNote,
        overdue: l.callbackAt ? isOverdue(l.callbackAt, l.callbackHasTime, now) : false,
    }));

    const calendar: Record<string, number> = {};
    for (const l of planned) {
        if (!l.callbackAt) continue;
        const key = businessDate(l.callbackAt);
        calendar[key] = (calendar[key] ?? 0) + 1;
    }

    return {
        batchCount,
        poolCount,
        retryCount,
        callbacksDue: urgent.filter((u) => !u.overdue).length,
        callbacksOverdue: urgent.filter((u) => u.overdue).length,
        urgent,
        calendar,
    };
}

// ── Obchody: vlastné (clients.view) alebo všetky (pipeline.view) ─────────────
export async function getDealsToday(user: AccessUser) {
    const now = new Date();
    const end = businessDayEnd(now);
    const all = can(user, "pipeline.view");
    if (!all && !can(user, "clients.view")) return null;
    const scope = {
        deletedAt: null,
        pipelineEnteredAt: { not: null },
        status: { in: ["ACTIVE" as const, "SNOOZED" as const] },
        ...(all ? {} : { ownerId: user.id }),
    };
    const { start, end: calEnd } = calendarWindow(now);

    const [due, openCount, planned] = await Promise.all([
        prisma.lead.findMany({
            where: { ...scope, nextActionMode: "SCHEDULED", nextActionAt: { lte: end } },
            select: {
                id: true,
                number: true,
                companyName: true,
                website: true,
                phone: true,
                nextActionAt: true,
                nextActionHasTime: true,
                nextActionNote: true,
                owner: { select: { firstName: true } },
            },
            orderBy: { nextActionAt: "asc" },
            take: 50,
        }),
        prisma.lead.count({ where: scope }),
        prisma.lead.findMany({
            where: { ...scope, nextActionAt: { gte: start, lt: calEnd } },
            select: { nextActionAt: true },
        }),
    ]);

    const urgent: TodayUrgentItem[] = due.map((l) => ({
        id: l.id,
        number: l.number,
        name: name(l),
        phone: l.phone,
        kind: "deal",
        href: all ? `/dashboard/pipeline/${l.id}` : `/dashboard/clients/${l.id}`,
        at: l.nextActionAt?.toISOString() ?? null,
        hasTime: l.nextActionHasTime,
        note: all && l.owner ? `${l.owner.firstName}: ${l.nextActionNote ?? ""}` : l.nextActionNote,
        overdue: l.nextActionAt ? isOverdue(l.nextActionAt, l.nextActionHasTime, now) : false,
    }));

    const calendar: Record<string, number> = {};
    for (const l of planned) {
        if (!l.nextActionAt) continue;
        const key = businessDate(l.nextActionAt);
        calendar[key] = (calendar[key] ?? 0) + 1;
    }

    return {
        scope: all ? ("all" as const) : ("own" as const),
        openCount,
        dueCount: urgent.filter((u) => !u.overdue).length,
        overdueCount: urgent.filter((u) => u.overdue).length,
        urgent,
        calendar,
    };
}

export function todayKey(now: Date = new Date()): string {
    return businessDate(now);
}

export function weekStartKey(now: Date = new Date()): string {
    const today = businessDate(now);
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = nedeľa
    return addBusinessCalendarDays(today, weekday === 0 ? -6 : 1 - weekday);
}
