# Wave 4 Part A implementation and production-readiness review — partA-R01

Date: 2026-09-21  
Scope: Wave 4 Part A (one manager task with several parts), its Wave 5 integration, tests, authoritative context,
database delta, and readiness of the complete pre-production branch for a live-data rollout.  
Review type: implementation and release-gate review. No application/context file or database was changed. This review
record is the only file added.

## Verdict

**Changes requested — do not deploy this branch to production yet.**

The central workflow design is good and should not be redesigned: one open manager task per deal, one immutable row
per kind of manager work (`PRICE`, `DESIGN`, `OTHER`), part-by-part delivery, and a separate Wave 5 ledger for what the
client asked for and received. It solves the real PRICE + DESIGN workflow without creating combined enums or turning
the CRM into a general task manager. The Wave 4 production schema is also additive: production has no task tables, so
it can receive the final `DealTask` + `DealTaskPart` shape directly and needs no Wave 4 task conversion.

The implementation nevertheless has **three direct blockers in the locked-step workflow**, plus two server-integrity
gaps. Correction and the “Chceli” pencil omit the P6 recomputation which the proposal explicitly requires. The
phone/SMS “I already gave the price; withdraw PRICE from the manager task” path is rejected by the server even though
the UI offers it. A crafted partial-withdraw payload may also withdraw task parts that were not covered by the send.
Finally, some task-ending owner transitions unlock only the old stored kind rather than computing the final step.

The current green concurrency result is not sufficient evidence against these bugs: one test labelled as testing a
correction leaves `SEND_DESIGN` both before and after the correction, so it passes even though no recomputation exists;
the partial-withdraw test exercises only the email command, not the phone/SMS command.

There is a separate production blocker outside the Wave 4 task schema. The selected old-send conversion is documented
as an unfinished prototype which must not be applied even to a production clone, and no full rollout has been
rehearsed on a fresh duplicate of production. The repository therefore cannot currently support the requested claim
that this is the final live schema with no more transformative changes. If the priority is “never drop a production
column again”, the safest policy is to retain the three old send columns permanently as frozen legacy evidence after
canonical conversion; otherwise the already-decided P-01–P-03 contraction remains a future non-additive change.

With a worker starting in seven hours, the safe operational decision is to leave the current production version in
place. Live production must not become the first rehearsal of a multi-wave schema and data migration.

## Findings

### 1. BLOCKER — correcting a send can leave an unrepairable false locked step

**What's wrong**

P6 says that while a task is open, the step is a pure function of outstanding work plus the task fallback. Crossing
out an `OFFER_SENT` changes outstanding work, so the proposal explicitly requires the locked step to be re-derived.
The command corrects the fact and reconciles requests, but never invokes `refreshLockedStep`.

**Where**

- `context/features/01-salesrep/wave-4-proposal.md:431-457` — correction is a required P6 event.
- `lib/commands/offers.ts:177-199` — `correctRecordAs` calls only `correctRecord`.
- `lib/domain/offerMutations.ts:281-323` — summaries and requests are recomputed, but not the locked step.
- `prisma/backfill/check-concurrency.ts:4439-4471` — the claimed correction test is a false positive: DESIGN remains
  outstanding, so `afterCorrection.nextActionKind === "SEND_DESIGN"` would pass with or without recomputation.

**Concrete failure scenario**

A task contains PRICE + OTHER and has fallback CALL. The manager returns PRICE; the SR sends it while OTHER is still
open, so the locked step correctly falls back to CALL. The SR then crosses out that email because it was not actually
sent. PRICE becomes outstanding again, but the stored locked step remains CALL. Because the task is open, the SR is
not allowed to edit the step. The CRM hides the price which still has to be sent and offers no repair path.

**Why it matters**

This breaks the central Wave 4 invariant on an ordinary correction path and can make promised work disappear from the
daily workflow.

**Suggested fix**

After `correctRecord` has recomputed facts and requests, call `refreshLockedStep` in the same Lead-lock transaction.
It will be a no-op when no task is open. Preserve the one-revision rule. Replace the current test with a transition
whose kind must visibly change: PRICE + OTHER, send PRICE (`SEND_QUOTE → fallback CALL`), then correct it
(`CALL → SEND_QUOTE`, still date `NULL`, mode `SCHEDULED`). Also assert that the identical correction on an unlocked
deal does not replan the user's step.

### 2. BLOCKER — the “Chceli” pencil still implements the pre-Wave-4 rule

**What's wrong**

The proposal calls out `setClientAsksAs` by name: while a task is open it must drop the `isSystemStep` guard and use
the same P6 formula and fallback as every other locked-step mutation. The implementation still has the old Wave 5
logic and even comments that the pencil does not touch the task.

**Where**

- `context/features/01-salesrep/wave-4-proposal.md:396-425` — P6 and the explicit `setClientAsksAs` requirement.
- `lib/commands/requests.ts:101-118` — recomputation is guarded by `isSystemStep`, calls `defaultStep` directly, and
  does not use the task fallback.
- `lib/domain/lockedStep.ts:11-25` — the canonical helper's own contract lists the “Chceli” pencil as a caller.
- `prisma/backfill/check-concurrency.ts:3400-3453` — the existing pencil test checks that the task remains open, but
  does not assert the locked step transition required by P6.

**Concrete failure scenario**

An OTHER-only task preserves the SR's fallback CALL. While the manager is answering it, the client also asks for an
exact price and the SR adds PRICE through the “Chceli” pencil. CALL is not a system step, so the current guard skips
the update. The task remains locked on CALL instead of changing to “Poslať cenu”. The user cannot repair it manually.

**Why it matters**

Two supported screens can now produce different stored steps for the exact same outstanding set. That invalidates the
claim that the locked step is derived rather than manually stored state.

**Suggested fix**

Split the command into two branches after request mutation:

- if an open task exists, call `refreshLockedStep` unconditionally;
- if no task exists, retain the Wave 5 `isSystemStep` protection for the user's freely chosen step.

Add exact OTHER/CALL → add PRICE → `SEND_QUOTE` → withdraw PRICE → fallback CALL assertions, including date, mode,
audit row, one revision, replay, conflict, and two-tab stale revision.

### 3. BLOCKER — the phone/SMS partial-withdraw option shown in the UI cannot be saved

**What's wrong**

When the SR says a price while a manager is still making PRICE, the UI offers “Už ju netreba – stiahnuť cenu”. The UI
classifies that selection as cancelling, so it does not send `keepLockedStep` and it deliberately does not send the
whole-task `cancelTask`. The server's general lock gate then rejects every such request before `withdrawParts` runs.

There is a second defect behind the rejection: even if a caller forces `keepLockedStep` to pass the gate, the code
ignores the `{ closed }` result from `applyPartOps`. If PRICE was the last requested part, the task closes and the
fact-only branch returns without `stepOnTaskClose`; the formerly locked no-date step can be stranded.

**Where**

- `components/pipeline/InteractionSheet.tsx:381-401` — PRICE overlap and the `cancelling` / `factOnly` choice.
- `components/pipeline/InteractionSheet.tsx:498-522` — `WITHDRAW_PARTS` sends neither `keepLockedStep` nor
  `cancelTask`.
- `lib/commands/dealWork.ts:245-263` — an open task plus `!factOnly` and no whole-task cancellation throws
  `STEP_LOCKED` before partial withdrawal.
- `lib/commands/dealWork.ts:317-363` — the result of `applyPartOps` is discarded and only the `keepLockedStep` branch
  refreshes P6.
- `prisma/backfill/check-concurrency.ts:4750-4801` — only the email send command is exercised; there is no phone/SMS
  `WITHDRAW_PARTS` case.

**Concrete failure scenario**

The task is PRICE + DESIGN. During a call, the client accepts a price the SR already knows. The SR checks “Povedal/a
som konkrétnu cenu”, chooses “Už ju netreba – stiahnuť cenu (zvyšok úlohy beží ďalej)”, enters a reason and saves.
The server returns `STEP_LOCKED`; no call or price is recorded. On a one-part PRICE task, a hand-crafted version can
close the task but leave a locked, null-dated step behind.

**Why it matters**

This is one of the explicit Wave 4 workflows and the UI currently advertises an action which cannot succeed. It also
creates a dangerous temptation to use the whole-task cancellation and accidentally stop DESIGN as a workaround.

**Suggested fix**

Treat a valid partial-withdraw overlap as its own allowed locked operation before the general cancellation gate. Keep
the call, receipt, part transition and final step in one transaction. Capture `closed`: if the task remains open,
refresh P6 after recording the price; if it closes, derive the final step once and unlock it (or apply the user's
explicit next step if this interaction supplies one and I10 permits it). Add PHONE and SMS tests for PRICE + DESIGN,
PRICE-only closure, KEEP_OPEN, stale task, non-owner, replay, fingerprint conflict, and two-tab races.

### 4. IMPORTANT — partial-withdraw payloads can withdraw work unrelated to the recorded send

**What's wrong**

Both send commands require a choice when a real overlap exists, but neither validates that
`withdrawParts.kinds` is exactly the set of requested task kinds covered by the content being recorded. Schema
validation proves only that the kinds are syntactically valid and distinct.

**Where**

- `lib/commands/offers.ts:65-69,113-130` — arbitrary named requested kinds are passed to `applyPartOps`.
- `lib/commands/dealWork.ts:186-189,257-262,317-330` — the same problem exists for the phone/SMS command.
- `context/features/01-salesrep/wave-4-proposal.md:575-585` — `WITHDRAW_PARTS` is specified as withdrawing exactly
  the overlapping requested parts.

**Concrete failure scenarios**

1. A PRICE + DESIGN task is open. A crafted “sent PRICE” payload submits
   `withdrawParts.kinds = [PRICE, DESIGN]`. Both parts are withdrawn even though the email contained only PRICE.
2. A crafted “sent ABOUT_US” payload supplies `overlap = WITHDRAW_PARTS` and withdraws PRICE although ABOUT_US does
   not overlap the manager task at all.

The normal UI currently constructs PRICE-only payloads, but UI shape is not a server integrity boundary. A stale or
modified client can reach these states.

**Why it matters**

Manager work can be silently cancelled by an unrelated client communication, changing task history and the next step
inside a transaction that otherwise looks valid.

**Suggested fix**

Centralize validation in a pure helper used by both commands. `WITHDRAW_PARTS` must require a non-empty actual overlap,
the same task ID, and exactly the overlapping requested kinds this save is taking back (or a documented subset if the
UI intentionally supports selecting a subset). Reject extra/non-overlapping kinds before any activity is created.
Test forged extra kinds, no-overlap payloads, missing kinds, wrong task, and the valid partial case.

### 5. IMPORTANT — owner-change task closure can unlock the wrong kind

**What's wrong**

Normal part-resolution paths use `stepOnTaskClose`, which evaluates P6 one last time and then unlocks the final kind.
`ownerTransition` does not. When changing to a resolver or to nobody ends a HELP task, it calls `cancelOpenTask` and
then merely puts today's date on whatever kind was stored before the task ended. An explicit takeover step masks the
problem, but the owner picker and bulk transfer do not provide one.

**Where**

- `context/features/01-salesrep/wave-4-proposal.md:459-473` — task close must run the P6 formula once, then unlock.
- `lib/domain/lockedStep.ts:62-100` — canonical `stepOnTaskClose` implementation.
- `lib/domain/taskMutations.ts:831-869` — `ownerTransition` ends the task but only fills today's date on the old kind.
- `lib/commands/pipeline.ts:193-206,350-363` — individual owner selection and bulk transfer call it without an
  explicit next step.
- `prisma/backfill/check-concurrency.ts:4884-4915` — `w4Survives` verifies pending items and task statuses, but not the
  resulting next-action kind.

**Concrete failure scenario**

PRICE + DESIGN is open. PRICE was returned and sent; DESIGN is still being made, so the locked kind is SEND_DESIGN.
A manager uses the owner picker or bulk transfer to take the deal. The transition withdraws DESIGN and closes the
task. With no remaining client or prepared work, P6 should restore the task fallback, for example CALL. Instead the
deal becomes due today with SEND_DESIGN, telling the new owner to send work that was just cancelled.

**Why it matters**

“The manager can take over any deal at any time” is a core workflow, and bulk ownership changes are an administrative
safety path. A stale step immediately becomes today's work after unlock.

**Suggested fix**

When `ownerTransition` ends a HELP task and `opts.step` is absent, run the equivalent of `stepOnTaskClose` before the
owner write; an explicit takeover step continues to win. Keep HANDOVER acceptance semantics separate. Add individual,
bulk, manager, and ownerless cases where the final kind differs from the pre-close kind, with and without a delivered
item.

Also audit `changeDealStatus`'s open-task snooze path (`lib/domain/dealMutations.ts:469-475`): it likewise uses bare
`unlockStep`. A task-originated null date becomes today, so a newly `SNOOZED` deal can immediately classify as woken.
The fixed test should assert both status and `clientSection`, not only task cancellation.

### 6. MINOR — an entirely dismissed delivered part still uses the “prepared” diamond

**What's wrong**

The text correctly says “neposiela sa”, but `taskPartState` assigns `PREPARED` to a delivered part with zero sent
items, including when every returned item was deliberately dismissed. The task card therefore renders an amber `◆`
beside “neposiela sa”, while the approved spec calls for an explicit not-sent mark.

**Where**

- `lib/domain/tasks.ts:341-378,386-406` — all-dismissed falls through to `PREPARED`, then only the label corrects it.
- `components/pipeline/TaskCard.tsx:82-99,108-119` — `PREPARED` always renders `◆` in amber.
- `context/features/01-salesrep/wave-4-proposal.md:308-383` — sent and deliberately not sent are distinct states.

**Concrete failure scenario**

The manager returns a price; the SR chooses “Neposielam” with a reason. The card shows the prepared diamond and the
words “neposiela sa”. At a glance it still looks like something is ready and waiting.

**Why it matters**

It does not corrupt data, but this task card is the user's compact status view. Conflicting icon and text invite a
wrong send.

**Suggested fix**

Represent all-dismissed explicitly in the derived mark/glyph (for example `DISMISSED` → `⊘`) or derive the glyph from
counts without changing persisted data. Add one compact-render projection test for a dismissed PRICE and one for two
designs where one is sent and one dismissed.

### 7. IMPORTANT — the current tests and status documents overstate completion

**What's wrong**

The tracker says Part A is DONE and that P6 is recomputed on every outstanding-changing event. The proposal header
still says nothing has been built. More importantly, the test suite names the missing correction behavior as covered
without forcing the kind to change, has no phone/SMS partial-withdraw case, and does not assert the post-owner-change
step. A passing total is therefore not a reliable release gate for the feature's central invariant.

**Where**

- `context/progress-tracker.md:209-214,265-280,290-314` — declares DONE and lists the behaviors as implemented/tested.
- `context/progress-tracker.md:324-340` — still records both Wave 4 and Wave 5 human click-through as owed.
- `context/features/01-salesrep/wave-4-proposal.md:3-8` — stale “design, nothing built” status.
- `prisma/backfill/check-concurrency.ts:4439-4471,4750-4801,4884-4915` — the three coverage holes described above.

**Concrete failure scenario**

The existing 211/211 run passes and Part A is declared done even though the UI's phone partial-withdraw action always
returns `STEP_LOCKED` and a correction can leave a stale uneditable step.

**Why it matters**

This is precisely the kind of false confidence that makes a rushed production cutover dangerous. A test name is not
proof unless its assertion would fail when the required line of production code is removed.

**Suggested fix**

Mark Part A as “implementation complete, review fixes and human acceptance pending” until findings 1–5 and their
regression tests pass. Update the proposal header to distinguish Part A built from Parts B/C unbuilt. After the fixes,
run the complete check matrix and perform the documented phone + desktop click-through with both an SR and a manager.

### 8. BLOCKER (ROLLOUT) — the documented live-data migration is not executable or final today

**What's wrong**

The Wave 4 task schema is additive to production, but this branch is not only Wave 4. Production is still on the
pre-round-1 schema and needs every delta through Waves 3a, 3, 5 and 4 plus multiple data steps. The chosen old-send
route is explicitly “NOT applied”; its script is explicitly forbidden even on a production clone because it guesses
contents, dates, actors and cenník recipients and can declare incomplete conversion successful. The Wave 5 request
backfill is ordered after that unfinished conversion. No fresh production duplicate rehearsal has happened.

The same document also plans to drop three columns which production currently has. Therefore “no more
destructive/transformative database changes” is not currently true for the full app, even though it is true for the
Wave 4 task tables themselves.

**Where**

- `context/domain/db-changes.md:12-28` — production baseline is an assumption, not a live measurement; the current
  additive claim excludes the unimplemented contraction.
- `context/domain/db-changes.md:211-219` — round-1 and Wave 5 data steps are still owed.
- `context/domain/db-changes.md:250-257,321-342` — old-send conversion is unimplemented and the prototype is unsafe.
- `context/domain/db-changes.md:348-373` — mandatory fresh-clone rehearsal and reconciliation have not happened.
- `context/domain/db-changes.md:375-395` — planned non-additive P-01 (`quoteSentAt`), P-02 (`aboutUsSentAt`) and P-03
  (`priceDisclosed`) drops plus code cutover.
- `context/domain/db-changes.md:397-425,429-485` — rollout order and Wave 5 dependency; the document states the clone
  and rehearsal are still missing.

**Concrete failure scenario**

The current Prisma schema is pushed to live because its net structural diff appears additive. The deployed code
expects the test legacy layer, while the chosen production route says those test-only fields must not be added. Or the
unfinished conversion is run to bridge the difference: an old price disclosure is assigned the current owner/current
price or a guessed phone channel, separate flags from one email become duplicate sends, and Wave 5 then backfills
“Chceli” from that false canonical history. The production database is internally consistent but factually wrong.

**Why it matters**

The live database contains thousands of contacts and the old send facts are the source from which the new request
ledger will be created. These errors become durable history and cannot be repaired by a UI patch. A backup helps
rollback, but it does not make the first un-rehearsed migration safe.

**Suggested fix**

Do not deploy this branch in the seven-hour window. First choose the final schema policy:

1. **Recommended for maximum safety:** keep `Lead.quoteSentAt`, `Lead.aboutUsSentAt` and `Lead.priceDisclosed`
   permanently as frozen, ignored legacy evidence. Convert their information into canonical events, cut application
   reads/writes over to canonical data, but never drop the old columns. This makes future schema work additive while
   retaining forensic rollback evidence. It changes the previous P-01–P-03 decision and must be recorded explicitly.
2. **If the clean contraction is still required:** accept that one reviewed non-additive migration remains. Complete,
   test and rehearse it before claiming the schema final. Do not describe the current branch as that final state.

Either choice still requires the corrected migration and a full rehearsal on a fresh live-data clone before a live
window.

## Workflow and future-proofing assessment

### What is correct and should be retained

- **Manager work and client intent are separate ledgers.** A manager task has only PRICE, DESIGN and OTHER; INFO,
  PRICELIST and REVIEW remain client requests and can never accidentally become manager work.
- **One task with parts is the right size.** It supports PRICE + DESIGN, partial return, partial send, decline,
  withdrawal and later addition without creating a second parallel planning system.
- **The client receipt remains canonical.** Delivering a task part does not claim the client received it; only a valid
  receipt consumes it.
- **No combined next-action enum is needed.** One stored category plus a derived headline avoids every PRICE + DESIGN
  + INFO combination in the schema.
- **The future developer feature does not require remodelling these parts.** A developer project can be a separate
  workflow owned by manager/developer while this task remains the SR↔manager assistance record. Adding a future enum
  value or a separate relation is additive.
- **The accepted one-step limitation is still a design choice, not a bug.** The app cannot independently schedule a
  future appointment while a task owns the current step. Wave 4 correctly does not attempt to become a calendar or
  multi-step project planner.
- **One part per kind is an intentional limit.** A second price while another part of the same task is still open is
  handled outside the task or after ownership handover; this review does not reopen that accepted product decision.

### Database finality answer

- **Wave 4 Part A schema:** structurally sound and likely final. No production row needs transformation because the
  task tables do not exist there yet. Parts B/C can be separate additive tables/columns.
- **Whole application schema:** not final today. The old-send conversion/cutover remains unfinished and the current
  chosen route includes three future production-column drops.
- **Best way to guarantee no future destructive schema operation:** retain old production columns frozen forever.
  Dead nullable columns cost very little in a CRM of this size and are safer than deleting the only original evidence
  immediately after a one-time translation.

## Gated production deployment plan

This is a plan, not authorization to run it. Every gate must pass in order. A failure stops the rollout; it does not
become an assumption or a manual production experiment.

### Gate A — finish and accept the code on test

1. Fix findings 1–6 without changing the task data model.
2. Add the exact regression cases described in each finding. Ensure the tests fail against today's implementation
   before accepting the fix.
3. Run the complete §7 matrix on the verified test endpoint: TypeScript, full lint, production build, both timezone
   runs, client-section parity, concurrency at 100 iterations, backfill delta, and every migration dry-run/verify.
4. Perform the owed human click-through on phone and desktop with separate SR and manager accounts:
   - request PRICE + DESIGN + OTHER;
   - return PRICE only, then send it while DESIGN remains;
   - phone and SMS PRICE overlap with KEEP_OPEN and WITHDRAW_PARTS;
   - add and withdraw one part;
   - decline one part;
   - correct the earlier price send;
   - edit “Chceli” while OTHER holds a fallback CALL;
   - take over and bulk-transfer with a partially delivered task;
   - snooze/cancel a task and verify its final section;
   - two returned designs, one sent and one deliberately not sent.
5. Michal explicitly accepts Q9/Q12 behavior and the visual result. Only then change the tracker from pending review to
   accepted.

### Gate B — decide the final legacy-column policy

1. Choose “retain frozen old columns” or “one final reviewed contraction”.
2. Update the feature design, Prisma target, code-cutover rules and `db-changes.md` to describe only that route.
3. Do not mix the current test-only `?` legacy layer with the canonical-conversion route. There must be one deployable
   target schema and one compatible application commit.

### Gate C — build a fresh production duplicate and inventory it

1. Create a new Neon branch/restore point from live production. Use a separate environment variable name; never point
   routine `DATABASE_URL` at live.
2. Record the exact live schema and deployed commit. Diff the actual live schema against the chosen target; do not rely
   on baseline commit `7beb689` alone.
3. Run a read-only inventory covering every old email/CP/price/návrh combination, undo sequence, missing amount/date,
   deleted/multiple design, tracker row, pre-pipeline/deleted lead, and any already-canonical event.
4. Produce an explicit exception/mapping file and have Michal classify every exception. Zero unclassified records is
   a hard gate. Cenník recipients are named evidence, never inferred from a date cutoff.

### Gate D — repair and rehearse the data migration on the duplicate

1. Replace the old-send prototype's guesses with deterministic source identities and reviewed overrides. Add an
   unconditional production-endpoint denylist, strict validation, Lead locking, idempotent source keys, and a verify
   mode which treats skips as unresolved—not success.
2. Apply enum values first, outside transactions that use them.
3. Apply the reviewed structural delta. Use explicit SQL and concurrent indexes where needed; never accept a Prisma
   data-loss warning. For production, create the final `DealTask` and `DealTaskPart` shape directly. **Do not run the
   Wave 4 test conversion script**; production has no task rows.
4. Create the “Obchod” routing team, run the round-1 backfill dry-run/apply/verify, then the corrected old-send
   conversion and complete reconciliation.
5. Run the Wave 5 request migration only after canonical send conversion passes. Dry-run, review counts, apply, verify
   zero missing/duplicate rows.
6. If contraction was selected, perform it only after the per-lead and aggregate reconciliation passes. If frozen
   columns were selected, leave them untouched and verify the new code never writes or reads them for live behavior.
7. Deploy the exact candidate app against the clone. Run the full automated matrix and the human smoke test. Verify
   roles/scope, calls, pipeline, client detail, task inbox, combined request headline, history, receipt summaries,
   filters and counts.
8. Repeat the entire migration from a second fresh duplicate, or restore the first and rerun. The same inputs must
   produce the same counts and no duplicate events.

### Gate E — separately approved production window

1. Schedule a quiet window; take a fresh backup and restore-point Neon branch. Keep the existing production app
   available for rollback and briefly freeze writes during data conversion.
2. Reconfirm the live endpoint, live schema and source counts. Any difference from the rehearsed source aborts.
3. Run the exact reviewed SQL/scripts from the rehearsal—no edits in the production session.
4. Reconcile before deployment: every old real send has exactly one canonical representation or an approved exception;
   no phantom sends; offer summaries, designs, request states, tracker counts and unrelated data agree.
5. Deploy the exact rehearsed commit, run smoke tests with manager, SR and telesales accounts, then reopen writes.
6. Re-run all verify modes and compare aggregate counts. Keep the restore branch until Michal signs off after real use.
7. On any failed gate, stop writes and switch/restore to the prepared branch; do not attempt an ad-hoc forward repair.

## Verification performed in this review

| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npx eslint .` | stopped only on the documented pre-existing `components/layout/MobileNav.tsx:17` error |
| `npx next build` | passed; 20 routes generated |
| business-time checks | passed locally and with `TZ=UTC` |
| client-section checks | passed; totality over 4,200 combinations |
| `npx prisma validate` | passed |
| `git diff --check` | no whitespace errors; only line-ending warnings |
| database concurrency/backfill suites | **not run in this read-only review**; they write test data. The previous 211/211 result is documented, but its coverage gaps are findings 1, 3 and 5 |
| browser click-through | **not performed**; still explicitly owed in the tracker |
| production database | **not accessed or changed** |

## Release decision

**NO-GO for production.** Accept the Wave 4 task/part architecture, fix findings 1–6, correct the tests and status
documents, decide the old-column policy, and complete a fresh-clone rehearsal. The worker should use the existing
production version in seven hours; deploying this unrehearsed multi-wave migration is a materially larger risk than
temporarily working without Wave 4.
