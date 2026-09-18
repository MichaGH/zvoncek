# Database change ledger

Every schema or data change this project makes, in one place, with its status per environment. **If a change is not in
this file, it must not be applied.** Add the row *before* running anything, update the status *after*.

Why this file exists: production is still on the pre-round-1 schema, so at any moment there are changes that exist on
the test branch and not in production. Without a ledger it is impossible to know what a production rollout still owes.

## Environments

| Name | Neon endpoint (suffix) | Role |
|---|---|---|
| test / development | `…nhww8x` | everything below is applied here first; verified 2026-09-18 as the value of `DATABASE_URL` |
| production | `…m0xyun` | commented out in `.env`; **never touched by a development session** |

Full connection strings are never written into docs, logs or scripts. Scripts verify the endpoint themselves
(`--expect-endpoint`) and refuse to run against anything else.

## Status legend

| Status | Meaning |
|---|---|
| `PLANNED` | agreed, not written to any database |
| `TEST` | applied to the test branch, verified |
| `PROD` | applied to production |
| `REJECTED` | considered and deliberately not done |

## Procedure (from `AGENTS.md`, repeated here because this is where it gets forgotten)

1. Edit `prisma/schema.prisma`, run `npx prisma generate`.
2. **Test branch:** verify the target first, then `npx prisma db push`. Never `--accept-data-loss`, never `--force-reset`.
3. If `db push` stops on a **data-loss warning for a purely additive change** (it does this for new unique indexes),
   do not accept it. Generate the diff, read it, apply it, confirm:
   ```bash
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o <file outside the repo>
   npx prisma db execute --file <that file>
   npx prisma db push      # must now report "already in sync"
   ```
4. **Production:** same reviewed-diff path, only in a separately approved rollout session, after a backup and a
   restore-point branch (`planning.md` §14).

---

## 1. Round 1 — caller assignment, SALES_REP, deals (applied to TEST, **owed to production**)

Schema source: commit `9cc335e`, diff `git diff 7beb689 9cc335e -- prisma/schema.prisma`.
All of it is **additive**: new nullable columns, one non-null column with a default, new enum values, new indexes, one
new table. Nothing was renamed, retyped or dropped.

### 1.1 `Lead` — new columns

| Column | Type | Null | Default | Status |
|---|---|---|---|---|
| `assignedCallerId` | text, FK → `User.id` | yes | — | TEST |
| `assignedCallerAt` | timestamptz | yes | — | TEST |
| `pipelineEnteredAt` | timestamptz | yes | — | TEST |
| `handedOffById` | text, FK → `User.id` | yes | — | TEST |
| `closedAt` | timestamptz | yes | — | TEST |
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

Plain `CREATE INDEX` takes a lock that blocks writes for its duration. On this table size that is milliseconds; if the
table ever grows, switch to `CREATE INDEX CONCURRENTLY` in a hand-written script (Prisma does not emit it).

### 1.3 `Activity` — new columns

| Column | Type | Null | Note | Status |
|---|---|---|---|---|
| `idempotencyKey` | text, **UNIQUE** | yes | the one object that made `db push` warn | TEST |
| `leadRevision` | integer | yes | only first calls write it | TEST |
| `revertedAt` | timestamptz | yes | | TEST |
| `revertedById` | text, FK → `User.id` | yes | | TEST |

**The gotcha to remember for production:** `prisma db push` refuses the new unique index on `idempotencyKey` with a
*data-loss warning*, even though the column is brand new and entirely NULL (NULLs are distinct in a Postgres unique
index, so there is nothing to lose). On the test branch this was resolved with the reviewed
`migrate diff` → `db execute` → `db push` ("already in sync") path from step 3 above. **Production will hit exactly the
same warning and needs exactly the same path, with Michal's explicit approval.** Do not answer "yes" to the warning.

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
| production | **PLANNED** — part of the approved rollout session |

### 1.7 Production rollout checklist for round 1 (still owed)

1. Backup + restore-point Neon branch.
2. Reviewed diff → `db execute` → `db push` reports "already in sync" (§1.3 gotcha).
3. Create team "Obchod" (leader Michal) so positive telesales calls route to an owner instead of landing unassigned.
4. Backfill dry-run → review → `--apply` → `--verify`.
5. Deploy, re-run `--verify`, spot-check the screens.

---

## 2. Round 2 — merged pipeline (`context/new-feature/round2-deal-workspace.md`)

### 2.1 Wave 1 (the merge): **no database change at all** — shipped 2026-09-18, confirmed

This is deliberate and worth stating loudly: merging `/dashboard/clients` into `/dashboard/pipeline` is **pure
application code**. Nothing in the list below touches Postgres, so wave 1 cannot break data, and it can be verified by
reading and tests alone:

- permission rename (`clients.view` → `deals.view`, `pipeline.view` → `deals.viewAll`, …) — `Permission` is a
  TypeScript union, not a database enum. `Role` is untouched.
- `dealScope()` / `dealCapabilities()` — pure functions.
- merged list and detail queries — different `where`/`orderBy`, same columns.
- deleted components and redirect pages.
- the `Na dnes` filter — a SQL predicate in a query, not a stored object.

If an agent believes wave 1 needs a migration, that is a signal something has been misunderstood. Stop and ask.

### 2.2 Wave 2 — interaction model (shipped to TEST 2026-09-18)

| id | Change | Kind | Risk | Status |
|---|---|---|---|---|
| S-01 | `NextActionKind += ORDER` | additive enum value | none; remember the "cannot use it in the same transaction" rule | **TEST** (2026-09-18, `db push`, no warning) |

The interaction model itself (contact result → reply → next step) stores into existing columns: one `Activity` row
(`type`, `outcome`, `note`, `meta`, `source`, `idempotencyKey`) plus the existing `Lead.nextAction*` fields. The quick
replies live in `Activity.meta` **on purpose**, so no column is needed (D-06). Confirmed in practice: the only database
change of wave 2 is the single enum value above. `Activity.meta` now carries `{ reply: "<key>" }` and the human label is
copied into `Activity.note`, so history stays readable if the reply list changes.

**Production note:** `ALTER TYPE "NextActionKind" ADD VALUE 'ORDER'` must run in the rollout script *before* any
statement that writes the value, and round 1's own additions have to land first (§1). The deals list shows the value
through `NEXT_ACTION_LABEL`, so deploying code that writes `ORDER` before the enum exists would fail at runtime — order
matters: schema, then deploy.

### 2.3 Wave 3 — tickets, handover, history (designed 2026-09-18, not applied)

Design: `context/new-feature/round2-deal-workspace.md` §2b. All additive.

| id | Change | Kind | Risk | Status |
|---|---|---|---|---|
| S-08 | `DealRequestKind += CALL_CLIENT, HANDOVER` | new enum values | none; `ORDER` stays as an unused legacy value rather than a destructive removal | PLANNED |
| S-09a | `DealRequest.toUserId` (FK → `User.id`, null) | additive column | none; null + `toRole` null means "for the manager", which is what every existing row is | PLANNED |
| S-09b | `DealRequest.toRole Role?` | additive column | none | PLANNED |
| S-09c | `DealRequest.updatedAt` | additive column with `@updatedAt` | none | PLANNED |
| S-10 | `DealRequestComment` (id, requestId → cascade, authorId, body, createdAt) + index `(requestId, createdAt)` | new table | none — nothing reads it until the UI ships | PLANNED |
| S-11 | `NextActionKind += WAITING_FOR_MANAGER` | new enum value | none; replaces the wave-2 `ORDER` step, which stays in the enum unused | PLANNED |
| S-12 | `DealOwnership` (id, leadId → cascade, fromUserId?, toUserId?, byUserId, note?, createdAt) + indexes `(leadId, createdAt)`, `(fromUserId, createdAt)` | new table | none | PLANNED |

**No data backfill.** Existing `ORDER` requests exist only as test fixtures (production has no `DealRequest` rows at all
— round 1 is still unshipped), and `DealOwnership` starts empty: history begins when the table does. If we ever want the
past owner changes in it, that is a **separate ledger row** with its own dry-run, reading the existing `OWNER_CHANGED`
activities.

**Order on rollout:** enum values (S-08, S-11) must be applied *before* the code that writes them is deployed —
`ALTER TYPE … ADD VALUE` first, then deploy. The same rule as S-01.

### 2.4 Wave 4 — notes

| id | Change | Kind | Risk | Status |
|---|---|---|---|---|
| S-02a | enum `LeadNoteKind` (`GENERAL`, `FOR_CALL`, `FOR_BUILD`, `INTERNAL`) | new enum | none | PLANNED |
| S-02b | enum `NoteStage` (`CALL_STAGE`, `DEAL_STAGE`) | new enum | none | PLANNED |
| S-02c | table `LeadNote` (FK → `Lead` cascade, FK → `User`, `authorRole` uses the existing `Role` enum) | new table | none — nothing reads it until the UI ships | PLANNED |
| S-02d | indexes `(leadId, pinnedAt)`, `(leadId, createdAt)` | new indexes on a new table | none | PLANNED |

No data migration: `Lead.note` keeps its value and its meaning narrows to "note written when the contact was added".
If we later decide to copy it into a `GENERAL` note, that is a **separate ledger row** with its own dry-run.

### 2.5 Wave 5 — pricing

| id | Change | Kind | Risk | Status |
|---|---|---|---|---|
| S-03a | enum `QuoteChannel` (`CALL`, `EMAIL`, `BOTH`) | new enum | none | PLANNED |
| S-03b | `Lead.pricelistSentAt timestamptz null` | additive column | none | PLANNED |
| S-03c | `Lead.priceQuotedAt timestamptz null` | additive column | none | PLANNED |
| S-03d | `Lead.priceQuotedVia QuoteChannel null` | additive column | none | PLANNED |
| S-03e | `Lead.priceItems jsonb null` | additive column | none; validated by strict zod in code | PLANNED |

`priceDisclosed` is **kept** and keeps its meaning ("knows a concrete price"). Deliberately **no backfill**: historical
rows get `pricelistSentAt = null` / `priceQuotedAt = null`, which is the truth — the app never sent a price list before,
and guessing a date from `updatedAt` would be exactly the ambiguity the backfill rules forbid.

### 2.6 Later / conditional

| id | Change | Kind | Trigger | Status |
|---|---|---|---|---|
| S-04 | `Activity.replyKind` enum column | additive column + backfill from `Activity.meta.reply` | only if statistics need it (D-06) | PLANNED |
| S-05 | `Lead.brief jsonb` | additive column | dropped from this round (D-08) | REJECTED for now |
| S-06 | drop `Lead.lockedById`, `Lead.lockedAt` | **destructive** | never inside a feature round; two unused nullable columns cost nothing | REJECTED |
| S-07 | `DealRequest.toRole`, `DealRequest.toUserId` | additive columns + default existing rows to the manager | when a developer or team-leader role arrives (D-15) | PLANNED |

---

## 3. Things that look like database changes but are not

Kept here so nobody goes looking for a migration that should not exist:

- **Permission renames** — `Permission` is a TypeScript union; `ROLE_PERMISSIONS` is a constant. No DB object.
- **Capabilities / scope** — pure functions of the user row.
- **Quick replies (D-06)** — values inside the existing `Activity.meta` JSON column.
- **`NEXT_STEP_OPTIONS`** — a constant; only the new `ORDER` *enum value* (S-01) is a DB change.
- **`Na dnes`** — a predicate inside a query.
- **The cenník (F-01, parked)** — would be a constant file, not a table, unless it grows an admin UI.

## 4. After every applied change

| Check | Command |
|---|---|
| schema really in sync | `npx prisma db push` → "already in sync" |
| client regenerated | `npx prisma generate`, then `npx tsc --noEmit` |
| business calendar | `npx tsx prisma/backfill/check-business-time.ts` (and with `TZ=UTC`) |
| section classification | `npx tsx prisma/backfill/check-client-sections.ts` |
| concurrency + scope | `npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint <dev endpoint>` |
| backfill integrity | `npx tsx prisma/backfill/check-backfill-delta.ts …` and the backfill's own `--verify` |

Then update the status column in this file in the same commit as the change.
