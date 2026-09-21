# 05 — Fresh-clone rehearsal runbook

This is a gated plan, not a command sheet. Exact commands and artifact hashes are inserted only after Phase 2 is built
and reviewed. Any material change restarts the rehearsal from a fresh clone.

## Before the clock starts

- [ ] Target commit and every migration artifact are frozen and hashed.
- [ ] Mapping/exception decisions are approved and reflected in authoritative context.
- [ ] Full checks pass on test.
- [ ] Fresh branch was created from current production and is clearly identified as rehearsal.
- [ ] Connection is stored in the dedicated rehearsal environment; production endpoint is independently denied.
- [ ] External side effects are disabled.
- [ ] Sensitive report directory exists outside the repository.

## R1 — baseline

1. Verify sanitized endpoint/database/branch identity.
2. Capture row counts and integrity baselines for all app tables.
3. Extract the schema and compare it with the previously measured source schema.
4. Run the inventory and compare normalized manifest hash/counts with the approved plan.
5. **STOP** on any drift, unresolved evidence or new exception.

## R2 — additive schema

1. Review the exact source -> final-target SQL again.
2. Apply enum additions before anything writes those values.
3. Apply tables, nullable/defaulted columns, FKs and indexes. Review locks on existing `Lead` and `Activity` indexes;
   use the approved concurrent/window strategy.
4. Do not add test-only legacy columns and do not run historical test-only task conversion.
5. Confirm a fresh schema diff is empty and Prisma reports the database in sync without accepting data loss.

## R3 — structural data backfills

1. Create/verify routing team `Obchod` and leader mapping exactly once.
2. Run Round 1 assignment backfill dry-run.
3. Review counts/exceptions; apply; verify zero drift.
4. Re-run dry-run/verify to prove idempotency.

## R4 — canonical old sends

1. Run the final converter in dry-run and compare manifest hash with R1.
2. Require zero unresolved exceptions and 100% source coverage.
3. Apply canonical events.
4. Run the independent reconciliation in `07-verification.md`.
5. Run apply/dry-run again and prove zero additional rows.
6. **STOP before later steps** on any mismatch; retain old fields and diagnose on the disposable clone.

## R5 — request ledger and derived state

1. Run Wave 5 request backfill only after R4 is fully green.
2. Dry-run -> review -> apply -> verify -> rerun.
3. Recompute/verify offer summaries and request reconciliation using final application logic.
4. Confirm already-received content is `SENT`, not false open work; open historical send steps remain `OPEN` only when
   no matching canonical receipt exists.

## R6 — application verification

1. Deploy the exact frozen V2 commit against the migrated clone.
2. Run automated migration, full repository, role/scope and HTTP checks.
3. Perform the defined manager/sales-rep desktop and phone acceptance set.
4. Compare list counts with detail results and direct reconciliation queries.
5. Exercise a small set of new V2 writes on the clone, then rerun integrity checks.

## R7 — recovery and contraction rehearsal

1. Rehearse the restore/switch procedure from the pre-migration restore point and record its duration.
2. Return to a freshly migrated clone.
3. If contraction remains a separate release, prove V2 runs while P-01..P-03 remain unused and stop here.
4. Separately rehearse the explicit contraction SQL; prove no application query reads dropped columns.
5. Run the full schema and application verification again.

## Rehearsal acceptance

A rehearsal passes only when every gate is green without ad-hoc SQL or data edits. Record start/end times, artifact
hashes, source and target schema hashes, counts and human sign-off in `PROGRESS.md`.

Repeat from a second fresh clone. A second run that uses repaired scripts is rehearsal 1 again, not rehearsal 2.

