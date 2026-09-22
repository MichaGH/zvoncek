# Wave 4 Part A implementation and production-readiness review — partA-R02

Date: 2026-09-21  
Scope: Wave 4 Part A after the `partA-R01` fixes, its Wave 5 integration, authoritative documentation, current
verification evidence, and a safe live-production rollout plan.  
Review type: read-only implementation and release-gate review. No application/context file or database was changed.

## Verdict

**Changes requested — Wave 4 Part A is not ready to call final, and the complete branch is not ready for production.**

The database shape and the central ownership model are accepted. One `DealTask`, stable `DealTaskPart` rows, one part
per manager-work kind, and a separate `LeadRequest` ledger for client intent are the right boundaries. Production has
no task tables, so it can receive the final Wave 3 + Wave 4 task schema in one additive step; the test-only removal of
`DealTask.contents` / `result` is not a production drop. Nothing found in this review requires another Wave 4 schema
change.

The six code defects from `partA-R01` were fixed correctly. The second pass did, however, find two remaining failures
in the locked-step workflow. Most importantly, the task fallback is assumed to be a deliberate user step, but in the
normal Wave 5 flow it is often an app-generated `SEND_QUOTE` / `SEND_DESIGN` / `SEND_EMAIL` step. Once that content is
sent, P6 restores the already-completed send step. The existing fallback tests only start from a deliberate `CALL`, so
they do not expose the common production case. Separately, the regular-email path that withdraws the last task part
still uses bare `unlockStep` instead of the canonical close derivation and offers the user a false “Ponechať: Poslať
cenu” choice after that price was just sent.

The partial-send confirmation explicitly required by the approved proposal is also absent. The form contains a static
warning, but saving a returned price while another part is still being made is a one-click save, not the specified
summary-and-confirm step.

Finally, production remains a **NO-GO independently of Wave 4**. The selected old-send conversion is still documented
as an unsafe prototype, the final contracted code/schema does not exist, and the complete migration has not been
rehearsed on a fresh production duplicate. The worker should remain on the current production application until the
gated plan at the end of this review has passed on a clone.

## Verification of partA-R01

| R01 finding | R02 result |
|---|---|
| 1 — correction did not recompute P6 | **Fixed.** `correctRecordAs` calls `refreshLockedStep` after reconciliation; no task is a no-op. |
| 2 — “Chceli” pencil used the pre-W4 rule | **Fixed.** An open task now invokes P6 without the `isSystemStep` guard; unlocked behavior is unchanged. |
| 3 — phone/SMS partial withdrawal could not save or strand the step | **Fixed.** Partial and closing withdrawals are distinguished, the server admits the closing case, and a stale fact-only client closes through `stepOnTaskClose`. |
| 4 — forged withdrawal could cancel unrelated work | **Fixed.** Both send commands use `withdrawMatchesOverlap`; exact task and exact overlapping requested kinds are required. |
| 5 — owner/status transitions used a stale stored step | **Fixed.** Cancelling owner transitions and snooze use `stepOnTaskClose`; snooze requires a future wake date. Bulk transfer shares the same domain primitive, although it still lacks a dedicated regression case. |
| 6 — fully dismissed output looked prepared | **Fixed.** The derived `DISMISSED` state renders `⊘`. |
| 7 — tests/status overstated confidence | **Partly fixed.** The missing targeted tests were added, but the response itself records that the full 100-iteration suite and backfill delta were not rerun after the final edits, and human acceptance is still owed. |
| 8 — live rollout was not executable | **Still open.** This remains a release blocker, not a Wave 4 task-table defect. |

## Findings

### 1. BLOCKER — the fallback can be an already-completed system send step

**What's wrong**

The proposal and implementation treat `fallbackKind` as the user's deliberate step. `createTask` actually copies the
current step unconditionally. In the normal Wave 5 workflow, the client first asks for a price or návrh, so the app has
already set `SEND_QUOTE` or `SEND_DESIGN` before the rep asks the manager. That app-generated send step is therefore
stored as the fallback. When no client-facing work remains but an `OTHER` part keeps the manager task open, P6 restores
the now-false send step. The same stale fallback can survive task closure.

**Where**

- `context/features/01-salesrep/wave-4-proposal.md:396-429` — P6 says fallback is the old step and describes it as the
  user's own decision, without handling an old system step.
- `lib/domain/taskMutations.ts:598-601` — every current kind/note is copied into the fallback.
- `lib/domain/lockedStep.ts:43-59` — no derived outstanding work means unconditional fallback restoration.
- `lib/domain/offerMutations.ts:237-255` and `lib/commands/offers.ts:165-166` — a send reconciles client work and then
  runs that fallback rule while the task stays open.
- `prisma/backfill/check-concurrency.ts:4488-4525` — `w4Fallback` covers only a deliberately chosen `CALL`; it never
  starts from the common app-generated `SEND_QUOTE` / `SEND_DESIGN` step.

**Concrete failure scenario**

1. The client asks for an exact price. Wave 5 creates an open PRICE request and the app sets `SEND_QUOTE`.
2. The SR asks the manager for `PRICE + OTHER`. `fallbackKind` is stored as `SEND_QUOTE`.
3. The manager returns PRICE; OTHER remains `REQUESTED`.
4. The SR sends the returned price. The PRICE request becomes `SENT` and the returned item is consumed.
5. There is now no client-facing outstanding content; only OTHER is still being answered. P6 finds no default and
   restores fallback `SEND_QUOTE`.
6. The deal card says “Poslať cenu” even though the event ledger proves the price was sent. The step is locked, so the
   SR cannot repair it. When OTHER closes, the same false step can become due today.

This is not an exotic correction or crafted payload. It starts with the principal “client asks → SR asks manager”
workflow.

**Why it matters**

The central Wave 4 promise is that a locked step is a truthful projection, not stale mutable state. This case violates
that promise in the most common price workflow and can instruct the worker to send the same content twice.

**Suggested fix**

Define fallback as a **manual/user-decided fallback**, not an unconditional snapshot. A system send step whose work no
longer exists must not be restored. This can be fixed without a schema change because the existing fallback columns
are nullable and `isSystemStep` already distinguishes app-owned steps.

One safe policy is:

- preserve `CALL`, `WAITING_FOR_CLIENT`, `CUSTOM`, etc. as the fallback;
- when the pre-task step is an app-owned send step (or no step), use a neutral post-task policy rather than preserving
  that stale send — for this small CRM, `CALL` today after closure and a locked “čaká na manažéra” representation while
  only OTHER remains is safer than silently restoring completed work;
- make the exact neutral behavior an explicit decision in the proposal before coding it.

Add a regression that starts from a real Wave 5 PRICE request and `SEND_QUOTE`, opens `PRICE + OTHER`, delivers and
sends PRICE, then closes OTHER. Assert that neither the locked nor unlocked step says `SEND_QUOTE`. Repeat with DESIGN
and with a deliberately chosen CALL to prove the valid manual fallback still returns.

### 2. BLOCKER — regular email can close the final task part through bare `unlockStep` and keep a false send step

**What's wrong**

When a regular email overlaps the last `REQUESTED` task part and the owner chooses “Už to netreba”, the command closes
the task and immediately calls bare `unlockStep`. It then records/reconciles the email. If the user declines the offered
follow-up, `recordOffer` sees no outstanding work and leaves the current kind unchanged. The task is closed, but the
step can remain the exact send which just happened.

This path also contradicts the now-documented invariant that every task-ending path uses `stepOnTaskClose` after the
final outstanding state is known.

**Where**

- `lib/commands/offers.ts:116-166` — final-part withdrawal calls `unlockStep` before `recordOffer`; no canonical close
  derivation runs after request reconciliation.
- `lib/domain/offerMutations.ts:241-255` — `followUp: false` plus no outstanding work intentionally leaves the current
  system kind alone.
- `components/pipeline/OfferSentDialog.tsx:150-154,182-203,525-540` — closing the task exposes a next-step choice and
  explicitly permits “Ponechať: Poslať cenu/návrh”.
- `prisma/backfill/check-concurrency.ts:4788-4801` — the final email-withdrawal test always uses `followUp: true`; there
  is no test for the “Ponechať” branch.
- `context/features/01-salesrep/wave-4-proposal.md:459-473` and `context/domain/operations.md:54` — close must perform
  the final P6 derivation and then unlock.

**Concrete failure scenario**

A one-part PRICE task is locked on `SEND_QUOTE`. The SR independently obtains the price, sends it by email, chooses
“Už to netreba – stiahnuť cenu”, and chooses “Ponechať: Poslať cenu” instead of the follow-up call. The transaction
records a valid PRICE receipt and closes the task as `CANCELLED`, but leaves `SEND_QUOTE` due today. The same screen
therefore records “sent” and tells the rep to send it again.

**Why it matters**

This is a normal owner workflow exposed by the UI, not a forged request. It breaks the event/summary/step agreement and
means not every task-ending route has the same semantics.

**Suggested fix**

Do not finalize the step before `recordOffer` has reconciled the send. After the email and part transition are both
known, use one canonical close policy: a requested follow-up may win; otherwise run the corrected task-close
derivation against the post-send outstanding state and the corrected fallback policy from finding 1. Remove or relabel
the false “Ponechať: Poslať …” option when the selected content completes that work.

Add tests for a one-part PRICE and a one-part DESIGN task with `WITHDRAW_PARTS`, both `followUp: true` and false, a
manual fallback, a system fallback, stale revision, replay, fingerprint conflict, and two simultaneous tabs. Assert
task status, request state, receipt, step kind/date/mode, one revision bump and one keyed primary event.

### 3. IMPORTANT — the required partial-send confirmation was never implemented

**What's wrong**

The approved proposal requires an in-dialog confirmation whenever the save sends only part of the work and the manager
task remains open. The current component displays a generic amber sentence at the top, but `save()` submits directly.
Its only second-stage confirmation is the unrelated “manager sending on somebody else's deal” question.

**Where**

- `context/features/01-salesrep/wave-4-proposal.md:587-598,1142-1147` — explicit summary/confirmation and Part A UI
  acceptance requirement.
- `components/pipeline/OfferSentDialog.tsx:236-280` — save has no partial-send confirmation state or gate.
- `components/pipeline/OfferSentDialog.tsx:302-310` — only a static generic warning.
- `components/pipeline/OfferSentDialog.tsx:465-496` — overlap choices explain manager work but are not the required
  summary for a returned PRICE sent while DESIGN remains.
- `components/pipeline/OfferSentDialog.tsx:566-585` — the only in-app confirmation is `confirmOwner`.

**Concrete failure scenario**

The manager returned PRICE but is still making DESIGN. The email form is prefilled with the ready price. The SR taps
“Uložiť” on a phone. The send is committed immediately; she never sees the required “sending price now / manager still
makes design / your step remains locked on design” summary and cannot go back from a confirmation screen.

**Why it matters**

No data invariant is violated, but this confirmation was Michal's explicit usability guard for the unusual partial
flow. Omitting it makes an irreversible business event easier to log accidentally and means the implementation does
not match the accepted feature.

**Suggested fix**

Add one second-stage state only when `task && factOnly`: show what is being sent, which `REQUESTED` parts remain, and
the resulting locked headline, with “Áno, poslať len …” and “Späť”. It must compose with `confirmOwner` without nested
browser dialogs or double submission, and it must reuse the same idempotency key. Add a component-level/manual phone
and desktop acceptance case.

### 4. IMPORTANT (release gate) — the latest complete database-backed verification has not been run

**What's wrong**

The R01 response correctly says that after its final edits only the selected Wave 4 set ran at 20 iterations. The full
100-iteration concurrency suite and backfill-delta check were not rerun, and human phone/desktop acceptance remains
owed. The tracker still displays the older 211/211 and 6/6 table under Wave 4 without clearly stating that those totals
predate the R01 fixes.

**Where**

- `.ai/reviews/01-sales-rep/W4/implementation/partA-R01-response.md:90-101` — exact missing checks.
- `context/progress-tracker.md:303-314,324-354` — older full results followed by the later fixes and outstanding human
  pass.
- `context/code-standards.md:94-109` — all checks are required before a wave is declared done; an unrun check did not
  pass.

**Concrete failure scenario**

The branch is deployed based on the older 211/211 headline even though findings 1 and 2 above have no regression and
the current post-R01 code has never completed the full race matrix. A timing or migration regression is then first
encountered by the worker.

**Why it matters**

The new defects are precisely in branches the current tests omit. Old green totals cannot certify changed code.

**Suggested fix**

After findings 1–3 are fixed, run the entire §7 matrix on the verified test endpoint, including concurrency at 100
iterations and `check-backfill-delta`. Add the missing regression cases first. Then perform the documented SR + manager
phone and desktop click-through. Record the post-fix run separately with its commit/worktree identity; do not reuse the
older total.

### 5. MINOR — authoritative workflow/domain documentation still describes pre-fix behavior

**What's wrong**

Several current-source-of-truth statements contradict the implementation and one another:

- the workflow says manager help is “one choice”, then immediately says Wave 4 permits any combination;
- the workflow says correcting a send never touches the step, but Wave 4 correctly re-derives it while locked;
- the operations map says `correctRecord` never touches the next step without qualifying the command-level locked
  recomputation;
- the operations map says the “Chceli” pencil never touches an open task, although the R01 fix deliberately does.

**Where**

- `context/app-workflow.md:214-216,284-296`.
- `context/domain/operations.md:54,56,88`.

**Concrete failure scenario**

A future AI follows `operations.md:88`, restores the `isSystemStep` guard to the pencil, and recreates R01 finding 2;
or a tester expects only one manager-help choice despite the shipped multi-part UI.

**Why it matters**

This does not break runtime today, but these files are explicitly the source of truth for future work. Contradictory
rules are likely to reintroduce fixed bugs.

**Suggested fix**

After the final step policy is decided, make the documents say: 1–3 task parts; correction and pencil re-derive only
while an open task owns the step; unlocked corrections preserve the user's step. Keep the proposal's protected status
text as historical design metadata if desired, but current domain/workflow docs must be unambiguous.

### 6. BLOCKER (ROLLOUT) — the branch still has no executable final migration from live production

**What's wrong**

Wave 4's own task schema is additive, but it is not deployable in isolation from the branch's Round 1, Wave 3a and
Wave 5 changes. The ledger assumes rather than measures the live baseline, still owes assignment/team/request data
steps, identifies the old-send conversion as defective, and says current code is incompatible with the chosen
contracted target. Planned P-01–P-03 drops are intentionally non-additive and have not been implemented or rehearsed.

**Where**

- `context/domain/db-changes.md:12-28` — production baseline is assumed; planned contraction is outside the current
  “all additive” delta.
- `context/domain/db-changes.md:123-137,164-176` — Wave 4 itself is additive to production and has no production task
  conversion.
- `context/domain/db-changes.md:211-219` — routing/assignment and Wave 5 data steps remain owed.
- `context/domain/db-changes.md:321-346` — the current old-send migration prototype is explicitly unsafe.
- `context/domain/db-changes.md:348-395` — clone rehearsal, reconciliation, P-01–P-03 and the code cutover are not done.
- `context/domain/db-changes.md:397-425` — the documented production order is still a plan, not a completed rehearsal.

**Concrete failure scenario**

The current Prisma schema is pushed directly to live because its net-delta section says “all additive”. Test-only
legacy columns are added despite the chosen final route, old sends are converted by the defective prototype or not at
all, Wave 5 backfills an incomplete picture, and the application then either duplicates old client receipts or loses
the meaning of the production price/email flags. Dropping the old columns afterwards removes the only remaining
evidence needed to repair the conversion.

**Why it matters**

This is the database holding thousands of real contacts. A restore branch is useful recovery, not a substitute for a
rehearsed mapping. The first execution of the combined multi-wave migration cannot be production.

**Suggested fix**

Follow the gated rollout plan below. Do not deploy this branch, run `db push`, run a backfill, or drop a live column
until every clone gate passes. This finding does not ask for a Wave 4 task-schema redesign.

## Checks performed in this read-only review

Safe local checks run against the files only:

| Check | R02 result |
|---|---|
| `git diff --check` | passed; only line-ending warnings from Git |
| `npx tsc --noEmit` | passed |
| `npx eslint .` | only the documented pre-existing `components/layout/MobileNav.tsx:17` error |
| `npx next build` | passed; 20 application routes |
| `npx prisma validate` | passed |
| `check-business-time.ts` | passed in local timezone and `TZ=UTC` |
| `check-client-sections.ts` | passed, including totality over 4200 combinations |
| database-backed concurrency/backfill scripts | **not run** — this review was explicitly read-only and they write to a database |
| phone/desktop click-through | **not run** — still a human acceptance gate |

Passing compilation and pure checks do not invalidate findings 1–3; their branches are absent from the current tests.

## Gated production deployment plan

This is a plan, not authorization to execute it. **Current gate: STOP at Phase 0.**

### Phase 0 — finish and freeze the target

1. Fix findings 1–3 without changing the Wave 4 schema. Record the chosen system-fallback behavior in the proposal and
   synchronize current workflow/domain docs.
2. Add the missing regressions and run the complete check matrix at 100 iterations on the verified test endpoint.
3. Complete SR + manager acceptance on phone and desktop for:
   - PRICE + DESIGN partial manager delivery;
   - sending PRICE while DESIGN remains in progress;
   - PRICE + OTHER beginning from a Wave 5-generated `SEND_QUOTE` step;
   - final-part email withdrawal with and without follow-up;
   - correction, “Chceli” pencil, owner change, snooze, add/withdraw/decline part, and manager takeover.
4. Implement the final old-send inventory/conversion/reconciliation and the matching contracted application code.
   Remove the test-only legacy layer from the target; do not add those temporary columns to production.
5. Freeze one exact deploy commit and generate all migration artifacts from that commit. No feature edits after the
   rehearsal begins; a code change restarts the affected gates.

### Phase 1 — fresh production-clone rehearsal

1. Create a fresh Neon branch/restore point from production and keep its connection string in a dedicated rollout
   environment, never the normal development `DATABASE_URL`.
2. Read the clone's actual schema and data inventory. Compare it with the assumed baseline in `db-changes.md`; record
   every surprise before generating SQL.
3. Generate and review one **live-baseline → final-target** schema diff. For Wave 4 specifically:
   - create `DealTask`, `DealTaskPart`, their enums, FKs and indexes directly in final shape;
   - do not run `2026-09-wave4-parts.ts` — production has no task rows and that script is historical/test-only;
   - do not create then drop `DealTask.contents` / `result`;
   - land enum values before any code or data step uses them.
4. Review lock impact. Indexes on new empty task/request tables are cheap; indexes on existing `Lead` / `Activity`
   tables need measured sizes and reviewed `CREATE INDEX CONCURRENTLY` or a maintenance window.
5. Apply the additive schema to the clone. Confirm the schema is exactly in sync without accepting any data-loss
   prompt.
6. Create the “Obchod” routing team, then run the Round 1 assignment backfill dry-run → reviewed apply → verify.
7. Run the corrected old-send inventory. Classify every old email/CP/price/návrh record and every exception; zero
   unclassified evidence is the apply gate.
8. Apply the corrected canonical send conversion idempotently, rerun it to prove no duplicates, and reconcile per lead
   and in aggregate: event counts, amounts, dates, actors, grouped email contents, designs, tracker history, summary
   columns, list/detail/filter parity.
9. Run the Wave 5 request backfill only after the send conversion; dry-run → reviewed apply → verify. Confirm “Chceli”
   and “Klient dostal” agree and no already-sent content becomes open work.
10. Apply P-01–P-03 only after steps 7–9 pass and the frozen application no longer reads those fields. This is the
    deliberate non-additive point of no return; verify the restore procedure before it.
11. Deploy the frozen application against the clone. Run the full automated matrix, migration verifies, role/scope
    checks, and the complete smoke/click-through list. Repeat the rehearsal from another fresh clone if any artifact or
    mapping changes.

### Phase 2 — production change window

1. Obtain separate rollout approval. Announce a short write freeze; keep the current production version running until
   the window begins.
2. Create and verify a production backup/restore-point branch. Re-read the live schema and the old-send inventory; they
   must match the successfully rehearsed source. Any drift aborts the rollout.
3. Freeze CRM writes. Run the **same reviewed artifacts, in the same order** as the successful clone rehearsal:
   additive schema → team → Round 1 backfill → old-send conversion/reconciliation → Wave 5 backfill → approved
   contraction.
4. Deploy the exact frozen commit immediately after the contraction. Do not run the old application against the
   contracted schema.
5. Run all verify modes and focused smoke tests before reopening writes: login/roles, calls claim/handoff, pipeline
   scopes, “Pre mňa”, “Čakám na manažéra”, multi-part task, partial send, history, “Chceli” versus “Klient dostal”,
   design tracking, counters versus lists.
6. Reopen writes only when every gate is green. If any pre-contraction gate fails, stop and fix without dropping old
   evidence. If a post-contraction gate fails, keep writes closed and switch/restore through the rehearsed Neon branch
   procedure; do not improvise data repair on live production.

### Release criteria

Production is a **GO** only when all are true:

- findings 1–3 are fixed and their regressions pass;
- the latest complete 100-iteration suite and backfill checks pass on the frozen commit;
- human phone/desktop acceptance passes;
- a fresh-clone rehearsal from the measured live schema completes twice without manual SQL improvisation;
- old-send inventory has zero unclassified evidence and reconciliation has zero unexplained differences;
- the exact target schema excludes test-only legacy fields and includes no unrecorded destructive change;
- backup, write freeze, rollback owner and stop conditions are agreed before the window.

## Final assessment

**Accept the Wave 4 Part A data model; request the listed code/UX fixes; do not deploy the branch yet.** Findings 1–3
are implementable without another schema change, so the task/part database design can remain final. The statement “no
more destructive/transformative production changes” cannot yet be made for the whole application because the already
chosen old-send contraction is still pending and unrehearsed.
