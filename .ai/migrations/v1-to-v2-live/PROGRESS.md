# Migration progress

Updated: 2026-09-21

Overall status: **REHEARSED ON CLONE 1 — production window planned for 2026-09-21 evening (runbook `06-production-cutover.md`)**

This tracker records preparation and rollout evidence. It does not authorize production access or production writes.

## Gate board

| Gate | State | Exit evidence |
|---|---|---|
| G0 — target frozen | BLOCKED | V2 reviews/click-through complete; exact deploy SHA recorded; full test checks pass |
| G1 — inputs/access | PARTIAL (clone + local secret done; Vercel SHA and side-effect isolation pending) | exact Vercel SHA; fresh clone; dedicated local secret; side effects disabled |
| G2 — real baseline measured | DONE on clone 1 (`INVENTORY-2026-09-21.md`); repeat on the final clone | schema-only dump/diff and sanitized table/enum/index inventory |
| G3 — source data classified | DONE on clone 1; re-check on the final clone (`inventory/`, gates in `02-data-mapping.md` §9) | inventory report; zero unclassified legacy evidence; decisions approved |
| G4 — migration implemented | DONE (converter, wrapper, SQL, post-check; legacy layer removed) | prototype replaced/fixed; deterministic artifacts; safety guards; tests pass |
| G5 — rehearsal 1 | DONE on clone 1 2026-09-21, every gate green | full run from fresh clone; all verification green; timings recorded |
| G6 — rehearsal 2 | SKIPPED by Michal's timeline — replaced by the read-only pre-check + dry-runs inside the window | independent fresh-clone run with same artifacts and expected results |
| G7 — production approval | NOT STARTED | owner, window, communication, restore route and go/no-go sign-off |
| G8 — production rollout | NOT STARTED | exact runbook completed; smoke checks green; writes reopened deliberately |
| G9 — contraction | NOT STARTED | stabilization accepted; P-01..P-03 separately rehearsed and approved |

## Phase 0 checklist

- [ ] Finish remaining V2 implementation reviews.
- [ ] Complete owed phone and desktop human click-through.
- [ ] Resolve the draft broad exact-price rule and its missing amount/date/design cases.
- [ ] Promote approved mapping decisions into the active feature/context documentation.
- [ ] Remove the temporary legacy layer from the final target design/code.
- [ ] Freeze the exact target commit.
- [ ] Run and record the complete required check suite on the test endpoint.

## Inputs to obtain from Michal

- [ ] Exact commit SHA of the currently deployed Vercel production deployment.
- [ ] Confirmation that `origin/main` represents the intended V1 code baseline.
- [x] Fresh Neon branch created from live production (2026-09-21, `ep-dark-band-asjtba8q`, auto-delete 7 days).
- [x] Clone connection stored locally under a dedicated rehearsal-only environment name.
- [ ] Confirmation that the clone/preview cannot send real email, SMS or other external effects.
- [x] Named cennik recipients: **none** (Michal 2026-09-21, D-004).
- [x] Answers to D-003 Q2–Q5, Q7–Q9 (2026-09-21).
- [x] Q6 = (a), návrh implies Info (2026-09-21).
- [x] Q1: #628 Info + Cena 499 €, #98 no price, #404 689 € (2026-09-21).
- [x] Clone stored as `MIGRATION_REHEARSAL_DATABASE_URL` in `.env.migration`.
- [ ] People and time window for manual UI acceptance and final production approval.

## Evidence log

Add one row per material run. Never include secrets or customer PII.

| Date/time | Environment identity (sanitized) | Commit/artifact | Action | Result | Evidence path |
|---|---|---|---|---|---|
| 2026-09-21 | local files only | current working tree | Created rollout dossier | complete; no DB accessed | this directory |
| 2026-09-21 | local files only; V1 = `origin/main` 8e8b183 | working tree | Claude review: V1 writers read, mapping rev. 2, D-003 r2, D-007, D-008, `CHANGES-OVERVIEW.md` | complete; no DB accessed | `02-data-mapping.md`, `DECISIONS.md` |
| 2026-09-21 12:25 | clone `ep-dark-band-asjtba8q` / neondb, direct, READ ONLY tx | `inventory/*.mjs` | Inventory 1: identity + canary, schema diff, census, Round 1 simulation, send census | schema = V1 exactly; 0 Round 1 conflicts; 86 send leads → 88 sends; 3 per-lead decisions | `INVENTORY-2026-09-21.md` |
| 2026-09-21 16:20 | clone `ep-dark-band-asjtba8q`, direct | working tree (uncommitted) | Rehearsal 1: schema → team → Round 1 → sends → Chceli → post-check | all green: 116 deals, 88 sends, 129 requests, invariants hold | `06-production-cutover.md` §D numbers |

## Current blockers

1. ~~Production schema and data unknown~~ — measured on clone 1; must be re-measured on the final clone.
2. The target code/schema is not frozen.
3. ~~Prototype converter~~ — replaced by `prisma/backfill/2026-09-v1-sends.ts` (rehearsed).
4. ~~D-003 open questions~~ — all answered 2026-09-21; promote to `context/` with the converter.
5. ~~No rehearsal~~ — rehearsal 1 green. Remaining: Michal's click-through, commit/PR approval, the window itself.
6. ~~Round 1 aborts on V1 reset / outcome-correction data~~ — 0 cases on clone 1 (gate only).
7. ~~Wave 5 open-step dating~~ — 0 cases on clone 1 (gate only). Its `--apply` abort must still accept #916 (price, no send) as an approved no-op.
8. ~~V2 code uses the test-only legacy layer~~ — removed 2026-09-21. (was: V2 code still reads/writes the test-only legacy layer (`hadLegacySends`, `legacySendsReviewedAt`,
   `Design.legacySentAt` in `lib/domain/offers.ts`, `lib/domain/offerMutations.ts`, `lib/commands/offers.ts`,
   `lib/queries/pipeline/index.ts`); the release target must not contain it.)
9. ~~History shows each old send twice~~ — fixed 2026-09-21 (`migratedSourceIds`, see `context/progress-tracker.md`).

