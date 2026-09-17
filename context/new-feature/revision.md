# Feature revision log

Feature: caller assignment, SALES_REP, `/dashboard/clients`, manager oversight.

Design baseline: `context/new-feature/planning.md` rev. 4; implementation record: `context/progress-tracker.md`.

Review date: 2026-09-17. This is an independent review of the implementation on the Neon **test** branch. No production rollout was attempted.

## Current decision

**Review of 2026-09-17 (original):** do not roll out yet; R-01 is a permission gap, R-02–R-05 need resolution.

**Update 2026-09-17 (implementation pass after the review):** R-01 through R-06 are **FIXED** on the test branch, each with a
regression test in `prisma/backfill/check-concurrency.ts`
(`--only r01CraftedInput,r02PipelineOrder,r03DetailScope,r04SearchPaging,r06RequestCount`). The review's three non-code
observations were addressed too: plan §11.3 row 5 now matches the script, the tracker's backfill delta count says 6, and team
"Obchod" (leader `t_michal`, member `t_timea`) exists on the test branch so the Timea → Michal → rep handoff can be clicked
through. Still open before rollout: a **human browser click-through** of the role screens, and the rehearsal + production
rollout of planning §14 (a separate, explicitly approved session).

Severity: **P1** = release blocker / data or permission integrity; **P2** = incorrect or incomplete workflow; **P3** = smaller plan/UI discrepancy. Status is `OPEN`, `FIXED`, or `ACCEPTED`.

## Findings

### R-01 — P1, FIXED — Sales rep contact edit accepts arbitrary Lead fields

**Evidence:** `lib/actions/clients/index.ts:38` exposes `updateClientContact(leadId, data)` as a server action. `lib/commands/clients.ts` checks ownership, but `lib/domain/dealMutations.ts:112-117` iterates over *every* runtime property of `input` and spreads that object into `tx.lead.update`. `DealContactInput` is only a TypeScript type; it does not strip extra properties received from a client. The manager version of the action uses the same body.

**Impact:** An owner can submit a crafted payload containing fields such as `status`, `ownerId`, `pipelineEnteredAt`, `deletedAt`, or Prisma relation updates alongside a contact field. That bypasses the dedicated status, ownership, close, and request rules. In particular, a SALES_REP can mark a deal WON without an ORDER confirmation or change its owner/stage. This is the most important authorization gap found; the normal form does not expose it, but UI hiding is not security.

**Required fix:** At the server boundary validate a strict runtime schema containing only `companyName`, `website`, `phone`, `email`, and `note`; construct the Prisma update from those five named fields only. Reject (or strip, with a test) unknown keys. Add a direct server-action/command regression test that submits forbidden fields and confirms the deal, owner, status, marker, requests, and revision remain unchanged. Check both pipeline and client entry points.

**Resolution / verification:** `lib/domain/dealMutations.ts` now validates every client-supplied object with a **strict** zod
schema inside the shared domain function, so the client and the pipeline entry point are both covered: `dealContactSchema`
(exactly `companyName`, `website`, `phone`, `email`, `note`), the quote input (`price`, `priceNote`) and `nextActionInputSchema`
(`kind`, `schedule`, `note`, `mode`). Unknown keys are rejected (`FORBIDDEN`, "Neplatné údaje."), and the Prisma update is built
from named fields only, so a relation payload such as `owner: { connect: … }` is refused as well. Regression test
`r01CraftedInput`: a crafted payload with `status`, `ownerId`, `pipelineEnteredAt`, `deletedAt`, `closedAt` (plus a relation
variant and an extra key on the next-action editor) is refused on both entry points; the deal's status, owner, marker, deletion,
`closedAt`, revision and request count are identical before and after; a legitimate contact edit still works. PASS.

### R-02 — P2, FIXED — Pipeline sorting happens after the page is truncated

**Evidence:** `lib/queries/pipeline/index.ts:189-209` orders the SQL result by `nextActionAt`, fetches only `take + 1`, slices to the current page, then sorts those rows in JavaScript. The `Požiadavky` view also sorts by oldest open request *after* truncation.

**Impact:** With more than 50 matching deals, the first screen need not contain the most urgent deals or the oldest manager requests. For example, an old request on a deal with `nextActionAt = null` can be excluded while 50 newer requests with dated next actions appear. “Oldest request first” in plan §8.1 is therefore not true globally. Increasing “Načítať ďalších” eventually reveals it but does not make the first page reliable.

**Required fix:** Apply the intended sort in the database **before** `LIMIT` (including the oldest OPEN request timestamp for the requests view), with a deterministic ID tie-breaker. Test with >50 deals where the oldest request / highest-priority next action would be outside the current SQL slice.

**Resolution / verification:** `getPipelineList` keeps the filters in Prisma (id-only query over the whole filtered set) and does
the **ordering and `LIMIT` in SQL** over that set, fetching full rows for the page only. `PIPELINE_RANK_SQL` mirrors
`nextActionSort` (0 urgent, including the 30-minute "soon" window and day-only comparison by business date in Europe/Bratislava;
1 in progress; 2 future; 3 dated-less step; 4 no step) with `nextActionAt ASC NULLS LAST, id` as tie-breaker; the requests view
orders by `min(createdAt)` of OPEN requests with the same tie-breaker. Regression test `r02PipelineOrder` (56 deals): an overdue
deal that the old `nextActionAt` slice excluded is now first on page 1; a deal with `nextActionAt = null` carrying the oldest
OPEN request is first in the requests view; a larger page repeats the same prefix without duplicates; and a parity check confirms
the SQL order matches `nextActionSort` over every deal in the database (0 inversions). PASS.

### R-03 — P2, FIXED — Client detail authorization and data fetch are separate queries

**Evidence:** `app/dashboard/clients/[id]/page.tsx:19-24` calls `requireDealView`, then `getClientDetail(id)`. The latter query in `lib/queries/clients/index.ts:205` filters by ID/deal marker/deletion but **not** by `ownerId` or viewer permission.

**Impact:** If a manager transfers a deal between those two queries, the former owner can receive the full detail response despite no longer owning it. Ordinary requests after transfer are denied, but this race weakens the strict “rep sees only own deals” guarantee.

**Required fix:** Make the detail-fetch query itself owner-scoped for non-managers (or combine guard and data read in one appropriately scoped query/transaction). Add a transfer-versus-read regression test or at least a direct query-scope test.

**Resolution / verification:** `getClientDetail(id, viewer)` carries the scope in the query itself: without `pipeline.view` it
filters `ownerId = viewer.id`, so the guard and the data read cannot disagree. Regression test `r03DetailScope`: the owner sees
the detail, after `changeOwner` the former owner gets `null`, and the new owner and the manager still see it. PASS.

### R-04 — P2, FIXED — Sales rep search silently stops at 100 matches

**Evidence:** `lib/queries/clients/index.ts:144-153` searches all of the rep's deals with `take: 100` and returns only `results`. `app/dashboard/clients/page.tsx` offers no next page in search mode. The archive has pagination, but the general search does not.

**Impact:** A rep with more than 100 matching open/recent/archived deals cannot reach older matches through search, contrary to plan §7.3 (“search all of the rep's deals”). A broad company/website query makes this plausible as the database grows.

**Required fix:** Add deterministic pagination or a “load more” cursor/limit for search mode, retaining the ownership filter and the query across pages. Test at least 101 matches.

**Resolution / verification:** Search mode is paginated (`SEARCH_PAGE = 50`, `take + 1`, deterministic `updatedAt desc, id asc`,
`hasMore`) and `/dashboard/clients` renders "Načítať ďalších 50" with the query preserved; the ownership filter is unchanged.
Regression test `r04SearchPaging` with 101 matches: first page 50 with `hasMore`, a larger page returns all 101 with the same
prefix and no duplicates. PASS.

### R-05 — P3, FIXED — Sales rep detail exposes design version numbers

**Evidence:** Plan §7.7 specifies design information for the rep as read-only status and confidence, with **no versions**. `lib/queries/clients/index.ts:299` returns `currentVersion`, and `components/clients/ClientDetail.tsx:286` renders `v{d.version}`.

**Impact:** A small product/visibility deviation. The rep does not receive tracker tokens, URLs or IPs, but sees technical version numbers that the approved screen design excluded.

**Required fix:** Remove the version from the rep-facing result and UI, unless Michal explicitly changes the design decision.

**Resolution / verification:** The version is gone from the rep-facing query result and from `ClientDetail.tsx`; the rep sees
label, sent state and the confidence summary only. Asserted in `r03DetailScope` (no `version` key in the returned designs). PASS.

### R-06 — P3, FIXED — Manager inbox title undercounts after 50 requests

**Evidence:** `lib/queries/today/manager.ts:18-24` fetches at most 50 OPEN requests; `app/dashboard/page.tsx:75` uses `manager.requests.length` as the title count. The card intentionally displays only the first 10, but the title implies a total.

**Impact:** At 51+ open requests it reports “Čaká na mňa (50)” rather than the actual total. The list is oldest-first, so this is a count/visibility issue, not a lost request.

**Required fix:** Count OPEN requests separately with the same scope, and keep a bounded preview query. Test >50 requests.

**Resolution / verification:** `getManagerToday` returns `requestCount` from a separate `count` with the same scope and keeps a
bounded preview (`take: 10`, `createdAt asc, id asc`); the dashboard title uses `requestCount`. Regression test `r06RequestCount`
with 51+ open requests: the title count equals the database count and the preview stays at 10. PASS.

## Release/readiness observations (not confirmed code defects)

- The backfill verification on the test endpoint reported **zero conflicts and zero pending changes**, but also warned that `t_timea`, `t_tereza`, and `telesales` currently have no routable team leader. Their real test-account positive calls will become **unassigned** until the “Obchod” team/leader/membership setup is done. The fixture-based routing race test passed; a human should also click through the configured Timea → Michal → rep handoff on the test branch before rollout.
- `context/progress-tracker.md` records an intentional backfill deviation: `CALLWORK_OK` accepts reverted queue calls so a reverted first call remains a retry. This is logically consistent with the plan's acceptance checklist but §11.3 row 5 still says “non-reverted”. Reconcile the plan text before production rehearsal so the documented migration rule matches the script.
- The progress tracker says the backfill delta suite was `7/7`; its current run printed **six** PASS checks. The suite passed, but the tracker count should be corrected when updating implementation status.
- The accepted limitations in the tracker remain: role changes require re-login because the route guard uses JWT claims; the statistics redesign is later; the login page still links to disabled signup. None of these was silently treated as a new blocker here.
- A normal browser click-through of all role screens was **not** independently completed in this review. The previous implementation record reports 31 HTTP role checks, but those are not equivalent to checking drawer/form usability in two browsers.

## Independent checks run in this review

Target identity was checked before database-connected tests: Neon test endpoint `ep-curly-field-asnhww8x`, database `neondb`, distinct from the production endpoint recorded in the progress tracker. Test scripts created and removed their own fixtures. After the tests, backfill `--verify` was clean: 253 non-deleted leads; `DEAL_OK 57`, `CALLWORK_OK 65`, `POOL 59`, `TERMINAL_OK 72`; `CONFLICT 0`, `ANCHOR_PENDING 0`, invariant violations 0, would change 0 rows.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS |
| Business-time self-check (Bratislava and `TZ=UTC`) | PASS, 33/33 each |
| Client section self-check | PASS, 19/19 including 4,200 combinations |
| Concurrency suite on test branch, `--iterations 100` | PASS, 48/48 (claims, stale tabs, idempotency, revert, requests, transfer, deactivation, handoff races) |
| Backfill delta suite on test branch | PASS, all 6 reported checks (dry-run, apply to disposable fixtures, conflict rollback, cleanup) |
| Backfill `--verify` after suites | PASS, clean |
| `npx eslint .` | FAIL: one known pre-existing `react-hooks/set-state-in-effect` error in `components/layout/MobileNav.tsx:17` |

These passing tests do **not** cover R-01's crafted action input, global ordering beyond the first page, >100 search results, or the client-detail transfer/read race. Add those regression tests with the fixes.

## Resolution history

| Date | Finding | Change made | Verification | Status |
|---|---|---|---|---|
| 2026-09-17 | R-01–R-06 opened | Review only; no application code changed | Checks above | OPEN |
| 2026-09-17 | R-01 | Strict zod validation of contact / quote / next-action input in `lib/domain/dealMutations.ts`; Prisma update built from named fields only | `r01CraftedInput` | FIXED |
| 2026-09-17 | R-02 | Ordering + `LIMIT` moved into SQL over the whole filtered set (`PIPELINE_RANK_SQL`, request-age order, `id` tie-breaker) | `r02PipelineOrder`, incl. parity with `nextActionSort` | FIXED |
| 2026-09-17 | R-03 | `getClientDetail(id, viewer)` owner-scoped in the query for non-managers | `r03DetailScope` | FIXED |
| 2026-09-17 | R-04 | Paginated client search (`SEARCH_PAGE`, `hasMore`, "Načítať ďalších") | `r04SearchPaging` | FIXED |
| 2026-09-17 | R-05 | Design version removed from the rep query and detail UI | `r03DetailScope` | FIXED |
| 2026-09-17 | R-06 | Separate `requestCount` with bounded preview | `r06RequestCount` | FIXED |
| 2026-09-17 | Observations | Plan §11.3 row 5 reconciled with the script; tracker delta count corrected to 6; team "Obchod" created on the test branch | Backfill `--verify` clean; suites re-run | DONE |
