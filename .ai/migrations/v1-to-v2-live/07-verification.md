# 07 — Verification and reconciliation

Verification is independent of the migration writer wherever practical. Success requires per-source coverage,
per-target justification, aggregate invariants, application parity and human acceptance.

## Schema

- Actual final schema equals the frozen Prisma target and reviewed SQL result.
- No unexpected table/column/enum/index/FK difference remains.
- Test-only `Lead.hadLegacySends`, `Lead.legacySendsReviewedAt` and `Design.legacySentAt` are absent from the final target.
- Before separate contraction, P-01..P-03 exist but final V2 code does not read/write them; after contraction they are
  absent.

## Per-source and per-event

- Every legacy field/activity/design signal is covered exactly once by a canonical event or approved no-op.
- Every canonical migrated event points back to its complete source set and approved rule.
- No duplicate deterministic migration key exists.
- Every `PRICE` has the approved amount snapshot and amount source.
- Every grouped event contains exactly the contents of one actual/inferred email.
- Actor, channel, business date, original timestamp and inference confidence are represented honestly.
- Historical source activities remain unchanged and are not double-presented to users as separate sends.

## Per lead

- Canonical events produce the expected `offerAboutUsAt`, `offerPricelistAt`, `offerPriceAt`, `offerReviewAt`,
  `Lead.designSentAt` and `Design.sentAt` summaries.
- Current `Lead.price` and `priceNote` are byte/value equivalent to pre-migration state.
- `LeadRequest` rows reflect canonical receipts and open send steps, with correct origin, links and migration keys.
- List, detail, filters and visible `Chceli`/`Klient dostal` agree.
- Closed/deleted/pre-deal records do not disappear from coverage.

## Aggregate invariants

- Source coverage = total eligible sources; unclassified = 0.
- Planned targets = written targets = justified targets.
- Second apply creates 0 rows and changes 0 existing target facts.
- Counts/hashes for users, contacts, old activities, designs, design versions, trackers and tracker events are unchanged
  except for explicitly listed target additions.
- Current price distribution and totals are unchanged.
- Migrated rows are excluded from live demand/experiment statistics as designed.
- Every request linked to a receipt references the correct lead and valid canonical activity.

## Application smoke set

At minimum inspect and exercise:

1. ADMIN, MANAGER, SALES_REP, TELESALES, SCOUT_LEADER and SCOUT access boundaries.
2. Call queue claim, first-call positive handoff and revert.
3. Pipeline own/all scope, filters, counters and one migrated deal of every source combination.
4. `Pre mna`, `Cakam na manazera`, multi-part task, partial delivery and send.
5. Ownership change/takeover/history.
6. Correct and cross out an offer; recomputation and request reconciliation remain correct.
7. A tracked Design and a historical untracked proposal.
8. One new normal V2 receipt and one new request; neither is labelled migrated.

## Final evidence bundle

- source and target schema hashes/diffs;
- source census and normalized plan counts;
- exception decisions and zero-unresolved assertion;
- writer and independent verifier summaries;
- idempotent rerun evidence;
- automated check results and durations;
- human acceptance checklist;
- restore rehearsal result;
- sanitized GO/NO-GO summary.

Sensitive manifests remain outside the repository. Store only their path, hash and aggregate counts here/under
`PROGRESS.md`.

