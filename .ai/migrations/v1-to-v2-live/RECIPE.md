# RECIPE — migrate a V1 Zvonček database to V2 (for any AI or human operator)

Last full run: **2026-09-22 on `ep-fragrant-sunset-aswxy5xw`** (untouched V1 copy of live taken 2026-09-21 12:21).
Result: **ALL STEPS PASSED** (one verify bug fixed during the run, see step 7). Code: branch `feature/sales-rep`.
Decisions behind every step: `DECISIONS.md` (D-003 sends, D-009 "looks as if always V2"); spec `02-data-mapping.md`.

## Before you start

1. `.env.migration` (repo root, gitignored) holds connection strings; the tools read them, **never print or paste them**.
   - `MIGRATION_REHEARSAL_DATABASE_URL` — default target (for the production window: Production's **direct** string).
   - `MIGRATION_REHEARSAL_DATABASE_STD_URL` — a second clone (used for the 2026-09-22 run).
2. The target must be **V1** (an untouched copy of live, or live itself during the freeze).
3. For live: freeze first (nobody works), Neon → create branch `pre-v2-restore` from Production = the rollback.
4. Know the target's endpoint id (`ep-…`, the part after `@`, without `-pooler`).

## One command runs everything

```bash
bash .ai/migrations/v1-to-v2-live/tools/run-migration.sh <ENV_VAR_NAME> <endpoint-id> [--production-window]
```

- It runs steps 1–12 below in order, dry-run before every apply, and **stops at the first non-zero exit**.
- `--production-window` is required when the endpoint is live (`…m0xyun`); without it the tools refuse production.
- Resume after a fix: `FROM=7 bash … ` (every step is idempotent / repeatable).
- Every command inside goes through `tools/with-target.mjs --var <ENV_VAR_NAME> --expect <ep>` which injects the URL.

## Steps and the results of the 2026-09-22 run (use them as the expected numbers)

| # | What | Command (inside the runner) | Result 2026-09-22 |
|---|---|---|---|
| 1 | V2 schema (additive) | `prisma db execute --file sql/01-schema-v1-to-v2.sql` | Script executed successfully |
| 1b | schema diff | `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma` | only `sql/03` (drop FK `Lead_lockedById_fkey` + 6 `DROP COLUMN`) |
| 2 | routing team | `sql/02-obchod-team.sql` | team **Obchod**, leader michal, member timea |
| 3 | deals / call queues dry-run | `2026-09-assignments.ts --owner-username michal` | DEAL_TO_MIGRATE 116, CALLWORK_TO_MIGRATE 1282, POOL 334, TERMINAL_OK 1888, CONFLICT 0 |
| 4 | apply + verify | same `--apply --confirm <ep>`, `--verify` | COMMITTED; RESULT: clean |
| 5 | old sends dry-run | `2026-09-v1-sends.ts` | 88 sends / 86 leads, 0 blockers (7 same-day merges) |
| 6 | apply | `--apply --confirm <ep>` | APPLIED: 88 OFFER_SENT |
| 7 | verify | `--verify` | RESULT: clean (see fix below) |
| 8 | V2 normalization dry-run | `2026-09-v2-normalize.ts` | first calls 116, asks 116, ownership 116, closed steps 44, call-stage steps 75, price notes 22, audits 7, old sends 97; 0 blockers |
| 9 | apply | `--apply --confirm <ep>` | APPLIED: 116 deals; audits 7, sends 97, callStage 75 deleted/cleared |
| 10 | verify | `--verify` | all 10 checks 0 → RESULT: clean |
| 11 | drop dead V1 columns | `sql/03-drop-v1-columns.sql` | Script executed successfully |
| 12 | diff + post-check | `migrate diff`, `tools/post-check.ts` | "empty migration"; "all post-migration invariants hold" |

Post-check numbers: 3 626 leads (status counts unchanged), 88 OFFER_SENT, 116 "Chceli" rows — DESIGN 13 open / 11 sent /
14 withdrawn, INFO 2 open / 61 sent / 2 withdrawn, PRICE 10 sent / 3 withdrawn, all `origin LIVE`; summaries
about 86 / price 19 / design 12; open-deal steps unchanged (CALL 51, SEND_DESIGN 11, SEND_EMAIL 1, WAITING 4, CUSTOM 2);
price total 21 prices / 12 465 €.

## Fix made during the run

Step 7 first reported `CONFLICT #618`: after step 6 both návrhy of one email get the same `Design.sentAt`, so the
re-plan listed them in another order. `sameEvent` in `2026-09-v1-sends.ts` now compares design ids and sources as sets.
Data was never wrong. Resumed with `FROM=7`; everything passed.

## After the steps (live only)

1. Merge PR `feature/sales-rep` → `main`; Vercel deploys V2. No new env vars.
2. Log in as michal: Pipeline → "Na spracovanie", a few known deals, Volania → Priradenia (timea).
3. OK → team may work. Not OK → Vercel Instant Rollback to the previous deployment **and** Neon → Production →
   Restore from `pre-v2-restore`.
4. Put a non-production value back into `.env.migration`.

## If a step stops

Read the printed BLOCKER / FAIL line. Blockers are data patterns the rules do not cover — show them to Michal, do
not improvise SQL. Nothing after the failing step has run; steps before it are repeatable.
