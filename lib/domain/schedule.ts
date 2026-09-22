import { z } from "zod";
import {
    addBusinessCalendarDays,
    addBusinessCalendarMonths,
    businessDate,
    businessDayStart,
    isValidBusinessDate,
    isValidWallTime,
    wallTimeToInstant,
} from "@/lib/domain/businessTime";

// Termín z klienta. Prehliadač nikdy neposiela okamihy pre deň-only termíny; server ich prepočíta v Europe/Bratislava.
export type Schedule =
    | { kind: "inHours"; hours: number } // „O hodinu" → okamih now + h, hasTime true
    | { kind: "day"; date: string } // len deň → 00:00 Europe/Bratislava, hasTime false
    | { kind: "dayTime"; date: string; time: string } // wall time Europe/Bratislava → okamih, hasTime true
    | { kind: "daysFromToday"; days: number } // „Zajtra" = 1, „O týždeň" = 7, hasTime false
    | { kind: "monthsFromToday"; months: number }; // snooze predvoľby, hasTime false

const dateString = z.string().refine(isValidBusinessDate, "Neplatný dátum.");

export const scheduleSchema: z.ZodType<Schedule> = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inHours"), hours: z.number().int().min(1).max(24) }),
    z.object({ kind: z.literal("day"), date: dateString }),
    z.object({
        kind: z.literal("dayTime"),
        date: dateString,
        time: z.string().refine(isValidWallTime, "Neplatný čas."),
    }),
    z.object({ kind: z.literal("daysFromToday"), days: z.number().int().min(0).max(366) }),
    z.object({ kind: z.literal("monthsFromToday"), months: z.number().int().min(1).max(24) }),
]);

export function resolveSchedule(schedule: Schedule, now: Date = new Date()): { at: Date; hasTime: boolean } {
    switch (schedule.kind) {
        case "inHours":
            return { at: new Date(now.getTime() + schedule.hours * 3_600_000), hasTime: true };
        case "day":
            return { at: businessDayStart(schedule.date), hasTime: false };
        case "dayTime":
            return { at: wallTimeToInstant(schedule.date, schedule.time), hasTime: true };
        case "daysFromToday":
            return { at: businessDayStart(addBusinessCalendarDays(businessDate(now), schedule.days)), hasTime: false };
        case "monthsFromToday":
            return {
                at: businessDayStart(addBusinessCalendarMonths(businessDate(now), schedule.months)),
                hasTime: false,
            };
    }
}

// Deň-only termín (snooze): len `day` alebo `monthsFromToday`.
export function isDayOnlySnooze(schedule: Schedule): boolean {
    return schedule.kind === "day" || schedule.kind === "monthsFromToday";
}
