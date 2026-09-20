# Test–production database delta

Only schema and data changes **already applied and verified on the test branch but not yet applied to production** are
listed here. This is the production-rollout checklist, not a place for unbuilt proposals or rejected ideas. A proposed
change belongs in the active feature design before any test application; once verified on test, add its exact delta here.
After a successful production rollout, clear the applied delta and keep the file ready for the next one.

Why this file exists: production is still on the pre-round-1 schema, so there are changes on the test branch that
production does not have. The ledger answers two questions: what a rollout still owes, and whether all of it is
**additive** compared with live production.

**Baseline.** Production is taken to equal `prisma/schema.prisma` at commit `7beb689`, the state when this ledger was
started. That is an assumption, not a measurement: before the production push, the live production schema is compared
with the target (procedure step 5), and any surprise is added here first.

**Net delta, not history.** What counts is the difference between live production and the current test schema. If a
change on test is later reverted or replaced before rollout (e.g. an enum value added in one wave and dropped in the
next), only the end result matters. A change is **non-additive** only when it removes, renames or retypes something
**production already has**, or adds a required column / constraint that existing production rows could violate.

**Rebuilt from zero on 2026-09-19 (wave 3).** §1 was regenerated from the two schema files, not copied from earlier
wave notes: `npx prisma migrate diff --from-schema <7beb689:prisma/schema.prisma> --to-schema prisma/schema.prisma
--script` (offline, no database). The script has **no `DROP` and no retype** — every statement is `CREATE TYPE`,
`ALTER TYPE … ADD VALUE`, `ADD COLUMN`, `CREATE TABLE`, `CREATE [UNIQUE] INDEX` or `ADD CONSTRAINT … FOREIGN KEY`.

**Non-additive changes owed to production: none.** Keep this line true: any non-additive entry must be listed here by
id, with its data plan, before it is applied on test. (The planned old-send contraction in §3.3 is not applied on test
and therefore not listed here.)

## Environments

| Name | Neon endpoint (suffix) | Role |
|---|---|---|
| test / development | `…nhww8x` | listed changes were applied here; endpoint re-verified 2026-09-19 |
| production | `…m0xyun` | commented out in `.env`; **never touched by a development session** |

Full connection strings are never written into docs, logs or scripts. Database-touching backfill and concurrency
scripts verify the endpoint (`--expect-endpoint`) and refuse an unexpected target; pure rule checks need no endpoint.

`TEST` in the tables below means applied and verified on test, still owed to production. A production status is not
recorded here because the row is removed after rollout.

## Procedure

1. **Before test application:** put the proposal, data-safety plan and application order in the active feature design.
   Review the exact schema change and verify that `DATABASE_URL` points to the test endpoint.
2. Edit `prisma/schema.prisma`, review the generated SQL diff, then run `npx prisma generate` and apply on **test**.
   Use `npx prisma db push`; never `--accept-data-loss` or `--force-reset`.
3. If `db push` stops on a **data-loss warning** (it does this for new unique indexes, and for any enum value or table
   it would drop), do not accept it. Generate the diff, read it, apply it, confirm:
   ```bash
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o <file outside the repo>
   npx prisma db execute --file <that file>
   npx prisma db push      # must now report "already in sync"
   ```
4. Verify the test schema and any backfill; then add only what actually changed to this file. Do not mark an unrun
   check as passed.
5. **Production:** separately approved rollout only, after a backup and restore-point Neon branch. Compare the live
   production schema with the reviewed target; do not assume it matches a Git commit. Apply the reviewed diff and
   backfill in the documented order (§4 below, `context/features/01-salesrep/planning.md` §14).

---

## 1. Net schema delta: production baseline → current test schema (all TEST, all additive)

"Came with" is only for tracing the design; the rollout applies the net result in one reviewed script.

### 1.1 New enum values on existing enums

| Enum | Added values | Came with | Status |
|---|---|---|---|
| `Role` | `SALES_REP` | round 1 | TEST |
| `CallOutcome` | `WANTS_TO_ORDER` | round 1 | TEST |
| `ActivitySource` | `CLIENTS` | round 1 | TEST |
| `ActivityType` | `CALLER_ASSIGNED`, `CALLER_RELEASED`, `CALL_REVERTED`, `DEAL_REOPENED` | round 1 | TEST |
| `ActivityType` | `OFFER_SENT`, `CLIENT_REPLIED` | round 2 wave 3a | TEST |
| `ActivityType` | `TASK_CREATED`, `TASK_MESSAGE`, `TASK_DONE`, `TASK_DECLINED`, `TASK_CANCELLED`, `TASK_REASSIGNED`, `TASK_RESULT_DISMISSED` | wave 3 | TEST |

`ALTER TYPE … ADD VALUE` is additive and cheap, but **a value added inside a transaction cannot be used by the same
transaction** — a rollout script must never add a value and write rows using it in one go, and the schema must land
**before** code that writes the value is deployed.

### 1.2 New enums

| Enum | Values | Came with | Status |
|---|---|---|---|
| `DealTaskType` | `HELP`, `HANDOVER` | wave 3 | TEST |
| `DealTaskContent` | `PRICE`, `DESIGN`, `OTHER` | wave 3 | TEST |
| `DealTaskStatus` | `OPEN`, `DONE`, `DECLINED`, `CANCELLED` | wave 3 | TEST |
| `DealOwnershipReason` | `HANDOFF`, `CHANGE`, `BULK`, `TAKEOVER`, `HANDOVER`, `REVERT` | wave 3 | TEST |

### 1.3 `Lead` — new columns

| Column | Type | Null | Default | Came with | Status |
|---|---|---|---|---|---|
| `assignedCallerId` | text, FK → `User.id` `ON DELETE SET NULL` | yes | — | round 1 | TEST |
| `assignedCallerAt` | timestamp(3) without time zone | yes | — | round 1 | TEST |
| `pipelineEnteredAt` | timestamp(3) without time zone | yes | — | round 1 | TEST |
| `handedOffById` | text, FK → `User.id` `ON DELETE SET NULL` | yes | — | round 1 | TEST |
| `closedAt` | timestamp(3) without time zone | yes | — | round 1 | TEST |
| `revision` | integer | **no** | `0` | round 1 | TEST |
| `offerAboutUsAt`, `offerPricelistAt`, `offerPriceAt` | timestamp(3) without time zone | yes | — | wave 3a | TEST |
| `legacySendsReviewedAt` | timestamp(3) without time zone | yes | — | wave 3a | TEST — **test-only per §3.3**, not for production |
| `hadLegacySends` | boolean | **no** | `false` | wave 3a | TEST — **test-only per §3.3**, not for production |

`revision` and `hadLegacySends` are the only NOT NULL additions; both have a constant default (PostgreSQL 11+ fast
default, no table rewrite).

### 1.4 `Activity` — new columns

| Column | Type | Null | Note | Came with | Status |
|---|---|---|---|---|---|
| `idempotencyKey` | text, **UNIQUE** | yes | see the gotcha below | round 1 | TEST |
| `leadRevision` | integer | yes | only first calls write it | round 1 | TEST |
| `revertedAt` | timestamp(3) without time zone | yes | | round 1 | TEST |
| `revertedById` | text, FK → `User.id` `ON DELETE SET NULL` | yes | | round 1 | TEST |
| `taskId` | text, FK → `DealTask.id` `ON DELETE SET NULL` | yes | set on `TASK_*` rows | wave 3 | TEST |

**Production gotcha:** on test, `prisma db push` refused the new unique index on `idempotencyKey` with a *data-loss
warning*, even though the new column was entirely NULL. The reviewed `migrate diff` → `db execute` → `db push`
("already in sync") path resolved it. Production may issue the same warning; inspect its actual diff with Michal's
explicit approval and do not answer "yes" to the warning.

### 1.5 `Design` — new column

| Column | Type | Null | Came with | Status |
|---|---|---|---|---|
| `legacySentAt` | timestamp(3) without time zone | yes | wave 3a | TEST — **test-only per §3.3**, not for production |

### 1.6 New tables

| Table | Columns | FKs | Came with | Status |
|---|---|---|---|---|
| `DealTask` | `id`, `leadId`, `type`, `contents DealTaskContent[]`, `status` (default `OPEN`), `text`, `requestedById`, `assigneeId`, `createdAt`, `closedAt?`, `closedById?`, `closeReason?`, `result jsonb?` | `leadId` → `Lead` `CASCADE`; `requestedById`, `assigneeId` → `User` `RESTRICT`; `closedById` → `User` `SET NULL` | wave 3 | TEST |
| `DealOwnership` | `id`, `leadId`, `fromUserId?`, `toUserId?`, `byUserId`, `reason`, `note?`, `createdAt` | `leadId` → `Lead` `CASCADE`; `fromUserId`, `toUserId` → `User` `SET NULL`; `byUserId` → `User` `RESTRICT` | wave 3 | TEST |

Both start empty. "At most one `OPEN` task per deal" is enforced **in code under the Lead row lock**, not by a partial
unique index (Prisma cannot declare one, so `db push` would treat it as drift). If it ever moves into the database it is
a new ledger row with a duplicate pre-check.

### 1.7 New indexes

| Index | Came with | Status |
|---|---|---|
| `Lead (status, assignedCallerId, createdAt)` | round 1 | TEST |
| `Lead (assignedCallerId, status, callbackKind)` | round 1 | TEST |
| `Lead (ownerId, status)` | round 1 | TEST |
| `Lead (pipelineEnteredAt, status)` | round 1 | TEST |
| `Activity (idempotencyKey)` **UNIQUE** | round 1 | TEST |
| `Activity (taskId)` | wave 3 | TEST |
| `DealTask (assigneeId, status, createdAt)`, `DealTask (leadId, status)` | wave 3 | TEST |
| `DealOwnership (leadId, createdAt)`, `DealOwnership (fromUserId, createdAt)` | wave 3 | TEST |

Plain `CREATE INDEX` takes a lock that blocks writes for its duration. The new-table indexes are instant (empty tables);
for `Lead` and `Activity` do not assume the duration on production — review table sizes and schedule the rollout, or
use reviewed `CREATE INDEX CONCURRENTLY` SQL instead of the Prisma-generated statement.

### 1.8 Added on test earlier and removed again — never reached production, nothing owed

These existed on test between waves and were dropped in wave 3 (test pre-check: 0 `DealRequest` rows, 0 `REQUEST_*`
activities, 0 leads with `nextActionKind = ORDER`; applied with reviewed SQL, `db push` "already in sync"). Production
never had them, so their removal is **not** a production change. Do not add them to production.

| Object | Was added in | Removed in |
|---|---|---|
| table `DealRequest`, enums `DealRequestKind`, `DealRequestStatus` | round 1 | wave 3 (replaced by `DealTask`) |
| `ActivityType.REQUEST_CREATED`, `REQUEST_RESOLVED` | round 1 | wave 3 (replaced by `TASK_*`) |
| `NextActionKind.ORDER` | round 2 wave 2 (S-01) | wave 3 ("chcú objednať" is an ordinary reply; handover is a `HANDOVER` task) |

---

## 2. Data steps owed to production

| Step | What | Test | Production |
|---|---|---|---|
| Round 1 backfill | `prisma/backfill/2026-09-assignments.ts` — populates `assignedCallerId`, `pipelineEnteredAt`, `handedOffById`, `closedAt` and normalises `NEW` contacts that already have call history. Dry-run by default, `--apply` requires a direct host and `--confirm <endpoint>`, aborts on ambiguous records, repeatable, `--verify` reports drift | applied, `--verify` clean (test was later wiped and reseeded, 2026-09-18 / 2026-09-19) | **OWED** — only in the approved rollout session |
| Routing team | create team "Obchod" (leader Michal) so positive telesales calls route to an owner instead of landing unassigned | seeded | **OWED** |
| Wave 3a legacy step | `prisma/backfill/2026-09-offer-legacy.ts` | applied before the wipe | **NOT IN THE CHOSEN FINAL ROUTE** — §3.3 replaces it |
| Wave 3 | none. `DealTask` / `DealOwnership` start empty; no existing row is rewritten | — | nothing to backfill. Consequence: História and ownership history show only moves **after** the rollout; older owner changes remain readable only as `OWNER_CHANGED` activities |

## 3. Old send data — wave 3a legacy layer and the decided conversion

Design: `context/features/01-salesrep/round2-deal-workspace.md` §2c. The wave 3a schema rows (`OFFER_SENT`,
`CLIENT_REPLIED`, `Lead.offer*`, `hadLegacySends`, `legacySendsReviewedAt`, `Design.legacySentAt`) are in §1.

### 3.1 Data step (not schema, still owed to production)

`prisma/backfill/2026-09-offer-legacy.ts` sets `Lead.hadLegacySends = true` for leads with old send evidence
(`quoteSentAt`, `aboutUsSentAt`, `priceDisclosed`, `QUOTE_SENT` / `EMAIL_SENT` / `DESIGN_SENT` activities, or a design
marked sent without any `OFFER_SENT`) and copies `Design.sentAt` → `Design.legacySentAt` for designs sent under the old
system. It only sets values, so it is repeatable.

| Environment | Status |
|---|---|
| test | TEST — dry-run 28 leads + 5 designs, `--apply` committed 28 + 5, `--verify` OK |
| production | **NOT IN THE CHOSEN FINAL ROUTE** — §3.3 replaces this temporary test-only legacy step |

### 3.2 Original legacy-layer production order — superseded by §3.3

These steps describe the currently implemented test design, **not** the chosen final production route. Retained for
the test–production delta audit until the revised migration is implemented and verified on test.

1. The §1 schema first — `OFFER_SENT` code assumes the round-1 schema.
2. Schema (enum values **before** any code that writes them; not used in the transaction that adds them).
3. `2026-09-offer-legacy.ts` dry-run → review counts → `--apply` → `--verify`.
4. Deploy the new code.
5. Run `--apply` **again** right after the deploy (old code may have written a send between steps 3 and 4), then
   `--verify` must report 0 left.

### 3.3 DECIDED TARGET — translate old sends, then remove the old send columns (NOT applied)

**Decision (Michal, 2026-09-18):** do not ship the permanent "?" legacy layer. Translate the live database's old
email, price and návrh facts into canonical `OFFER_SENT` records, verify them on a fresh **duplicate of production**,
then remove obsolete send columns in a separately reviewed, non-additive contraction. This is a **rollout plan, not
part of the verified test–production delta above**. The code and test schema still implement the legacy layer today;
`prisma/backfill/2026-09-offer-migrate.ts` is a prototype and **must not be run with `--apply` on the production clone
or production in its present form**. The test-only dry-run (2026-09-18, a guessed 2026-09-01 cenník cutoff) found 28
deals, 27 proposed events and 5 deals with exceptions; these numbers say nothing reliable about live production.

#### Live-data meanings and target mapping to confirm on the duplicate

Michal's description of live data is the business input below, **not a measured inventory**. Produce a read-only
inventory of every combination, including deleted/closed leads and send evidence outside the deal stage, before
approving any conversion. `NULL`/false means "not recorded/marked", not proof that nothing was sent.

| Live fact | Meaning under old code | Proposed canonical result / required decision |
|---|---|---|
| `Lead.aboutUsSentAt` and/or `EMAIL_SENT` | an email was marked sent; the generic activity could also mean another email | Confirm which were the initial "o nás" email. Create `EMAIL` + `ABOUT_US` only for confirmed sends; reconcile matching activity/field dates and use a field-only fallback only when no matching row exists. A mismatched date is an exception, not automatic deduplication. Do not convert routine replies as offer sends. |
| Cenník sent to roughly the last 20 recipients | no dedicated old database flag | Review an **explicit set of old email/lead IDs and contents**, then add `PRICELIST` to the **same** email event. A global date cutoff or "last N" rule is not evidence. |
| `Lead.price`, `priceNote` | today's editable internal price and breakdown | Keep as current price; **no send event merely because a price is present**. They are not historical snapshots. |
| `Lead.quoteSentAt` / `QUOTE_SENT` | CP marked sent; old code allowed no amount, and undo cleared the field but kept the row | Convert only a confirmed real send to `EMAIL` + `PRICE`, with the amount from a trustworthy old activity note or a manager-confirmed amount. Reconcile field/activity dates; an undo, missing amount, multiple CPs, mismatched dates or disagreement with `priceDisclosed` needs an explicit per-event decision. |
| `Lead.priceDisclosed = true` | "client knows a price", by any channel; Michal says that in live cases it was the exact calculated price | Reconcile against already-confirmed price sends. If it represents a **separate** disclosure, confirm amount, channel and business date; do not assume `PHONE`, current `Lead.price`, or the toggle's audit timestamp without review. False is not a new send. |
| `Design` exists, `sentAt = NULL` | návrh exists but was not marked sent | Keep the Design, versions, tracker/token and all view events unchanged; create no `OFFER_SENT`. |
| `Design.sentAt` and/or `Lead.designSentAt`; old `DESIGN_SENT` rows | návrh marked sent; toggles were reversible, and old `DESIGN_SENT` has no design ID | For each still-valid marked send, create `EMAIL` + `DESIGN` with the right Design ID and confirmed date. Resolve reverted sends, multiple designs, deleted designs and field-only `Lead.designSentAt` explicitly. Keep versions, links, tracker tokens and tracker-event history in place; a view is not proof of email contents. |

**Michal's clarifications (2026-09-20), to be verified on the duplicate, not assumed:**

- **There is no cenník in live production.** The old system had no such content and no flag; `PRICELIST` exists only on
  test (wave 3a). Any old cenník recipient must be named explicitly by Michal, otherwise no `PRICELIST` is created.
- **A price plus "klient pozná cenu" means the exact calculated price, sent by email.** So `priceDisclosed = true` with
  a price present converts to one `OFFER_SENT(EMAIL, [PRICE])` with that amount and the old CP date. The inventory must
  still count and classify the exceptions (flag without a price, price without the flag, undo sequences, several CPs);
  each exception gets an explicit decision.

This need not mean hand-editing hundreds of deals. After the duplicate's inventory, Michal may approve a **bulk rule**
for the old initial emails and for `priceDisclosed = true` with a non-null matching price, if the old history and a
sample support it. Only exceptions need per-record overrides. The roughly 20 cenník recipients still need an explicit
identification; a cutoff can be used to *find candidates*, never as the final truth. A missing business date, amount
or channel stays an exception until Michal chooses a documented representation. The old `priceNote` is not a proven
historical breakdown, even if today's total matches.

**Event identity matters.** If "o nás", cenník, calculated price and/or návrh went in **one email**, create **one**
`OFFER_SENT` with all confirmed contents, not one row per old flag. Conversely, do not merge separate sends merely
because they share a day. This preserves the first-email pricing experiment. Migrated historical deals stay out of that
experiment even after their contents are reconstructed; select them by `meta.migrated`, not `hadLegacySends`.

For each created row record `meta.migrated = true`, the original row/field IDs and confidence/manager decision in
provenance. Preserve the original `QUOTE_SENT` / `EMAIL_SENT` / `DESIGN_SENT` and audit rows as read-only history; do not
delete them just to remove the legacy UI. `createdAt` must remain the **migration recording time** and
`meta.sentOn` the historical client-send day (`historical: true`); keep the original timestamp separately in provenance.
Attribute an activity-backed send to its original actor. A field-only send has unknown actor and must be labelled as
migration-attributed, not silently assigned to the deal's current owner. Preserve the old activity's `source` where
there is one. Preserve `Lead.price` and `priceNote` unchanged. The detail history must present a converted old row as
the **source of** its canonical event (or in an audit-only expansion), not as a second client send; otherwise every
old email/CP/návrh appears twice to users and statistics.

#### Prototype defects to fix before using the production duplicate

`2026-09-offer-migrate.ts` currently guesses cenník from `--pricelist-from`; converts every `EMAIL_SENT` to about-us;
forces `priceDisclosed` without a price event into `PHONE` at an audit timestamp/current price; creates separate rows
for flags that may have been one email; assigns every new row to the current owner; writes old `createdAt` with
`historical: false`; and ignores old designs if any newer `OFFER_SENT` mentions that ID. Its per-lead "any migrated
row" shortcut can hide an incomplete conversion, while `skip` can make `--verify` report success despite unconverted
data. It has no production-data reconciliation of counts and snapshots. Its endpoint confirmation is **not** a
production denylist: providing the production endpoint as both arguments would allow `--apply`. It also currently
depends on test-only `Design.legacySentAt`, which a fresh production clone does not have until that column is added.
It excludes all leads with `pipelineEnteredAt = NULL` without reporting old send evidence there. Its `OFFER_SENT`
meta parser validates shape but does not enforce cross-field rules (e.g. `PRICE` must have an amount, `DESIGN` must
identify the intended design), so the migration must validate those itself. These are implementation blockers, not
accepted migration assumptions.

`recomputeOffers`, the list/detail and the `got_design` filter must use **only canonical events** after cutover and
agree for a historical design with no Design row. Do not drop the old `Lead.designSentAt` until its replacement rule
is implemented and checked (it remains a current summary column). Keep the ability to enter a genuinely backdated
send manually, or state explicitly why that feature is removed; "historical" is not synonymous with "legacy layer".
Replace legacy-only concurrency tests with conversion, correction, summary/list/filter parity, history de-duplication,
idempotent rerun and
multiple-design tests. The current W3a/W3b code is not yet compatible with the contracted schema.
The idempotency-fingerprint defect noted here earlier (`offerFingerprint` without price / follow-up, `logFollowUpAs`
replaying by outcome only) was **fixed in wave 3**: both store the full canonical fingerprint in `meta.fp`, and
`w3Fingerprints` in the concurrency suite covers same-key / changed-payload cases. A converted row must not carry a
`meta.fp` that a live retry could match.

#### Required implementation and rehearsal order

1. Record the final schema and data-safety proposal in the active feature design. Build a read-only inventory/report
   against a **fresh production duplicate**, not production: old fields and activities, all cenník recipients,
   same-email groupings, price amounts/dates/channels, undo sequences, designs with/without rows, tracker counts,
   pre-deal/deleted leads, and existing new `OFFER_SENT` if any. Review an exception file with Michal; **zero
   unclassified records** before apply. No fabricated amount, date, channel or email contents.
2. Fix the script and new code on test. Use explicit source/event IDs and a reviewed mapping/overrides file, validate
   its schema and unique source coverage, and make each event idempotent. Under the `Lead` lock, re-read and check the
   expected source/revision before writing. Preserve old raw history. A `skip` is an explicit unresolved exception,
   **not** a passing verification. Make the script refuse the production endpoint independently of CLI arguments.
3. Rehearse the **entire rollout** on the duplicate from the actual production schema: round 1 schema → create the
   routing team → round 1 backfill (§2), the rest of the §1 schema without the test-only columns, conversion,
   recomputation, then the reviewed
   non-additive contraction. The old one-time `2026-09-offer-legacy.ts` step is **not** part of the final route.
   Avoid a `db push` that accepts a data-loss warning; review the explicit SQL and apply contraction only after
   reconciliation. Test new app code against the contracted clone; do not open it to writes during the cutover.
4. Reconcile **per lead and in aggregate**: each old real send has exactly one canonical representation (or a signed
   documented exception); no phantom sends; correct contents/grouping/price snapshots/actors/business dates; Lead
   `offer*` and `designSentAt`, each `Design.sentAt`, list/detail/filter results agree; tracker token, versions and
   event counts are unchanged; current prices and unrelated leads/activities are unchanged; no duplicate events on a
   second run. Verify a sample of every combination in the UI and run §4 checks, including new migration tests.
5. Only after the duplicate passes: separately approve the production window. Take a backup and restore-point branch,
   compare the *live* schema with the rehearsed source, freeze writes, run the **same reviewed sequence**, verify the
   same reconciliation, deploy compatible code, smoke-test, then reopen writes. If any gate fails, keep writes closed
   and restore/switch back using the rehearsed rollback procedure. Never run this from a routine dev session.

**Target schema, not yet in the current delta:** the following are planned contraction IDs; **none has been applied
on test** and none belongs in the "Non-additive changes owed" line yet. Add the verified exact delta there by ID only
after test application. The reviewed SQL must drop these only after conversion and reconciliation:

| Planned ID | Production column | Treatment |
|---|---|---|
| P-01 | `Lead.quoteSentAt` | remove after every real/undone CP is classified |
| P-02 | `Lead.aboutUsSentAt` | remove after email sends are classified |
| P-03 | `Lead.priceDisclosed` | remove after every true flag is represented or documented as an exception |

`hadLegacySends`, `legacySendsReviewedAt`, and `Design.legacySentAt` exist only on today's test schema; remove them
from the final test target and do **not** add them to production. Keep `Lead.price`/`priceNote`,
`Lead.designSentAt`, `Design.sentAt`, Design/versions/trackers/events, and historical raw activities. Old activity
enum values can remain because raw rows remain. Do not remove unrelated legacy columns such as `Lead.designUrl` in
this rollout.

**Code/documentation cutover:** remove `legacyUnreviewed`, the "?" state, the "Neoverené" pill/panel, frozen-field
reads, `confirmLegacyReviewedAs`, legacy design-date baselining and the one-time legacy script; update
`offers.ts`, `offerMutations.ts`, `commands/offers.ts`, pipeline queries/filters, offer/dialog/list/detail/design UI,
`database-map.md`, `operations.md`, `app-workflow.md` and the statistics rule together. Preserve correction and
backdated-entry behaviour that is still useful. The tracker ingest and existing design rows are not rebuilt.

## 4. Production rollout order and verification

Order (all of it only in a separately approved rollout session; rehearse on a fresh production duplicate first):

1. Backup + restore-point Neon branch. Compare the **live** production schema with the §1 baseline; add any surprise
   here before continuing.
2. Reviewed net-delta SQL (§1, regenerate it against the live schema with `migrate diff --from-config-datasource`) →
   `db execute` → `db push` reports "already in sync" (§1.4 gotcha). Enum values before any code that writes them. Leave
   out the test-only columns marked in §1.3 / §1.5 if §3.3 is implemented by then.
3. Create the routing team "Obchod" (leader Michal) (§2).
4. Round 1 backfill dry-run → review → `--apply` → `--verify` (§2).
5. Old-send conversion and reconciliation per §3.3 (not the old one-time legacy step).
6. Deploy the new code, re-run `--verify`, spot-check the screens (including "Pre mňa", "Čakám na manažéra", a task,
   História).

| Check | Command |
|---|---|
| schema really in sync | `npx prisma db push` → "already in sync" |
| client regenerated | `npx prisma generate`, then `npx tsc --noEmit` |
| business calendar | `npx tsx prisma/backfill/check-business-time.ts` (and with `TZ=UTC`) |
| section classification (incl. the locked step) | `npx tsx prisma/backfill/check-client-sections.ts` |
| concurrency + scope + wave 3 tasks | `npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint <dev endpoint>` |
| backfill integrity | `npx tsx prisma/backfill/check-backfill-delta.ts …` and the backfill's own `--verify` |
| wave 3a legacy step | current test implementation only; replace with the conversion/reconciliation checks in §3.3 before rollout |

Re-check the target endpoint and compare the actual production schema before any production command. A Git schema diff
alone does not establish the live database state.
