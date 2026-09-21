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

## D. Migration

One command, exactly as rehearsed (steps, expected numbers and resume rules: `RECIPE.md`):

```bash
bash .ai/migrations/v1-to-v2-live/tools/run-migration.sh MIGRATION_REHEARSAL_DATABASE_URL <ep> --production-window
```

It stops at the first failure, including a schema diff that differs from the reviewed SQL.

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
