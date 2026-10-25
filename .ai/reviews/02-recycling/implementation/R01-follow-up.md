# Feature 02 — R01 follow-up: second review pass

Date: 2026-10-25. Checkout: `backup/recycling-2026-10-25`, application HEAD `de35293`.

This adds evidence to the current R01 review. Its five recycling findings remain open; no application fixes have been made between the two passes. The original R01 record is unchanged.

## Outcome

**No additional recycling-specific defect was confirmed in this pass.** The expanded checks support the archive isolation, filter, transaction, and subsequent-round behavior described below.

One **pre-existing pipeline search defect** was independently reproduced while checking the actual readers affected by recycling. It is recorded separately as R01-FU-01, rather than being presented as a defect introduced by Feature 02.

This result does not establish that every possible path is correct. It identifies what was examined and where the second pass added evidence beyond the first.

## Additional confirmed issue — inherited pipeline behavior

### R01-FU-01 — [P2, inherited] “Dostali návrh” overwrites the text-search predicate

**Locations:** `lib/queries/pipeline/index.ts:93`, `:115`, `:557`, and `:600`–`:602`. The page passes the text search into these readers at `app/dashboard/pipeline/page.tsx:70`.

`searchWhere` builds an `OR` across company, website, phone, and email. `baseWhere` includes that object. The `got_design` view then contributes a different `OR` for either a sent Design or the legacy `designSentAt` summary. `pillFilter` spreads the view after the base, so its `OR` replaces the search `OR`.

Consequently, both the “Dostali návrh” list and its count can include deals whose text does not match the search. This also makes post-recycling verification misleading: searching for a recycled deal in that view can show unrelated deals instead of an empty result.

**Isolated reproduction:**

1. Create two ACTIVE deals belonging to one disposable sales representative, named `<run>_search_ALPHA` and `<run>_search_BETA`. Both have a sent-design summary.
2. Search for the exact ALPHA name in the ordinary pipeline list. Exactly ALPHA is returned — the control passes.
3. Keep that search and select `view=got_design`. **Both ALPHA and BETA are returned; the count is 2 instead of 1.**
4. Recycle ALPHA using the normal recycling command. Repeat the same searched view. **BETA is still returned; the expected result is empty.** ALPHA's archive itself remains hidden.

The latest test log records both failures:

```text
FAIL INHERITED: got_design preserves the search predicate
  expected=1, actualRows=2, actualCount=2, returnedUnrelatedBeta=true
FAIL INHERITED: search for recycled ALPHA does not return unrelated BETA
  expected=0, actualRows=1, returnedUnrelatedBeta=true
```

**Why classified as inherited:** `git diff origin/main -- lib/queries/pipeline/index.ts` is empty, and inspection of that file in the locally available `origin/main` shows the same `OR` composition. Feature 02 did not change it. No older feature specification or historical review artifact was needed to establish this.

**Impact:** inaccurate search results and pill counts in this view. The isolated reproducer stayed within one owner's scope; it did not demonstrate an authorization bypass.

**Repair guidance:** combine the independent search and sent-design predicates with `AND`, preserving both `OR` groups. Keep list and count on the same shared predicate. This is recorded for a fixing session; no application code was changed here.

**Regression requirement:** retain the ALPHA/BETA control, list/count assertions, and after-recycling assertion. Include a search that matches neither record and a case with a real sent Design rather than only the legacy summary column.

## What the second pass checked

Added `prisma/backfill/check-recycling-second-pass.ts`. It creates only its own contacts, users, activities, requests, designs, task parts, and ownership records, and refuses any endpoint except `ep-divine-waterfall-asbkuort` with an explicit matching argument.

### Actual read-model behavior

The first review identified that several named requirements were covered only by shared predicates or read-model capability flags. This pass called the actual readers with fixtures that qualified before recycling:

- Pipeline list and all counted views, including current work and today's work. A real ACTIVE fixture disappeared after recycling; its archive and reset live contact were excluded.
- The owner's dashboard due list and open-deal count; manager per-owner open/overdue/new-deal totals.
- Ownership history: a genuine qualifying `fromUserId` ownership event appeared before recycling and disappeared afterwards.
- Contacts-added daily totals and the per-scout adding log. The contact kept one original attribution after archiving.
- Call and client-demand statistics. Real historical calls and requests remained counted once.
- Caller dashboard and assignment overview for an overdue scheduled callback. The fixture qualified before recycling and was removed from those current-work readers afterwards.
- Remaining-work and manager inbox reads, alongside the command-level protection against archiving open manager work.

The broad pipeline assertion initially encountered the inherited search problem above. It was corrected to distinguish unrelated existing matches from an archive leak. The final test verifies that the archive and current NEW contact are absent while the unrelated sent-design count remains unchanged. The independent ALPHA/BETA test continues to fail on the actual search defect.

### Existing mutation entry points against archives

Exercised seven ordinary mutation paths against archived parents or their children:

1. Correct an old offer record.
2. Remove its archived Design.
3. Add a version to that Design.
4. Change that Design's metadata.
5. Send a message on an archived task.
6. Record a new offer against the archive Lead.
7. Reopen the archive as a deal.

All returned errors. Comparing snapshots afterwards confirmed that the sampled archive Lead, activities, Design, and task were unchanged by these attempts. The relevant Design/activity/task commands were also inspected for re-reading and validating their parent relationship after locking.

### Candidate filtering beyond bucket parity

Ran 20 combinations through the actual recycling list, bucket counts, first-N selection, and holder options, comparing the outputs with independently constructed fixture expectations. Cases covered:

- All current age choices and contacts just to either side of the 7- and 30-day cutoffs.
- Minimum no-answer counts, including a recent reverted call that must not count.
- All four existing received-material filters.
- First-round and later-round filters.
- Assigned callers, the last caller on closed call-stage contacts, deal owners, and no holder.
- Combined bucket/holder/age/attempt/receipt/round filters.
- An OPEN manager task and a hidden archive fixture, both excluded.
- No-contact fallback to `createdAt`.
- CALL, SMS, offer, and client reply timestamps; recent internal notes and task messages did not reset last contact.
- Equal-time call tie-breaking by ID and assigned-caller precedence over the last call author.
- Literal percent, underscore, backslash, apostrophe, Slovak text, and `#number` searches.

These checks passed for the filters that currently exist. They do not implement or excuse the missing “chceli” filters already reported in R01.

### Additional forced race orders

Used a held database row and observed lock waiters to force both orders for:

| Contention | Recycling acquires its turn first | Other operation acquires its turn first |
|---|---|---|
| New manager task | Recycling succeeds; task creation returns NOT_FOUND | Task creation succeeds; stale recycle returns CHANGED; retry with the fresh revision returns OPEN_TASK |
| Deal owner change | Recycling succeeds; owner change returns NOT_FOUND | Owner changes; stale recycle returns CHANGED |
| Caller-work transfer | Recycling succeeds; transfer moves 0 | Transfer moves 1; stale recycle returns CHANGED |

All six contention cases and the fresh-revision task guard passed. They produced consistent final states and no duplicate archive.

### A complete positive-call workflow through another round

Exercised a path not covered by the first browser's “Nezdvihli” example:

1. A sales representative records an interested first call requesting PRICE and DESIGN.
2. The manager creates a tracked proposal through the normal command.
3. The representative records a real offer with info, price, and the proposal. Both original requests become SENT.
4. The admin recycles the active deal.
5. The representative claims it through `claimBatchAs` and records a new interested first call asking only for PRICELIST.
6. The real deal-detail reader returns a clean round-two deal: no old price, price history, proposal, tasks, pending results, receipts, or activities; its only current ask is PRICELIST and its next step is SEND_EMAIL.
7. The original requests, offer activity, and Design remain attached to the archive.

All four workflow assertions passed. Pool-order fixture changes were limited to our own contact and nine filler contacts, ensuring the claim touched only review fixtures. Those fixtures were removed afterwards.

### Database structure

Inspected the development database's actual foreign keys into Lead. They are exactly the five moved child relationships — Activity, LeadRequest, DealTask, DealOwnership, Design — plus Lead's archive self-reference. No unhandled direct child table was found.

## Checks and cleanup

| Check | Second-pass result |
|---|---|
| `check-recycling-second-pass.ts --expect-endpoint ep-divine-waterfall-asbkuort` | **52/54 passed**. The two failures reproduce the single inherited search defect above. |
| `npx tsc --noEmit` | Passed |
| Targeted ESLint on the added test and updated cleanup helper | Passed |
| `git diff --check` | Passed; Git reported its usual LF/CRLF conversion notice for the tracker |
| Final cleanup audit | `reviewLeads=0`, `reviewUsers=0`, `suiteLeads=0`, `visibleArchives=0`, `newWithCalls=0` |

Evidence: `evidence/R01-second-pass.log` and `evidence/R01-second-pass-cleanup.log`.

The original full suite, build, lint, time-zone checks, HTTP checks, and browser results remain recorded in R01. They were not represented as freshly rerun in this pass. Application code was unchanged; this pass added targeted tests and review documentation.

No schema changes, schema/backfill application, production access, commits, pushes, or deployments occurred. Database identity remained **`ep-divine-waterfall-asbkuort` / `neondb`**. Test-created number sequence gaps were left intact.

## Handoff

The original **five Feature 02 findings still require fixes**. This pass found no additional recycling-specific defect and confirmed one inherited pipeline search defect. The new tests retain its two failing expectations for the fixing agent.

Changed in this pass: the new second-pass regression script, the cleanup helper's recognition of the new fixture prefix, this follow-up and evidence, and the progress-tracker entry. The application and protected feature specification remain unchanged.
