# Wave 4 Part A implementation and production-readiness review — partA-R03

Date: 2026-09-21  
Scope: Wave 4 Part A after the `partA-R02` fixes, the redesigned pipeline filters, the uncommitted
`/dashboard/pipeline/[id]` restyle, authoritative documentation, current automated verification, and readiness for a
live-production migration.  
Review type: implementation and release-gate review. The application, context files and production database were not
changed. The database-backed verification scripts used only the verified test branch and removed their fixtures.

## Verdict

**Changes requested — do not deploy this working tree to production yet.**

The central Wave 4 solution is accepted: `DealTask` represents one manager-assistance process, stable
`DealTaskPart` rows represent PRICE / DESIGN / OTHER work, `LeadRequest` remains the separate record of what the
client asked for, and the locked step is derived from remaining work. The R02 fallback, final-part email withdrawal
and partial-send confirmation fixes are present and the complete automated suite now passes. I found no reason to
redesign the Wave 4 task tables and no additional Wave 4 schema change is required by this review.

The branch is nevertheless not release-ready. The supposedly visual deal-detail restyle removed the only UI for
correcting **what the client asked for**, which is a shipped Wave 5 operation and is not equivalent to correcting what
the client received. The new “Na spracovanie” queue also hides a deal as soon as any manager task is open, even after
one part has returned and the owner can act on it. A separate URL-state defect carries a hidden step filter into the
“Klient už dostal” views, so their displayed count can disagree with the resulting list and the user cannot see why.

Production remains a separate **NO-GO**: the current V2 code still depends on the temporary test-only legacy layer,
the old-send converter is explicitly unsafe, the live baseline has not been measured, and no fresh-production-clone
rehearsal has occurred. Wave 4's own final task schema is additive to production, but the complete branch still has a
planned, non-additive P-01–P-03 conversion/contraction. It is therefore not correct yet to promise that no further
transformative production migration remains.

## Verification of partA-R02

| R02 finding | R03 result |
|---|---|
| 1 — stale system fallback could restore an already-completed send | **Fixed.** A manual step remains the fallback; a system/no step uses the neutral CALL fallback. The only-OTHER presentation is waiting for the manager, not another send instruction. |
| 2 — final regular-email withdrawal used bare `unlockStep` | **Fixed.** The send is reconciled before canonical task-close step derivation; the no-follow-up and follow-up branches are covered. |
| 3 — partial-send confirmation was missing | **Fixed in code.** The staged confirmation lists what is sent and what remains, composes with the foreign-owner confirmation and reuses the idempotency key. Human phone/desktop acceptance is still owed. |
| 4 — complete current verification had not run | **Fixed for automation.** The current tree passed 231/231 at 100 iterations and the 6/6 backfill-delta matrix. Human acceptance is still open. |
| 5 — current documentation described pre-fix behavior | **Mostly fixed.** The current fallback/correction rules are synchronized. `operations.md` has since become stale for the redesigned filters; see finding 5. |
| 6 — no executable final production migration | **Still open and release-blocking.** See finding 6. |

## Findings

### 1. BLOCKER — the “visual-only” detail restyle removed the only correction UI for “Chceli”

**What's wrong**

The restyle removed the second pencil and the complete `ClientAsks` sheet from `CenovaPonukaCard`. The server command
still exists, but no application component calls it. Correcting **what the client asked for** is not the same as
correcting an `OFFER_SENT` receipt. The progress tracker explicitly describes this as UI-only while also recording the
removal, and incorrectly justifies it through receipt correction.

**Where**

- `components/pipeline/CenovaPonukaCard.tsx:61-87,135-152` — the component no longer receives `revision`, imports or
  invokes `setClientAsks`, and the “Chcú teraz” panel has no edit control.
- `lib/actions/pipeline/index.ts:149-152` — `setClientAsks` remains implemented but has no UI caller.
- `context/features/01-salesrep/wave-5-proposal.md:103,311` — an ask can be added or withdrawn through the pencil, with
  row-level stale/idempotency rules.
- `context/app-workflow.md:236-260` — the authoritative workflow still promises the pencil for adding and withdrawing
  client intent.
- `context/progress-tracker.md:383-394` — labels the restyle “UI only” while recording that this functional entry point
  was removed.

**Concrete failure scenario**

Telesales accidentally marks DESIGN, or the client later says “návrh už nechcem”. The resulting `LeadRequest(DESIGN,
OPEN)` continues to drive “Na spracovanie”, the combined send headline and the unsent-work warning. The SR opens the
deal but has no way to withdraw that request. Correcting a send cannot help because nothing was sent, and closing or
snoozing the whole deal is not the intended correction.

**Why it matters**

This can strand false open work and cause the rep or manager to create work the client no longer wants. It is a
functional regression immediately before rollout, not a design preference.

**Suggested fix**

Restore an explicit “Upraviť, čo klient chce” entry point using the existing `setClientAsks` command and its existing
sheet behavior. It may be a small pencil in “Chcú teraz”, an action in the main action bar, or an item inside the
history disclosure; the visual placement may change, but the operation must remain reachable for every actor already
authorized by the command. Do not replace it with receipt correction. Add a component/manual acceptance case for add,
withdraw-with-reason, open-task warning, stale revision and manager-on-rep-deal use.

### 2. IMPORTANT — a partially returned manager task remains excluded from “Na spracovanie” even when the owner can act

**What's wrong**

“Na spracovanie” is documented as open client promises on which the owner can act now. Its query instead excludes
every deal with any open manager task. Wave 4 deliberately permits PRICE to be returned and sent while DESIGN remains
in progress. At that point the deal is simultaneously waiting for the manager **and** actionable by the SR, but the
query keeps it only in “Čakám na manažéra” (and “Všetko”), not in the owner's work queue.

**Where**

- `lib/queries/pipeline/index.ts:75-86` — `work` requires an OPEN request and `tasks.none(status = OPEN)`.
- `context/app-workflow.md:134-138` — “Na spracovanie” means client promises the owner can act on now.
- `context/features/01-salesrep/wave-4-proposal.md` §5.4/§7 — partial task completion and sending one returned part
  while another part remains are intentional core behavior.
- `prisma/backfill/check-concurrency.ts` — the Wave 4 partial-send scenarios prove the operation is legal, but the W4A-F
  filter tests do not assert that this newly actionable deal enters “Na spracovanie”.

**Concrete failure scenario**

The client asks for PRICE + DESIGN. The manager returns PRICE today and continues making DESIGN for a week. The SR can
and, in the exceptional workflow, should send PRICE now. The default pipeline opens “Na spracovanie” because other
work exists, but this deal is absent; it remains grouped only under “Čakám na manažéra”, where the user reasonably
expects there is nothing for her to do.

**Why it matters**

The redesign was specifically meant to show the SR what to finish after the initial-call batch. It misses the most
important new Wave 4 edge: one task can be partly returned and partly waiting. This can delay a promised price.

**Suggested fix**

Allow the two queues to overlap. Keep the deal in “Čakám na manažéra” while any part is `REQUESTED`, but also include
it in “Na spracovanie” whenever at least one client-facing item is actionable by the owner now. In concrete terms, an
OPEN INFO/PRICELIST/REVIEW request is owner-actionable, and PRICE/DESIGN is owner-actionable when it is not still
covered by a matching `REQUESTED` manager part (including a delivered/prepared result that has not been sent). Derive
this from the same request/task-part state used by the detail; do not infer it solely from `nextActionKind`. Add list +
count tests for PRICE delivered / DESIGN requested, the reverse, task-only returned work without a `LeadRequest`, all
parts still requested, and consumption of the returned part.

If product policy intentionally wants the queues mutually exclusive, rename/reword them and explicitly teach the SR
to inspect “Čakám na manažéra” for returned work. That is a product choice; it does not match the currently documented
meaning or the workflow Michal requested.

### 3. IMPORTANT — “Klient už dostal” keeps an invisible step filter, causing count/list mismatch

**What's wrong**

The step chip is intentionally hidden while an extra view such as “Dostali cenu” is active. However, `dealsHref`
preserves the current `step`, and those extra views are considered step-compatible. The query therefore silently
intersects the extra view with the hidden old step. The chip displays the unfiltered extra count from `getDealCounts`,
so the number can disagree with what clicking it shows.

**Where**

- `components/pipeline/DealFilters.tsx:140-149,301-318` — extra view hides step controls and its links change only
  `view`.
- `lib/domain/dealFilters.ts:72-73,87-88,151-165` — only inbox/waiting-manager clear `step`; got-price/pricelist/design
  preserve it.
- `lib/queries/pipeline/index.ts:592-620` — the preserved step is applied to the extra-view query.
- `lib/queries/pipeline/index.ts:703-714` — the displayed extra count is calculated without the page's current step.
- `context/app-workflow.md:139-146` — promises visible composable state and a count that matches the clicked list.

**Concrete failure scenario**

The SR selects `Všetko → Volať`, opens the disclosure and clicks “Dostali cenu (12)”. The generated URL still contains
`step=call`. The step row disappears because the extra view is active, while the list shows only price recipients
whose next step is CALL — perhaps 2 records. The UI still showed 12 and offers no visible indication or direct control
for clearing the hidden filter.

**Why it matters**

The filter looks broken and can make records appear missing immediately after a click. This is a deterministic URL
state bug, not a subjective layout concern.

**Suggested fix**

Because the design hides step chips in these views, treat every extra view as a no-step view: clear `step` when
entering `got_pricelist`, `got_price`, `got_design` or `unverified`, and normalize hand-written URLs the same way.
Alternatively, keep the step row visible and calculate the visible extra counts inside that step, but that is a more
complex UI than intended. Add href/parse/list/count tests starting from both `work?step=...` and `all?step=...`.

### 4. IMPORTANT — “Chcú teraz” can present manager-only work as something the client requested

**What's wrong**

`outstandingRows` intentionally merges three different sources: open client requests, manager work being made and
prepared manager results. The redesigned card places all three beneath the literal title “Chcú teraz”. A Wave 3/4
manager task may exist without any `LeadRequest`; that is explicitly supported. In that case the panel makes a false
business claim about the client.

**Where**

- `components/pipeline/CenovaPonukaCard.tsx:99,135-150` — any row with an open request, prepared result or `making`
  flag is displayed under “Chcú teraz”.
- `context/features/01-salesrep/wave-5-proposal.md:216,426-447,568-572` — manager work is a separate source and may
  exist with no client request; `OTHER` never maps to client intent.
- `context/app-workflow.md:40-48,236-260` — asking for manager work and recording what the client asked for are
  deliberately separate processes.

**Concrete failure scenario**

An SR asks the manager to calculate PRICE as internal assistance without recording a client PRICE request. The manager
returns it. The detail now says “Chcú teraz: Konkrétna cena”, even though the request ledger contains no evidence that
the client asked for that. The same false label appears while manager work is merely being prepared.

**Why it matters**

Wave 5 was built specifically to keep client intent separate from manager assistance. The data remains correct, but
the new UI erases that distinction and may lead staff to contact the client on a false premise.

**Suggested fix**

Under “Chcú teraz”, render only rows with `openIds.length > 0`. Show task-only `making` / `prepared` rows separately as
“Práca pre manažéra / pripravené na odoslanie”, or rename the entire panel to a truthful neutral label such as “Treba
vybaviť” and visually distinguish “klient chce” from “interná práca”. Preserve the request history as the source of
truth for the former. Add the already-supported manager-work-without-request scenario to component/manual acceptance.

### 5. MINOR — `operations.md` still documents the old flat filter contract

**What's wrong**

The current domain map says `DEFAULT_VIEW = "today"`, calls step kinds views/pills, and omits `AUTO_VIEW`,
`DEAL_STEPS`, `resolveView`, `statusHasQueues` and `getDealStepCounts`. The implementation and `app-workflow.md` now
use a three-level status → queue → step model with an automatic work/today default.

**Where**

- `context/domain/operations.md:49` — stale filter API and default.
- `lib/domain/dealFilters.ts:25-27,65-73,118-139` — current URL model and automatic default.
- `lib/queries/pipeline/index.ts:703-722` — separate queue and within-queue step counts.

**Concrete failure scenario**

A future change follows the source-of-truth operations map and restores `today` as the raw default or treats `call` as
a queue view. That can bypass the new normalization and recreate count/list divergence.

**Why it matters**

No runtime bug is caused today, but `operations.md` is explicitly the reusable-operation source for future AI work.

**Suggested fix**

After findings 2–3 settle the final behavior, rewrite only the `dealFilters.ts` / pipeline-query entries to document
the current status, queue, step, auto-default and count APIs. Keep implementation history in the progress tracker, not
in the domain map.

### 6. BLOCKER (ROLLOUT) — the final live migration is still at Phase 0 and current code targets the wrong legacy shape

**What's wrong**

Wave 4's task tables can be created additively and production has no task rows to transform. The complete V2 branch,
however, cannot be applied safely to the live database yet. The current schema/code still read test-only
`hadLegacySends`, `legacySendsReviewedAt` and `Design.legacySentAt`; the selected final route says not to create those
columns in production. The converter that should replace them has known mapping, safety and reconciliation defects.
The actual live schema/data combinations have not been inventoried and none of the clone gates has begun.

**Where**

- `.ai/migrations/v1-to-v2-live/README.md:17-27` — explicit STOP at Phase 0 and unsafe-prototype warning.
- `.ai/migrations/v1-to-v2-live/PROGRESS.md:5-32,52-58` — G0 blocked; G1–G9 not started.
- `context/domain/db-changes.md:250-264,321-373` — selected canonical conversion, prototype defects and mandatory
  rehearsal order.
- `context/domain/db-changes.md:375-394` — planned P-01–P-03 contraction and removal of test-only legacy code/fields.
- `lib/queries/pipeline/index.ts:95-96,205-206,271-272,480-481,547-549,844-850` and
  `components/pipeline/CenovaPonukaCard.tsx:95-96,173-213` — current application still depends on that temporary layer.

**Concrete failure scenario**

The current branch/schema is deployed directly because the Wave 4 portion is additive. The application then either
expects legacy fields that the chosen production target intentionally lacks, or those temporary fields are added and
the unsafe converter is used. Existing live email/price/návrh evidence can be duplicated, misclassified or left
unconverted; dropping P-01–P-03 afterwards removes the evidence needed to repair it.

**Why it matters**

This database contains thousands of live contacts. Passing Wave 4 tests proves the new task workflow; it does not
prove the multi-wave V1 → V2 data translation.

**Suggested fix**

Do not deploy or run schema/backfill commands on production. Complete the gated rollout below. This finding does not
require a different Wave 4 schema.

## Pipeline filter assessment

The overall redesign is appropriate for the real workflow: status, work queue and step are now distinct; manager
inbox and waiting-for-manager are separate; the default chooses actionable post-call work before deadlines; server
scope remains authoritative; and list/count queries share their predicates. Owner/status normalization and the
manager inbox still preserve the existing permission boundary. No server-side scope leak was found.

Findings 2 and 3 are the two material gaps. They are predicate/URL-state problems, not reasons to abandon the filter
design. Fixing them needs no database change.

## Deal-detail and `/calls` UI assessment

Moving the four primary actions into one bar preserves the previous capability checks (`editable`, owner-only
`canAsk`, no second open task), and removing duplicate ask buttons from `TaskCard` does not create a permission bypass.
The history/cena disclosures are presentational and compile cleanly. The shared `/calls` request cards and the pipeline
picker use the same option component and no functional divergence was found in code.

The detail restyle is not purely visual because of finding 1, and “Chcú teraz” needs the semantic correction in
finding 4. The new partial-send confirmation, shared `/calls` picker, filter layout and restyled detail have still not
been clicked through in a real phone and desktop browser; this remains a release acceptance gate even though the code
and automated tests pass.

## Checks performed on the current working tree

The configured database identity was verified as the test branch (`ep-curly-field-asnhww8x`, database `neondb`). The
production endpoint was not present or accessed.

| Check | R03 result |
|---|---|
| `git diff --check` | passed; Git reported only line-ending warnings |
| `npx tsc --noEmit` | passed |
| targeted ESLint for the changed pipeline/calls/filter files | passed |
| `npx eslint .` | only the known pre-existing `components/layout/MobileNav.tsx:17` `react-hooks/set-state-in-effect` error |
| `npx next build` | passed; 20 application routes |
| `npx prisma validate` | passed |
| business-time check, local timezone | passed |
| business-time check, `TZ=UTC` | passed |
| client-section totality/parity suite | passed; 4200 combinations |
| full concurrency/functional suite, `--iterations 100` | passed; **231/231**; test fixtures cleaned up |
| backfill-delta matrix on the test branch | passed; **6/6**; test fixtures cleaned up |
| human phone + desktop click-through | **not run** |

The green suite validates the implemented cases, including the R02 fixes. It does not invalidate findings 1–4: the
removed UI route and the specific queue/hidden-filter presentation cases are not asserted by those tests.

## Gated live-deployment plan

This is a plan, not authorization to access or change production. **Current gate: STOP at Phase 0.**

### Phase 0 — finish and freeze

1. Restore the “Chceli” correction entry point and fix the two filter predicates/URL rules. Correct the “Chcú teraz”
   label/source distinction. None requires a schema change.
2. Add the targeted regressions described in findings 1–4 and rerun the complete §7 matrix on the verified test
   branch.
3. Perform the documented SR + manager click-through on phone and desktop: first-call multi-select, request correction,
   ask PRICE + DESIGN, partial return, partial send confirmation, final return/send, task-only work, all filter
   transitions (including extra views from an active step), and the restyled detail actions/history.
4. Implement and review the final old-send inventory, deterministic conversion, reconciliation and contracted
   application code. Remove the temporary legacy layer from the target; do not add its test-only columns to live.
5. Freeze one exact deploy commit/SHA. Any application, schema or conversion change after this point restarts the
   affected gates.

### Phase 1 — rehearse twice on fresh production duplicates

1. Obtain the exact currently deployed application SHA and create a fresh Neon branch from production with external
   side effects disabled. Store its connection separately from normal development.
2. Measure the clone's actual schema and every old email/price/návrh combination; compare it with the assumed ledger.
   Resolve every exception with Michal. Zero unclassified source evidence is the apply gate.
3. Generate and review an explicit **measured live baseline → final target** migration. Create the Wave 3/4 task tables
   directly in final shape; do not create/drop historical test-only task columns and do not run the test-data Wave 4
   converter against production data.
4. Apply additive schema and routing/team changes, then run the reviewed assignment, old-send and Wave 5 request data
   steps in their documented order. Each step must have dry-run, apply, verify and idempotent-rerun evidence.
5. Reconcile per lead and in aggregate: one canonical receipt per real send, correct amount/date/channel/actor/content,
   correct design links, summary columns, request states, task/step views, filters/counts and untouched unrelated data.
6. Apply P-01–P-03 only after canonical reconciliation is zero-difference and the frozen application no longer reads
   them. Deploy the frozen app to the clone and run the full automated and human smoke matrix.
7. Repeat the complete rehearsal from a second fresh clone using the same artifacts without ad-hoc SQL. Any artifact or
   mapping change invalidates the earlier rehearsal.

### Phase 2 — controlled production window

1. Obtain explicit production approval, name the rollout/rollback owner, announce a short write freeze and create a
   verified restore-point branch.
2. Re-read live schema/data. Any drift from the successful rehearsal aborts the window.
3. With writes frozen, execute the exact reviewed artifacts in the exact rehearsed order. Never use `db push` with a
   data-loss acceptance and never improvise data repair on live.
4. Deploy the exact frozen SHA, run all verify modes and focused role/workflow/filter/detail smoke tests, then reopen
   writes only if every gate is green.
5. A pre-contraction failure stops without dropping old evidence. A post-contraction failure keeps writes closed and
   uses the rehearsed Neon restore/switch procedure.

## Release criteria

Production is a **GO** only when:

- findings 1–4 are fixed and their targeted regressions pass;
- the current complete automated matrix remains green after those fixes;
- phone and desktop acceptance passes for the new confirmation, `/calls` picker, filters and restyled detail;
- the exact target commit and migration artifacts are frozen;
- the measured live inventory has zero unclassified evidence;
- the full migration succeeds twice from fresh production clones with zero unexplained reconciliation differences;
- the final schema/code excludes the test-only legacy layer and every non-additive P-01–P-03 step is separately
  reviewed, rehearsed and backed by a verified restore route.

## Final assessment

**Accept the Wave 4 Part A data model and R02 fixes; request the four implementation/UI fixes above; do not deploy the
branch yet.** The remaining Wave 4/filter issues need no schema change, so the task/part design can be considered final.
The complete live migration cannot yet be called final or additive-only because the previously chosen legacy-send
conversion and P-01–P-03 contraction are still unresolved and unrehearsed.
