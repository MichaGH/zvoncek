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

**Non-additive changes owed to production (D-009, Michal 2026-09-22):** drop `Lead.quoteSentAt`, `aboutUsSentAt`,
`priceDisclosed`, `designUrl`, `lockedById` (+ FK), `lockedAt` — `.ai/migrations/v1-to-v2-live/sql/03-drop-v1-columns.sql`,
the last data step of the window, after the send conversion and normalization verify clean. **Test:** the schema
file no longer has them; the test database still has the columns until the showcase deployment runs the new code
(the new code works with the extra columns). Previously: none. Keep this line true: any non-additive entry must be listed here by
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
| `ActivityType` | `CLIENT_ASK_CHANGED` (S-18) | wave 5 | TEST |
| `CallOutcome` | `INTERESTED` (S-19) | wave 5 | TEST |
| `ActivityType` | `TASK_PART_ADDED`, `TASK_PART_DONE`, `TASK_PART_DECLINED`, `TASK_PART_WITHDRAWN` (S-14), `PRICE_CHANGED` (S-15) | wave 4 | TEST |

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
| `RequestContent` | `INFO`, `PRICELIST`, `PRICE`, `DESIGN`, `REVIEW` (S-16) | wave 5 | TEST |
| `RequestState` | `OPEN`, `SENT`, `WITHDRAWN` (S-16) | wave 5 | TEST |
| `RequestOrigin` | `LIVE`, `MIGRATED_RECEIPT`, `MIGRATED_OPEN_STEP` (S-16) | wave 5 | TEST |
| `DealTaskPartStatus` | `REQUESTED`, `DELIVERED`, `DECLINED`, `WITHDRAWN` (S-13a) | wave 4 | TEST |

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
| `offerReviewAt` (S-17) | timestamp(3) without time zone | yes | — | wave 5 | TEST |

`revision` is the only NOT NULL addition; it has a constant default (PostgreSQL 11+ fast
default, no table rewrite). `LeadRequest` is a new table, so its NOT NULL columns cost nothing.

**Wave 5 application on test (2026-09-20).** The reviewed diff (`migrate diff --from-config-datasource --to-schema`)
contained only `CREATE TYPE` ×3, `ALTER TYPE … ADD VALUE` ×2, `ADD COLUMN` ×1 (nullable), `CREATE TABLE` ×1,
`CREATE [UNIQUE] INDEX` ×3 and `ADD CONSTRAINT … FOREIGN KEY` ×5 — **no `DROP`, no retype**. `prisma db push`
applied it without a data-loss warning and a second run reported "already in sync". Endpoint verified before the
command: `…nhww8x` / `neondb`.

**Wave 4 application on test (2026-09-20), in two steps.** Endpoint verified before each command
(`…nhww8x` / `neondb`); both diffs were generated with `migrate diff --from-config-datasource --to-schema` and read
before applying, then applied with `db execute` and confirmed with a second `migrate diff` that came back empty.

- **S-13a + S-14 + S-15 (additive):** `CREATE TYPE "DealTaskPartStatus"` ×1, `ALTER TYPE "ActivityType" … ADD VALUE`
  ×5, `ADD COLUMN` ×2 on `DealTask` (both nullable), `CREATE TABLE "DealTaskPart"` ×1, `CREATE INDEX` ×1,
  `CREATE UNIQUE INDEX` ×1, `ADD CONSTRAINT … FOREIGN KEY` ×3 — **no `DROP`, no retype**.
- **S-13b (test-only drop, after the code was switched over and verified):**
  `ALTER TABLE "DealTask" DROP COLUMN "contents", DROP COLUMN "result"` — two columns **production has never had**.
  Nothing is owed to production for it and the ledger keeps "non-additive owed: none" true.

  Test-data conversion between the two steps: `prisma/backfill/2026-09-wave4-parts.ts` derived one `DealTaskPart`
  per task content (12 parts from 12 tasks, no blockers, zero drift verified). Production runs **none** of it — it
  has no task rows to convert — so it is not a data step in §2. The script is kept only as the record of what ran
  and refuses to run again.

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

### 1.5 `Design` — no new column

`Design.legacySentAt`, `Lead.hadLegacySends` and `Lead.legacySendsReviewedAt` (wave 3a "?" layer) were **dropped on
test on 2026-09-21** (reviewed SQL, three `DROP COLUMN`, `migrate diff` empty afterwards). Production never had them;
nothing is owed. The reviewed V1 → V2 script is `.ai/migrations/v1-to-v2-live/sql/01-schema-v1-to-v2.sql`
(generated offline from `origin/main` → current schema: no DROP, no retype; rehearsed on a production clone).

### 1.6 New tables

| Table | Columns | FKs | Came with | Status |
|---|---|---|---|---|
| `DealTask` | `id`, `leadId`, `type`, `status` (default `OPEN`), `text`, `requestedById`, `assigneeId`, `createdAt`, `closedAt?`, `closedById?`, `closeReason?`, `fallbackKind?`, `fallbackNote?` | `leadId` → `Lead` `CASCADE`; `requestedById`, `assigneeId` → `User` `RESTRICT`; `closedById` → `User` `SET NULL` | wave 3, wave 4 | TEST |
| `DealTaskPart` (S-13a) | `id`, `taskId`, `kind`, `status` (default `REQUESTED`), `result jsonb?`, `addedById`, `addedAt`, `resolvedById?`, `resolvedAt?`, `reason?`; **UNIQUE `(taskId, kind)`** | `taskId` → `DealTask` `CASCADE`; `addedById` → `User` `RESTRICT`; `resolvedById` → `User` `SET NULL` | wave 4 | TEST |
| `DealOwnership` | `id`, `leadId`, `fromUserId?`, `toUserId?`, `byUserId`, `reason`, `note?`, `createdAt` | `leadId` → `Lead` `CASCADE`; `fromUserId`, `toUserId` → `User` `SET NULL`; `byUserId` → `User` `RESTRICT` | wave 3 | TEST |
| `LeadRequest` (S-16) | `id`, `leadId`, `content`, `state` (default `OPEN`), `origin` (default `LIVE`), `requestedAt`, `requestedById?`, `sourceActivityId?`, `resolvedAt?`, `resolvedById?`, `resolvedActivityId?`, `reason?`, `migrationKey?` **UNIQUE**, `provenance jsonb?`, `createdAt`, `updatedAt` | `leadId` → `Lead` `CASCADE`; `requestedById`, `resolvedById` → `User` `SET NULL`; `sourceActivityId`, `resolvedActivityId` → `Activity` `SET NULL` | wave 5 | TEST |

All start empty. "At most one `OPEN` task per deal" is enforced **in code under the Lead row lock**, not by a partial
unique index (Prisma cannot declare one, so `db push` would treat it as drift). If it ever moves into the database it is
a new ledger row with a duplicate pre-check.

**`DealTask.contents` / `DealTask.result` are gone (S-13b, wave 4)** and are deliberately **not** in the table above:
production never had the task tables at all, so it receives the final parent + parts shape in one additive step. The
drop was a test-only cleanup of a column production never saw — it is **not** a non-additive change owed to
production, and there is nothing for a rollout to drop.

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
| `LeadRequest (leadId, state)`, `LeadRequest (leadId, content, state)`, `LeadRequest (migrationKey)` **UNIQUE** | wave 5 | TEST |
| `DealTaskPart (taskId, status)`, `DealTaskPart (taskId, kind)` **UNIQUE** | wave 4 | TEST |

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
| Routing team | team "Obchod", leader `michal`, member `timea` (live has no team for telesales) — `.ai/migrations/v1-to-v2-live/sql/02-obchod-team.sql` | seeded | **OWED** |
| V1 send conversion | `prisma/backfill/2026-09-v1-sends.ts` (§3) | rehearsed on clone 1 2026-09-21: 88 `OFFER_SENT`, verify clean | **OWED** |
| Wave 3 | none. `DealTask` / `DealOwnership` start empty; no existing row is rewritten | — | nothing to backfill. Consequence: História and ownership history show only moves **after** the rollout; older owner changes remain readable only as `OWNER_CHANGED` activities |
| Wave 5 | `prisma/backfill/2026-09-wave5-requests.ts` — "what the client asked for" for old deals (§5 below) | rehearsed on clone 1 2026-09-21 | **NOT USED** — replaced by the D-009 normalization ("Chceli" from the first call) |

## 3. Old send data — conversion (implemented, rehearsed, owed to production)

The wave 3a "?" legacy layer is removed from code and test schema (2026-09-21). Old V1 sends are converted once by
`prisma/backfill/2026-09-v1-sends.ts` under the rule approved by Michal on 2026-09-21 (D-003 r2 in
`.ai/migrations/v1-to-v2-live/DECISIONS.md`; spec `02-data-mapping.md`; measured data `INVENTORY-2026-09-21.md`):

| V1 | V2 `OFFER_SENT` (channel EMAIL, `historical` + `migrated`, `createdAt` = original V1 time) |
|---|---|
| `EMAIL_SENT` ("Email o nás") | `ABOUT_US` |
| `QUOTE_SENT` not undone | `ABOUT_US` + `PRICE` (amount from the QUOTE_SENT note) |
| sent `Design` (matched to its `DESIGN_SENT`) | `ABOUT_US` + `DESIGN` |
| several of the above on one business day | one send with all contents |
| price filled / "klient pozná cenu" without a CP | no receipt (except the per-lead decision #628) |

No `PRICELIST`, no `REVIEW`. Any pattern outside this table stops the run before writing. `Lead.price` / `priceNote`,
steps and statuses are never touched. Raw V1 rows stay; the history hides those listed in `meta.migration.sources`.

**Normalization (D-009):** after the conversion, `prisma/backfill/2026-09-v2-normalize.ts` makes the data V2-shaped
(first calls → `INTERESTED` + "Chceli" from the call, ownership `HANDOFF`, closed deals / call stage without a step,
closed asks withdrawn, old send rows and audits removed, price notes → `PRICE_CHANGED`). Then the six dead V1 columns
are dropped (see the non-additive line at the top). The wave-5 receipts backfill is no longer used.

## 4. Production rollout order and verification

Order (only in the approved window; rehearsed end-to-end on production clone 1, 2026-09-21). Exact commands, stop
gates and rollback: `.ai/migrations/v1-to-v2-live/06-production-cutover.md`.

1. Write freeze + Neon restore-point branch; re-run the read-only inventory and compare with clone 1.
2. `sql/01-schema-v1-to-v2.sql` (`db execute`), then `migrate diff` must be empty.
3. `sql/02-obchod-team.sql` (routing team).
4. Round 1 backfill dry-run → `--apply` → `--verify`.
5. `2026-09-v1-sends.ts` dry-run → `--apply` → `--verify` (§3).
6. `2026-09-wave5-requests.ts` dry-run → `--apply` → `--verify` (§5; after step 5, never before).
7. `tools/post-check.ts`; deploy the V2 code; smoke-test; reopen writes.

| Check | Command |
|---|---|
| schema really in sync | `npx prisma db push` → "already in sync" |
| client regenerated | `npx prisma generate`, then `npx tsc --noEmit` |
| business calendar | `npx tsx prisma/backfill/check-business-time.ts` (and with `TZ=UTC`) |
| section classification (incl. the locked step) | `npx tsx prisma/backfill/check-client-sections.ts` |
| concurrency + scope + wave 3 tasks + wave 5 requests | `npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint <dev endpoint>` |
| wave 5 requests backfill | `npx tsx prisma/backfill/2026-09-wave5-requests.ts …` dry-run → `--apply` → `--verify` (§5) |
| backfill integrity | `npx tsx prisma/backfill/check-backfill-delta.ts …` and the backfill's own `--verify` |
| wave 3a legacy step | current test implementation only; replace with the conversion/reconciliation checks in §3.3 before rollout |

Re-check the target endpoint and compare the actual production schema before any production command. A Git schema diff
alone does not establish the live database state.

---

## 5. Wave 5 — the production migration of "what the client asked for" (NOT executed)

Design: `context/features/01-salesrep/wave-5-proposal.md` §11. Script: `prisma/backfill/2026-09-wave5-requests.ts` (its SQL is
in `wave5-requests-sql.ts`, which `w5MigrationPricelist` runs in a rolled-back transaction).
The schema (S-16 – S-19, §1 above) is applied and verified on test; **no production command has been run**, and the
script has only been executed in dry-run mode against the test branch.

### 5.1 The rule (Michal, 2026-09-20 — business input, to be verified on the clone)

For old records, everything the client **received** is treated as something they **asked for**. An open deal whose
send step has no matching receipt still owes that content, so the pending work survives the deploy.

| Old, after the §3.3 send conversion | Wave-5 backfill | `origin` |
|---|---|---|
| canonical `ABOUT_US` receipt | `LeadRequest(INFO, SENT)` dated with the first such send | `MIGRATED_RECEIPT` |
| canonical `PRICE` receipt | `LeadRequest(PRICE, SENT)` | `MIGRATED_RECEIPT` |
| canonical `DESIGN` receipt | `LeadRequest(DESIGN, SENT)` | `MIGRATED_RECEIPT` |
| canonical `PRICELIST` receipt | `LeadRequest(PRICELIST, SENT)`. Live production had no cenník content and no flag (§3.3), so a receipt exists only where Michal named the recipient's email at the send conversion. **No manual list here** — an `OPEN` row for a recipient would be false work (R01-1) | `MIGRATED_RECEIPT` |
| **rozbor webu** | nothing — the old system had no such content | — |
| **open** deal with `SEND_QUOTE` / `SEND_DESIGN` / `SEND_EMAIL` and no matching receipt | one `LeadRequest(PRICE / DESIGN / INFO, OPEN)` | `MIGRATED_OPEN_STEP` |
| anything else | no rows, no warnings | — |

One row per (lead, content), taken from the **first** matching receipt — the client asked once, not at every email.

### 5.2 Identity, provenance and safety

- `migrationKey` is deterministic (`w5:receipt:<leadId>:<content>`, `w5:step:<leadId>:<content>`) and **unique**, so a rerun or an interrupted run cannot duplicate a row (`ON CONFLICT DO
  NOTHING`). Covered by `w5Migration` in the concurrency suite.
- `provenance` records the source activity / column, the rule and the confidence.
- `requestedById` is **NULL** — the historical actor is unknown and is never attributed to today's owner.
- Migrated rows are excluded from demand statistics (`getDemandStats` reads `origin = LIVE` only).
- The script **refuses the production endpoint independently of its arguments** (endpoint denylist), requires
  `--expect-endpoint` + `--expect-db` to match `DATABASE_URL`, and `--apply` additionally needs a **direct** (non-pooler)
  host plus `--confirm <endpoint>`. Dry-run is the default; `--verify` reports what is still missing.
- `--apply` **aborts** while any lead still has old send evidence (`quoteSentAt` / `aboutUsSentAt` / `priceDisclosed`
  / old `QUOTE_SENT` / `EMAIL_SENT` / `DESIGN_SENT`) without a single canonical `OFFER_SENT`: the conversion of §3.3
  must come first, or the migration would describe an incomplete picture.

### 5.3 Order inside the rollout

Insert between steps 5 and 6 of §4:

1. §1 schema (including S-16 – S-19; the enum values land **before** any code that writes `INTERESTED` /
   `CLIENT_ASK_CHANGED` is deployed, and never inside the transaction that adds them).
2. The §3.3 old-send conversion and its reconciliation.
3. Michal's cenník recipients, if any, are already inside step 2 as `PRICELIST` added to named canonical sends; if
   there are none, no `PRICELIST` row is created.
4. `2026-09-wave5-requests.ts` dry-run → review the counts and the exception list → `--apply` → `--verify` (0 left).
5. Reconcile: every lead's "Chceli" matches its "Klient dostal"; open deals with an unmet send step have exactly one
   `OPEN` row; no lead has two rows of the same content from the migration; demand statistics are unchanged.
6. Deploy the code, then re-run `--verify`.

### 5.4 What is still missing before any of this may run

Unchanged from the wave-5 design §11: a **fresh duplicate of production** under its own env name (never
`DATABASE_URL`), the exact deployed commit, permission for the read-only inventory, Michal's cenník recipients (probably
none; named at the send conversion), and a full rehearsal on that duplicate. None of that has happened.
