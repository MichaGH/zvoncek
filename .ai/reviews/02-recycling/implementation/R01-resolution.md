# Feature 02 — implementation review R01 resolution

Date: 2026-10-25. Fixer: Codex. Checkout: `backup/recycling-2026-10-25`, starting HEAD `7090aff`.

**Result: all six confirmed findings addressed and verified on the development copy.** This records the fixes to
R01-01–05 and R01-FU-01 from `R01.md` and `R01-follow-up.md`. Both original records and their evidence are unchanged.
This is a resolution record, not a claim that production has been deployed or verified.

Read the current repository rules and authoritative context, Feature 02's approved specification and rollout SQL,
and the two current review records. No unrelated feature specifications or older review rounds were used.
`.ai/reviews/README.md` requires immutable review records, hence this separate file. The requested
`.ai/reviews/review-format.md` is still absent; `.ai/review-format.md` is empty. This record uses the existing finding
IDs, changes, verification evidence, and explicit remaining limits.

## Resolution matrix

| Finding | Status | Change and verification |
|---|---|---|
| R01-01 — child timestamps overwritten | Resolved | `archiveRound` uses parameterized FK-only SQL for `LeadRequest` and `Design`, bypassing Prisma's `@updatedAt`. Other child models retain their existing FK-only writes. Tests compare **every scalar except leadId in all five child tables**, including several Design/LeadRequest rows with distinct historical timestamps and a soft-deleted design. Both original timestamp assertions pass. Nested versions, trackers, events, and rollback still pass. |
| R01-02 — incomplete confirmation | Resolved | Manual and first-N selections retain revision, bucket, holder ID/name, last-contact date and distinct OPEN request contents. The shared pure summary produces per-owner active/sleeping counts, unfinished-request counts by content, recency and bucket totals. The sticky bar renders the bucket breakdown; confirmation also retains bad-number/callback warnings. Owner grouping uses IDs, so two people with the same name remain distinct. Browser and database tests cover off-page warnings and filter changes clearing selection. Mutation input remains strictly ids plus original revisions. |
| R01-03 — missing “chceli” filters | Resolved | A separate URL-backed `asked=INFO\|PRICE\|DESIGN` filter selects OPEN requests on current deals. Its EXISTS predicate lives in the same candidate CTE used by list, counts, holders and first-N. It composes with the receipt filter. Tests cover OPEN/SENT/WITHDRAWN, duplicate request content, already-received design plus a later request, archive rows, call-stage rows, URL round trips, exact IDs and metadata parity. The browser control isolates the two expected open design requests. |
| R01-04 — dead archive links | Resolved | Call-history deal links require a non-deleted Lead. Hidden archive entries retain the live number and old round as plain text, without edit/revert. Tests cover the administrator and former owner, and preserve a working owner link for a current deal. Browser verification found the archived deal under its original number/round with zero matching links. |
| R01-05 — empty final page | Resolved | The server redirects an out-of-range page to the last valid page using the canonical URL builder, preserving filters and sort. This covers successful recycling and lists changed elsewhere. Browser: recycling the two contacts on page 2 of 102 candidates redirected to page 1 with 100 visible candidates. Real HTTP checks also cover page 3→2 with 200 remaining, an empty list, and page 999→3 with 201 candidates. Page input is bounded before calculating the SQL offset. |
| R01-FU-01 — inherited pipeline search OR overwritten | Resolved | The base scope/search and view predicates now compose through AND, preserving both independent OR clauses. Existing status/step policies remain in place. Tests verify matching legacy receipt summaries and actual sent Design rows, exclusion of unrelated BETA and another owner's matching ALPHA, a no-match search, counts, and no unrelated result after recycling the matching contacts. |

## Supporting changes and decisions

- The per-chunk transaction timeout now matches the approved **30 seconds**, with the existing **10-second lock
  timeout**. The forced partial-batch failure still commits the first 100 and returns RETRYABLE for the later chunk;
  retrying the original selection creates exactly one archive per contact.
- The recycle page exports `maxDuration = 300`. A fresh production build emits that value for
  `/dashboard/admin/recycle` in `.next/server/functions-config-manifest.json`. This requests a hosting allowance; it
  does not prove the actual deployment honors it. Runbook A7a now requires deployment verification against the dev
  database, including a 500-contact request and response-loss recovery, before rollout.
- Recency means within the default **30-day** last-contact window, including the boundary; the no-contact fallback
  uses creation time. It is only a warning. OPEN request-content warning counts represent distinct selected contacts,
  so repeated requests of the same content on one contact do not inflate the summary. Owners and warning metadata
  are selection snapshots; the command still rechecks revisions and eligibility under locks.
- Corrected the rollout's “7 statements” to **four SQL statements implementing seven schema operations**, also in
  `db-changes.md`. Corrected the smoke test: Kontakty displays NEW; the claimed call queue/drawer displays the round
  badge. No extra contacts-page feature was added. These are the review-requested runbook corrections; the approved
  recycling specification and schema SQL are unchanged.
- Updated current workflow, operation documentation, database description and progress tracker. The net database
  delta is unchanged: production still owes the already-recorded additive S-R1 rollout.

## Verification actually executed

All database checks used `ep-divine-waterfall-asbkuort` / `neondb`. No production connection, schema mutation,
backfill, seed, commit, push, merge, or deployment was performed during this resolution.

| Check | Final result | Evidence under `evidence/` |
|---|---|---|
| `npx tsc --noEmit` | Passed | `R01-resolution-typecheck.log` (empty output, exit 0) |
| `npx next build` | Passed, all 21 routes | `R01-resolution-build.log` |
| Built recycle-route duration configuration | `maxDuration: 300` emitted (local configuration only) | `R01-resolution-duration.json` |
| `npx eslint .` | **Not clean:** known MobileNav line 17 error and existing ignored render-script warning; no new errors | `R01-resolution-lint.log` |
| ESLint on every changed TS/TSX file and test script | Passed | `R01-resolution-targeted-lint.log` |
| Business-time checks, normal environment and `TZ=UTC` | Both passed; temporary TZ removed | `R01-resolution-time.log`, `R01-resolution-time-utc.log` |
| Client-section checks | Passed | `R01-resolution-client-sections.log` |
| Full concurrency suite, `--iterations 100` | **261/261**, including recycle invariants and TS/SQL parity | `R01-resolution-concurrency.log` |
| Expanded `check-recycling-review.ts --bulk-500` | **36/36** | `R01-resolution-regression.log` |
| Expanded `check-recycling-second-pass.ts` | **55/55** | `R01-resolution-second-pass.log` |
| New `check-recycling-resolution.ts --http` | **26/26** | `R01-resolution-targeted.log` |
| Actual server-action HTTP checks | **10/10**, including first-N authorization/metadata and retry of a discarded success | `R01-resolution-actions.log` |
| Existing HTTP render check, with `--base http://localhost:3100` | **10/10** | `R01-resolution-render.log` |
| Read-only Prisma schema diff against development DB | Empty migration | `R01-resolution-schema.log` |
| Post-check fixture and invariant audit | Clean | `R01-resolution-cleanup.log` |

The expanded regression run exercised a **500-contact batch with one real CALL child per contact**. All five
chunks completed: 500 archives, 500 fresh live NEW contacts at round 2/revision 1, no live call history, **71,148 ms**
elapsed locally. This is a successful command run, not a deployed HTTP duration measurement. A forced later-chunk
timeout returned RETRYABLE after 100 commits; retrying the unchanged 101-item input produced exactly 101 archives.
The direct HTTP test additionally discarded a successful result and resubmitted the original id/revision; it returned
success with exactly one archive and no second round. It does not simulate a hosting provider terminating a function.

One intermediate second-pass run had an incorrect forced-race ordering while other suites were running. The test
waited for any matching SQL lock waiter on the whole database, so an unrelated suite could satisfy it prematurely.
The retained `R01-resolution-second-pass-initial.log` records that failure. Both targeted race helpers now follow
`pg_blocking_pids` recursively from their **own fixture transaction's backend PID**, preserving the original outcome
assertions. The corrected final run passed both orders for task creation, owner change and caller transfer. The
archive/call race suite also passed again with the tighter helper. The earlier passing archive run is retained as
`R01-resolution-regression-initial.log`.

`check-backfill-delta.ts` was **not run**. It invokes the old assignment backfill, including apply passes across the
database, and creates retired first-call outcomes. It is an obsolete migration check against this production-shaped
copy, not a recycling regression. No pass is claimed for it.

## Browser verification

Used the actual local development server on port 3100 with the development database, the existing Michal admin
session, and isolated disposable fixtures. The Computer Use skill controlled the browser. This was automated
click-through; it does not replace Michal's rollout approval.

1. Selected 100 rows on page 1, navigated to page 2, selected the remaining six. Confirmed the sticky bucket summary
   and dialog totals: 102 lost calls, one bad number, one scheduled callback, one active deal and one sleeping deal.
2. Confirmed the two named owners and their separate active/sleeping counts; two contacts requesting design, one
   requesting price, and one recent contact. Cancelled, cleared selection, chose first 106 and confirmed identical
   warnings even for the deals off the initial page.
3. Checked the dialog at **390 × 844**: warnings and both buttons remained accessible. Reset the viewport afterwards.
4. Chose **Chceli návrh** in the new request control. Exactly the two expected deals remained; the 106-row selection
   cleared. The URL retained the filter and the rest of the search/sort state.
5. Recycled the last two rows of the isolated 102-row lost-call list. The URL dropped page 2 and displayed the
   remaining 100 candidates on page 1, with the success notification.
6. Recycled the isolated active deal. It disappeared from eligible work. In the caller-filtered call history,
   `#13848 … Active (1. kolo)` was plain text with no matching deal link.

Screenshots: `R01-resolution-warnings.jpg`, `R01-resolution-warnings-mobile.jpg`,
`R01-resolution-request-filter.jpg`, and `R01-resolution-shrinking-page.jpg`. The warning screenshots preceded a
final wording-only cleanup of the request/recency messages; their counts and behavior are unchanged. Development
console output included the pre-existing dark-mode toggle hydration-label mismatch and pg SSL-mode warning; neither
was a recycling error. The temporary verification tab and dev server were closed.

## Cleanup and remaining rollout work

Final audit: **0 review leads, 0 review users, 0 concurrency fixture leads, 0 visible archives, 0 live NEW leads with
CALL history**. Tests cleaned their own rows, including archived children. Temporary UI fixture metadata was removed.
The unrelated `.ai/prompts/` files were preserved.

No confirmed R01 finding remains open. The development implementation is ready for an independent verification
review. Production readiness still requires the existing S-R1 schema/code rollout, actual deployment duration and
disconnect/retry rehearsal from runbook A7a, and Michal's production smoke/approval. The known unrelated full-repo
lint error remains outside this feature's fixes.
