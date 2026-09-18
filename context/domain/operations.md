# Operations

Reusable server code that exists **today**. Reference, not tutorial: what it does, what it guards, what it bumps.
If you need one of these behaviours, call it — do not re-implement it. Adding or removing one? Update this file in the
same change. Anything marked **unused** exists but has no caller; do not build on it without reading its note.

Layer meaning: `access` = guard/lock helper · `command` = transaction body taking an `AccessUser` · `domain` = pure rule
or shared mutation body · `query` = scoped read.

## Access / locking (`lib/access/`)

| Operation | Notes |
|---|---|
| `requireUser()` | current **DB** user (`deletedAt: null`) as `AccessUser`, not `session.user`. Returns `null` when logged out or deactivated; the caller redirects (`/login?deactivated=1`). |
| `withLockTx(fn, { lockTimeout?, timeout? })` | interactive transaction with `SET LOCAL lock_timeout` (default `5s`); deadlock / lock timeout become `RETRYABLE` via `toActionError`. |
| `lockUsers(tx, ids, "SHARE" \| "UPDATE")` | locks user rows one by one, ascending id; returns found users (deactivated included). |
| `lockUserModes(tx, [{ id, mode }])`, `lockTeams(tx, ids, mode)` | mixed modes in one ascending pass / team rows. Lock order `Team → User → Lead`. |
| `lockLeadRow(tx, id)` | `SELECT … FOR UPDATE`; `false` when the row is gone. |
| `lockLeadWithUsers(tx, leadId, userIds, { expectedRevision })` | reads `assignedCallerId` without a lock, locks those users `FOR SHARE`, locks the lead, re-validates that the assignee did not change; `STALE` on revision mismatch. Used by the deal guards. |
| `requireCallLead(tx, user, leadId, expectedRevision?)` | call-stage mutation guard: `calls.work`, lead in the call stage **and** assigned to the actor, else `NOT_ASSIGNED`. |
| `requireDealWork(tx, user, leadId, { expectedRevision, closedPolicy, lockUserIds })` | deal mutation guard for **owner or manager**; not in scope ⇒ `NOT_FOUND`. `closedPolicy`: `reject` (default, closed ⇒ `DEAL_CLOSED`) / `reopenRequestOnly` (only on a closed deal) / `allow` (manager only). Returns `{ lead, actor, users, isManager }`. |
| `requireDealManage(tx, user, leadId, { expectedRevision, lockUserIds })` | manager-only guard (`deals.manage`), any deal state; non-manager ⇒ `NOT_FOUND`. |
| `requireDealView(db, user, leadId)` | **unused** since the round-2 merge. Round-1 read guard; it ignores `deals.viewTeam`. Do not use it — `getDealDetail` enforces scope inside its query. |
| `isOpenDealStatus`, `isClosedDealStatus` | `ACTIVE`/`SNOOZED` vs `WON`/`LOST`/`UNREACHABLE`. |
| `AccessError(code, message?)`, `toActionError(err, fallback, label)`, `UNAUTHENTICATED`, `FORBIDDEN`, `isUniqueViolation`, `isRetryableDbError` | error plumbing. Codes and the client's reaction: `context/architecture.md` §4. |

## Permissions and dictionaries

| Operation | Notes |
|---|---|
| `can(user, perm)`, `canAny(user, perms)`, `permissionsOf`, `roleOf` (`lib/permissions.ts`) | the only permission check. `ROLE_PERMISSIONS` is the matrix. |
| `requiredPermissionForPath(path)` | route guard used by `auth.config.ts` (run from `proxy.ts`). |
| `lib/dictionaries.ts` | every UI label for enums: `STATUS_LABEL`, `OUTCOME_LABEL`, `ACTIVITY_LABEL`, `ACTIVITY_SOURCE_LABEL`, `PROJECT_TYPE_LABEL`, `ROLE_LABEL`, `ROLES`, `CONFIDENCE_LABEL`, `NEXT_ACTION_LABEL`, `REQUEST_KIND_LABEL`, `REQUEST_STATUS_LABEL`. |

## Domain rules (`lib/domain/`)

| Operation | Notes |
|---|---|
| `leadFlow.ts` constants | `FIRST_CALL_OUTCOMES`, `HANDOFF_OUTCOMES` (`WANTS_QUOTE`/`WANTS_EMAIL`/`WANTS_DESIGN`) + `isHandoffOutcome`, `FOLLOW_UP_OUTCOMES`, `FOLLOW_UP_NEXT_KINDS` (next steps the interaction may pick — **no `ORDER`**). |
| `leadStateForOutcome(outcome, when, callbackNote, now)` | first-call transition → status, `callback*`, `keepsAssignment`, and for handoff outcomes the pre-filled `nextAction*`. Never writes `nextAction*` for non-handoff outcomes. |
| `dealStateForFollowUp(outcome, { when, nextKind, note, lostReason }, current, now)` | follow-up transition; throws on a closed deal. Date/mode rules come from `nextStepOptions`. `NO_ANSWER` honours an explicit `nextKind`/`when` and still records the miss. `WANTS_DESIGN` → `SEND_DESIGN` in progress + `DESIGN` request. `WANTS_TO_ORDER` → `ORDER` step + `ORDER` request. `NOT_INTERESTED`/`BAD_NUMBER` close. |
| `nextStepOptions.ts` | `NEXT_STEP_OPTIONS` (the one ordered list, `date: required/today/optional`, `mode`), `NEXT_STEP_KINDS` (whitelist for the strict zod schema), `nextStepOption`, `requiresDate`. The detail editor offers all of them; the interaction sheet filters to `FOLLOW_UP_NEXT_KINDS`. |
| `clientReplies.ts` | `CLIENT_REPLIES` ("čo povedali" menu), `REPLY_KEYS`, `replyOf`, `noteWithReply(key, note)` → `"Label – note"`. Stored as `Activity.meta.reply`. |
| `clientSections.ts` | `clientSection(deal, now)` → exactly one section + optional badge; `isDealOverdue`; `recentClosedLimit`; `CLIENT_SECTION_LABEL`. Its "Na dnes" rule is **duplicated in SQL** as `TODAY_SQL` (`lib/queries/pipeline/index.ts`) — change both together; see `context/code-standards.md` §5. |
| `dealScope.ts` | `dealScope(viewer, teamUserIds?)` → `own \| team \| all`; `scopeWhere`, `resolveOwnerFilter` (validates `?owner=`, falls back to "me"), `ownerFilterWhere`, `ownerFilterParam`. |
| `dealCapabilities.ts` | `dealCapabilities(viewer)` → what renders. Never a permission. |
| `dealFilters.ts` | URL model of the pipeline screen: `DEAL_STATUS_TABS`, `DEAL_VIEWS`, defaults (`DEFAULT_VIEW = "today"`, `DEFAULT_OWNER = "me"`), `isDealView`, `viewIgnoresStatus`, `parseDealParams`, `statusOf`, `viewOf`, `requestKindOf`, `dealsHref` (resets paging on any filter change). Safe to import from client components. |
| `dealMutations.ts` | shared deal mutation bodies used by both command files: `updateDealContact`, `saveQuote`, `setProjectType`, `setNextAction`, `addBusinessNote` (`NOTE` only), `changeDealStatus`, `closeDeal`, `markLost`, `reopenDeal`, `changeOwner`; helpers `updateLead` (one bump per transaction), `hadNextAction`, `followUpInSevenDays(sentAt)`; schemas `dealContactSchema`, `nextActionInputSchema`. Contact, quote, and next-action object inputs use strict Zod schemas; other inputs have specific command/domain checks, not blanket Zod parsing. Writes use named fields; each body bumps the revision at most once. |
| `offers.ts` | **what the client received** (pure, client-safe): `OFFER_CONTENTS` / `OFFER_CONTENT_LABEL`, `parseOfferMeta`, `offerNote`, `moneyToString`, `formatMoney`, `offerInstant`, `compareOffers` (order: `sentOn`, historical before normal on the same day, then `createdAt`), `summarizeOffers(rows)` (first about-us / cenník, last price + snapshot, first send per design; valid rows only), `clientKnowledge` (yes / "?" / no — legacy fields never mean yes), `legacyUnreviewed`, `isValidSentOn`. |
| `offerMutations.ts` | `recomputeOffers(tx, leadId)` — the **only** writer of `Lead.offer*`, `Lead.designSentAt`, `Design.sentAt`; `recordOffer(tx, actor, lead, input, source)` — writes one `OFFER_SENT` (price snapshot; saves the lead's price first if given), recomputes, optionally plans "Zavolať, či prišlo" in 7 days, and until wave 3 closes matching open requests (never for a historical entry); `correctRecord` — crosses out an `OFFER_SENT` / `SMS_SENT` / `CLIENT_REPLIED` (reason in `meta.correction`), recomputes; never touches the next step or requests; `CORRECTABLE_TYPES`. |
| `designLinks.ts` | `normalizeUrl`, `displayUrl`, `trackedUrl(targetUrl, token)`. |
| `dealRequests.ts` | `ensureOpenRequest(tx, leadId, kind, actor, note, source)` → one open request per (deal, kind), appends the note to an existing one, returns `{ created }`; `resolveOpenRequests(tx, leadId, kinds \| "ALL", status, …)` — call **only** from the business mutation that actually did the work; `closeRequestsForStatus(tx, leadId, status, actorId)` when a deal closes (WON → `ORDER` done, the rest cancelled). Requests are still also closed by `saveQuote` (PRICE) and `recordOffer` (PRICE / EMAIL / DESIGN) until wave 3. |
| `dealRouting.ts` | `resolveDealOwner(caller, leader)` — owner of a positive first call: (1) the caller if they have `deals.receive`, else (2) the caller's active team leader if they have `deals.receive`, else (3) `null` = unassigned. Called under the Team → User locks. |
| `businessTime.ts` | Europe/Bratislava calendar: `BUSINESS_TZ`, `businessDate`, `businessDayStart/End`, `businessTodayStart`, `nextBusinessWorkingDayStart`, `addBusinessCalendarDays/Months`, `businessDaysBetween`, `businessWeekday`, `isDueByBusinessDay`, `isOverdue`, `wallTimeToInstant`, `isValidBusinessDate`, `isValidWallTime`, formatting `businessDayMonth`, `businessHm`, `formatBusinessDateTime`, `businessInputParts`. |
| `schedule.ts` | `Schedule` input type (`day`, `dayTime`, `daysFromToday`, `monthsFromToday`) + `scheduleSchema` + `resolveSchedule` → `{ at, hasTime }`; `isDayOnlySnooze`. |
| `revision.ts` | `bump` (spread into a lead update), `markLeadBumped`, `isLeadBumped`, `bumpLeadOnce` — exactly one increment per business transaction. |
| `idempotency.ts` | `idempotentReplay(key, { userId, leadId, source, outcome })` → `null` if the key is new; success without another write if the same CALL was already recorded; `IDEMPOTENCY_CONFLICT` if the key belongs to a different write. For a handoff replay, the toast recipient is reconstructed from the lead's **current** owner, so it can differ after a later transfer; the original CALL author/history is unchanged. CALL activities only. `activityReplay(key, { userId, leadId, types })` — the same idea for any other activity type (OFFER_SENT, CLIENT_REPLIED, SMS_SENT, the planning row of "bez kontaktu"). |
| `callAssignment.ts` | `CLAIM_BATCH_SIZE` (10 = batch size and the max unworked NEW a caller holds). |
| `validation.ts` | `usernameSchema`, `emailSchema`, `passwordSchema`, `SignupSchema`. |

## Activity log and urgency helpers

| Operation | Notes |
|---|---|
| `createBusinessActivity`, `createPlanningActivity`, `createAuditActivity` (`lib/activityLog.ts`) | build an `Activity` payload with the right `category` (planning is limited to `NEXT_ACTION_*` types). Use them instead of writing `category` by hand. |
| `nextActionData(kind, at, note, hasTime, mode)`, `describeNextAction` | the `nextAction*` field block and its human text for the planning log. |
| `urgencyOf`, `URGENCY_TEXT`, `PROGRESS_TEXT`, `fmtProgress`, `fmtCallback` (`lib/overdue.ts`) | the one urgency scale (`future/soon/due/late`) for callbacks and next steps; rendered by `components/shared/UrgencyLabel.tsx`. |
| `nextActionSort` | in-memory row ranking; **duplicated in SQL** as `DEAL_RANK_SQL` in `lib/queries/pipeline/index.ts` — change both together. |

## Commands (`lib/commands/`)

| Operation | Guard / effect |
|---|---|
| `claimBatchAs(user)` (`claims.ts`) | claims up to `CLAIM_BATCH_SIZE` pool contacts (`SKIP LOCKED`), sets `assignedCaller*`. |
| `logCallAs(user, input)` (`calls.ts`) | first call: `requireCallLead` + revision + idempotency; writes the `CALL` activity then stores `leadRevision`, applies `leadStateForOutcome`, performs the handoff (`resolveDealOwner`, `pipelineEnteredAt`, `handedOffById`). Replays on a lost race. |
| `updateLeadContactAs(user, leadId, patch)` (`calls.ts`) | caller edits contact data in the call stage. |
| `revertCallResultAs(user, activityId, expectedRevision)` (`history.ts`) | undoes a first-call result only if `Activity.leadRevision == Lead.revision`; also undoes the handoff. Audit `CALL_REVERTED`. |
| `transferCallWorkAs(actor, { fromUserId, toUserId, kind, limit })`, `releaseBatchAs(actor, fromUserId)` (`assignments.ts`) | `calls.assign`: move call work between users or back to the pool (`toUserId: null`); never skips rows. |
| `deactivateUserAs(actor, userId)`, `updateUserProfileAs(actor, userId, data)`, `getRemainingWork(userId)` (`admin.ts`) | deactivation serialized with in-flight work, ends with 0 NEW contacts on the user; a role change in `updateUserProfileAs` is serialized the same way and reports released call work. |
| `logFollowUpAs(user, input)` (`dealWork.ts`) | the interaction: strict input, `requireDealWork` + revision + idempotency. `contact` decides the history row: `CALL` → `CALL`, `REPLIED` → `CLIENT_REPLIED`, `SMS` → `SMS_SENT` (note only; outcome must be `POSITIVE`), `NONE` → no contact row (outcome `POSITIVE`, the key sits on the planning row). Applies `dealStateForFollowUp`, plans the next step, opens a request when the outcome implies one, closes requests when the deal closes. `phonePrice` (CALL only, not with no-answer / closing outcomes) writes an `OFFER_SENT` channel `PHONE` linked to the call in the same transaction. `sourceFor(user)` is exported. |
| `setDealNextActionAs`, `updateDealContactAs`, `saveDealQuoteAs`, `addDealNoteAs` (`dealWork.ts`) | owner-or-manager deal work, open deals only for the owner. Activity source follows the actor: `deals.manage` → `PIPELINE`, else `CLIENTS`. |
| `recordOfferSentAs(user, input)` (`offers.ts`) | "Čo sme poslali": strict input (`contents`, `sentOn` ≤ today, optional `price`, `designIds`, `followUp`, `historical`), `requireDealWork` (manager may act on a closed deal) + `expectedRevision` + `idempotencyKey` (`activityReplay`). `historical` = manager only, only on an unreviewed legacy deal, never `followUp`. |
| `correctRecordAs(user, activityId, reason)` (`offers.ts`) | crosses out an `OFFER_SENT` / `SMS_SENT` / `CLIENT_REPLIED`: its author or the manager, reason 3–500 chars; already crossed out → `STALE`; any other type → `FORBIDDEN`. |
| `confirmLegacyReviewedAs(user, leadId)` (`offers.ts`) | manager only (`requireDealManage`): sets `legacySendsReviewedAt` on a `hadLegacySends` lead + audit row. |
| `createDealRequestAs(user, leadId, kind, note)`, `cancelOwnDealRequestAs(user, requestId, note)` (`dealWork.ts`) | rep-side requests; note required for `ORDER` / `DESIGN` / `OTHER`; `REOPEN` only on a closed deal; only the author cancels. |
| `updateLeadAs`, `saveQuoteAs`, `setProjectTypeAs`, `setNextActionAs`, `markLostAs`, `addBusinessNoteAs` (`NOTE` only), `changeStatusAs`, `reopenDealAs`, `changeOwnerAs` (`pipeline.ts`) | manager-only (`requireDealManage`), any deal state. |
| `resolveDealRequestAs(user, requestId, status, note)` (`pipeline.ts`) | manager marks a request `DONE` (only `OTHER`; other kinds close through their business action) or `CANCELLED` (reason required). |
| `transferDealsAs(user, input)` (`pipeline.ts`) | bulk owner transfer in batches of 200, `SKIP LOCKED`, returns `{ moved, skipped }`. |
| `deleteTeamAs`, `setTeamLeaderAs`, `setUserTeamAs` (`teams.ts`) | lock `Team` before `User`. Team **create** and **rename** have no command — `createTeam` / `renameTeam` write directly in `lib/actions/teams`. |
| `createDesignAs`, `addDesignVersionAs`, `updateDesignMetaAs`, `removeDesignAs` (`tracking.ts`) | guarded through `design.leadId` with `requireDealManage`. Marking a design sent is **not** here any more — it is `recordOfferSentAs` with `DESIGN`. Tracking ingest (`app/api/p`) never bumps the revision. |

Server actions (`lib/actions/**`) are thin wrappers over these; `lib/actions/pipeline/index.ts` exposes both deal
command files and `lib/commands/offers.ts` (`recordOfferSent`, `correctRecord`, `confirmLegacyReviewed`).

## Queries (`lib/queries/`)

| Operation | Notes |
|---|---|
| `getDealScope(viewer)` (`pipeline/`) | resolves the scope, loading team member ids when needed. |
| `getDealList(params)` | the pipeline list: filters in Prisma (ids only), ordering + `LIMIT` in SQL over the whole filtered set (`DEAL_PAGE_SIZE = 50`), full rows for the page, `noAnswerStreak` per page in one window query (consecutive non-reverted `NO_ANSWER` since the last `CALL` / `CLIENT_REPLIED`). Row "Naposledy" = `LAST_TOUCH_WHERE`: business rows, not crossed out, not a phone price, not a historical send. Views `got_pricelist` / `got_price` / `got_design` / `unverified` (legacy, cross-status). |
| `getDealCounts({ scope, owner, handedOffBy })` | `today` (SQL, `TODAY_SQL`), `requests` (deals in scope + owner filter with an open request), `open`, `unassignedOpen` (scope `all` only). |
| `getDealDetail(id, scope, caps)` | scope is inside the query; non-managers get business activities only and no design version numbers. Also returns `offers` (summary dates, legacy flags, last price snapshot), `lastTouch` (same rule as the list), per-activity `revertedAt` / `correctionReason` / `offer`, and per-design `url` + `trackedUrl` for the copy button. |
| `getDealOwnerOptions(scope)`, `getHandoffOptions(scope)` | filter dictionaries. |
| `openRequestsWhere(viewer, scope)` (`pipeline/requests.ts`) | **unused.** Intended single definition of "open requests for me"; wave 3 wires the inbox through it. Today the `Požiadavky` count/view and `getManagerToday` each build their own filter. |
| `getCallerToday`, `getDealsToday`, `getManagerToday` (`today/`) | dashboard blocks. |
| calls (`calls/`) | `getCallsBoard`, `getPoolCount`, `POOL_WHERE`, `callWorkWhere`, `getMoreRetriesFor`, `getHandoffRecipient`; `getCallHistory` (with revert eligibility); `getAssignmentsOverview`. |
| teams (`teams/`) | `getTeams`, `getTeamOptions`, `getTeamMemberIds`, `getTeamPeople`, `getTeamForLeader`, `getTeamScopeForLeader` (team scope for contacts and stats). |
| contacts, users, stats | `getContactsList`, `getContactsOverview`; `getUserOptions`, `getAdminUser*`; `queries/stats/*` + `lib/stats/range.ts` (unfinished statistics). |
| tracking (`tracking/`) | `resolveTrackerToken` (ingest), `getDesignsForLead` (manager view with tokens/URLs). |

## Scripts (`prisma/backfill/`)

| Script | Purpose |
|---|---|
| `2026-09-offer-legacy.ts` | wave 3a one-time step: `Lead.hadLegacySends` and `Design.legacySentAt` for old send evidence. Only sets values (repeatable); dry-run / `--apply` (direct host + `--confirm`) / `--verify`; `--expect-endpoint`, `--expect-db`. |
| `2026-09-assignments.ts` | round-1 backfill. Dry-run by default; `--apply` needs a direct host + `--confirm`; also `--expect-endpoint`, `--expect-db`, `--owner-username`, `--identity`; `--verify` reports drift; aborts on ambiguity. |
| `check-business-time.ts` | business calendar (run in local TZ and with `TZ=UTC`). |
| `check-client-sections.ts` | section classification, incl. totality over all combinations. |
| `check-concurrency.ts` | functional + concurrency suite, incl. the TS ↔ SQL agreement tests; creates and removes its own fixtures; `--expect-endpoint`, `--only`, `--iterations`. |
| `check-backfill-delta.ts` | backfill delta scenarios and CONFLICT abort. |
