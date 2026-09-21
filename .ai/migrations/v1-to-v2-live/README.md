# V1 live database -> V2 rollout dossier

Working area for planning, rehearsing and recording the one-time migration from the live V1 database to the final V2
application and schema.

This directory records the **process**. It is not an authority for current application behaviour or the verified
test-production database delta:

- `context/domain/db-changes.md` remains the rollout ledger and database source of truth.
- Approved product/data meanings belong in the active feature design and current domain/workflow documentation.
- Check results from application work belong in `context/progress-tracker.md`.
- Decisions may be drafted here, but a decision required to build or operate the app must be promoted to `context/`
  before implementation is considered ready.

## Current state — 2026-09-21

**STOP at Phase 0 — preparation. No production rollout is authorized.**

- V2 reviews are still in progress; no deploy commit is frozen.
- The repository has the V1 `origin/main` Prisma schema at commit
  `8e8b1836bc91a67587783cf1443cd26c68a74f58`. It has the same Prisma schema as the recorded baseline `7beb689`.
- The actual live database schema has not been measured; the Git baseline remains an assumption.
- No fresh production duplicate has been created or inspected for this rollout.
- No live-data inventory or exception classification exists.
- `prisma/backfill/2026-09-offer-migrate.ts` is an unsafe prototype and must not be applied to production or a
  production duplicate.
- Michal proposed a broader migration-only rule on 2026-09-21: old price evidence, old about-us email, and old sent
  proposal evidence imply an exact-price receipt. It is recorded as a **draft decision** in `DECISIONS.md`; its missing
  amount/date cases are unresolved and it has not yet been promoted to authoritative context.

## Folder map

| File | Purpose |
|---|---|
| `PROGRESS.md` | One current status board, gates, owners and evidence links |
| `DECISIONS.md` | Proposed, approved, superseded and rejected migration decisions |
| `01-inputs-and-access.md` | Everything required before reading the production duplicate |
| `02-data-mapping.md` | Source-to-target mapping and exception taxonomy |
| `03-inventory-plan.md` | Read-only inventory and the reports it must produce |
| `04-build-and-test-plan.md` | Migration implementation, safety and automated test plan |
| `05-rehearsal-runbook.md` | Ordered fresh-clone rehearsal with stop/go gates |
| `06-production-cutover.md` | Production window plan; not executable until rehearsals pass |
| `07-verification.md` | Per-lead, aggregate, schema and application reconciliation |
| `08-rollback.md` | Rollback triggers and rehearsed recovery routes |

## Hard safety rules

1. Never paste or commit a database connection string, password, raw customer export or exception file containing PII.
2. A production duplicate uses its own environment variable, never the normal development `DATABASE_URL`.
3. Inventory is read-only. Apply mode is forbidden until the mapping has zero unclassified evidence.
4. Every database command verifies endpoint and database identity. Apply scripts independently deny the production
   endpoint until the separately approved production window.
5. No data-loss prompt is accepted. Non-additive SQL is explicit, reviewed and rehearsed.
6. The rehearsal clone is disposable and never becomes production after live V1 has continued receiving writes.
7. A changed deploy commit, migration artifact or approved mapping invalidates the affected rehearsal evidence.
8. Failure of any gate stops the sequence. It never authorizes improvised SQL.

## Phases

0. Finish reviews, settle migration meanings and freeze an exact target commit.
1. Create a fresh production duplicate and measure its schema/data read-only.
2. Build the final schema diff, conversion, reconciliation and rollback artifacts on test.
3. Rehearse the complete sequence on a fresh duplicate; fix and restart when anything changes.
4. Repeat successfully from another fresh duplicate with identical artifacts.
5. Obtain explicit rollout approval and execute the production change window.
6. Observe V2, then perform the obsolete-column contraction as a separately approved change.

