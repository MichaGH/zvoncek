# 04 — Migration build and test plan

Build against test and disposable fresh clones only. Production remains denied until a separately approved rollout.

## Deliverables

1. Frozen live-baseline -> final-target schema SQL, generated from measured schemas and reviewed statement by statement.
2. Read-only inventory/report command.
3. Validated decision/override input with one stable schema and no customer PII committed.
4. Corrected canonical old-send converter replacing the current prototype behaviour.
5. Reconciliation/verify command independent of the writer.
6. Existing Round 1 and Wave 5 backfills wired into the final order with strengthened endpoint guards.
7. Final contracted application code that uses canonical events only and does not require test-only legacy columns.
8. Explicit P-01..P-03 contraction SQL, kept separate from the initial rollout unless D-006 is rejected.
9. Machine-readable run summary: artifact hashes, counts, durations and pass/fail gates without secrets/PII.

## Writer requirements

- Dry-run by default; `--apply` requires direct host, exact expected endpoint/database and a separate confirmation.
- Production endpoint denylist cannot be defeated by passing that endpoint as the expected value.
- Deterministic per-source migration keys and database uniqueness prevent duplicates.
- Per-lead transaction uses the required Lead lock and re-reads expected source state.
- Interrupted apply is safely restartable; completed sources are verified, not broadly skipped per lead.
- Unknown actor remains unknown/migration-attributed.
- Historical client day lives in canonical metadata; database write time remains the recording time.
- Cross-field validation: PRICE has an amount; tracked DESIGN identifies the correct Design; contents/channel/date shape
  is canonical.
- Old raw activities, current price fields and tracker history are never rewritten.

## Automated tests

At minimum cover:

1. Every row of `02-data-mapping.md`, alone and in combinations.
2. Same email with several contents vs separate emails on the same day.
3. Matching and mismatching field/activity dates.
4. Missing amount/date/actor/design identity.
5. Undo and correction sequences.
6. Multiple quote sends, several Designs and deleted Designs.
7. Pre-deal, closed and soft-deleted leads.
8. Existing canonical events and partial earlier migration.
9. Interrupted rerun and complete rerun create no duplicates.
10. A changed source after inventory causes apply to stop, not silently use stale planning.
11. Summary/list/detail/filter parity, including untracked historical designs.
12. Wave 5 requests are created only after receipts and resolve to the correct activity.
13. Source coverage and target justification both reach 100%.
14. Unrelated tables/columns and tracker counts remain unchanged.
15. Safety tests: test endpoint accepted; wrong endpoint/database, pooler apply and production endpoint refused.

Run the repository's full required type, lint, build, business-time, client-section, concurrency, role/scope and
backfill checks after migration-specific tests. Record a failure as a failure; no unrun check passes.

## Review split

- Primary implementer owns code and artifacts.
- Independent reviewer receives the frozen mapping, measured schema diff, scripts and test evidence.
- Reviewer does not edit or run production; findings return to Phase 2, and material changes restart rehearsal.

