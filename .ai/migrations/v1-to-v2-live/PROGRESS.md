# Migration progress

Updated: 2026-09-21

Overall status: **NOT READY — Phase 0**

This tracker records preparation and rollout evidence. It does not authorize production access or production writes.

## Gate board

| Gate | State | Exit evidence |
|---|---|---|
| G0 — target frozen | BLOCKED | V2 reviews/click-through complete; exact deploy SHA recorded; full test checks pass |
| G1 — inputs/access | NOT STARTED | exact Vercel SHA; fresh clone; dedicated local secret; side effects disabled |
| G2 — real baseline measured | NOT STARTED | schema-only dump/diff and sanitized table/enum/index inventory |
| G3 — source data classified | NOT STARTED | inventory report; zero unclassified legacy evidence; decisions approved |
| G4 — migration implemented | NOT STARTED | prototype replaced/fixed; deterministic artifacts; safety guards; tests pass |
| G5 — rehearsal 1 | NOT STARTED | full run from fresh clone; all verification green; timings recorded |
| G6 — rehearsal 2 | NOT STARTED | independent fresh-clone run with same artifacts and expected results |
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
- [ ] Fresh Neon branch created from live production, with creation timestamp recorded.
- [ ] Clone connection stored locally under a dedicated rehearsal-only environment name.
- [ ] Confirmation that the clone/preview cannot send real email, SMS or other external effects.
- [ ] Named cennik recipients, if any; default is none, never a cutoff guess.
- [ ] People and time window for manual UI acceptance and final production approval.

## Evidence log

Add one row per material run. Never include secrets or customer PII.

| Date/time | Environment identity (sanitized) | Commit/artifact | Action | Result | Evidence path |
|---|---|---|---|---|---|
| 2026-09-21 | local files only | current working tree | Created rollout dossier | complete; no DB accessed | this directory |

## Current blockers

1. The actual production schema and live-data combinations are unknown.
2. The target code/schema is not frozen.
3. The old-send converter is explicitly a prototype with known safety and correctness defects.
4. The new broad exact-price migration rule has unresolved missing amount/date cases.
5. No complete fresh-clone rehearsal has occurred.

