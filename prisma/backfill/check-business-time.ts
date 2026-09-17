// Samokontrola obchodného kalendára (len lokálne / branch). Spusti aj s TZ=UTC – výsledky musia byť rovnaké.
//   npx tsx prisma/backfill/check-business-time.ts
//   $env:TZ="UTC"; npx tsx prisma/backfill/check-business-time.ts
import {
    addBusinessCalendarDays,
    addBusinessCalendarMonths,
    businessDate,
    businessDayEnd,
    businessDayStart,
    businessTodayStart,
    isDueByBusinessDay,
    isOverdue,
    nextBusinessWorkingDayStart,
    wallTimeToInstant,
} from "../../lib/domain/businessTime";
import { resolveSchedule } from "../../lib/domain/schedule";

let failed = 0;
function eq(label: string, actual: unknown, expected: unknown) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}
const iso = (d: Date) => d.toISOString();

console.log(`process TZ offset now: ${new Date().getTimezoneOffset()} min`);

// DST jar 2026-03-29 (02:00 → 03:00), jeseň 2026-10-25 (03:00 → 02:00)
eq("dayStart 2026-03-29 (CET)", iso(businessDayStart("2026-03-29")), "2026-03-28T23:00:00.000Z");
eq("dayStart 2026-03-30 (CEST)", iso(businessDayStart("2026-03-30")), "2026-03-29T22:00:00.000Z");
eq("dayEnd of 2026-03-29", iso(businessDayEnd(new Date("2026-03-29T12:00:00Z"))), "2026-03-29T21:59:59.999Z");
eq("dayStart 2026-10-25 (CEST)", iso(businessDayStart("2026-10-25")), "2026-10-24T22:00:00.000Z");
eq("dayStart 2026-10-26 (CET)", iso(businessDayStart("2026-10-26")), "2026-10-25T23:00:00.000Z");
eq("dayEnd of 2026-10-25 (25h day)", iso(businessDayEnd(new Date("2026-10-25T12:00:00Z"))), "2026-10-25T22:59:59.999Z");
eq("wall 2026-10-26 13:00", iso(wallTimeToInstant("2026-10-26", "13:00")), "2026-10-26T12:00:00.000Z");
eq("wall 2026-07-01 13:00", iso(wallTimeToInstant("2026-07-01", "13:00")), "2026-07-01T11:00:00.000Z");
eq("businessDate 2026-09-16T22:30Z = 17th", businessDate(new Date("2026-09-16T22:30:00Z")), "2026-09-17");
eq("businessDate 2026-09-16T21:59Z = 16th", businessDate(new Date("2026-09-16T21:59:00Z")), "2026-09-16");

// +7 across DST
eq("+7 from 2026-10-20", addBusinessCalendarDays("2026-10-20", 7), "2026-10-27");
eq("dayStart(+7 from 2026-10-20)", iso(businessDayStart(addBusinessCalendarDays("2026-10-20", 7))), "2026-10-26T23:00:00.000Z");
eq("+1 month 2026-01-31", addBusinessCalendarMonths("2026-01-31", 1), "2026-02-28");
eq("+1 month 2028-01-31 (leap)", addBusinessCalendarMonths("2028-01-31", 1), "2028-02-29");
eq("+6 months 2026-08-31", addBusinessCalendarMonths("2026-08-31", 6), "2027-02-28");
eq("+2 months 2026-11-15", addBusinessCalendarMonths("2026-11-15", 2), "2027-01-15");
eq("-90 days 2026-09-17", addBusinessCalendarDays("2026-09-17", -90), "2026-06-19");

// next working day (2026-09-18 = Friday)
eq("next working from Fri 2026-09-18 10:00", businessDate(nextBusinessWorkingDayStart(new Date("2026-09-18T08:00:00Z"))), "2026-09-21");
eq("next working from Sat 2026-09-19", businessDate(nextBusinessWorkingDayStart(new Date("2026-09-19T08:00:00Z"))), "2026-09-21");
eq("next working from Sun 2026-09-20", businessDate(nextBusinessWorkingDayStart(new Date("2026-09-20T08:00:00Z"))), "2026-09-21");
eq("next working from Thu 2026-09-17", businessDate(nextBusinessWorkingDayStart(new Date("2026-09-17T08:00:00Z"))), "2026-09-18");
eq("next working from Fri 23:30 Bratislava", businessDate(nextBusinessWorkingDayStart(new Date("2026-09-18T21:30:00Z"))), "2026-09-21");

// "Zajtra" created at 23:30 Bratislava
const late = new Date("2026-09-17T21:30:00Z"); // 23:30 Bratislava, 17.9.
const tomorrow = resolveSchedule({ kind: "daysFromToday", days: 1 }, late);
eq("zajtra from 23:30 → date", businessDate(tomorrow.at), "2026-09-18");
eq("zajtra due at 23:45 same day?", isDueByBusinessDay(tomorrow.at, false, new Date("2026-09-17T21:45:00Z")), false);
eq("zajtra due at 00:10 next day?", isDueByBusinessDay(tomorrow.at, false, new Date("2026-09-17T22:10:00Z")), true);
eq("o týždeň from 2026-10-20 (DST)", iso(resolveSchedule({ kind: "daysFromToday", days: 7 }, new Date("2026-10-20T10:00:00Z")).at), "2026-10-26T23:00:00.000Z");

// legacy values: 09:00 local snooze and UTC midnight custom snooze
eq("legacy 09:00 local 2026-09-20 date", businessDate(new Date("2026-09-20T07:00:00Z")), "2026-09-20");
eq("legacy UTC midnight 2026-09-20 date", businessDate(new Date("2026-09-20T00:00:00Z")), "2026-09-20");

// overdue / due
const now = new Date("2026-09-17T10:00:00Z");
eq("day-only yesterday overdue", isOverdue(businessDayStart("2026-09-16"), false, now), true);
eq("day-only today not overdue", isOverdue(businessDayStart("2026-09-17"), false, now), false);
eq("exact later today due", isDueByBusinessDay(new Date("2026-09-17T20:00:00Z"), true, now), true);
eq("exact tomorrow 00:30 not due", isDueByBusinessDay(new Date("2026-09-17T22:30:00Z"), true, now), false);
eq("todayStart", iso(businessTodayStart(now)), "2026-09-16T22:00:00.000Z");

if (failed) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
}
console.log("\nall business-time checks passed");
