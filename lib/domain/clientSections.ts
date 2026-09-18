import type { LeadStatus, NextActionKind, NextActionMode } from "@/app/generated/prisma/enums";
import {
    addBusinessCalendarDays,
    businessDate,
    businessDayStart,
    isDueByBusinessDay,
    isOverdue,
} from "@/lib/domain/businessTime";

// Úplná klasifikácia obchodu do sekcie na obrazovke obchodov. Čistá funkcia bez DB:
// pravidlá zhora nadol, prvá zhoda vyhráva, každý obchod dostane práve jednu sekciu.

export const CLIENT_SECTIONS = [
    "TODAY",
    "WAITING_ON_US",
    "IN_PROGRESS",
    "PLANNED",
    "WAITING_ON_CLIENT",
    "SNOOZED",
    "CLOSED_RECENT",
] as const;

export type ClientSection = (typeof CLIENT_SECTIONS)[number] | "ARCHIVED";

export const CLIENT_SECTION_LABEL: Record<ClientSection, string> = {
    TODAY: "Na dnes",
    WAITING_ON_US: "Čaká na nás",
    IN_PROGRESS: "Rozpracované",
    PLANNED: "Naplánované",
    WAITING_ON_CLIENT: "Čaká na klienta",
    SNOOZED: "Spiace",
    CLOSED_RECENT: "Uzavreté",
    ARCHIVED: "Archív",
};

export type ClassifiableDeal = {
    status: LeadStatus;
    nextActionKind: NextActionKind | null;
    nextActionAt: Date | null;
    nextActionHasTime: boolean;
    nextActionMode: NextActionMode;
    closedAt: Date | null;
    openRequestCount: number;
};

export type Classification = { section: ClientSection; badge?: string };

export const RECENT_CLOSED_DAYS = 90;

export function recentClosedLimit(now: Date): Date {
    return businessDayStart(addBusinessCalendarDays(businessDate(now), -RECENT_CLOSED_DAYS));
}

export function clientSection(deal: ClassifiableDeal, now: Date = new Date()): Classification {
    const due = () => deal.nextActionAt !== null && isDueByBusinessDay(deal.nextActionAt, deal.nextActionHasTime, now);

    // 1. uzavreté
    if (deal.status === "WON" || deal.status === "LOST" || deal.status === "UNREACHABLE") {
        // closedAt je po backfille vždy nastavené; null sa berie ako archív, nikdy ako nedávne
        if (deal.closedAt && deal.closedAt.getTime() >= recentClosedLimit(now).getTime()) return { section: "CLOSED_RECENT" };
        return { section: "ARCHIVED" };
    }
    if (deal.status !== "ACTIVE" && deal.status !== "SNOOZED") {
        if (process.env.NODE_ENV !== "production") throw new Error(`Neplatný stav obchodu: ${deal.status}`);
        return { section: "TODAY", badge: "neplatný stav" };
    }
    // 2. otvorená požiadavka
    if (deal.openRequestCount > 0) return { section: "WAITING_ON_US" };
    // 3. spiace
    if (deal.status === "SNOOZED") {
        if (deal.nextActionAt === null) return { section: "TODAY", badge: "chýba dátum" };
        if (due()) return { section: "TODAY", badge: "zobudený" };
        return { section: "SNOOZED" };
    }
    // 4.–9. aktívne
    if (deal.nextActionKind === null) return { section: "TODAY", badge: "bez ďalšieho kroku" };
    if (deal.nextActionMode === "IN_PROGRESS") return { section: "IN_PROGRESS" };
    if (deal.nextActionKind === "WAITING_FOR_CLIENT") {
        if (deal.nextActionAt !== null && due()) return { section: "TODAY", badge: "skontrolovať" };
        return { section: "WAITING_ON_CLIENT" };
    }
    if (deal.nextActionAt === null) return { section: "TODAY", badge: "bez termínu" };
    if (due()) return { section: "TODAY" };
    return { section: "PLANNED" };
}

export function isDealOverdue(deal: Pick<ClassifiableDeal, "nextActionAt" | "nextActionHasTime" | "nextActionMode">, now: Date = new Date()) {
    return deal.nextActionMode === "SCHEDULED" && deal.nextActionAt !== null && isOverdue(deal.nextActionAt, deal.nextActionHasTime, now);
}
