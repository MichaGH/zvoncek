# 06 — Production cutover (tonight's exact runbook)

Rehearsed end-to-end on clone 1 (`ep-dark-band-asjtba8q`) on 2026-09-21. Every step below passed there with the
numbers shown. Each step is run by Claude **only after Michal says "go" for that step** in chat. Any number that
differs from what is expected, or any blocker, means **STOP**: keep writes frozen and decide (rollback below).

Operator: Claude (commands). Decision owner: Michal (freeze, GO/NO-GO, rollback). Expected freeze: ~30 minutes.

## A. Before the window (can be done now)

- [ ] Michal clicked through V2 on the migrated clone (`http://localhost:3200`, preview "zvoncek-migrated-clone").
      Check the deals he knows: steps, "Klient dostal", "Chceli", history (each old send once, no label), #628, #98, #404,
      one návrh deal (#2365), the call queue for timea.
- [ ] Code reviewed and committed on the branch. Michal approves commit + push + the PR into `main`. **Do not merge yet.**
      Vercel production builds from `main`. Merging is the deploy.
- [ ] Vercel: note the current production deployment. It is the V1 rollback target ("Instant Rollback").
      V2 needs **no new environment variables** (only `DATABASE_URL`, `AUTH_SECRET`; Vercel sets `AUTH_TRUST_HOST`).
- [ ] Telesales / scouts told: no work in Zvonček from HH:MM for ~30 minutes.

## B. Freeze and restore point

1. Everyone stops using Zvonček. Michal confirms nobody is working (and closes his own tabs).
2. Neon → project → Branches → **Create branch** from `Production`, "current point in time", name
   `pre-v2-restore-2026-09-21`. This is the restore point. It stays untouched.
3. Neon → Production branch → **Connect** → *Connection pooling OFF* → copy the direct string. Replace the value
   in `.env.migration` with it (same variable name). Tell Claude only the endpoint id (`ep-…-m0xyun`).
   From here every command uses `--expect <that id> --production-window`. Below it is written as `$W`:
   `node .ai/migrations/v1-to-v2-live/tools/with-target.mjs --expect <ep> --production-window --`.

## C. Checks before writing (read-only)

4. `ALLOW_PRODUCTION_READ=1 EXPECT_ENDPOINT=<ep> node .ai/migrations/v1-to-v2-live/inventory/<script>` for
   `01-identity.mjs`, `02-schema.mjs`, `04-census.mjs`, `05-round1.mjs`, `06-sends.mjs` (read-only transactions).
   **Expect:** schema identical to V1; drift from clone 1 only as listed in `03-inventory-plan.md` "Expected
   drift" (new NEW leads, telesales first calls). **Any new send / price / design / reset / correction → STOP and
   show Michal.**

## D. Migration (same artifacts as the rehearsal)

Rehearsal 2 numbers are filled in after it runs on a fresh copy (see `PROGRESS.md`). Rehearsal 1 numbers in brackets.

| # | Command (`$W` prefix) | Expected | Stop if |
|---|---|---|---|
| 5 | `npx prisma db execute --file .ai/migrations/v1-to-v2-live/sql/01-schema-v1-to-v2.sql` | "Script executed successfully" | any error |
| 6 | `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` | exactly the 6 `DROP COLUMN` + 1 `DROP CONSTRAINT` of `sql/03` (they run last) | anything else |
| 7 | `npx prisma db execute --file .ai/migrations/v1-to-v2-live/sql/02-obchod-team.sql` | success | error (a user missing) |
| 8 | `npx tsx prisma/backfill/2026-09-assignments.ts --expect-endpoint <ep> --expect-db neondb --owner-username michal` | [116 deals, 1 282 call work, 334 pool, 1 888 terminal, 0 conflict] | CONFLICT / NEW_WITH_HISTORY / OUTCOME_CORRECTED |
| 9 | same + `--apply --confirm <ep>`, then same + `--verify` | "RESULT: clean" | not clean |
| 10 | `npx tsx prisma/backfill/2026-09-v1-sends.ts --expect-endpoint <ep>` | [88 sends / 86 leads, 0 blockers] | any BLOCKER |
| 11 | same + `--apply --confirm <ep>`, then same + `--verify` | "RESULT: clean" | not clean |
| 12 | `npx tsx prisma/backfill/2026-09-v2-normalize.ts --expect-endpoint <ep>` | 116 first calls, 116 asks, 116 ownership rows, 44 closed steps, 75 call-stage steps, 22 price notes, 7 audits, 97 old sends; 0 blockers | any BLOCKER |
| 13 | same + `--apply --confirm <ep>`, then same + `--verify` | "RESULT: clean" (every line 0) | any FAIL |
| 14 | `npx prisma db execute --file .ai/migrations/v1-to-v2-live/sql/03-drop-v1-columns.sql` then `migrate diff` (step 6 command) | success; diff **empty** | error / any statement |
| 15 | `npx tsx .ai/migrations/v1-to-v2-live/tools/post-check.ts` | "all post-migration invariants hold" | any FAIL |

`2026-09-wave5-requests.ts` is **no longer part of the route** (D-009: "Chceli" comes from the first call, not from
receipts). Numbers grow only by the expected drift.

## E. Deploy and reopen

15b. Merge the approved PR (`feature/sales-rep` → `main`) → Vercel builds V2 (≈2–3 min). Wait for "Ready".
16. Smoke test on the live URL (Michal, logged in as himself): Pipeline opens on "Na spracovanie" (open deals whose
    client still waits for návrh/info), #628 / #404 / #2365 detail, a call-queue page as timea is not possible → check
    `/dashboard/calls/assignments` shows timea's 1 280 contacts; one harmless write (e.g. change a note) succeeds.
17. **GO:** tell the team they can work. **NO-GO:** rollback below.
18. After GO: `.env.migration` back to a non-production value (or delete it); keep `pre-v2-restore-2026-09-21` for at
    least a week; record the run in `PROGRESS.md`; clear the applied rows in `context/domain/db-changes.md`.

## F. Rollback (only before writes reopen, or with Michal's explicit decision after)

- **Before step 5:** nothing changed. Unfreeze, V1 keeps running.
- **After step 5, before the deploy (V1 still deployed):** Neon → Production → **Restore** to the timestamp of
  `pre-v2-restore-2026-09-21` (or restore from that branch). V1 code is unchanged, so V1 works again. Unfreeze.
- **After the deploy:** Vercel → previous (V1) deployment → **Instant Rollback**, then the Neon restore as above.
  Any work done in V2 after reopening would be lost by the restore, so decide before reopening writes.

The dead V1 columns are dropped in step 14 (D-009: nothing V1-shaped stays). V1 cannot run on the database after
that step; rollback is the Neon restore point, as for every other step.
