# 06 — Production cutover plan

**NOT AUTHORIZED.** This becomes executable only after two clean fresh-clone rehearsals, a frozen commit/artifact set,
an approved maintenance window and explicit go/no-go approval.

## Preferred strategy

Migrate the current live database during a short write freeze while retaining a verified Neon restore point. This
avoids losing V1 writes made after an earlier clone and avoids changing the database connection URL. A final-branch
switch is acceptable only if the branch is created after writes freeze and the switch/redeploy/rollback procedure was
rehearsed exactly.

## Pre-window

- [ ] Record operator, verifier, decision owner and communication channel.
- [ ] Record exact source deployment SHA, target SHA and artifact hashes.
- [ ] Confirm no new code/schema/mapping change since rehearsal 2.
- [ ] Confirm Neon restore retention, restore procedure and expected connection interruption.
- [ ] Confirm Vercel deploy/rollback artifacts and environment values without printing secrets.
- [ ] Announce maintenance/write freeze and expected duration.
- [ ] Define hard abort time, maximum migration duration and who may declare rollback.

## Window sequence

1. Keep V1 available only until the announced freeze begins.
2. Freeze every CRM write path; ensure no old deployment or background process can still write.
3. Wait for in-flight requests/transactions to finish and verify database write quietness.
4. Create and verify the final pre-migration restore-point branch.
5. Re-read production schema and inventory. Compare to rehearsal source hashes/counts; **abort on unexplained drift**.
6. Run the same frozen sequence and artifacts as rehearsal:
   - additive schema;
   - routing team;
   - Round 1 backfill;
   - canonical send conversion and independent reconciliation;
   - Wave 5 request backfill and reconciliation.
7. Deploy the exact frozen V2 application. Do not reopen writes yet.
8. Run the critical automated verifies and focused smoke tests from `07-verification.md`.
9. Decision owner reviews the final summary and explicitly chooses GO or rollback.
10. On GO, reopen writes deliberately and monitor first real actions.

If D-006 is approved, P-01..P-03 are **not dropped in this initial window**. They remain unused/read-only until a
separate stabilization and contraction release. If the decision changes, this runbook and rollback plan require new
review and two new rehearsals.

## First-hour monitoring

- login and permission failures;
- database/application errors and latency;
- calls claim/handoff and one reversible test workflow;
- pipeline scopes and counts;
- `Pre mna`, manager waiting tasks and ownership history;
- `Chceli` vs `Klient dostal` on migrated and newly changed deals;
- new `OFFER_SENT` and request rows use live—not migrated—provenance;
- no writes to frozen legacy columns.

Record the production result in authoritative `context/domain/db-changes.md`: remove applied delta entries only after
verification. Record application check results in `context/progress-tracker.md`. This dossier retains the process
evidence and sanitized run summary.

