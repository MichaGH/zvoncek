# Development–production database delta

Only schema and data changes **already applied and verified on the development database but not yet applied to
production** are listed here. This is the production-rollout checklist, not a place for unbuilt proposals or rejected
ideas. A proposed change belongs in the active feature design before any development application; once verified
there, add its exact delta here. After a successful production rollout, clear the applied delta and keep the file
ready for the next one.

The ledger answers two questions: what a rollout still owes, and whether all of it is **additive** compared with live
production.

**Baseline (cleared 2026-10-25).** The V1 → V2 rollout ran on production on 2026-09-22 (all steps passed:
`.ai/migrations/v1-to-v2-live/PROGRESS.md`, `RECIPE.md`) and the V2 code is deployed from `main` (PR #5). Every entry
that was listed here before was applied by that rollout and has been removed. Measured on 2026-10-25: the development
database (a copy of production taken 2026-10-24) gave an **empty** `migrate diff --from-config-datasource --to-schema
prisma/schema.prisma` against the schema of commit `5f9f06b` (= the production schema). Before any production push,
the live production schema is compared with the expected pre-state again (procedure step 5).

**Net delta, not history.** What counts is the difference between live production and the current development
schema. If a change is later reverted or replaced before rollout, only the end result matters. A change is
**non-additive** only when it removes, renames or retypes something **production already has**, or adds a required
column / constraint that existing production rows could violate.

**Non-additive changes owed to production:** none. Keep this line true: any non-additive entry must be listed here by
id, with its data plan, before it is applied on development.

## Environments

| Name | Neon endpoint | Role |
|---|---|---|
| development | `ep-divine-waterfall-asbkuort` | copy of production taken 2026-10-24 (real data); `DATABASE_URL` in `.env`. Listed changes are applied here. **Never wipe or reseed it** (`seedTestWorld.ts` is for the old test branch only) |
| old test branch | `…nhww8x` | used until 2026-09-22; no longer the development target |
| production | `ep-ancient-glitter-asm0xyun` | **never touched by a development session**; reached only in an approved rollout window through `.ai/migrations/v1-to-v2-live/tools/with-target.mjs` with a temporary `.env.migration` |

Full connection strings are never written into docs, logs or scripts. Database-touching backfill and concurrency
scripts verify the endpoint (`--expect-endpoint`) and refuse an unexpected target; pure rule checks need no endpoint.

`DEV` in the tables below means applied and verified on development, still owed to production. A production status is
not recorded here because the row is removed after rollout.

## Procedure

1. **Before development application:** put the proposal, data-safety plan and application order in the active feature
   design. Review the exact schema change and verify that `DATABASE_URL` points to the development endpoint.
2. Edit `prisma/schema.prisma`, review the generated SQL diff, then run `npx prisma generate` and apply on
   **development**. Never `--accept-data-loss` or `--force-reset`.
3. Prefer the reviewed path, and always use it when `db push` stops on a **data-loss warning**:
   ```bash
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o <file outside the repo>
   npx prisma db execute --file <that file>
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script   # must be empty
   ```
4. Verify the development schema and any backfill; then add only what actually changed to this file. Do not mark an
   unrun check as passed.
5. **Production:** separately approved rollout only, after a backup and restore-point Neon branch. Compare the live
   production schema with the expected pre-state; do not assume it matches a Git commit. Apply the reviewed diff and
   any data step in the order of the feature's rollout runbook.

---

## 1. Net schema delta: production → current development schema

### S-R1 — recycling (feature 02, `context/features/02-recycling/recycling-spec.md` §4.2) — DEV, additive

| Object | Change |
|---|---|
| `Lead.round` | `INTEGER NOT NULL DEFAULT 1` (constant default, no rewrite; every existing row becomes round 1) |
| `Lead.roundStartedAt` | `TIMESTAMP(3)`, nullable |
| `Lead.archiveOfId` | `TEXT`, nullable, FK → `Lead.id` `ON DELETE RESTRICT`, index `Lead_archiveOfId_idx` |
| `Lead.archivedById` | `TEXT`, nullable, FK → `User.id` `ON DELETE SET NULL` |

No `DROP`, no retype, no enum change. Applied on development 2026-10-25 (endpoint verified
`ep-divine-waterfall-asbkuort` / `neondb`): reviewed `migrate diff` SQL → `db execute` → second `migrate diff` empty.
Production script: `context/features/02-recycling/sql/01-recycling-schema.sql` (generated offline from the `main`
schema, same 7 statements). Rollout: `context/features/02-recycling/production-rollout.md` — schema before code.

## 2. Data steps owed to production

None.
