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

**Non-additive changes owed to production: none.** Keep this line true: any non-additive entry must be listed here by
id, with its data plan, before it is applied on test.

## Environments

| Name | Neon endpoint (suffix) | Role |
|---|---|---|
| test / development | `…nhww8x` | listed changes were applied here; endpoint was verified 2026-09-18 |
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
3. If `db push` stops on a **data-loss warning for a genuinely additive change** (it does this for new unique indexes),
   do not accept it. Generate the diff, read it, apply it, confirm:
   ```bash
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o <file outside the repo>
   npx prisma db execute --file <that file>
   npx prisma db push      # must now report "already in sync"
   ```
4. Verify the test schema and any backfill; then add only what actually changed to this file. Do not mark an unrun
   check as passed.
5. **Production:** separately approved rollout only, after a backup and restore-point Neon branch. Compare the live
   production schema with the reviewed target; do not assume it matches a Git commit. Apply the reviewed diff and
   backfill in the documented order (`context/features/01-salesrep/planning.md` §14).

---

## 1. Round 1 — caller assignment, SALES_REP, deals (applied to TEST, **owed to production**)

Schema source: commit `9cc335e`, diff `git diff 7beb689 9cc335e -- prisma/schema.prisma`.
All of it is **additive**: new nullable columns, one non-null column with a default, new enum values, new indexes, one
new table. Nothing was renamed, retyped or dropped.

### 1.1 `Lead` — new columns

| Column | Type | Null | Default | Status |
|---|---|---|---|---|
| `assignedCallerId` | text, FK → `User.id` | yes | — | TEST |
| `assignedCallerAt` | timestamp(3) without time zone | yes | — | TEST |
| `pipelineEnteredAt` | timestamp(3) without time zone | yes | — | TEST |
| `handedOffById` | text, FK → `User.id` | yes | — | TEST |
| `closedAt` | timestamp(3) without time zone | yes | — | TEST |
| `revision` | integer | **no** | `0` | TEST |

`revision` is the only NOT NULL addition. It is safe on PostgreSQL 11+ (fast default, no table rewrite); Neon is far
newer, so this was instant.

### 1.2 `Lead` — new indexes

| Index | Status |
|---|---|
| `(status, assignedCallerId, createdAt)` | TEST |
| `(assignedCallerId, status, callbackKind)` | TEST |
| `(ownerId, status)` | TEST |
| `(pipelineEnteredAt, status)` | TEST |

Plain `CREATE INDEX` takes a lock that blocks writes for its duration. Do not assume the duration on production;
review its table size and schedule the rollout accordingly. If needed, use reviewed `CREATE INDEX CONCURRENTLY` SQL
instead of Prisma-generated `CREATE INDEX`.

### 1.3 `Activity` — new columns

| Column | Type | Null | Note | Status |
|---|---|---|---|---|
| `idempotencyKey` | text, **UNIQUE** | yes | the one object that made `db push` warn | TEST |
| `leadRevision` | integer | yes | only first calls write it | TEST |
| `revertedAt` | timestamp(3) without time zone | yes | | TEST |
| `revertedById` | text, FK → `User.id` | yes | | TEST |

**Production gotcha:** on test, `prisma db push` refused the new unique index on `idempotencyKey` with a *data-loss
warning*, even though the new column was entirely NULL. The reviewed `migrate diff` → `db execute` → `db push`
("already in sync") path resolved it. Production may issue the same warning; inspect its actual diff with Michal's
explicit approval and do not answer "yes" to the warning.

### 1.4 New enum values

| Enum | Added values | Status |
|---|---|---|
| `Role` | `SALES_REP` | TEST |
| `CallOutcome` | `WANTS_TO_ORDER` | TEST |
| `ActivitySource` | `CLIENTS` | TEST |
| `ActivityType` | `CALLER_ASSIGNED`, `CALLER_RELEASED`, `CALL_REVERTED`, `REQUEST_CREATED`, `REQUEST_RESOLVED`, `DEAL_REOPENED` | TEST |

Adding a value to an existing enum is `ALTER TYPE … ADD VALUE`. Additive and cheap, but **a value added inside a
transaction cannot be used by the same transaction** — so a rollout script must never add a value and write rows using
it in one go. None of ours does.

### 1.5 New table `DealRequest` + enums

| Object | Status |
|---|---|
| enum `DealRequestKind` (`PRICE`, `DESIGN`, `EMAIL`, `ORDER`, `REOPEN`, `OTHER`) | TEST |
| enum `DealRequestStatus` (`OPEN`, `DONE`, `CANCELLED`) | TEST |
| table `DealRequest` (+ FKs to `Lead` `ON DELETE CASCADE`, to `User` twice) | TEST |
| indexes `(status, createdAt)`, `(leadId, status, kind)` | TEST |

"At most one OPEN request per (leadId, kind)" is enforced **in code under the Lead row lock**, not by a partial unique
index. If that ever moves into the database it is a new ledger row (a partial unique index is additive, but it can fail
on existing duplicates, so it needs a pre-check query first).

### 1.6 Data backfill (not schema, still owed to production)

`prisma/backfill/2026-09-assignments.ts` — populates `assignedCallerId`, `pipelineEnteredAt`, `handedOffById`,
`closedAt` and normalises `NEW` contacts that already have call history. Dry-run by default, `--apply` requires a direct
host and `--confirm <endpoint>`, aborts on ambiguous records, repeatable, `--verify` reports drift.

| Environment | Status |
|---|---|
| test | TEST — applied, `--verify` clean |
| production | **OWED** — apply only in the approved rollout session |

### 1.7 Production rollout checklist for round 1 (still owed)

1. Backup + restore-point Neon branch.
2. Reviewed diff → `db execute` → `db push` reports "already in sync" (§1.3 gotcha).
3. Create team "Obchod" (leader Michal) so positive telesales calls route to an owner instead of landing unassigned.
4. Backfill dry-run → review → `--apply` → `--verify`.
5. Deploy, re-run `--verify`, spot-check the screens.

---

## 2. Round 2, Wave 2 — interaction model (applied to TEST 2026-09-18)

| id | Change | Kind | Risk | Status |
|---|---|---|---|---|
| S-01 | `NextActionKind += ORDER` | additive enum value | deploy schema before code; do not use the value in the transaction that adds it | **TEST** (2026-09-18, `db push`, no warning) |

**Production note:** `ALTER TYPE "NextActionKind" ADD VALUE 'ORDER'` must run in the rollout script *before* any
statement that writes the value, and round 1's own additions have to land first (§1). The deals list shows the value
through `NEXT_ACTION_LABEL`, so deploying code that writes `ORDER` before the enum exists would fail at runtime — order
matters: schema, then deploy.

Production has never had `NextActionKind.ORDER` or `DealRequestKind.ORDER`. If a later wave removes them from the test
schema before the rollout, delete their rows here — that is still additive toward production. Once production has
them, removing them is non-additive.

## 3. Round 2, Wave 3a — what the client received (applied to TEST 2026-09-18)

Design: `context/features/01-salesrep/round2-deal-workspace.md` §2c. Reviewed `migrate diff` SQL contained exactly the
rows below; `prisma db push` applied it with no data-loss warning; a second push reported "already in sync".
All additive: nothing production already has is renamed, retyped, dropped or rewritten.

| Change | Kind | Status |
|---|---|---|
| `ActivityType += OFFER_SENT, CLIENT_REPLIED` | two additive enum values | TEST |
| `Lead.offerAboutUsAt`, `Lead.offerPricelistAt`, `Lead.offerPriceAt`, `Lead.legacySendsReviewedAt` | nullable `timestamp(3)` columns | TEST |
| `Lead.hadLegacySends` | `boolean NOT NULL DEFAULT false` (fast default, no table rewrite) | TEST |
| `Design.legacySentAt` | nullable `timestamp(3)` column | TEST |

### 3.1 Data step (not schema, still owed to production)

`prisma/backfill/2026-09-offer-legacy.ts` sets `Lead.hadLegacySends = true` for leads with old send evidence
(`quoteSentAt`, `aboutUsSentAt`, `priceDisclosed`, `QUOTE_SENT` / `EMAIL_SENT` / `DESIGN_SENT` activities, or a design
marked sent without any `OFFER_SENT`) and copies `Design.sentAt` → `Design.legacySentAt` for designs sent under the old
system. It only sets values, so it is repeatable.

| Environment | Status |
|---|---|
| test | TEST — dry-run 28 leads + 5 designs, `--apply` committed 28 + 5, `--verify` OK |
| production | **OWED** |

### 3.2 Production order for wave 3a

1. Round 1 (§1) and wave 2 (§2) first — `OFFER_SENT` code assumes the round-1 schema.
2. Schema (enum values **before** any code that writes them; not used in the transaction that adds them).
3. `2026-09-offer-legacy.ts` dry-run → review counts → `--apply` → `--verify`.
4. Deploy the new code.
5. Run `--apply` **again** right after the deploy (old code may have written a send between steps 3 and 4), then
   `--verify` must report 0 left.

## 4. Verification before production rollout

| Check | Command |
|---|---|
| schema really in sync | `npx prisma db push` → "already in sync" |
| client regenerated | `npx prisma generate`, then `npx tsc --noEmit` |
| business calendar | `npx tsx prisma/backfill/check-business-time.ts` (and with `TZ=UTC`) |
| section classification | `npx tsx prisma/backfill/check-client-sections.ts` |
| concurrency + scope | `npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint <dev endpoint>` |
| backfill integrity | `npx tsx prisma/backfill/check-backfill-delta.ts …` and the backfill's own `--verify` |
| wave 3a legacy step | `npx tsx prisma/backfill/2026-09-offer-legacy.ts … --verify` → 0 left |

Re-check the target endpoint and compare the actual production schema before any production command. A Git schema diff
alone does not establish the live database state.
