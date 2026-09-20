// Kontrola čistej klasifikácie „Moji klienti" (plán §7.4) – každé pravidlo + úplnosť nad kombináciami.
//   npx tsx prisma/backfill/check-client-sections.ts
import type { LeadStatus, NextActionKind, NextActionMode } from "../../app/generated/prisma/enums";
import { businessDayStart } from "../../lib/domain/businessTime";
import { clientSection, CLIENT_SECTIONS, type ClassifiableDeal } from "../../lib/domain/clientSections";

let failed = 0;
function eq(label: string, actual: unknown, expected: unknown) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

const now = new Date("2026-09-17T10:00:00Z"); // 12:00 Bratislava
const base: ClassifiableDeal = {
    status: "ACTIVE",
    nextActionKind: "CALL",
    nextActionAt: businessDayStart("2026-09-20"),
    nextActionHasTime: false,
    nextActionMode: "SCHEDULED",
    closedAt: null,
    stepLocked: false,
};
const c = (patch: Partial<ClassifiableDeal>) => clientSection({ ...base, ...patch }, now);

eq("closed recent", c({ status: "WON", closedAt: new Date("2026-09-01T10:00:00Z") }), { section: "CLOSED_RECENT" });
eq("closed old", c({ status: "LOST", closedAt: new Date("2026-05-01T10:00:00Z") }), { section: "ARCHIVED" });
eq("closed without closedAt", c({ status: "UNREACHABLE", closedAt: null }), { section: "ARCHIVED" });
eq("closed stays closed even if a lock were reported", c({ status: "LOST", closedAt: new Date("2026-09-10T10:00:00Z"), stepLocked: true }), { section: "CLOSED_RECENT" });
eq("locked step wins over overdue (wave 3)", c({ stepLocked: true, nextActionAt: businessDayStart("2026-09-01") }), { section: "WAITING_ON_MANAGER" });
eq("locked step without date is not 'bez termínu'", c({ stepLocked: true, nextActionAt: null }), { section: "WAITING_ON_MANAGER" });
eq("locked snoozed deal is not 'zobudený'", c({ stepLocked: true, status: "SNOOZED", nextActionAt: null }), { section: "WAITING_ON_MANAGER" });
eq("locked deal without any step", c({ stepLocked: true, nextActionKind: null, nextActionAt: null }), { section: "WAITING_ON_MANAGER" });
eq("snoozed without date", c({ status: "SNOOZED", nextActionAt: null }), { section: "TODAY", badge: "chýba dátum" });
eq("snoozed due", c({ status: "SNOOZED", nextActionAt: businessDayStart("2026-09-17") }), { section: "TODAY", badge: "zobudený" });
eq("snoozed future", c({ status: "SNOOZED" }), { section: "SNOOZED" });
eq("no next action", c({ nextActionKind: null, nextActionAt: null }), { section: "TODAY", badge: "bez ďalšieho kroku" });
eq("in progress", c({ nextActionKind: "SEND_DESIGN", nextActionMode: "IN_PROGRESS", nextActionAt: businessDayStart("2026-09-01") }), { section: "IN_PROGRESS" });
eq("waiting, check due", c({ nextActionKind: "WAITING_FOR_CLIENT", nextActionAt: businessDayStart("2026-09-17") }), { section: "TODAY", badge: "skontrolovať" });
eq("waiting, no date", c({ nextActionKind: "WAITING_FOR_CLIENT", nextActionAt: null }), { section: "WAITING_ON_CLIENT" });
eq("waiting, future check", c({ nextActionKind: "WAITING_FOR_CLIENT" }), { section: "WAITING_ON_CLIENT" });
eq("scheduled without date", c({ nextActionAt: null }), { section: "TODAY", badge: "bez termínu" });
eq("overdue day-only", c({ nextActionAt: businessDayStart("2026-09-10") }), { section: "TODAY" });
eq("exact later today counts as today", c({ nextActionAt: new Date("2026-09-17T19:00:00Z"), nextActionHasTime: true }), { section: "TODAY" });
eq("exact tomorrow 00:30 is planned", c({ nextActionAt: new Date("2026-09-17T22:30:00Z"), nextActionHasTime: true }), { section: "PLANNED" });
eq("future planned", c({}), { section: "PLANNED" });

// Úplnosť: každá kombinácia dostane práve jednu sekciu zo zoznamu (alebo ARCHIVED).
const statuses: LeadStatus[] = ["ACTIVE", "SNOOZED", "WON", "LOST", "UNREACHABLE"];
const kinds: (NextActionKind | null)[] = [null, "CALL", "SEND_QUOTE", "SEND_DESIGN", "SEND_EMAIL", "WAITING_FOR_CLIENT", "CUSTOM"];
const ats = [null, businessDayStart("2026-09-01"), businessDayStart("2026-09-17"), businessDayStart("2026-10-01"), new Date("2026-09-17T20:00:00Z")];
const modes: NextActionMode[] = ["SCHEDULED", "IN_PROGRESS"];
const closeds = [null, new Date("2026-09-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z")];
let combos = 0;
let bad = 0;
for (const status of statuses)
    for (const nextActionKind of kinds)
        for (const nextActionAt of ats)
            for (const nextActionHasTime of [false, true])
                for (const nextActionMode of modes)
                    for (const closedAt of closeds)
                        for (const stepLocked of [false, true]) {
                            combos++;
                            const r = clientSection({ status, nextActionKind, nextActionAt, nextActionHasTime, nextActionMode, closedAt, stepLocked }, now);
                            if (![...CLIENT_SECTIONS, "ARCHIVED"].includes(r.section)) bad++;
                        }
eq(`totality over ${combos} combinations`, bad, 0);

if (failed) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
}
console.log("\nall client-section checks passed");
