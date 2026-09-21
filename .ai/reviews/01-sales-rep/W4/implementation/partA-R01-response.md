# Wave 4 Part A implementation review partA-R01 — response

Date: 2026-09-21. Answers `partA-R01.md` in this folder. Branch `feature/wave5-workflow-fix`, test database only.
**No schema change, nothing committed or pushed, production not touched.** The test database was wiped and reseeded
afterwards (`seedTestWorld.ts --minimal`) at Michal's request; that is unrelated to the findings.

Findings 1–6 were re-read against the code and all are valid. Finding 7 is fixed with new tests; finding 8 is a
rollout decision, not a code fix (see below).

| # | partA-R01 finding | Verdict | Fix |
|---|---|---|---|
| 1 | Correcting a send leaves a false locked step | **Valid** | As suggested |
| 2 | "Chceli" pencil still uses the pre-wave-4 rule | **Valid** | As suggested |
| 3 | Phone/SMS partial withdraw cannot be saved | **Valid** | Suggested fix, plus a UI split (partial vs closing) |
| 4 | Forged `withdrawParts` withdraws unrelated work | **Valid** | As suggested (one shared validator) |
| 5 | Owner change unlocks the wrong kind | **Valid** | As suggested; snooze half needed a decision from Michal |
| 6 | Dismissed part shows the "prepared" diamond | **Valid** | New derived mark `DISMISSED` (⊘) |
| 7 | Tests / status documents overstate completion | **Valid** | New test `w4ReviewR01`; tracker wording corrected |
| 8 | Rollout not executable or final | **Valid, not code** | Not touched — see below |

## 1. Correction left the step stale

`correctRecordAs` (`lib/commands/offers.ts`) now calls `refreshLockedStep` after `correctRecord`, in the same Lead lock
and the same revision. No open task = no-op, so an unlocked deal keeps the user's step.
Test W4A-R01-1: PRICE + OTHER on a deal whose step was CALL; send PRICE → `CALL/null/SCHEDULED`; correct it →
`SEND_QUOTE/null/SCHEDULED`, exactly one revision and one planning row. The same correction on an unlocked deal leaves
the step unchanged.

## 2. "Chceli" pencil

`setClientAsksAs` (`lib/commands/requests.ts`): with an open task it calls `refreshLockedStep` unconditionally (no
`isSystemStep` guard, task fallback used); without a task the wave-5 `isSystemStep` rule is unchanged.
Test W4A-R01-2: OTHER-only task on CALL → add PRICE → `SEND_QUOTE` → withdraw PRICE → back to `CALL`, always no date and
`SCHEDULED`, one revision per save, task stays open; two tabs on the same revision → one wins, one `STALE`.

## 3. Phone / SMS partial withdraw

Both defects were real. **UI** (`InteractionSheet.tsx`): only a withdrawal that takes the *last* open part counts as
"cancelling" (the owner then picks the next step, as with "Zrušiť + zmeniť"). A partial withdrawal is a fact save with
`keepLockedStep`, still asks for the reason, and the box text says only the price is being taken back.
**Server** (`dealWork.ts`): a `withdrawParts` that closes the task passes the lock gate like `cancelTask`; the `closed`
result of `applyPartOps` is now used — a fact-only save that closed the task (e.g. a stale client) runs
`stepOnTaskClose`, so no locked null-date step is stranded.
Tests W4A-R01-3, for **CALL and SMS**: PRICE + DESIGN partial withdraw keeps the task open and the step on
`SEND_DESIGN`; without `keepLockedStep` → `STEP_LOCKED`; forged kinds and a non-owner refused with nothing written;
concurrent identical saves + replay = one contact, a changed body = `IDEMPOTENCY_CONFLICT`. PRICE-only closure: the
chosen step wins; a stale `keepLockedStep` client gets the task closed and the step unlocked on the fallback.
Not covered: KEEP_OPEN for phone/SMS is unchanged code and was not given a new case.

## 4. Forged `withdrawParts`

New pure helper `withdrawMatchesOverlap` (`lib/domain/tasks.ts`), used by both send commands: the same task, non-empty,
and **exactly** the requested kinds this save covers (phone: only with a told price). Also `withdrawClosesTask`.
Test W4A-R01-4: extra kind, a kind the send does not cover, wrong task, wrong kind → refused before anything is
written; the exact overlap still works.

## 5. Owner change / snooze

`ownerTransition` now ends a cancelled task through `stepOnTaskClose` when no explicit takeover step was given (an
accepted HANDOVER keeps the plain date fill). The import is dynamic so `taskMutations` ↔ `lockedStep` stay acyclic.
`changeDealStatus` uses `stepOnTaskClose` too (`cancelForStatus` now returns the task).
**Decision from Michal:** a snooze that cancels an open task must not leave the step due today ("zobudený" at once), so
`changeStatusAs` takes `snoozeUntil` (future business day, required server-side in that case) and the detail's status
sheet has a date input. Test W4A-R01-5 covers owner → nobody, owner → manager and snooze (refused without a date,
refused for today, accepted with a date), each ending on the CALL fallback instead of the withdrawn `SEND_DESIGN`.
Bulk transfer goes through the same `ownerTransition` but has no separate test case.

## 6. Dismissed part mark

`partMarkOf` (new, `lib/domain/tasks.ts`) derives `DISMISSED` when nothing was sent and nothing is waiting; the card
shows ⊘ "neposiela sa". The old W4-0 test re-implemented the mark locally and is now calling `partMarkOf`. Test
W4A-R01-6 checks a dismissed PRICE. One sent + one dismissed design stays `PARTLY_SENT` (existing W4-7).

## 7. Tests and status documents

`w4ReviewR01` in `check-concurrency.ts` uses transitions where the step **kind** visibly changes. The old W4-4
correction check is kept but is not the evidence. Tracker heading changed to "implementation complete … review fixes
applied, human acceptance pending".
**Not verified:** I did not re-run the new tests against the pre-fix code to show they fail there (a stash was too risky
with this much uncommitted work); the argument that they would fail rests on reading the old code.
**Not changed:** the wave-4 proposal header still says "nothing built" — it is a protected feature file.

## 8. Production rollout

Not a code change. Michal's answer: he does not want to keep legacy data, i.e. the existing plan (convert, then drop
the old send columns as a reviewed non-additive step) stands and the "freeze them forever" option is **not** chosen.
No document was changed. The blocker itself stands: the old-send conversion is unfinished and no fresh-clone rehearsal
has happened, so **the branch is still NO-GO for production**.

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npx eslint .` | only the known `MobileNav.tsx` error |
| `npx next build` | passed (before the snooze/label edits; type-check passed after) |
| `check-business-time` (also `TZ=UTC`), `check-client-sections` | passed |
| `check-concurrency` wave-4 set + `w5Pencil`, `--iterations 20`, on the freshly seeded test DB | **42/42** |
| `check-concurrency` full, `--iterations 100` | **not run to completion after the last edits** |
| `check-backfill-delta` | not run |
| Human click-through (phone + desktop, SR and manager) | still owed |
