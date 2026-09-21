In this file progress of feature implementation is tracked. Should contain

- features we are currently working on, or even its individual stages
- feature that have been finished (dont go back in history to add old progress)
- To do problems and stages

---

# Feature: caller assignment, SALES_REP, /dashboard/clients, manager oversight

Source of truth: `context/features/01-salesrep/planning.md` (rev. 4). Phases = plan §13.

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
| 13 | Independent review `context/features/01-salesrep/revision.md` (R-01…R-06) fixed + regression tests | DONE |

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
  - `CALLWORK_OK` accepts *any* CALL_QUEUE call (also reverted), matching §11.3 row 5. A lead whose only call was
    reverted (CALLING RETRY, assigned) remains call work as required by §15.
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
- 2026-09-17 revision pass (`context/features/01-salesrep/revision.md`, independent review by ChatGPT Codex) – all six findings FIXED:
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

Source: `context/features/01-salesrep/round2-deal-workspace.md` — **DISCUSSION, NOT APPROVED, nothing implemented.**
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

## Wave 4 Part A: one task, several parts (implementation complete on the test branch, 2026-09-20; review partA-R01 fixes applied 2026-09-21, human acceptance pending)

Design: `context/features/01-salesrep/wave-4-proposal.md` (rewritten from zero against the shipped wave 5; reviews R01
and R02 resolved). Built in the order §9 asks for: prerequisites → schema → conversion → pure rules → reads → commands
→ step rules → screens → tests → cutover → docs. **Parts B (notes) and C (order note) are not built** — they wait on
Michal's Q5 / Q6.

### Prerequisites fixed first (§7) — both were defects in code shipped by wave 5

- **P0 — `defaultStep(..., { locked: true })` could store a locked step with mode `IN_PROGRESS`.** The *changed kind*
  branch cleared the date but not the mode, so a pencil edit on a deal with an open task could leave
  `SEND_DESIGN` + `IN_PROGRESS` + `nextActionAt = NULL`, against "an `OPEN` task ⇒ date NULL and mode SCHEDULED"
  (wave 3 I8). Now `opts.locked` forces `SCHEDULED`. It mattered more for wave 4 because P6 runs that branch
  constantly. Property test: `w4Pure` asserts it over every outstanding set × every current step.
- **P1 — the follow-up call was not gated on what the client is still owed.** `finishAndSendAs` decided "Zavolať, či
  prišlo" from returned **task items** only, and `recordOffer`'s follow-up branch asserted only I10 — neither looked at
  `LeadRequest`. So a manager who finished price + návrh and sent them himself scheduled a call about an email while
  the client was still owed info and cenník; the send dialog enforced the right rule, the **server** did not. Now
  `recordOffer` reads `outstandingOf` after the reconcile: `followUp: true` with outstanding work is refused
  (`FORBIDDEN`, after I10's precise message gets its chance), and `finishAndSendAs` passes `followUp: "IF_CLEAR"`, so
  it degrades to the remaining send step instead of failing. Test: `w4FollowUpGate`.

### Schema (S-13a, S-14, S-15, then S-13b — applied on test only)

- New table **`DealTaskPart`** (`taskId`, `kind`, `status`, `result?`, `addedBy/At`, `resolvedBy/At?`, `reason?`) with
  **`@@unique([taskId, kind])`** — load-bearing: it keeps a returned item's address `(taskId, kind, designId)` stable
  and makes a kind either `REQUESTED` or resolved, never both. Enum `DealTaskPartStatus`.
- `DealTask.fallbackKind` / `fallbackNote` — the step the deal had **before** the task locked it (R02-3).
- `ActivityType += TASK_PART_ADDED, TASK_PART_DONE, TASK_PART_DECLINED, TASK_PART_WITHDRAWN` (S-14) and
  `PRICE_CHANGED` (S-15).
- **S-13b:** `DealTask.contents` and `DealTask.result` **dropped** after the code was switched over — what a task
  carries and what it returned are now only its parts. Production never had either column, so nothing is owed.
- Endpoint verified before each command (`…nhww8x` / `neondb`), both diffs reviewed before applying, `migrate diff`
  empty afterwards. Ledger: `context/domain/db-changes.md` §1.

### Test-data conversion (§6.3)

`prisma/backfill/2026-09-wave4-parts.ts` + `wave4-parts-sql.ts`: dry-run → apply → verify, one part per task content,
**12 parts from 12 tasks, no blockers, zero drift**. After the cutover parts are the source of truth and are never
re-derived, so the script now refuses to run (`POST_CUTOVER_SQL` detects real part state a pure derivation could not
have produced) and is kept only as the record of what ran. Production runs none of it — it has no task rows.

### Code

- **`lib/domain/tasks.ts`** (pure, client-safe): `taskStatusOfParts` (the task status as an order-independent function
  of its parts), `taskPartState(task, parts, consumption)` → `{ parts, openKinds, nextStatus }`, `partItems`,
  `partMarkLabel`, `partInPlay`, and the types that keep **part state and item fate apart** — `ItemDisposition`
  (`WAITING` / `SENT` / `DISMISSED`) per returned item, `PartMark` for the part. `returnedItems` now reads **parts**,
  so an open task contributes items as soon as one part is delivered. `itemKey` gained `part` for a declined part, so
  two declined parts of one task are two acknowledgements. `overlapsTask` → `overlappingKinds` (only kinds still
  `REQUESTED`); `OVERLAP_CHOICES` = `KEEP_OPEN` · `WITHDRAW_PARTS`.
- **`lib/domain/taskMutations.ts`**: `applyPartOps` is the **only** writer of part state — resolve the named parts,
  recompute the task status, write the keyed `TASK_PART_*` row and the task-level row the **resulting status** calls
  for (§2.4a). `cancelOpenTask` keeps its name, callers and input and now withdraws every part still `REQUESTED`.
  `addParts`, `buildPartResult` (refuses values for a kind it was not asked to deliver), `acceptHandover`,
  `declineHandover`, `setNextStepAfterTask`, `openTaskWithParts`, `consumptionByLead`.
- **`lib/domain/lockedStep.ts`** (new): P6 — while a task is open the step is
  `defaultStep(outstanding, lead, { locked: true }) ?? task fallback`, recomputed on every event that changes the
  outstanding work, always date `NULL` + `SCHEDULED`. Its own module so `taskMutations` and `requestMutations` stay
  acyclic, and **command-owned**: putting it inside `recordOffer`'s `factOnly` branch would have wiped the step date
  on a deal with no task at all (`keepStep`, the SMS path).
- **Commands**: `askManagerAs` takes 1–3 kinds and stores the fallback step; `resolveTaskPartsAs` (new) replaces
  `finishTaskAs` and absorbs `declineTaskAs`; `finishAndSendAs` works over the named parts; `withdrawTaskPartsAs` and
  `addTaskPartsAs` (owner only) are new; `declineHandoverAs` keeps "Nie, pokračuj ty" for a `HANDOVER`, which has no
  parts to decline. `recordOfferSentAs` and `logFollowUpAs` swap `cancelTask`-on-overlap for `withdrawParts`.
- **Reads**: `managerWorkOf`'s `making` is the open task's `REQUESTED` kinds (a delivered part moves to `prepared`
  without closing the task); the list row carries `openKinds` + a progress line; the detail carries each task's
  `parts` with their item dispositions; the manager's inbox shows only what is still on **him**.
- **Screens**: "Požiadať manažéra" is a multi-select; "Hotovo" has a per-part **"Odovzdať teraz"** toggle (a
  pre-filled price is never a decision — R02-4); the task card lists parts with `○ ◆ ✓ ✗ –`, expands a part's items
  when there is more than one or something was deliberately not sent, and offers "+ Pridať" / "Už netreba" /
  "Toto nerobím" / "Zamietnuť všetko"; the send dialog asks about parts, not the whole task.

### Part D — D5 price history (accepted 2026-09-20)

`saveQuote` writes one `PRICE_CHANGED` **BUSINESS** row (so the deal's own rep sees it — the old `CONTACT_UPDATED`
audit row was invisible to her), including for a **breakdown-only** edit, which used to vanish silently. `meta.via`
(`EDIT` / `TASK` / `SEND`) keeps one user action from telling the same story twice; the price popup takes an optional
short reason. The row is deliberately in neither whitelist: it never moves "Naposledy" and cannot be crossed out.
The last few changes render under the current price on "Cena & ponuky".

### Tests

15 new groups in `prisma/backfill/check-concurrency.ts`: `w4Pure` (the status over all 64 part combinations and its
order-independence, item addresses, the compact mark, and the P0/P6 property over every outstanding set), `w4Ask`,
`w4Partial` (Michal's workflow end to end, both orders and all at once), `w4Selection` (R02-4), `w4StepLocked`
(P6 through deliver / send / correction, plus B1: a deal with **no** task is untouched), `w4Fallback` (R02-3),
`w4Terminal` (every row of the §2.4a table), `w4Items` (R02-2), `w4WithdrawAdd`, `w4SendWhileOpen`, `w4FollowUpGate`
(P1), `w4Survives`, `w4Race`, `w4PriceHistory` (D5), `w4Conversion`.

Two wave-3 expectations were **rewritten, not patched around**, because wave 4 changes the behaviour on purpose:
"finish needs an amount" (delivering only the návrh is now legal and leaves the price open) and the overlap payloads
(`CANCEL_TASK` → `WITHDRAW_PARTS`).

### Checks (all actually run, 2026-09-20 / 21)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint .` | only the known pre-existing `components/layout/MobileNav.tsx` error |
| `npx next build` | succeeded (20 routes) |
| `npx tsx prisma/backfill/check-business-time.ts` (and `TZ=UTC`) | passed |
| `npx tsx prisma/backfill/check-client-sections.ts` | passed (totality over 4200 combinations) |
| `npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint …nhww8x --iterations 100` | **211/211** |
| `npx tsx prisma/backfill/check-backfill-delta.ts --expect-endpoint …nhww8x --expect-db neondb --owner-username admin --caller-username telesales` | 6/6 — **after fixing a wave-5 leftover, below** |
| wave-4 conversion dry-run / apply / verify on test | 12 parts, no blockers, zero drift |

**Found while running the checks — a wave-5 leftover in a production-rollout script.**
`prisma/backfill/2026-09-assignments.ts` classifies a lead by its first *positive* call, but its `POSITIVE` list was
never updated when wave 5 added `CallOutcome.INTERESTED` — the outcome the call queue now writes for every handoff. So
every deal created through the shipped wave-5 flow was classified `CONFLICT`, which **aborts the whole one-time
production backfill**. On the test database that was 17 of Michal's click-through deals. `POSITIVE` now mirrors
`HANDOFF_OUTCOMES` (`lib/domain/leadFlow.ts`) and the delta check passes 6/6. Nothing wave 4 did caused it; it would
have surfaced during the production rollout instead.

### Wave 4 Part A — review partA-R01 (`.ai/reviews/01-sales-rep/W4/implementation/partA-R01.md`), fixed 2026-09-21

Findings 1–6 were re-read against the code and all were real. No schema change.

- **partA-R01-1 correction** — `correctRecordAs` now calls `refreshLockedStep` after `correctRecord` (no-op without an open
  task; an unlocked deal keeps the user's step).
- **partA-R01-2 "Chceli" pencil** — `setClientAsksAs`: open task → `refreshLockedStep` unconditionally (no `isSystemStep`
  guard); no task → wave-5 `isSystemStep` rule unchanged.
- **partA-R01-3 phone/SMS partial withdraw** — UI: only a withdrawal that takes the *last* open part counts as
  "cancelling"; a partial one is a fact save (`keepLockedStep`) that still asks for the reason. Server: a
  `withdrawParts` that closes the task passes the lock gate like `cancelTask` (owner's chosen step wins); the `closed`
  result of `applyPartOps` is now used — a fact-only save that closed the task runs `stepOnTaskClose`.
- **partA-R01-4 forged `withdrawParts`** — `withdrawMatchesOverlap` (`lib/domain/tasks.ts`) is the one validator for both
  send commands: exactly the requested kinds the save covers, same task, non-empty (phone: needs a told price).
- **partA-R01-5 owner change / snooze** — `ownerTransition` (cancel branches only; an accepted HANDOVER is unchanged) and
  `changeDealStatus` now end the task through `stepOnTaskClose` instead of bare date-filling. Michal's decision on the
  snooze half: a snooze that cancels an open task **asks for a wake-up date** (`changeStatusAs.snoozeUntil`, required
  server-side, date input in the detail's status sheet) instead of leaving the step due today ("zobudený" at once).
- **partA-R01-6** — new part mark `DISMISSED` (⊘ "neposiela sa") when every returned item was deliberately not sent.
- **partA-R01-7 tests** — new `w4ReviewR01` in `check-concurrency.ts`, built on transitions where the step *kind* visibly
  changes (CALL ⇄ SEND_QUOTE, SEND_DESIGN → CALL). The old W4-4 correction check stays but is not the evidence.
- **Not changed here:** partA-R01-8 (production rollout / legacy-column policy) is Michal's decision, not code; the wave-4
  proposal header is a protected feature file and still says "nothing built".

### Wave 4 Part A — review partA-R02 (`.ai/reviews/01-sales-rep/W4/implementation/partA-R02.md`), fixed 2026-09-21

No schema change. R02-1/2/3/5 fixed; R02-4 and R02-6 are release gates (see the response file).

- **R02-1 system fallback** — a task's fallback step is now `helpFallback(...)`: a manual step returns as it was; an
  app-generated `SEND_*` (or no step) becomes `CALL` + "Pokračovať s klientom po odpovedi manažéra". Stored at ask time
  **and** applied on read (`lockedStepFor`), so older tasks are covered. While only the question is left the list and
  detail read "Čaká na <manažér> – otázka / konzultácia" (`waitingOnQuestionHeadline`); the OTHER answer shows on the task
  card; `TASK_CONTENT_LABEL.OTHER` = "Otázka / konzultácia" (Michal's decisions, 2026-09-21).
- **R02-2 e-mail final-part withdrawal** — `recordOfferSentAs` no longer unlocks before the send is reconciled; without a
  follow-up it runs `stepOnTaskClose` afterwards, with one the requested call wins. The dialog's "Ponechať" now names the
  step that will really result (fallback exposed as `openTask.fallbackKind`).
- **R02-3 partial-send confirmation** — a second stage in `OfferSentDialog` (what is sent · what the manager still makes ·
  the locked step · "Áno, poslať len …" / "Späť"), same idempotency key, composes with the foreign-deal confirmation.
- **R02-5 docs** — `app-workflow.md` and `operations.md` no longer say a correction / the pencil never touch the step.
- **Also this session (not a review item):** the five "Čo chceli" cards from the pipeline dialog are now a shared
  component (`components/shared/OptionCard.tsx`, `RequestContentPicker`) used by the pipeline action sheet **and** the
  `/calls` drawer (equal card heights via `auto-rows-fr`, one column on phone).
- Tests: `w4ReviewR02` (W4A-R02-*) starts from a real Wave 5 `SEND_QUOTE` / `SEND_DESIGN`.
- **Not verified by a human:** the new confirmation and the `/calls` cards on phone + desktop (no browser session).

### Backup before the filter redesign — 2026-09-21

GitHub backup of everything above (R01 + R02 fixes, the shared "Čo chceli" cards, the test-DB reseed script, the review
records, and ChatGPT's unfinished filter attempt as it stood): branch **`backup/wave4a-r01-r02-fixes-pre-filters-2026-09-21`**,
commit **`8478c7f`**, pushed to `origin`. The working branch `feature/wave5-workflow-fix` was fast-forwarded onto that
commit and continues from there. Earlier backups: `backup/wave5-ui-redesign-2026-09-21`,
`backup/wave5-built-pre-ui-fix-2026-09-20`, `codex/pre-wave5-*`. Restore = `git switch` to the branch; nothing else.

### Wave 4 — pipeline filters redesigned: status on top + two composable levels (2026-09-21, after partA-R02)

Michal's rep workflow: call ~20 numbers in /calls → in the pipeline first finish what the calls promised (prices,
cenníky, návrhy, asking the manager) → then the day's deadlines. The flat pills did not answer that ("Rozpracované
návrhy" mixed manager work with the rep's own; "Všetko → Volať" did not exist). Managers use the same screen for their
own deals and for their telesales' deals. **No schema, no server rule changed — filters only.**

- **Level 1, queue** (big pills, icon + count): *Pre mňa* (manager) · *Čakám na manažéra* │ *Na spracovanie* · *Na dnes* ·
  *Všetko*. **Level 2, step kind** (chips, counts inside the current queue): Volať · Poslať cenu · Poslať návrh · Poslať
  email · Čaká na klienta — a *narrowing* of level 1 (`step` URL parameter), so *Všetko → Volať* and *Na dnes → Volať* differ
  as Michal expected; hidden in *Čakám na manažéra* / *Pre mňa*. **Status** (Aktívne … Všetky) is the subtle switch at the very top again (Michal's correction to the first version, which put it in *Všetko*); queues and steps exist **only for Aktívne** — any other status is a plain list, even from a hand-made URL, and switching status resets queue and step (back to Aktívne re-picks the queue by work).
  "Klient už dostal" / "Neoverené" moved into one quiet disclosure. ChatGPT's boxed "Pracovný rad" card and its hint
  sentence are gone.
- **Default:** no `view` in the URL → *Na spracovanie* while its count > 0, otherwise *Na dnes* (`resolveView`); the choice is
  visible because the active queue is filled with colour. Every link the screen builds carries an explicit queue. If that
  turns out to be confusing in daily use, the alternative is a fixed default — one constant (`DEFAULT_VIEW`).
- **"Poslať návrh"** = `nextActionKind = SEND_DESIGN` replaces "Rozpracované návrhy" (`nextActionMode = IN_PROGRESS`);
  manager work is already *Čakám na manažéra*. Old `?view=call|quote|email|design|waiting` links still work (= *Všetko* + step).
- Code: `lib/domain/dealFilters.ts` (model), `lib/queries/pipeline` (`stepWhere`, `getDealStepCounts`),
  `components/pipeline/DealFilters.tsx`, `app/dashboard/pipeline/page.tsx`. Tests `w4aFilterLevels` (W4A-F-1..4): queue × step is
  the intersection, step counts equal their lists in every queue, legacy links, parsing; `w3LockParity`, `w1TodayParity`,
  `w3InboxHref` still pass.
- **Not verified visually or on a phone** (no browser login by the agent) — the layout is owed a click-through.

### Wave 4 — not resolved / to do later

- **Human click-through owed** (phone + desktop, a browser session is not something this agent may open with someone's
  credentials): asking for two or three kinds at once; the manager's "Hotovo" with one part ticked and the rest left
  open; sending the ready price while the návrh is still being made; "+ Pridať" and "Už netreba" on a running task;
  "Toto nerobím" on one part; a DESIGN part with two návrhy where one is sent and the other dropped; the price history
  on "Cena & ponuky".
- **Two questions still open for Michal** (they change display and one policy, not the data):
  **Q12** — a part that returned two návrhy renders as one row with a compact mark (`✓ Návrh · 1 z 2`) that expands to
  the item lines; confirm that, or ask for two top-level rows. **Q9** — a declined part changes nothing about the
  client's request (no shortcut, no automation); built as "do nothing", confirm.
- **Parts B and C are not built.** Part B (`LeadNote`) needs Q5 (§3.3 + §3.4 of the design: INTERNAL is manager-only to
  **read** as well as write, bodies immutable, deletion records who and why, an old `Lead.note` labelled
  "Staršia poznámka (autor a pôvod neznámy)"); Part C needs Q6.
- **Part D leftovers D1–D4** were not taken (Q7 answered only for D5).
- The wave-5 click-through (F4 in `wave-5-followups.md`) is **still open**; wave 4 was built on top of it rather than
  after it, so both click-throughs are owed together.
- `prisma/backfill/2026-09-wave4-parts.ts` and `wave4-parts-sql.ts` are historical: they cannot run after S-13b and
  refuse to. Keep them until the production rollout is done, then they can go.

## Wave 5: what the client asked for vs. what they got (DONE on the test branch, 2026-09-20)

Design: `context/features/01-salesrep/wave-5-proposal.md` (draft v4, reviews R01–R03 resolved). Implemented in the
order the design asks for: schema → pure rules → reconciliation → commands → screens → tests → docs.

### Schema (S-16 – S-19, applied on test only)

- New table **`LeadRequest`** + enums `RequestContent` (INFO · PRICELIST · PRICE · DESIGN · REVIEW), `RequestState`
  (OPEN · SENT · WITHDRAWN), `RequestOrigin` (LIVE · MIGRATED_RECEIPT · MIGRATED_OPEN_STEP), with real relations to
  `Lead`, `User` and `Activity`, a unique `migrationKey` and `provenance`.
- `Lead.offerReviewAt`, `ActivityType.CLIENT_ASK_CHANGED`, `CallOutcome.INTERESTED`.
- Endpoint verified first (`…nhww8x` / `neondb`), diff reviewed before applying: `CREATE TYPE` ×3,
  `ALTER TYPE … ADD VALUE` ×2, one nullable `ADD COLUMN`, one `CREATE TABLE`, 3 indexes, 5 FKs — **no DROP, no
  retype**. `prisma db push` applied it with no data-loss warning; a second run reported "already in sync".
  Ledger: `context/domain/db-changes.md` §1 and §5.

### Code

- **`lib/domain/clientRequests.ts`** (pure, client-safe): the §5 mapping, dominance, `coveredContents` / `stepView` /
  `warningText` (§6.9a), `resolveRequests` (§6.7), `clientRequestState` over **three** sources (§6.9),
  `defaultStep` (§6.8), `isSystemStep`, and `sendCompletesStep` — **moved here from `tasks.ts`**, because it now
  counts outstanding contents, not only returned task items.
- **`lib/domain/requestMutations.ts`**: `reconcileRequests` (the only writer of `state` / resolver),
  `addRequests`, `withdrawRequests`, `deleteRequestsOfActivity`, `assertLeadActivity`, and the read helpers the
  queries use.
- **`lib/commands/requests.ts`**: `setClientAsksAs` — the pencil, keyed, one bump, open rows only.
- `logCallAs`: `INTERESTED` + `asked[]`, rows with the call's instant, `meta.asked` / `meta.fp` (a different
  selection under the same key is a conflict). `logFollowUpAs`: "Chcú aj …" (also while the step is locked), a phone
  price resolving that call's rows by link, and the step re-derived when the user submitted none.
  `recordOfferSentAs` / `recordOffer`: `REVIEW` content, reconciliation after every send, and the step following
  what is left outstanding. `correctRecord`, `revertCallResultAs`, `reopenDeal`, `askManagerAs` updated to match.
- Queries: one projection for the list and the detail (`outstanding`, `stepHeadline`, `askWarning`, `askHistory`,
  `outstandingRows`, `asked`, `clientPrice`).
- Screens: telesales ticks instead of three buttons; "Chceli" + pencil on the price card; the derived headline,
  checklist and warning in the detail and the list; "Rozbor webu" and pre-ticked asks in "Čo sme poslali";
  "Chcú aj …" in the call sheet plus the "which price did they see" line; the call-history line ("Chceli: …").
- Statistics: `getDemandStats` counts `LeadRequest` rows with `origin = LIVE` — the "Čo chceli" card no longer reads
  `CallOutcome` (R01-11). `INTERESTED` joins the "interested" bucket next to the frozen `WANTS_*`.
- **Migration script** `prisma/backfill/2026-09-wave5-requests.ts` (dry-run default, production endpoint denied
  independently of the arguments, `--apply` needs a direct host + `--confirm`, `--verify`, blocked while unconverted
  legacy sends exist). **Not run against production.**

### Two deliberate behaviour changes to shipped wave-3 rules

1. **After a partial send the step follows what is left.** Sending the návrh while a returned price is still unsent
   now moves the step to "Poslať cenu" instead of keeping "Poslať návrh" (design §3.7 / §6.8). Test `w3R03` was
   updated to assert the new, specified result.
2. **Reopen is no longer always "Zavolať".** A reopened deal with outstanding work opens on that send step, due
   today; "Zavolať" + `REOPEN_STEP_NOTE` remains only when nothing is outstanding (§6.10). This also settles the
   wave-4 leftover "reopen has no step choice" for the request case.

Only a step the app chose itself is ever re-derived: a call, "Čakáme na klienta" and a custom step are the user's
decision and survive every reconciliation (R01-8 / R02-2).

### Tests

13 new cases in `prisma/backfill/check-concurrency.ts`: `w5FirstCall` (single + combined ticks, canonical
fingerprint, parallel double submit), `w5PhonePrice` (same-call link, manual step survives), `w5AskAgain` (old
receipt never satisfies a later ask, grouping, backdated send), `w5PartialSend` (step follows the rest, coverage,
list ↔ detail), `w5Correction` (reopen only when nothing else satisfies, earliest eligible receipt wins, withdrawn
never revived), `w5Revert`, `w5ManagerWork` (R03-1: manager work with no client request), `w5Pencil` (add /
withdraw / reason / SENT refused / foreign NOT_FOUND / same key once / task untouched), `w5CloseReopen`, `w5Links`
(R02-7), `w5Migration` (rerun is a no-op, no actor, excluded from demand stats), `w5Parity` (list ↔ detail and
"Na dnes" TS ↔ SQL), `w5Race` (two tabs with overlapping subsets, pencil on a closed deal).

### Checks (all actually run, 2026-09-20)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint .` | only the known pre-existing `components/layout/MobileNav.tsx` error |
| `npx next build` | succeeded |
| `npx tsx prisma/backfill/check-business-time.ts` (and `TZ=UTC`) | passed |
| `npx tsx prisma/backfill/check-client-sections.ts` | passed (totality over 4200 combinations) |
| `npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint …nhww8x --iterations 100` | **160/160** |
| `npx tsx prisma/backfill/check-backfill-delta.ts --expect-endpoint …nhww8x --expect-db neondb --owner-username admin --caller-username telesales` | passed |
| `2026-09-wave5-requests.ts` dry-run on test | ran; reported its counts and the "0 unconverted" blocker |
| production endpoint denylist in that script | verified: aborts before connecting |

### Wave 5 — problems Michal found in the click-through (2026-09-20)

**`context/features/01-salesrep/wave-5-followups.md` is the list — do not close these in a review without Michal.**
F1 the `/calls` toast says "Odovzdané: <me>" when the caller is her own sales rep (open). F2 "Poslať návrh" is
`IN_PROGRESS`, so it lands in Rozpracované and **not** in "Na dnes", although asking the manager is work for today —
a concept decision, not a quick fix (open). F3 the interaction sheet repeated its options and had no confirm button —
**fixed** on branch `feature/wave5-interaction-ui`; the state before the fix is the branch
`backup/wave5-built-pre-ui-fix-2026-09-20`.

### Wave 5 — implementation review R01, applied (2026-09-20)

Review: `.ai/reviews/01-sales-rep/W5/implementation/R01.md`; answer and open questions:
`…/R01-response.md`. **No schema change** — everything below is application code, one migration script and tests.

| # | What changed | Where |
|---|---|---|
| 1 | The wave-5 backfill no longer has a manual cenník list (it inserted `OPEN` rows for recipients). A canonical `PRICELIST` receipt becomes a linked `SENT` row like any other content; SQL moved to `wave5-requests-sql.ts` so a test runs the real statements | `prisma/backfill/2026-09-wave5-requests.ts`, `wave5-requests-sql.ts`, `w5MigrationPricelist` |
| 2 | "Chcú niečo poslať" no longer sends a pre-computed step: `stepFromRequests` makes the server derive it after asks and phone price are written; if the told price covered everything the sheet goes to "Kedy ďalej?" | `lib/commands/dealWork.ts`, `InteractionSheet.tsx`, `w5StepFromRequests` |
| 3 | Snooze / close from the sheet with open asks: lists them, mandatory reason, `withdraw {ids, reason}` compared to the open rows under the lock, one revision bump, audit row | `dealWork.ts`, `InteractionSheet.tsx`, queries (`openRequests`), `w5CloseWithdraw` |
| 4 | "Čo sme poslali" pre-ticks only what was asked (`offerDefaults`) | `clientRequests.ts`, `OfferSentDialog.tsx`, `w5DialogDefaults` |
| 5 | Untracked návrh receipt: `untrackedDesign` (only for a deal with no `Design`), satisfies the request, `Lead.designSentAt` recomputed, correction reopens | `offers.ts`, `offerMutations.ts`, `commands/offers.ts`, dialog, `w5UntrackedDesign` |
| 7 | Follow-up round (Michal's answers): manager LOST / UNREACHABLE withdraw open asks (WON does not); "Pozreli, chcú zmeny" / "Cena je vysoká" default to a "Požiadať manažéra" step today; "Poslali sme SMS" can carry a price (`PHONE` + `via: "SMS"`); Q1 clarified as the narrow CP mapping | `withdrawOpenOnLeave`, `clientReplies.ts`, `InteractionSheet.tsx`, `DealDetail.tsx`, `w5ManagerClose`, `w5SmsPrice` |
| 8 | Review R02 applied: manager SNOOZED withdraws asks (`withdrawOpenOnLeave` in `changeDealStatus`); `Lead.designSentAt` = latest valid date across tracked designs **and** untracked sends, list + "Dostali návrh" filter agree; crossing out an SMS crosses out its price; SMS "keep step" is preselected only for a planned step and refused when the SMS price finished a send step; **migration SQL send instant now equals `offerInstant()` (Bratislava midnight, not UTC) — found in the follow-up review** | `dealMutations.ts`, `offerMutations.ts`, `queries/pipeline`, `InteractionSheet.tsx`, `wave5-requests-sql.ts`, `w5ManagerSnooze`, `w5UntrackedLifecycle`, `w5SmsCorrection`, `w5InstantParity` |
| 6 | Status files: F4 stays **open** until Michal accepts the corrected sheet; nothing closed in `wave-5-followups.md` | — |

Checks: see the response file (`tsc`, targeted ESLint, the new groups, the full concurrency suite, `next build`).

### Wave 5 — not resolved / to do later

- **Human click-through still owed** (phone + desktop, a browser session is not something this agent may open with
  someone's credentials): the telesales tick list and its "Pokračovať" gate, the "Chceli" card and its pencil
  (including the "task stays open" note), the derived headline and the ⚠ line in the list and the detail, the
  pre-ticked "Čo sme poslali", "Chcú aj …" in the call sheet, and the "which price did they see" header.
- **The production migration has not been rehearsed.** It needs a fresh production clone under its own env name, the
  deployed commit, a read-only inventory and Michal's cenník recipients (probably none, named at the send conversion) — `db-changes.md` §5.4.
- **Wave 4 Part A: built on the test branch 2026-09-20** — see the "Wave 4" section above. It carried wave 5's two
  owed prerequisite fixes with it: **P0** (`defaultStep(…, { locked: true })` left the mode `IN_PROGRESS` on a kind
  change, against I8) and **P1** (the follow-up call was decided from task items instead of what the client is still
  owed). Both are fixed and tested (`w4Pure`, `w4FollowUpGate`).
- **A third wave-5 leftover surfaced while running the checks and is fixed:** `2026-09-assignments.ts` (the one-time
  production backfill) never learned about `CallOutcome.INTERESTED`, so every deal created through the shipped wave-5
  flow classified as `CONFLICT` and would have aborted the production run. `POSITIVE` now mirrors `HANDOFF_OUTCOMES`.
- The design's §10.20 ("production-clone rehearsal") is by nature not part of the automated suite.
- `LeadRequest` has no partial unique index for "one open row per content" — by design: a second open ask is a real
  second ask, and the grouping happens in the projection.

## Round 2 – wave 1: merged deals screen (DONE on the test branch, 2026-09-18)

**Database: no change at all.** Wave 1 is pure application code; every schema change of round 2 is still `PLANNED` in
`context/domain/db-changes.md` (which also lists what round 1 still owes production).

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

Not done in wave 1 (next waves, see `context/features/01-salesrep/round2-deal-workspace.md` §5): D-04 ResponsiveSheet + D-05
interaction model + D-06 quick replies + S-01 `NextActionKind.ORDER` (wave 2), D-07 notes (wave 3), D-09 pricing (wave 4).
A human click-through of both roles is still pending – the automated checks cover HTTP responses, not drawers and forms.

## Round 2 – wave 2: the interaction model (DONE on the test branch, 2026-09-18)

**Database: one additive enum value** – `NextActionKind += ORDER` (S-01), pushed to the test branch with `prisma db push`
(no data-loss warning). Everything else uses existing columns; the quick replies live in `Activity.meta.reply` on purpose
(D-06 option A). Ledger updated: `context/domain/db-changes.md` §2.2.

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

## Round 2 – wave 3 designed, not implemented (2026-09-18) — SUPERSEDED

> **SUPERSEDED on 2026-09-19** by the manager-task design `context/features/01-salesrep/wave-3-task-proposal-final.md`.
> The ticket / `WAITING_FOR_MANAGER` design below was dropped; this entry is kept only as history.

Using waves 1–2 exposed a modelling mistake: `DealRequest` was doing three jobs at once (ticket, state marker, implied
handover). Symptom Michal hit: as SALES_REP, four first calls produced **"Požiadavky (4)"** on his own screen, the deal
stayed in that bucket whatever he did next, and as manager the pill was empty until he switched the owner filter.

Agreed design is in `context/features/01-salesrep/round2-deal-workspace.md` §2b (D-16…D-22). In short:

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

Schema (all additive, none applied): S-08…S-12 in `context/features/01-salesrep/round2-deal-workspace.md` §2b. Notes (was wave 3) and
pricing move to waves 4 and 5, deliberately behind the ticket model.

## Round 2 – post-merge cleanup (2026-09-18)

Leftover naming from the merge removed; everything on this screen is now "pipeline".

- `components/deals/*` → `components/pipeline/*` (DealList, DealDetail, DealFilters, InteractionSheet, NextActionEditor)
- `lib/queries/deals/*` → `lib/queries/pipeline/*`
- `lib/actions/deals/index.ts` merged into `lib/actions/pipeline/index.ts` — one `"use server"` file, two guard levels
  (`lib/commands/pipeline.ts` = manager, `lib/commands/dealWork.ts` = owner or manager); the command split stays.
- `app/dashboard/clients/**` deleted (the redirect stubs) and its route-guard line removed — the route is gone (404).
- Navbar and page title say **Pipeline** for every role, including SALES_REP; the dashboard's two duplicate buttons
  merged into one.

No behaviour change beyond the labels and the removed redirects. Checks: `tsc` clean (after a rebuild regenerated
`.next` route types), `eslint` only the known `MobileNav.tsx` error, `next build` OK, client sections pass,
concurrency **67/67**, HTTP role checks **35/35** (four assertions updated to the new expectations: `/dashboard/clients`
is now 404, the rep's nav and title say Pipeline).

## Round 2 – wave 3a: what the client received (DONE on the test branch, 2026-09-18)

Design: `context/features/01-salesrep/round2-deal-workspace.md` §2c (folded in from the reviewed proposal, which was then
deleted). Also agreed there: no automatic tickets from wave 3 on (D-17 updated), team sanity warnings as a later item.

Baseline before any change: `npx tsc --noEmit` clean.

Log:

- Schema: test endpoint verified (`…nhww8x`, db `neondb`). `prisma validate` OK. Reviewed `migrate diff` SQL — exactly
  `ActivityType += OFFER_SENT, CLIENT_REPLIED`, `Design.legacySentAt`, `Lead.hadLegacySends` (NOT NULL DEFAULT false),
  `Lead.legacySendsReviewedAt`, `Lead.offerAboutUsAt`, `Lead.offerPriceAt`, `Lead.offerPricelistAt`; nothing else, all
  additive.
- Schema applied on test: `npx prisma db push` — "now in sync", **no data-loss warning**; `npx prisma generate` OK; a
  second `db push` reports "already in sync".
- New script `prisma/backfill/2026-09-offer-legacy.ts` (the one-time legacy step: `Lead.hadLegacySends`,
  `Design.legacySentAt`; only sets values, repeatable; dry-run / `--apply` on direct host with `--confirm` / `--verify`).
  On test: dry-run → 28 leads + 5 designs to mark; `--apply` (direct host) COMMITTED 28 + 5; `--verify` OK (0 left).
- Code (server): `lib/domain/offers.ts` (pure: contents, meta schema, ordering, `summarizeOffers`, `clientKnowledge`),
  `lib/domain/offerMutations.ts` (`recomputeOffers`, `recordOffer`, `correctRecord`), `lib/commands/offers.ts`
  (`recordOfferSentAs`, `correctRecordAs`, `confirmLegacyReviewedAs`), `activityReplay` in `lib/domain/idempotency.ts`,
  `lib/domain/designLinks.ts`. `logFollowUpAs` now takes `contact` (CALL / REPLIED / SMS / NONE) and `phonePrice`; the
  input schema is strict. Deleted old write paths: actions `setQuoteSent`, `setDealQuoteSent`, `logSent`,
  `logDealEmailSent`, `setPriceDisclosed`, `setDealPriceDisclosed`, `logBusinessActivity`, `setDesignSent`; commands
  `setQuoteSentAs`, `logSentAs`, `setPriceDisclosedAs`, `setDealQuoteSentAs`, `logDealEmailSentAs`,
  `setDealPriceDisclosedAs`, `setDesignSentAs`; domain `setQuoteSent`, `logSent`, `setPriceDisclosed`; notes are `NOTE` only.
- Code (UI): new `OfferSentDialog` ("Čo sme poslali", incl. historical mode), `components/shared/copyEmailLink.ts`;
  `CenovaPonukaCard` → "Cena & ponuky" (what the client got, "?", price-mismatch warning, legacy ⚠ + review);
  action sheet: "📨 Poslali sme ponuku" / "💬 Poslali sme SMS", "Povedal/a som cenu", truthful contact type; detail:
  "Naposledy" from `lastTouch`, "Email o nás" card removed, crossed-out history rows + "Opraviť", SR návrh copy button;
  design card: "Odoslané…" opens the shared dialog + "Odkaz do emailu"; list chips cenník/cena/návrh/⚠; pills "Poslať
  cenu", "Dostali cenník/cenu/návrh", "Neoverené" (manager); labels for WANTS_QUOTE/WANTS_EMAIL/SEND_QUOTE/SEND_EMAIL.
- Found while writing tests and fixed before the run: a back-filled (historical) entry would have shown as "Naposledy";
  a návrh's sent date is now the **earlier** of the first new send and the legacy date (the design text said "new send,
  else legacy", which would move an old date forward — §2c 4.2 updated to match).
- `npx tsc --noEmit` clean.
- `check-concurrency.ts --expect-endpoint …nhww8x --iterations 100`: **80/80**. The 67 existing checks all pass (four
  were rewritten because their commands were deleted: the CP-sent, design-sent and revision checks now use
  `recordOfferSentAs`, and the revision check also covers `correctRecordAs`); 13 new W3a checks: A record +
  idempotency (parallel same key = one row; two different submits on one revision = one wins, one STALE), B price
  snapshot, C corrections order-independent + design first-sent/legacy date, D legacy "?" / historical mode / review,
  E truthful contact types + streak reset by a written reply, F phone price, G correction permissions + "Naposledy",
  H ordering rule.
- Checks after the code change (test branch `…nhww8x`): `npx eslint .` only the known `MobileNav.tsx` error (two new
  findings of mine — a straight quote in Slovak text and unused imports left in `lib/commands/tracking.ts` — fixed);
  `npx tsc --noEmit` clean; `npx next build` OK; `check-business-time.ts` 33/33 local and 33/33 `TZ=UTC`;
  `check-client-sections.ts` 19/19; `check-backfill-delta.ts` 6/6; round-1 backfill `--verify` clean;
  `2026-09-offer-legacy.ts --verify` OK (0 left); HTTP role checks **42/42** against `next dev` (35 previous + 7 new:
  rep detail shows "Cena & ponuky" and no old send buttons, `?zaznam=ponuka` renders, "Neoverené" pill only for the
  manager and lists a legacy deal, the legacy review panel renders, the calls screen has the new labels).
- Gate grep: no writes of `quoteSentAt` / `aboutUsSentAt` / `priceDisclosed` / `QUOTE_SENT` / `EMAIL_SENT` /
  `DESIGN_SENT` left outside `prisma/backfill` (only reads in the detail's legacy block); `Design.sentAt`,
  `Lead.designSentAt` and `Lead.offer*` are written only by `recomputeOffers`.
- Docs updated to what now exists: `context/domain/database-map.md`, `context/domain/operations.md`,
  `context/domain/db-changes.md` (§3 wave 3a delta + data step + production order), `context/app-workflow.md` (§5, new
  §5a, §6, §7, §9), `context/project-overview.md` (§6, §7), `context/architecture.md`, `context/ui-context.md`;
  feature design §2c status + the design-date row, D-19 note.

Deviations from §2c, for review:
- From the **list**, "📨 Poslali sme ponuku" opens the deal detail with the dialog already open (`?zaznam=ponuka`);
  the dialog needs the deal's designs and price, which the list does not load. From the detail it opens in place.
- `Design.sentAt` = the earlier of the first new send and the legacy date (see the fix above).
- The manager's "not your deal" question is a browser confirm dialog.

Not done / still open:
- **Human click-through** (not verifiable by the agent): the "Čo sme poslali" dialog on phone and desktop (defaults,
  price edit, date picker, návrh copy → paste into Gmail shows the clean address), "Povedal/a som cenu", SMS,
  "Opraviť", the legacy panel + "Doplniť starý záznam" + "Hotovo", the new pills and list icons.
- Production still owes round 1, wave 2 and wave 3a (`context/domain/db-changes.md`); nothing was touched there.
- Wave 3 (manager tasks — `wave-3-task-proposal-final.md`) is next: remove the automatic DESIGN ticket and all automatic ticket closing in one change (§2c §6,
  §9a); team sanity warnings are listed as a later item in §2c §10.

## Round 2 – wave 3b: deal detail rework (DONE on the test branch, 2026-09-18)

Design: `context/features/01-salesrep/round2-deal-workspace.md` §2d (from Michal's testing of 3a). Backup before any
change: local commit `1dae205` ("Backup wave 3a … before 3b detail rework", not pushed). No schema change planned.

Log:

- Design and notes recorded in §2d (incl. two later items: a sort choice for the pipeline, and "Pozreli, chcú zmeny"
  needing a manager path in wave 3). Backup commit `1dae205`.
- **No redirect:** list rows carry `dialog` (`OfferDialogDeal` in `lib/domain/offers.ts`: price, breakdown, what the
  client got, designs with the copy link); `DealList` opens `OfferSentDialog` in place. The `?zaznam=ponuka` path is
  removed.
- **Follow-up date:** `recordOfferSentAs` accepts `followUpOn` (≥ today, only with `followUp`); the dialog shows a date
  field (default +7 days).
- **Detail:** `NextActionEditor` deleted; new "Ďalší krok · Naposledy" card (two tiles, one "Zaznamenať kontakt");
  "Zmeniť krok" opens the action sheet in a `replan` mode (next-step screen, pre-filled, contact `NONE`). Quick events
  and the free note field removed. The now-unused actions `setNextAction`, `setDealNextAction`, `addBusinessNote`,
  `addDealNote` deleted (their commands stay for the check scripts).
- **"Bez kontaktu" keeps the deal's status** (a snoozed deal stays snoozed when re-planned) — without this, "Zmeniť
  krok" on a snoozed deal would have woken it.
- **Price edit popup** replaces the inline edit (3a's inline form kept stale values after a save — the reported bug).
- Checks (test branch `…nhww8x`): `tsc` clean; `eslint` only the known `MobileNav.tsx` error (unused imports left in
  `lib/actions/pipeline/index.ts` removed); `next build` OK; business time 33/33 + 33/33 `TZ=UTC`; client sections 19/19;
  concurrency **83/83** (80 + W3b-A replan keeps SNOOZED and writes no call, W3b-B follow-up day used / past day and
  day-without-follow-up refused, W3b-C list row carries the dialog data); HTTP role checks **43/43** — the `?zaznam`
  assertion was replaced by two layout checks. One of them failed on its first run because it looked for the quick-event
  text, which still exists as an old history note on that test deal; the assertion was changed to look for the removed
  section's own heading and placeholder, not the code.
- Docs: `context/domain/operations.md`, `context/app-workflow.md` (§5, §5a, §7), feature status.

Still open: human click-through of the new card, "Zmeniť krok", the price popup, the follow-up date field and the
in-place dialog from the list.

Follow-up after Michal's testing (2026-09-18, same wave):
- **The last send stays visible:** after a later call, "Naposledy" no longer hides that we are waiting on a návrh / price.
  The list row, the detail's "Naposledy" tile and the action sheet header show "Odoslané: návrh smrek1 · 15. 9."
  (`offerSummary`, `lastOfferOf` in `lib/domain/offers.ts`; list rows get `lastOffer` from one query per page; detail
  gets `lastOffer`).
- **No browser popups in the new flows:** the manager's "not your deal" question in "Čo sme poslali" and "Hotovo – toto
  je všetko" are now in-app confirmations. Older `window.confirm` uses elsewhere (user deactivation, batch release,
  call revert, contact delete, mark WON) are unchanged.
- Checks: `tsc` clean; `eslint` only the known `MobileNav.tsx` error; `next build` OK; concurrency **84/84** (+ W3b-D:
  list and detail keep showing the last send after a later call). HTTP role checks not re-run for this small UI change.

Third external review of 3a/3b (ChatGPT, read-only) — all 8 findings checked against the code, all real, all fixed:
- R3-1 "Čo sme poslali" offered to replace the step even when the ticked contents did not complete it (e.g. step
  "Poslať cenu", only the cenník ticked). The default now follows the ticked contents; the user can still choose.
- R3-2 a design marked sent by old code after the one-time step, then sent again by the new system, lost its old date.
  `recordOffer` now baselines such a design's date into `legacySentAt` before the first new send.
- R3-3 the list's page fetch did not re-apply the scope (a deal transferred between the two queries could appear once).
  One-line fix: the page fetch uses the scope too.
- R3-4 a legacy lead with `Lead.designSentAt` but no `Design` row showed "návrh" as not sent. The one-time step counts it
  as legacy evidence, and list/detail fall back to `Lead.designSentAt` when the lead has no design rows (on test the
  step found no such lead — dry-run 0 new).
- R3-5 `activityReplay` ignored the content: the same key with different contents returned a false "saved". Now a
  content fingerprint is compared (send contents/date/designs; SMS text; reply outcome+text) → `IDEMPOTENCY_CONFLICT`.
  The W3a-A check that accepted the old behaviour was changed to expect the conflict.
- R3-6 a historical entry showed up as "Odoslané" under "Naposledy"; and "Naposledy" counted any business row (e.g. a
  ticket). Now "Naposledy" = real client contact only (`LAST_TOUCH_TYPES`), and historical sends are excluded.
- R3-7 deleting a sent design left `Lead.designSentAt` stale. `removeDesignAs` now recomputes.
- R3-8 a phone price with a new amount inherited the old breakdown. A new amount without a breakdown clears it, the
  same amount keeps it, and the sheet has a breakdown field. The phone price row in the history reads "↳ Cena povedaná
  v hovore" under its call.
- Checks: `tsc` clean; `eslint` only the known `MobileNav.tsx` error; `next build` OK; concurrency **90/90** (84 + R3-2,
  R3-4, R3-5, R3-6, R3-7, R3-8; R3-1 is a UI default and R3-3 a query filter, not separately tested);
  `2026-09-offer-legacy.ts` dry-run 0 new. HTTP role checks not re-run for these changes.
- Recorded in §2d: the "Naposledy" definition, the read race, and the later decision whether to fully migrate old sends
  into `OFFER_SENT` instead of keeping a legacy layer (possibly non-additive).

Prepared (not applied): **full migration of old sends instead of the legacy layer** (Michal's proposal after the
reviews kept finding legacy edge cases):
- New script `prisma/backfill/2026-09-offer-migrate.ts` (dry-run + review CSV, overrides JSON for anything it cannot
  decide, `--apply` guarded like the other backfills, `--verify`). `meta.migrated` added to the `OFFER_SENT` meta schema
  (optional; nothing writes it yet).
- Dry-run on test (`--pricelist-from 2026-09-01`): 28 deals, 27 events converted automatically, 5 deals need a
  decision. Nothing written.
- Rules, production order, the list of legacy code to delete and the schema consequence (additive if the legacy columns
  are simply not added to production; dropping the old send fields would be non-additive) are in
  `context/domain/db-changes.md` §3.3; pointers in the feature §2d, `operations.md`, `ai-workflow-rules.md`.
- `tsc` clean; `eslint` on the script clean. The legacy layer is unchanged until Michal decides.

## Test database reset (2026-09-18)

At Michal's request the test branch was wiped and reseeded before designing wave 3, so old test "požiadavky" do not
shape the design. New script `prisma/dummySeeds/seedTestWorld.ts`: refuses unless (1) `--confirm` equals the
`DATABASE_URL` endpoint ending in the test suffix, (2) that endpoint differs from the commented-out production URL in
`.env` (compared in memory, nothing printed), (3) the schema has test-only objects (`DealRequest`,
`Lead.hadLegacySends`). Pre-check: current `…nhww8x`, production `…m0xyun`, different. Then `TRUNCATE` of all app tables
and a fresh world built **through the app's own commands** (claims, first calls, follow-ups, sends, a design, WON):
48 contacts, 12 deals (t_michal 3, t_rep/Jana 6, sales/Samo 3), 5 sends, 0 tickets; two routing setups (Timea →
Michal via "Obchod", Tereza → Jana via "Tím Jana"). All accounts: password123. Round-1 backfill `--verify`: clean,
0 CONFLICT. The concurrency suite creates its own fixtures and is unaffected; the HTTP role script's accounts exist.


## Wave 3: manager tasks, step lock, handover, História, counters (DONE on the test branch, 2026-09-19)

Design: `context/features/01-salesrep/wave-3-task-proposal-final.md` (official). Order: its §10 steps 0–6.
Database: Neon **test** endpoint `…nhww8x` only; production `…m0xyun` (commented out in `.env`) never touched.

| Step | Scope | Status |
|---|---|---|
| 0 | Wipe test DB + minimal seed (users + ~50 scout contacts) | DONE |
| 1 | Schema (`DealTask`, `DealOwnership`, `Activity.taskId`, enum changes) via reviewed SQL | DONE |
| 2 | Domain (`tasks.ts`, `taskMutations.ts`, lock, owner transition, section rule + SQL twin) | DONE, tested |
| 3 | Commands + actions (tasks, freshness/keys on manager commands, fact-only / overlap / cancel+change, D14 refusal, bulk op id) | DONE, tested |
| 4 | Queries (rows, detail, pending items, pills + counts, História, dashboard) | DONE, tested |
| 5 | UI | DONE; Michal's first click-through → feedback round below (DONE) |
| 6 | Docs, checks, HTTP role checks | DONE |
| – | Michal's click-through feedback (ask dialog, automatic step, default manager, UI polish) | DONE, see log |

Log:

- **Step 0 (2026-09-19).** `prisma/dummySeeds/seedTestWorld.ts` got a `--minimal` mode (same triple guard; the schema
  fingerprint now accepts `DealRequest` **or** `DealTask` next to `Lead.hadLegacySends`, so the guard still works after
  wave 3; the wipe truncates only tables that exist). Run: identity OK (`…nhww8x` ≠ production), all app tables
  truncated, seeded users `admin` (ADMIN), `sales` (SALES_REP), `manager` (MANAGER, leads team "Obchod"), `telesales`
  (TELESALES, member of "Obchod" → its positive calls route to `manager`), `scout` (SCOUT, member of "Skauti"),
  `scoutleader` (SCOUT_LEADER, leads and is a member of "Skauti"); password `password123`. 50 contacts by `scout`, all
  NEW and unclaimed; 0 activities, 0 deals. The full-world mode still exists (its old accounts `t_*` are gone now).
- **Step 1 (2026-09-19).** Pre-check on test: `DealRequest` rows 0, `REQUEST_*` activities 0, leads with
  `nextActionKind = ORDER` 0. Schema edited (S-08…S-11); `prisma migrate diff` SQL generated outside the repo and
  reviewed statement by statement: `ActivityType` recreated with all 22 remaining values + 7 `TASK_*` (no default on
  the column, cast via text, 0 affected rows), `NextActionKind` recreated without `ORDER` (no default), `DealRequest` +
  its two enums dropped (0 rows, test-only), new `DealTask`, `DealOwnership`, 4 enums, `Activity.taskId` (nullable, FK
  `ON DELETE SET NULL`, indexed). Endpoint re-verified (`…nhww8x`), applied with `prisma db execute`; `prisma db push`
  → "already in sync"; `prisma generate` OK. No `--accept-data-loss`. The partial unique index "one OPEN task per deal"
  was **not** added: Prisma cannot declare it, so `db push` would treat it as drift; the rule is enforced in the command
  under the Lead lock (design §4.1 allowed either).
- **Steps 2–5 (2026-09-19), code written; `tsc` clean for the app, `eslint` only the known `MobileNav.tsx` error.**
  Domain: `lib/domain/tasks.ts` (pure), `lib/domain/taskMutations.ts` (lock guard, pending items, I10, dismissals,
  cancel, `fulfils` validation, `recordOwnership`, the shared owner transition, create / message / finish / decline /
  reassign), `lib/domain/leadWrites.ts` (`updateLead` / `hadNextAction` moved here so the two mutation modules do not
  import each other; `dealMutations` re-exports them). `ORDER` removed from `nextStepOptions` / `leadFlow` /
  dictionaries; "Chcú objednať" is an ordinary reply; `WANTS_DESIGN` no longer creates anything (D9); F1 `stepNote`.
  Deleted: `lib/domain/dealRequests.ts`, `lib/queries/pipeline/requests.ts`, `components/pipeline/RequestsCard.tsx`,
  the request commands/actions, `ClosedPolicy "reopenRequestOnly"`. Commands: new `lib/commands/tasks.ts`;
  `logFollowUpAs` (fact-only, overlap, cancel + change, dismissals, F1, full fingerprint), `recordOfferSentAs`
  (fact-only while locked, overlap, `fulfils`, dismissals, full fingerprint), manager status / lost / reopen / owner
  with `expectedRevision` + key, bulk transfer with `operationId` + `bulkFp` + per-lead transition, first-call handoff
  and revert write `DealOwnership`, deactivation / role change refused with held deals or tasks. Queries: one predicate
  per pill for list and count, `STEP_LOCKED_SQL`, rows/detail carry the task, lock and pending items, "Pre mňa",
  "Čakám na manažéra", História, dashboard "Čaká na mňa". UI: `AskManagerDialog`, `TaskCard`, `FinishTaskDialog`,
  `TakeoverDialog`, reworked `InteractionSheet`, `OfferSentDialog`, `DealList`, `DealFilters`, `DealDetail`,
  `TransferDealsDialog`, dashboard, `/dashboard/pipeline/historia`, `DesignTrackingCard` (R17).
- **Tests for steps 2–5 (2026-09-19).** `check-concurrency.ts`: existing tests adapted (handoff writes
  `DealOwnership`, `dealLifecycle` replaces the request test, revision steps include the task commands, inbox, today
  parity, W2 order reply, W3a legacy, W3b replan with `stepNote`, W3c last-touch rules) and new wave 3 tests `w3Create`,
  `w3Lock`, `w3Overlap`, `w3Finish`, `w3Results`, `w3Handover`, `w3OwnerTransition`, `w3Deactivation` (staggered race so
  both orders are exercised), `w3Freshness`, `w3LockParity` (TS ↔ `STEP_LOCKED_SQL`), `w3History`, `w3Fingerprints`,
  `w3InboxHref`, `w3TaskRowsNotLastTouch`, `w3SheetNotes`. `check-client-sections.ts` updated to `stepLocked`.
  `check-backfill-delta.ts` got `--caller-username` (the minimal seed has no `t_timea`).
- **Michal's click-through feedback (2026-09-19)** — fixed:
  1. *The ask dialog's note looked like the company note.* It was pre-filled with the last call note. Now it is an
     empty **"Správa pre manažéra"** that belongs only to the task (placeholder by content, "Vidí ju manažér pri úlohe.
     Poznámku klienta nemení."). It never wrote `Lead.note`; it is `DealTask.text` (verified in `createTask`).
  2. *Manager chosen from nothing every time.* New `getResolverOptions(viewerId)` marks the rep's default manager
     (`mine`): the leader of her team, else the manager she asked last. The dialog shows it as a line ("NM Nikolas
     Manažér · tvoj manažér · Zmeniť"); "Zmeniť" reveals the list. Seed: `sales` is now a member of "Obchod"
     (`seedTestWorld.ts --minimal`); on test the same was set directly (`User.teamId` of `sales`, endpoint checked).
  3. *Next step chosen in the dialog, buggy on a second ask (only "Poslať cenu / Poslať návrh").* The step is no longer
     chosen: new pure `stepAfterTask` (`lib/domain/tasks.ts`) — Cena → "Poslať cenu", Návrh → "Poslať návrh", Iné → the
     current step stays (optional "Zmeniť"); the note stays when the kind does not change; a pending návrh narrows to
     "Poslať návrh" (I10). The server derives the same step when the client sends none; a `step` is accepted only for
     "Iné" (I10-checked) or when it equals the derived kind (else `STALE`). `allowedFollowUpKinds` /
     `defaultFollowUpKind` removed. The "second ask" symptom was I10 narrowing the old two-button picker; the dialog now
     explains it ("Ešte neposlané: cena 1 285 € – krok ostáva „Poslať…“").
  4. *Content = one choice now; price + návrh together is wave 4.* The dialog is a 3-tile single choice. Marked
     `[WAVE 4]` in `AskManagerDialog.tsx` and at `stepAfterTask`; backlog BL-12; `app-workflow.md` §6.1.
  5. *UI polish.* `AskManagerDialog` rewritten (section labels, tiles with icons, stable primary button "Odoslať –
     Nikolas" with the missing-field hint under it, derived step as a summary card, no appearing/disappearing buttons).
     `TaskCard` rewritten (status badge "čaká na manažéra · Nikolas", request in a quote box, "Po vybavení: Poslať
     cenu", chat-style message thread with a send button, actions in one row — "Presunúť…" hidden behind a button,
     returned items as a list with icons and a direct **"Poslať klientovi…"** that opens "Čo sme poslali"; manager sees
     them as "Vrátené obchodníkovi – ešte neposlané klientovi"; closed tasks under "História úloh"). `FinishTaskDialog`
     restyled (request shown on top, € suffix, "Hotovo – odoslať výsledok"). Labels no longer build Slovak datives from
     names ("Hotovo – vrátiť Jana" → "Hotovo…"). "Vybavil som to sám…" → "Poslal som to sám…".
  - New test `w3AutoStep` (5 checks: the pure matrix, price keeps "Poslať cenu" + note, call → "Poslať cenu", design,
    other keeps step + note, other with a chosen step, price with a different step refused, pending návrh narrows,
    default manager = team leader / last asked / none).
  - Browser check (dev server, desktop and 375 px phone, as `sales` and `manager`): ask with Cena (step shown fixed),
    Návrh, Iné (+ step change), manager "Zmeniť"; task card as rep and manager; manager "Hotovo" with 1 285 € → the rep
    sees "Od manažéra – ešte neposlané klientovi" with "Poslať klientovi…"; a second ask with the price pending shows
    "Poslať cenu" and the explanation. Fixture deal removed afterwards.
- **Step 6 — docs (2026-09-19).** `context/domain/database-map.md` (DealTask, DealOwnership, `Activity.taskId`, task rows
  and their meta, `OFFER_SENT.fulfils` / `fp`, keyed main rows, locked step, invariants; DealRequest / ORDER /
  `REQUEST_*` removed), `context/domain/operations.md` (task domain / commands / queries, keyed manager commands,
  `runKeyed`, `ownerTransition`, `getResolverOptions`, `getHandedOverHistory`, seed script; request operations removed),
  `context/domain/db-changes.md` **rebuilt from zero** as the net delta baseline `7beb689` → current test schema,
  regenerated offline with `prisma migrate diff --from-schema … --to-schema …` (0 `DROP`, 0 retype: all additive;
  DealRequest / `REQUEST_*` / ORDER listed as "added on test and removed again — nothing owed"; wave 3 data step: none),
  `context/app-workflow.md` (wave 3 shipped, §6 rewritten, `[WAVE 4]` marker), `project-overview.md` (roles,
  permissions, História route), `ui-context.md` (counts on every pill, dialog conventions), `architecture.md`
  (`tasks.ts` split, wave 3 error codes), `features/backlog.md` (BL-01 / BL-09 past tense, BL-12 new). The feature design
  file was not edited.
- **Checks (final, 2026-09-19, after the feedback round).** DB identity: `…nhww8x`, database `neondb` (production
  `…m0xyun` untouched). `npx tsc --noEmit` clean. `npx eslint .` → only the known `MobileNav.tsx`
  `react-hooks/set-state-in-effect` error (pre-existing). `next build --webpack` OK, 20 routes incl.
  `/dashboard/pipeline/historia` (built in a scratch copy so Michal's running dev server was not disturbed; the Turbopack
  build refused the copy's junctioned `node_modules`; the earlier Turbopack build of steps 2–5 passed). Business time
  local + `TZ=UTC`: passed. Client sections: passed. `check-concurrency --iterations 100`: **139/139**.
  `check-backfill-delta --expect-db neondb --owner-username admin --caller-username telesales`: 6/6. HTTP role checks
  (`.claude/http-roles.ts`, signed local sessions, all six roles): **30/30** — counts are now read from the DB (the test
  data may contain Michal's own tasks) and the "not found" checks read the raw HTML (Next streams `notFound()` after
  `loading.tsx`, so the status stays 200; the page carries the 404 marker and no deal name).

- **Implementation review R01 (`.ai/reviews/01-sales-rep/W3/implementations/R01.md`, 2026-09-19)** — all five
  findings accepted and fixed:
  1. *Embedded dismissals bypassed the owner rule.* New `assertDecidesResults(lead, actor)` (`taskMutations.ts`) is
     called before every user dismissal: `dismissResultsAs`, `recordOfferSentAs`, `logFollowUpAs` (closing a deal
     stays a system dismissal). Client: `OfferSentDialog` / `InteractionSheet` send dismissals only when the viewer
     decides (owner, or manager on an ownerless deal) — a manager on a rep's deal records the fact, older / leftover
     items stay with the owner, "Neposielam" and "Beriem na vedomie" are hidden for him, and a step other than
     "Poslať…" is blocked with "Rozhoduje vlastník".
  2. *"Poslal som to sám" without the follow-up left "Poslať cenu" due today.* The follow-up call is now mandatory
     (`followUp` only `true`; the checkbox is gone, the day stays editable). Found while fixing: if an **older**
     returned price / návrh is still unsent, a call would violate I10 — then no call is planned and the step stays
     "Poslať…" for that item (the dialog says so).
  3. *Reopen could make a deactivated / demoted user own a live deal.* Reopen (`reopenDealAs` and the status select)
     now locks the retained owner before the Lead (`manageWithOwner`) and, if the owner is deactivated or lost
     `deals.receive`, hands the deal to the reopening manager (or to nobody if he cannot own deals) through
     `ownerTransition` — `OWNER_CHANGED` + `DealOwnership(CHANGE)`, same transaction and revision. **Confirmed by Michal
     (2026-09-19):** the reopening manager gets it and can transfer it (review offered three options); a concurrent deactivation waits on the owner lock and then sees the open deal.
  4. *Spec vs shipped.* The official `wave-3-task-proposal-final.md` now carries dated "decision update 2026-09-19"
     entries in D3 (derived step) and D4 (one content now, both = wave 4), §1 situation 3, the §1d note pre-fill and
     the §6.1 mock-up / follow-up rule; `round2-deal-workspace.md` §2b summary says "implemented" and points to the
     update. Original texts are kept as history.
  5. *Send with `KEEP_OPEN` could still cancel the task.* `recordOfferSentAs` now requires `cancelTask` ⇔
     `overlap: CANCEL_TASK`, with a non-empty reason (no silent "už to netreba").
  - New test `w3R01` (4 checks: embedded dismissals by a manager refused / plain call + send allowed / owner allowed;
    finish-and-send opt-out refused, default call, older návrh keeps "Poslať návrh"; reopen with a deactivated and a
    demoted owner → the manager owns it with ownership rows, a valid owner stays, pure "nobody eligible" case; three
    invalid overlap / cancel payloads refused, task stays open). Docs: `operations.md`, `app-workflow.md`.

- **Implementation review R02 (`.ai/reviews/01-sales-rep/W3/implementations/R02.md`, 2026-09-19)** — R01 fixes
  verified by the reviewer; new findings:
  1. *Stale role in a profile save.* `updateUserProfileAs` now locks the User row (`SELECT … FOR UPDATE`) before reading
     the old role, and checks held deals / tasks against the **new** role's permissions whatever the old role was — a
     stale form can no longer leave work on a user who cannot do it.
  2. *Hidden overlap choice made "Čo sme poslali" unsaveable.* `OfferSentDialog` and `InteractionSheet` use the choice
     only while the contents (or the told phone price) still overlap the task; otherwise nothing is sent and the
     choice reappears if the content is ticked again.
  3. *"N. pokus" tie order.* `noAnswerStreaks` orders by `(createdAt, id)` and treats an empty outcome like the detail
     does; the list's "Naposledy" query also got the `id` tie-breaker. (Call-stage lists — `queries/calls`,
     `queries/contacts` — still order by `createdAt` only; out of wave-3 scope.)
  4. *Spec leftovers.* `wave-3-task-proposal-final.md`: "chosen" → derived step, finish-and-send fingerprint without a
     follow-up choice, reopen's fixed step, §6.11 invalid-owner rule, §6.12 race rule.
  5. *Backup folder deleted.* Michal deleted `context/features/01-salesrep/backup/` himself (no longer needed) — not
     restored; the wave-3 spec header says so.
  - New test `w3R02` (2 checks). The UI state fix (2) has no automated component test (no component test setup);
    it is a derived value in both dialogs.
- **`[WAVE 4]` markers in code** (comments only): `AskManagerDialog.tsx`, `tasks.ts` (`stepAfterTask`,
  `returnedItems`), `taskMutations.ts` (`pendingByLead`), `OfferSentDialog.tsx`, `FinishTaskDialog.tsx`.
- **Implementation review R03 (`.ai/reviews/01-sales-rep/W3/implementations/R03.md`, 2026-09-19)** — R02 fixes
  verified by the reviewer. Fixed the one wave-3 bug (R03-1): with a returned price and návrh, sending the návrh first
  and the price last defaulted to keeping "Poslať návrh" although nothing was left to send. New pure
  `sendCompletesStep` (`lib/domain/tasks.ts`): a send also completes a "Poslať…" step when it consumes (sends or
  dismisses) the last pending returned price / návrh; `OfferSentDialog` uses it for the default. The server already
  accepted the follow-up in both orders. New test `w3R03` (2 checks: pure matrix; both orders on the DB → CALL).
  Checks: tsc clean, eslint only `MobileNav.tsx`, client sections OK, `check-concurrency --iterations 100` 147/147.
  (Findings 2–6 are wave-4 design, handled in the feature files.)

### Wave 3 — not resolved / to do later

- **Human click-through still owed** for the rest of wave 3 on a phone and desktop: overlap choice in "Čo sme poslali"
  and in the call sheet, cancel + replan / snooze / close, handover accept / decline, takeover, owner change with a task,
  bulk transfer with tasks, História, deactivation refusal.
- **Send dialog with items left over:** when some returned items stay unsent, the kept "Poslať…" step's date and note
  cannot be edited in the same dialog (it points to "Zmeniť krok").
- **Reopen has no step choice** (always "Zavolať" today, `REOPEN_STEP_NOTE`).
- **A manager cannot cancel + replan** another rep's task (only by closing the deal) — as designed (the owner decides);
  revisit if it is annoying in practice.
- **"Pre mňa" / counts cost:** `getDealCounts` runs one id query per counted pill (13 per page load). Fine at today's
  volume; measure before production volumes grow.
- `getResolverOptions` "last asked" reads `DealTask` by `requestedById` without an index — fine now; add
  `(requestedById, createdAt)` in a later schema change if the table grows.
- The **full-world seed** mode (`seedTestWorld.ts` without `--minimal`) was not re-run after wave 3.
- Pre-existing, not wave 3: hydration warning from `DarkModeToggle` (`aria-label` differs server vs client) shows as
  "1 Issue" in the dev overlay; `MobileNav.tsx` eslint error.
- `DealTask.contents` accepts several contents while the UI sends one — keep until wave 4 (BL-12) decides the combined
  step.
- **Production owes everything** (`context/domain/db-changes.md`): the §1 schema, the §2 data steps, the §3.3 old-send
  conversion. Nothing was applied there.
