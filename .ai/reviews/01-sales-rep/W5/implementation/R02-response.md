# Wave 5 implementation review R02 — response

Date: 2026-09-20. Answers `R02.md` in this folder, then adds a fresh review of the implementation.
Branch `feature/wave5-workflow-fix`, test database only. **No schema change, nothing committed or pushed, production
not touched.**

All five findings are valid. Michal asked for 2, 3 and 4 in particular; 1 is a real bypass of an invariant we just
built, so it is fixed too, and 5 is documentation. The fresh review found **one problem that is worse than any in
R02** (migration, section B) and it is fixed.

| # | R02 finding | Verdict | Fix |
|---|---|---|---|
| 1 | Manager can still snooze from the detail without withdrawing asks | **Valid** | As suggested, plus a server rule that refuses `withdraw` for statuses that do not consume it |
| 2 | Untracked návrh stops counting once any Design row exists | **Valid** | As suggested; the same drift also existed in the list row and the "Dostali návrh" filter, fixed there too |
| 3 | Crossing out an SMS leaves its price active | **Valid** | As suggested |
| 4 | "Keep current step" is preselected even when the SMS just finished that step | **Valid** | Suggested fix, plus a server refusal so the wrong state cannot be saved by another client |
| 5 | Proposal note describes pre-R01 behaviour | **Valid** | Replaced by the final matrix; W5-9 test name corrected |

## A. R02 findings

### 1. Manager snooze bypassed the invariant

`changeDealStatus` now calls the shared `withdrawOpenOnLeave()` for `SNOOZED` under the same Lead lock, before the
status changes. A `withdraw` payload for any status that does not consume it (ACTIVE, WON) is refused, and a payload on
a no-op status change is `STALE` instead of being silently ignored. A closed deal that is snoozed in one move goes
through the reopen first, so the rule still applies. In the detail, the confirmation opens for `SNOOZED` when asks are
open, lists them, and requires the reason (the same predicate is used for LOST / UNREACHABLE).
Test `w5ManagerSnooze`: no payload / blank / partial refused with nothing written; success = one revision bump, one audit
row, all rows `WITHDRAWN`; replay by key; a withdraw on ACTIVE refused; snooze with an open task **and** open asks needs
both the task cancellation and the withdrawal.

### 2. `designSentAt` and untracked sends

The reviewer's diagnosis is right (`designs.length` counted deleted rows, and the two sources were never combined).
`recomputeOffers` now sets `Lead.designSentAt` to the **latest valid date across non-deleted tracked designs and valid
untracked sends**; the legacy value is left alone only when the deal has neither any Design history nor any untracked
send. A deleted Design, or a Design created later (and then deleted), never suppresses a valid untracked send.

While tracing it I found the same drift in two more places, and fixed them together: the list row summary
(`legacyAwareDesignSentAt`) ignored the column as soon as a Design row existed, and the **"Dostali návrh" filter read
only Design rows**, so it never showed an untracked or legacy návrh at all. Both now read the column too (the row takes
the later of rows and column). `db-changes.md` §3.3 already required list, detail and filter to agree for a historical
design with no Design row.
Test `w5UntrackedLifecycle`: (a) only a deleted Design before the untracked send, (b) a Design created afterwards plus an
unrelated send, (c) that Design deleted, (d) crossing the untracked send out while another unsent Design exists, plus the
filter.

### 3. Crossing out an SMS

`correctRecord` for a non-offer record now crosses out every valid `OFFER_SENT` whose `meta.callActivityId` is that
record, in the same transaction, with one recompute, one reconcile and one revision bump. The reverse direction stays
independent (crossing out only the price leaves the SMS text). The child's correction reason says it followed its SMS.
Test `w5SmsCorrection`: the price knowledge clears, the PRICE request goes `SENT → OPEN`, one bump, two concurrent
corrections → one wins and one is `STALE`, correcting only the price leaves the SMS.

### 4. "Keep current step"

The reviewer is right that the easiest path was wrong exactly when it mattered. What changed:

- **Preselected only for a deliberately planned step** (call, waiting, custom). A system "Poslať …" step is not
  preselected.
- **Not offered at all when the SMS carries a price and the current step is a system send step**: that SMS just
  satisfied it, so the rep chooses the next step herself instead.
- The server refuses `keepStep` + price on a system send step (`FORBIDDEN`, "Po cene v SMS vyber ďalší krok"), so this
  does not depend on the screen.
- The card shows the real headline (`stepHeadline`, e.g. "Poslať návrh + cenu + cenník"), then the step note.
Test `w5SmsKeepStep` now asserts: plain SMS keeps a system step (allowed); price on a system step refused; price on a
planned CALL is kept, with the same date; keepStep on a call or with an explicit step refused.

One judgement call to know about: for a system step **without** a price ("email sme poslali" while "Poslať info" is
pending) keep is still offered, just not preselected — one extra tap, but no silent default on a step the SMS may not
have completed.

### 5. Documentation

`wave-5-proposal.md` §6.10 now has the final matrix (withdraw: action-sheet snooze/close, manager snooze,
manager LOST/UNREACHABLE; leave open as history: manager WON only). `app-workflow.md`, `operations.md` and
`database-map.md` are updated, and the W5-9 test is renamed to say it tests WON, the intentional exception.

## B. Fresh review of the implementation

I re-read the parts of Wave 5 that the two reviews touched least, looking for things that would fail on production data
rather than on test fixtures: the first-call path and its revert, the migration SQL against the app's own time rules,
demand statistics, task creation against the request projection, and the sheet/server contract for every new payload.

### B1. SEVERE (found, fixed) — migrated receipts would reopen on the first reconcile

**Where:** `prisma/backfill/wave5-requests-sql.ts` (the send instant), against `lib/domain/offers.ts` `offerInstant()`
and `resolveRequests()` (a receipt satisfies a request only if its instant is **not earlier** than the request).

**What was wrong.** The migration computed a historical receipt's instant as `sentOn::date::timestamp`, i.e. midnight
**UTC**. The app computes it as midnight **Europe/Bratislava** (1–2 hours earlier), and for a non-`historical` row the
SQL used the write time while the app uses the day rule. The migration writes `requestedAt` from its instant, and the
app's reconcile recomputes the receipt's instant its own way.

**Failure.** Migrate a lead whose old send was on 15 March: the row is inserted `SENT`, `requestedAt` = 15 March
00:00 UTC. The first later action on that deal (any new ask, any send, a correction, an SMS price…) runs the
reconciliation. It computes the receipt as 14 March 22:00/23:00 UTC, **earlier** than the request, so the row flips to
`OPEN`. Every migrated request for content the client had already received would silently become "still owed", and
open-deal lists would start telling reps to send things again. Nothing on the test database showed it because no test
migrated a historical receipt and then touched the deal, and the earlier "5 leads / 27 events" dry-run counts said
nothing about it.

**Fix.** The SQL now uses the exact `offerInstant` rule (same-business-day → write time, otherwise Bratislava midnight of
`sentOn`), exported as `instantSql`. Test `w5InstantParity` compares the SQL instant with `offerInstant()` for today's,
backdated and historical rows, **and** runs the migration SQL followed by a real reconcile in a rolled-back
transaction: the migrated historical receipt stays `SENT` and linked.

**Still needed before production:** the rehearsal on the production duplicate should include this exact check (migrate,
then touch a sample of deals, confirm no row changed). It is now a named step in my notes below, not something the
migration test alone can promise for real data.

### B2. Drift, same family as R02-2 (fixed under finding 2)

The "Dostali návrh" filter and the list summary could disagree with the receipts for untracked / legacy návrh. Fixed above.

### B3. Checked, no defect found

- **First call and revert.** Requests are created after the Lead write so the revision rises once; revert is refused
  after any later change (its `leadRevision` guard) and deletes only that call's rows, refusing if one was already
  received.
- **Demand statistics** count `LIVE` rows only, including later-withdrawn ones (they were asked, so that is right) and
  never migrated rows.
- **Task creation** derives its step from the whole outstanding set, and a returned manager price still holds the step
  (I10) — the new custom "Požiadať manažéra" step interacts correctly: with an unsent returned result the sheet asks for
  a reason, as for any non-send step.
- **New payloads** (`stepFromRequests`, `withdraw`, `keepStep`, `untrackedDesign`, `via: "SMS"`) are strict-schema,
  fingerprinted only when present (old fingerprints unchanged), replay-safe, and their invalid combinations are refused
  on the server, not only hidden in the UI.
- **Access.** Nothing new bypasses `requireDealWork` / `requireDealManage`; withdraw ids are matched against the same
  lead under the lock, so a foreign id cannot be withdrawn.

### B4. Low / notes, not fixed

- Demand statistics count a withdrawn ask as demand. Deliberate (it was asked), but worth stating so nobody "fixes" it.
- "Ozvať sa o pár mesiacov" from the sheet writes an answered-call row (`CALL`, outcome `SNOOZE`). Pre-existing.
  It is treated as a real conversation.
- `/dev/proposal?preview=interaction` renders the sheet with mock data and is reachable without signing in. It carries
  no real data, but it is a dev page that ships with the app; remove or guard it before production.
- A legacy deal that has Design rows **and** an old `Lead.designSentAt` now shows the column's date even though the
  rows are unsent (before: "not sent"). That is the old system's truth; the send conversion covers it.

### B5. What I did not review

The tracking ingest (`app/api/p`), the full `clientSection` / `TODAY_SQL` parity beyond the existing tests, all
`context/features/**` history, and any human click-through. Wave 4 is untouched.

## Questions for Michal

None blocking. Two things to confirm when you click through:
1. "Ponechať aktuálny krok" after an SMS is now preselected only for a planned step (call / waiting / custom). Is that
   what you expect, or do you want it preselected for a "Poslať …" step too when the SMS has no price?
2. F4 stays open until you have clicked through the corrected sheet (phone and desktop).

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| ESLint on `components/pipeline`, `lib`, `prisma/backfill` | passed |
| `npx prisma validate` | passed |
| `check-business-time.ts`, `check-client-sections.ts` | passed |
| New groups `w5ManagerSnooze`, `w5UntrackedLifecycle`, `w5SmsCorrection`, `w5SmsKeepStep`, `w5InstantParity` | passed on the verified test endpoint (`…nhww8x`) |
| Full `check-concurrency.ts` | **176 / 176** |
| `npx next build` | passed |
| Browser | not re-checked in this round (the previous round's SMS and snooze screens were); **phone and the real click-through are still Michal's** |

## Before Wave 4

Nothing in Wave 5 blocks starting Wave 4, except Michal's click-through (F4). Production still owes what it owed:
the send conversion, the production-duplicate rehearsal (now including the migrate-then-touch check from B1), the CP
mapping to confirm on the duplicate, and the removal of the dev preview page.
