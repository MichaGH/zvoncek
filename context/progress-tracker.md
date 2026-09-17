In this file progress of feature implementation is tracked. Should contain

- features we are currently working on, or even its individual stages
- feature that have been finished (dont go back in history to add old progress)
- To do problems and stages

---

# Feature: caller assignment, SALES_REP, /dashboard/clients, manager oversight

Source of truth: `context/new-feature/planning.md` (rev. 4). Phases = plan §13.

Database used for development: Neon **test** endpoint `…nhww8x` (verified 2026-09-17: not the production endpoint `…m0xyun`,
which is commented out in `.env`). Production is never touched in this work.

Baseline before any change (2026-09-17): `npx tsc --noEmit` clean; `npx eslint .` 4 errors + 1 warning, all pre-existing
(`CallDrawer.tsx` unescaped quote, `MobileNav.tsx` setState in effect, `PipelineDetail.tsx` unused `clearNextAction` + unescaped
quote, `PipelineViewTabs.tsx` component created during render).

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Schema, dictionaries, permission matrix, revision helper, business calendar | DONE |
| 2 | Access helpers, locking utilities, `requireUser` migration, lastLoginAt fix | DONE (calls/pipeline/tracking actions migrate with their rewrites in 4–5) |
| 3 | Backfill script + run on test DB | DONE |
| 4 | Calls: claim, personal board, logCall, revert, history, scout lock, teams locking, contacts/new | DONE |
| 5 | Pipeline hardening, dealMutations, requests, bulk deal transfer | DONE |
| 6 | Clients page, drawer, detail, client actions | DONE (browser click-through pending, see phase 9) |
| 7 | Dashboards, time-zone fixes, assignments tool, deactivation serialization | DONE |
| 8 | Gate greps | DONE |
| 9 | Concurrency scripts | DONE |
| 10 | Rehearsal on fresh production branch | NOT IN SCOPE (separate approved session) |
| 11 | Production rollout | NOT IN SCOPE (separate approved session) |
| 12 | Docs (app-workflow, AGENTS.md, this tracker) | DONE |
| 13 | Independent review `context/new-feature/revision.md` (R-01…R-06) fixed + regression tests | DONE |

## Open items / waiting for the approved production session

- Production: rehearsal on a fresh production branch (§13 phase 10), then §14 (backup, restore-point branch, team "Obchod"
  Michal + Timea, identity → reviewed diff → **`db execute` of the diff because `db push` stops on the idempotencyKey unique-index
  warning** → generate → backfill dry-run/apply → deploy → backfill again → verify).
- Plan deviations to review: SALES_REP gets a *redirect* (JWT route guard) instead of a 404 on `/dashboard/pipeline/<id>`; statistics still use server-local days (§9 "later");
  deactivated users are sent to `/login?deactivated=1` (needed to avoid a redirect loop with a still-valid JWT).
- Not done / not in plan scope: stats redesign (follow-ups, handoffs per caller, excluding reverted calls); Slovak holidays in
  "next working day"; the login page still links to the disabled `/signup`; pre-existing lint error in `MobileNav.tsx`.
- Manual browser click-through by a human is still recommended (agent verified pages over HTTP with signed sessions, not by
  clicking through the UI).
- Test DB now also contains `t_rep` (SALES_REP) with 3 own deals, 1 retry, 6 uncalled batch contacts and
  1 open PRICE request.

## Log

- 2026-09-17: read plan, workflow doc, AGENTS.md and all affected code; verified test DB.
- 2026-09-17 phase 1 DONE:
  - `prisma/schema.prisma`: additive changes of plan §3 (Role SALES_REP, CallOutcome WANTS_TO_ORDER, ActivitySource CLIENTS,
    6 ActivityTypes, Lead assignment/deal/revision fields + 4 indexes, Activity idempotency/revert fields, DealRequest model).
  - Test DB: `migrate diff` reviewed (only CREATE TYPE / ADD VALUE / CREATE TABLE / ADD COLUMN / CREATE INDEX / ADD FK).
    **`db push` refused** with a data-loss *warning* for the new unique index on the new all-NULL column
    `Activity.idempotencyKey` (cannot actually fail). `--accept-data-loss` is forbidden, so the reviewed diff was applied with
    `prisma db execute --file <diff>` and `db push` then reported "already in sync". **The production rollout (§12/§14 step 4)
    will hit the same warning – use the same reviewed-diff + `db execute` path there (needs Michal's approval).**
  - `lib/dictionaries.ts` labels + `ROLES` (with runtime assertion) + request labels; stats `OUTCOME_ORDER`/`GOOD`.
  - `lib/permissions.ts` matrix §6.3 + route guard (`/dashboard/calls/assignments`, `/dashboard/clients`, `/dashboard/contacts/new`).
  - New: `lib/domain/businessTime.ts`, `lib/domain/schedule.ts`, `lib/domain/revision.ts`, `lib/domain/callAssignment.ts`,
    `prisma/backfill/check-business-time.ts` (passes in Bratislava and `TZ=UTC` processes).
- 2026-09-17 phase 2 DONE:
  - New `lib/access/errors.ts` (codes, `AccessError`, RETRYABLE detection), `lib/access/user.ts` (`requireUser`),
    `lib/access/locks.ts` (`withLockTx` with `lock_timeout`, `lockUsers`, `lockTeams`, `lockLeadRow`),
    `lib/access/leads.ts` (`lockLeadWithUsers` with assignee lock, `requireCallLead`, `requireDealWork` + closedPolicy,
    `requireDealManage`, `requireDealView`).
  - `requireUser` on every dashboard page, admin/teams/contacts actions, Header nav (+ `hideIf`). `auth.ts` lastLoginAt fixed.
  - Deleted dead `signup` action and `components/layout/SignUpForm.tsx` (the /signup page already redirects; the login page's
    "Zaregistruj sa" link was left as is – out of scope).
- 2026-09-17 phase 3 DONE: `prisma/backfill/2026-09-assignments.ts` (dry-run default, identity flags, direct host + --confirm for
  apply, exclusive classes with multi-match assertion, set-based updates with guards + count checks, anchor pass, post-apply
  re-classification + invariants, all in one transaction).
  - **Deviation from §11.3 row 5 (documented in the script):** CALLWORK_OK accepts *any* CALL_QUEUE call (also reverted).
    Otherwise a lead whose only call was reverted (CALLING RETRY, assigned) would be CONFLICT, contradicting §15
    ("a later backfill run classifies it as call work").
  - Test DB run (owner `t_michal`): dry-run 0 CONFLICT → apply DEAL_TO_MIGRATE 54, CALLWORK_TO_MIGRATE 63, NEW_WITH_HISTORY 1,
    anchors 129 → second run clean (DEAL_OK 54, CALLWORK_OK 64, POOL 63, TERMINAL_OK 72, ANCHOR_PENDING 0, invariants 0).
- 2026-09-17 phase 4 DONE:
  - Transaction logic lives in plain modules `lib/commands/{calls,claims,history}.ts` (functions `…As(user, …)`); the
    `"use server"` files only do `requireUser` + revalidate. Reason: server-action files export callable endpoints (a helper
    exported there would be public), and the concurrency scripts must run the exact same code outside Next.
  - `claimBatch` (User FOR UPDATE, SKIP LOCKED pool), personal board + pool count + authenticated retry pagination,
    `logCall` rewrite (Schedule input, note inside, idempotency incl. parallel same-key replay, Team→User→Lead locks, routing,
    handoff marker = CALL createdAt, single bump, `leadRevision` bookkeeping, DESIGN request), `revertCallResult`, scoped
    `updateLeadContact`, history scope/flags/reverted badge, `CallDrawer`/`CallQueue` (claim button, recipient preview + actual
    recipient toast, error codes, retry with same key), scout lock under row lock, team actions Team→User locking + routing
    hint, `/dashboard/contacts/new` (pool count, back link, generic duplicate message).
  - Deleted: `calls-pagination.ts`/`getMoreNew`, `updateLeadNote`, `resetLeadToCalls`, `correctOutcome`, `editActivityNote`.
  - New pure/domain: `lib/domain/{dealRouting,dealRequests,idempotency}.ts`, `leadFlow.ts` rewritten (+ `dealStateForFollowUp`).
  - `prisma/backfill/check-concurrency.ts` (fixtures `cc_*`/“CC-TEST”, removed after each run): claims, stale tabs,
    idempotency (sequential/parallel/conflict), revert (immediate, double, after edit), handoff routing + revert, scope – all PASS.
    Bug found and fixed by it: parallel submit with the same key returned STALE instead of replaying success.
- 2026-09-17 phase 5 DONE:
  - `lib/domain/dealMutations.ts` (shared bodies, request rules §7.6 inside, +7-day follow-ups on the business calendar,
    close/reopen rules, status restricted to deal statuses, one revision bump per transaction guarded by `isLeadBumped`).
  - `lib/commands/pipeline.ts` (requireDealManage for every command, owner target locked FOR SHARE, `resolveDealRequestAs`
    with DONE-only-for-OTHER + reason-required decline, `transferDealsAs` bounded 200-row SKIP LOCKED loop with RETURNING
    and audit only for moved ids), `lib/commands/tracking.ts` (design guards through design.leadId, DESIGN request DONE on
    "sent"), thin `lib/actions/{pipeline,tracking}` wrappers, `canManagePipeline` removed.
  - Pipeline UI: deal-only list (no NEW/deleted), tabs without "Nové", owner filter "Rieši", "Požiadavky" view with count,
    unassigned banner, request badges, "Presunúť obchody" dialog, detail with requests card (per-kind completing action,
    decline with reason), shared `components/deals/NextActionEditor.tsx` (expectedRevision), reopen, owner options =
    active `deals.receive` users, business-TZ date text. `lib/overdue.ts` switched to business-day comparisons.
  - Checks added and passing: requests (dedupe + append, DONE rules, decline reason, PRICE/EMAIL/DESIGN/ORDER/REOPEN
    completion, close leaves no OPEN), closed deal read-only for rep, owner kept on manager price, deal scope, follow-up vs
    bulk transfer race (20×), revision exactly-once across 15 commands.
  - Lint now: only the pre-existing `MobileNav.tsx` error (the other baseline problems disappeared with rewritten files).
- 2026-09-17 phase 6 DONE: `lib/domain/clientSections.ts` (+ `prisma/backfill/check-client-sections.ts`, 19 checks incl.
  totality over 4 200 combinations), `lib/queries/clients`, `lib/commands/clients.ts` + thin actions, `/dashboard/clients`
  (sections, chips, search, archive), `ClientDrawer`, `/dashboard/clients/[id]` (shared next-action editor and price card).
- 2026-09-17 phase 7 DONE: scoped dashboard (`lib/queries/today/{index,manager}.ts`), contacts filters "Volá" / "Rieši obchod",
  pool-based counts, stats pool by `assignedCallerId`, business-TZ date text, `/dashboard/calls/assignments`
  (`lib/commands/assignments.ts`), deactivation / role change serialization (`lib/commands/admin.ts`), remaining-work card on
  user detail, team commands split (`lib/commands/teams.ts`), `/login?deactivated=1` escape from the JWT redirect loop.
- 2026-09-17 phase 8 DONE (gates): lead mutations only through locking helpers; no `session.user` into `can`; `SKIP LOCKED`
  only in claim + bulk deal transfer; Team→User order in team commands; DONE-only-for-OTHER; signup removed; `ROLES` asserted.
  Remaining local-day logic only in the stats module (out of scope).
- 2026-09-17 phase 9 DONE – results on the test DB:
  - `check-business-time.ts` 33/33 (Bratislava process) and 33/33 (`TZ=UTC`); `check-client-sections.ts` 19/19
  - `check-concurrency.ts --iterations 100`: 48/48 (claims 2×20, stale tabs 30×, idempotency, revert, handoff routing,
    requests, deal scope, follow-up vs bulk deal transfer 20×, revision exactly-once, claim vs deactivation 100×, deactivation
    vs in-flight rolled-back call 100×, deactivation past lock_timeout, transfer-then-revert, 1 050 retries bulk transfer,
    NEW capacity, handoff vs setTeamLeader 100×, deleteTeam vs handoffs)
  - `check-backfill-delta.ts`: 6/6 (old-code deltas migrate exactly once, CONFLICT aborts + rolls back, fixtures removed)
  - backfill `--verify` after all runs: clean
  - `next build` OK; HTTP role checks with locally signed sessions against `next dev`: 31/31 (script kept outside the repo)
- 2026-09-17 phase 12 DONE: `context/app-workflow.md` rewritten ([PLANNED] removed, [ROLLOUT] where production still needs the
  migration), `AGENTS.md` updated (roles, routes, architecture, concurrency rules, DB rules, checks).
- 2026-09-17 revision pass (`context/new-feature/revision.md`, independent review by ChatGPT Codex) – all six findings FIXED:
  - **R-01 (P1)** `updateDealContact` spread every runtime key into `lead.update`, so a crafted payload could set `status`,
    `ownerId`, `pipelineEnteredAt`, `deletedAt`… Now strict zod schemas (`dealContactSchema`, quote input,
    `nextActionInputSchema`) inside `lib/domain/dealMutations.ts` reject unknown keys and the update is built from named fields
    only – both the clients and the pipeline entry point.
  - **R-02 (P2)** pipeline list ordered after the page was cut. Ordering + `LIMIT` are now done in SQL over the whole filtered
    set (`PIPELINE_RANK_SQL` mirrors `nextActionSort`, requests view by oldest OPEN request, `id` tie-breaker); rows are fetched
    for the page only.
  - **R-03 (P2)** `getClientDetail(id, viewer)` is owner-scoped in the query for non-managers (guard and read can no longer
    disagree when a deal is transferred between them).
  - **R-04 (P2)** client search is paginated (`SEARCH_PAGE = 50`, `hasMore`, "Načítať ďalších").
  - **R-05 (P3)** design version number removed from the rep query and detail UI.
  - **R-06 (P3)** `getManagerToday` returns an exact `requestCount` (separate count) with a bounded 10-row preview.
  - Observations: plan §11.3 row 5 text reconciled with the script's `anyQueueCall` rule; this tracker's backfill delta count
    corrected to 6/6; team "Obchod" (leader `t_michal`, member `t_timea`) created on the test DB so Timea's handoffs route to
    Michal instead of staying unassigned.
  - Verification after the fixes: `tsc` clean, `next build` OK, lint unchanged (only `MobileNav.tsx`), business time 33/33 +
    33/33 (`TZ=UTC`), client sections 19/19, concurrency suite **58/58** (48 previous + 10 new regression checks
    `r01CraftedInput`, `r02PipelineOrder` incl. SQL↔`nextActionSort` parity, `r03DetailScope`, `r04SearchPaging`,
    `r06RequestCount`), HTTP role checks 31/31, backfill delta suite and `--verify` clean.
