# 08 — Rollback and abort plan

Rollback is rehearsed before production. A backup existing somewhere is not a rollback plan.

## Abort before any write

Abort when endpoint/database/branch identity, deployed commit, actual schema, inventory hash or source counts do not
match the approved rehearsal. Nothing needs restoring because nothing changed.

## Abort after additive schema, before conversion

Keep writes frozen. Additive objects may remain temporarily, but do not improvise cleanup. Decide whether to redeploy
V1 and reopen only after proving V1 is compatible with the applied additions. Record the partial state and rehearse the
next attempt from a fresh clone.

## Abort during restartable data steps

Keep writes frozen. Do not manually delete partial rows. Use deterministic keys and independent verification to
determine completed sources, fix the cause outside production, and either safely rerun the frozen artifact or restore.
Only a pre-approved decision owner chooses between those paths.

## Failure before writes reopen

Preferred recovery is the rehearsed Neon restore/switch to the verified pre-migration restore point, followed by the
exact V1 deployment. Verify schema, row counts and a V1 smoke set before reopening. Because writes remained frozen,
the restore should not discard legitimate post-snapshot CRM changes.

## Failure after V2 writes reopen

This is materially harder: restoring the pre-migration snapshot would lose legitimate V2-period writes. Therefore:

1. Stop writes immediately and record the incident time.
2. Preserve the affected database branch; do not overwrite it.
3. Inventory V2-period changes using activity IDs/timestamps/revisions and external logs.
4. Choose between a forward fix and snapshot restore plus explicit replay/reconciliation of those writes.
5. Never point V1 at a database whose old columns became stale after V2 writes unless a rehearsed compatibility/replay
   process has restored their required semantics.

This is why production writes reopen only after full smoke verification and why D-006 recommends delaying contraction.

## Mandatory rollback rehearsal evidence

- exact restore point used and branch identities;
- observed connection interruption and recovery time;
- V1 deployment recovery procedure and duration;
- schema and row-count verification after restore;
- proof no rehearsal-period data was expected to survive;
- named rollback decision owner and hard time limit.

## Contraction rollback

Dropping P-01..P-03 is a separate non-additive change. Before it:

- take a new restore point;
- export/hash those columns and coverage provenance;
- prove V2 does not query them;
- define how any post-drop writes would be preserved if restore were needed.

Do not use re-adding empty columns as a rollback; it does not restore their historical values.

