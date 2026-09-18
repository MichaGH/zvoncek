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

---

# Round 2 (discussion): one deal workspace, interactions, notes, pricing

Source: `context/new-feature/round2-deal-workspace.md` — **DISCUSSION, NOT APPROVED, nothing implemented.**
Written 2026-09-17 from Michal's feedback after using the shipped round-1 feature.

Scope of the discussion (ids are defined in that file):

| id | Topic | Recommendation |
|---|---|---|
| D-01 | `/clients` and `/pipeline` are two UIs over the same data | keep both routes, one shared implementation + capabilities from `can()` |
| D-02 | Card list does not scale (80+ deals, anchor chips, no paging) | filter chips + paging, desktop table / mobile cards |
| D-03 | Row click: act vs inspect | row → action sheet, `i` icon → detail |
| D-04 | vaul drawer used on desktop too | `ResponsiveSheet`: drawer < md, Radix dialog >= md |
| D-05 | **Core**: "did I already call them" vs "what is next" are disconnected | one Interaction: contact result → what they said → next step; both lines always visible |
| D-06 | No vocabulary for what the client said | curated quick replies in `Activity.meta` first, enum later |
| D-07 | Six different note fields, none for the developer | notes wall: new `LeadNote` model with audience tag + pinning |
| D-08 | ORDER request does not say what they want to order | note required server-side now, "Zadanie" block later |
| D-09 | Pricing changed: cenník vs konkrétna cena | additive `pricelistSentAt` / `priceQuotedAt` / `priceItems` |
| D-10 | Next-step type lists differ between drawer and detail | one `NEXT_STEP_OPTIONS` constant, add `NextActionKind.ORDER` |
| D-11 | Three near-identical drawers | one sheet, two variants (firstCall / followUp), commands stay separate |
| D-12 | Manager filters | add handed-off-by, section chips, request kind |

Bugs recorded in the same file: B-01 (date picker in the clients drawer does not open on click), B-02 (chips scroll
down only), B-03/B-04 (no interaction card on either detail), B-05 (empty ORDER/DESIGN request note), B-06/B-07
(next-step list + "Objednávka" lands in "Čaká na klienta"), B-08 (phone layout on desktop), B-09 (`Lead.note` shared).

Proposed schema (all additive, none applied): S-01 `NextActionKind.ORDER`, S-02 `LeadNote` + `LeadNoteKind`,
S-03 price knowledge fields, S-04/S-05 optional later.

**Headline decision: one screen.** `/dashboard/pipeline` (+ `/[id]`) serves every deal-working role; `/dashboard/clients`
becomes a two-line redirect and `components/clients/**` + `lib/queries/clients/**` are deleted. Access and scope are
split: `deals.view` / `deals.work` (open the screen, act in scope) vs `deals.viewAll` / `deals.viewTeam` /
`deals.manage`; `dealScope(viewer)` is the single place scope is decided and `?owner=` is validated against it.
Default filter on open = my own deals, for every role including the manager. `Požiadavky` stays visible for everyone,
scoped. The merge is **one atomic wave** followed by a full check pass (incl. new scope/crafted-call tests and a
`Na dnes` ↔ `clientSection()` parity check) before any further work.

Other decisions: D-02 one filter row for both roles + new `Na dnes` pill replacing the card sections; D-03 row → action
sheet, `i` → detail; D-04 drawer < md / dialog >= md (the two-column **detail page** layout is unchanged); D-05
interaction model (contact → reply → next step, "Naposledy" line always visible); D-06 option A (`Activity.meta`,
no enum yet); D-07 `LeadNote` with author/role/stage recorded automatically + pinning, shown in the detail (no dashboard
note board yet); D-08 step 1 only (ORDER note required server-side, mirrored as a pinned `FOR_BUILD` note); D-09
additive price-knowledge fields, ceník stays outside the app (F-01 parked); D-10 telesales menu unchanged, one shared
next-step list, `NextActionKind.ORDER`; D-11 one sheet, two variants, commands stay separate; D-12 owner filter = my
work / one person / everything + handed-off-by and request-kind filters; D-13 scope and capabilities as single
functions; D-14 `lockedById`/`lockedAt` stay as dead columns (the claim mechanism replaced that idea) and the
"Multi-Telesales Locking" section of `context/additional-features-todo.md` is obsolete; D-15 `requestsForViewer()` now,
addressed requests (`toRole`/`toUserId`) when a developer or team leader arrives.

Still open (§6 of that file): whether `ActivitySource.CLIENTS` survives the merge, whether reps can also *filter* by
handed-off-by, note edit/delete rules, whether a sales-rep team leader is a separate role, whether a future developer
role shares this screen, and the parked ceník-in-app idea.

## Round 2 – wave 1: merged deals screen (DONE on the test branch, 2026-09-18)

**Database: no change at all.** Wave 1 is pure application code; every schema change of round 2 is still `PLANNED` in
`context/new-feature/db-changes.md` (which also lists what round 1 still owes production).

What shipped:

| Area | Change |
|---|---|
| Route | `/dashboard/pipeline` (+ `/[id]`) is the one deal screen for every role; `/dashboard/clients(/[id])` are two-line redirects; nav label differs per role |
| Permissions | `clients.view/work` → `deals.view/work`, `pipeline.view/manage` → `deals.viewAll/manage`, new unused slot `deals.viewTeam`; route guard now asks for `deals.view` |
| Scope | `lib/domain/dealScope.ts` – the only place scope is decided (`own` / `team` / `all`); `?owner=` validated against it (`resolveOwnerFilter`), never trusted |
| Capabilities | `lib/domain/dealCapabilities.ts` – rendering hints only; every command keeps its own guard |
| Queries | `lib/queries/deals/**` replaces `queries/pipeline` + `queries/clients`; adds the `Na dnes` SQL predicate, handed-off-by and request-kind filters, scoped counts, scoped detail; `requestsForViewer()` prepares D-15 |
| Commands | `commands/clients.ts` → `commands/dealWork.ts` (owner **or** manager); activity `source` now follows the actor (`deals.manage` → PIPELINE, else CLIENTS); ORDER/DESIGN/OTHER requests require a note server-side (B-05) |
| Actions | `lib/actions/clients` → `lib/actions/deals` with `*Deal*` names; manager-only actions stay in `lib/actions/pipeline` |
| UI | new `components/deals/{DealList,DealFilters,DealActionSheet,DealDetail}.tsx`; deleted `components/clients/**`, `PipelineTable/PipelineDetail/PipelineStatusTabs/PipelineViewTabs/PipelineSearch/PipelineOwnerSelect` |
| UX | one filter row for both roles, `Na dnes` pill + default, 50/page everywhere, desktop table + phone cards, row → action sheet, `i` → detail, date fields open the picker on click (B-01) |

Bugs closed by this wave: B-01, B-02, B-03, B-04, B-05, B-08, B-10 (the "Multi-Telesales Locking" section of
`context/additional-features-todo.md` now says the claim design solved it and the lock columns are dead).

Checks (test branch `…nhww8x`, 2026-09-18):

- `npx tsc --noEmit` clean; `npx eslint .` only the known pre-existing `MobileNav.tsx` error; `npx next build` OK
- `check-business-time.ts` 33/33, `check-client-sections.ts` 19/19
- `check-concurrency.ts --iterations 100`: **62/62**, including four new wave-1 checks – W1-A (a rep's list and detail never
  return another owner's deal for any `?owner=` value, including a crafted id), W1-B (manager filtering by a rep gets exactly
  that rep's board in the same order), W1-C (`Na dnes` SQL matches `clientSection()` over all 356 open deals, count included),
  and the audit-activity check on the rep detail
- `check-backfill-delta.ts` 6/6, backfill `--verify` clean
- HTTP role checks **35/35** against the running dev server (rep sees the merged screen and cannot reach a manager's deal by
  URL or by `?owner=`; old client URLs redirect; manager keeps the full toolset)

Known gap: during the role-check update I first deleted the manager block by accident (the run reported 27/27 instead of
31); it was restored and the suite re-run at 35/35.

Not done in wave 1 (next waves, see `context/new-feature/round2-deal-workspace.md` §5): D-04 ResponsiveSheet + D-05
interaction model + D-06 quick replies + S-01 `NextActionKind.ORDER` (wave 2), D-07 notes (wave 3), D-09 pricing (wave 4).
A human click-through of both roles is still pending – the automated checks cover HTTP responses, not drawers and forms.

## Round 2 – wave 2: the interaction model (DONE on the test branch, 2026-09-18)

**Database: one additive enum value** – `NextActionKind += ORDER` (S-01), pushed to the test branch with `prisma db push`
(no data-loss warning). Everything else uses existing columns; the quick replies live in `Activity.meta.reply` on purpose
(D-06 option A). Ledger updated: `context/new-feature/db-changes.md` §2.2.

What shipped:

| Area | Change |
|---|---|
| Sheet | `components/shared/ResponsiveSheet.tsx` – vaul drawer below `md`, Radix dialog from `md` up (`components/ui/dialog.tsx` added). First paint is always the drawer branch (`useSyncExternalStore` on `matchMedia`), so hydration is stable. Used by the deal sheet, `CallDrawer` and `InfoDrawer`. |
| Interaction | `components/deals/InteractionSheet.tsx` replaces `DealActionSheet`: **čo sa stalo → čo povedali → ďalší krok**. `NO_ANSWER` keeps its outcome even when the user picks a different next step (this is the fix for "the moment I set the next step I no longer see that I called"). |
| Vocabulary | `lib/domain/clientReplies.ts` – ten curated replies; key → `Activity.meta.reply`, label → prefix of `Activity.note`. Unknown keys are refused by the strict schema. |
| Next steps | `lib/domain/nextStepOptions.ts` – one ordered list with date/mode rules, used by the editor, the sheet **and** `dealStateForFollowUp`; `FOLLOW_UP_NEXT_KINDS` now includes `SEND_DESIGN` and `CUSTOM` (B-06). |
| ORDER step | `WANTS_TO_ORDER` now parks the deal on `ORDER` ("Objednávka – potvrdiť") instead of `WAITING_FOR_CLIENT` (B-07), so the board says we wait for the manager. |
| Attempt counter | `noAnswerStreak` in the list (one SQL window query for the page) and in the detail (from loaded history); shown as "· N. pokus" on the row, in the sheet header and on the detail card. |
| Manager detail | "Zaznamenať kontakt" button in the `Naposledy` card opens the same sheet (B-04 – the manager had no way to record a call at all). |

Checks (test branch `…nhww8x`, 2026-09-18):

- `npx tsc --noEmit` clean; `npx eslint .` only the known `MobileNav.tsx` error; `npx next build` OK
- `check-business-time.ts` 33/33; `check-client-sections.ts` passed (totality now covers the new `ORDER` kind)
- `check-concurrency.ts --iterations 100`: **67/67** – the 62 from wave 1 plus five new wave-2 checks:
  W2-A (no-answer keeps its outcome with a custom next step, default behaviour unchanged), W2-B (reply in `meta` +
  label in the note, unknown reply refused), W2-C (wants-to-order → `ORDER` step + ORDER request), W2-D (streak counts
  consecutive misses in list **and** detail, resets after a real contact), W2-E (shared step rules: design is in
  progress from today, call without a date refused)
- `check-backfill-delta.ts` 6/6; HTTP role checks 35/35

Note: W2-A failed on its first run because the assertion forgot that the fixture creates the deal with a positive first
call (three CALL rows, not two). The test was corrected, not the code.

Still open: the human click-through (now also worth checking the desktop dialog and the three-step flow on a phone),
then wave 3 (notes, S-02) and wave 4 (pricing, S-03).

## Round 2 – wave 3 designed, not implemented (2026-09-18)

Using waves 1–2 exposed a modelling mistake: `DealRequest` was doing three jobs at once (ticket, state marker, implied
handover). Symptom Michal hit: as SALES_REP, four first calls produced **"Požiadavky (4)"** on his own screen, the deal
stayed in that bucket whatever he did next, and as manager the pill was empty until he switched the owner filter.

Agreed design is in `context/new-feature/round2-deal-workspace.md` §2b (D-16…D-22). In short:

- **Požiadavky becomes an inbox of tickets** (Pre mňa / Od mňa / Vybavené) that ignores the owner filter; the deal list
  stops filtering by open request and shows a badge instead.
- **Where a deal sits is decided by its next step**: new `WAITING_FOR_MANAGER` with the reason from the ticket;
  `clientSection()` loses the "open request" rule and the `Na dnes` SQL must lose its `NOT EXISTS (open request)` clause
  in the same commit (the W1-C parity test is the gate).
- **`ORDER` is replaced by `HANDOVER`** – "áno, ideme do toho" is not an order specification, it is "take the client".
  WON stays a manager-only action on the deal. The note requirement shrinks to `OTHER` only, and both creation paths
  (call outcome and manual) go through one function — today they disagree, which is our bug.
- New kinds `CALL_CLIENT` and `HANDOVER`; handover available manually at any time.
- **Tickets are editable by the author while open and appendable by both sides**; age does not reset on edit;
  cancelling clears the next step so the deal resurfaces in "Na dnes" as "bez ďalšieho kroku".
- **Resolution is two switches** (kto posiela × kto pokračuje), so the three endings are combinations, and manager →
  developer delegation later is the same mechanism.
- **Takeover removes the rep's access**; a new `DealOwnership` record powers the rep's "História" list
  (`prevzaté 18. 9. · Michal`), statistics, and future rep → rep transfers. Detail access for reps is behind one unused
  capability flag.
- Counters on every pill.

Schema (all additive, none applied): S-08…S-12 in `context/new-feature/db-changes.md` §2.3. Notes (was wave 3) and
pricing move to waves 4 and 5, deliberately behind the ticket model.
