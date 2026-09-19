# Feature plan: caller assignment, SALES_REP role, `/dashboard/clients`, manager oversight

Status: **HISTORICAL — approved design rev. 4 (2026-09-17), implemented on the test branch the same day.** The current
state is described by `context/domain/*` and `context/app-workflow.md`; later changes are in `round2-deal-workspace.md`.
Audience: coding agents. Read `AGENTS.md` and `context/app-workflow.md` first.
Decision owner: Michal (account role `ADMIN`, acts as the business manager).

> **Later note (2026-09-19).** This round-1 plan was implemented on the test branch on 2026-09-17 (round 2 builds on
> it: `round2-deal-workspace.md`). Its **requests to the manager** (`DealRequest`, "Požiadavky", the per-kind resolution
> rules of the former §7.6, the automatic DESIGN/ORDER requests, the REOPEN request) are **replaced in round 2 wave 3
> by manager tasks with a step lock** — the only design for that is `wave-3-task-proposal-final.md`. The request
> passages were removed from this file; the full original is in git (commit `1dae205`). The revision notes below are
> kept as history.

Rules for the implementing agent:

- Do not deviate from the decisions in §1 without asking. If code contradicts this file, stop and ask.
- **Development agents never run schema commands (`db push`, `migrate diff` against a live target), backfills or any
  writes against the production database.** All development and rehearsal happens on a Neon branch (§12).
  The production steps in §14 are executed only in a **separate, explicitly approved rollout session** by Michal
  or by an agent Michal explicitly instructs for that session.
- Never use `--accept-data-loss` or `--force-reset`.
- Keep the Prisma model name `Lead`. All permission checks go through `can()` + the access helpers (§6).
- Every mutation of an existing `Lead` follows the locking discipline in §10.1. Contact creation has no existing row
  to lock and inserts at revision 0.
- Implement in the phase order of §13. Each phase must pass `npx tsc --noEmit` and lint before the next starts.

Revision 2 changes (from design review): removed automatic claim reclaim; batch claims by explicit action; `Lead.revision`
optimistic check; unified lock order (User rows → Lead rows); deal rows locked on every mutation; revert marker on
activities; backfill aborts on ambiguity, uses bulk SQL and stronger target identity; transfers batched with
`UPDATE … RETURNING`; closed deals read-only for reps with a reopen flow; total section classification; one open
request per kind; correct Prisma 7.8 diff command; rollback is roll-forward first.

Revision 3 changes (second review, 2026-09-17):
- Call-work mutations lock the **assignee's User row**. Deactivation and transfers therefore wait for in-flight work, never
  skip rows, and must end with 0 NEW contacts left on the user.
- Revert is allowed only if nothing has touched the lead since that call (`Activity.leadRevision == Lead.revision`, and every
  lead-related change bumps the revision).
- Contact edits require the current assignment or manager permission.
- Team-row locking is shared by routing and team changes (lock order Team → User → Lead).
- `requireUser()` covers all protected server paths.
- NEW contacts with call history are excluded from the pool and converted by the backfill.
- `/dashboard/contacts/new` is guarded by `contacts.create`.

Revision 4 changes (third review + full self-review, 2026-09-17):
- Backfill classes spell out the allowed statuses and are mutually exclusive. Every other combination is CONFLICT. `closedAt` is
  backfilled for historical closed deals and kept consistent.
- The hand-written `ROLES` array (admin role pickers) must include SALES_REP.
- Requests reach DONE only through the business action that does the work (except OTHER). Manual resolution is CANCELLED with a note.
- Business calendar = Europe/Bratislava for every day-only computation (§10.3). Date-only inputs travel as `YYYY-MM-DD` and are
  converted on the server.
- Revision rule: exactly one increment per lead per business transaction. Writing `Activity.leadRevision` is bookkeeping and never
  bumps again.

Self-review fixes:
- The REOPEN-request exception now matches `requireDealWork`.
- The `updatedAt` fallback for closed deals is removed.
- The backfill script moved before the calls rewrite, so development runs on realistic assigned data.
- `leadRevision` is written only for first calls.
- The stats `OUTCOME_ORDER` array is noted.
- The schema diff output goes outside the repo.

---

## 0. Why this feature exists

1. **Two or more callers at once.** Today `/dashboard/calls` shows every caller the same global list. Two callers
   dial the same NEW contact, or dial one someone already called in a tab that wasn't refreshed.
   Contacts cannot be pre-split per caller at insert time: one caller may be on holiday holding 150 while
   another has none.
2. **New role SALES_REP.** Makes first calls **and** follow-ups on their own opportunities until they close.
   Must see only their own opportunities, never Michal's historical ones.
3. **Future-proof handoff.** Positive results from a first-call-only caller (Timea, `TELESALES`) must go to a
   configurable person. Today that is Michal. Later a SALES_REP will finish Timea's follow-ups.
4. **Manager oversight.** Michal sees everything and must see at a glance what each rep does and what they
   need from him (price, design, order confirmation).

---

## 1. Decisions (final)

| # | Decision |
|---|---|
| D1 | New Lead fields separate **call responsibility** (`assignedCallerId`) from **deal ownership** (`ownerId`). Never use one for the other. |
| D2 | NEW contacts sit in a shared **pool**. A caller takes a **batch of `CLAIM_BATCH_SIZE` (10)** with an explicit button, and can take the next batch only after the current batch is fully called (10 → 10 → 10). Callers only see the aggregate pool count. **No automatic claiming, no automatic expiry/reclaim.** Once a number has been shown to a caller, only the manager can move it (§4.6). |
| D3 | **Retries, agreed callbacks and call-stage snoozes stay with the caller who has them** (the client may call back the same person). Holidays and departures are handled by the manager transfer tool (§4.6), never by automatic redistribution. |
| D4 | `pipelineEnteredAt` marks a lead as a deal (opportunity). It stays set after WON/LOST/SNOOZED/UNREACHABLE. Board membership is decided by this marker, not by status alone. |
| D5 | The deal owner for a positive first call is resolved by **routing through Teams** (§5.1): if the caller can own deals → caller; else the caller's team leader → leader; else unrouted (`ownerId = null`, visible to the manager). Callers do not choose the recipient in v1. The manager moves individual deals afterwards (`changeOwner`, bulk transfer). |
| D6 | SALES_REP gets a new simple page, **`/dashboard/clients` ("Moji klienti")**. SALES_REP does **not** get `/dashboard/pipeline`. Pipeline stays the manager's full tool. |
| D7 | SALES_REP may set the price, mark the quote as sent, and mark the about-us email as sent on their own **open** deals. When unsure, they ask the manager (round 1: a request; from round 2 wave 3: a task — `wave-3-task-proposal-final.md`). Design creation/versions/tracking stay manager-only. WON and reopening closed deals are manager-only. The manager can do everything on any deal. |
| D8 | *(Superseded.)* Round 1 built requests to the manager as `DealRequest`; wave 3 of round 2 replaces them with tasks — `wave-3-task-proposal-final.md`. |
| D13 | Business calendar is **Europe/Bratislava**. Everything that means "a day" (today, tomorrow, +7 days, next working day, due today, overdue by day) is computed in that zone on the server, independent of server or browser time zone. Exact-time appointments stay instants (§10.3). |
| D9 | All historical deals get `ownerId = Michal`. Nikolas (`MANAGER`) keeps global access as an observer. Nothing is built specifically for him. |
| D10 | Existing call-stage work is assigned to its last caller (Timea for almost all). A new SALES_REP starts with the NEW pool only. Michal may move part of Timea's backlog with the transfer tool. |
| D11 | Authorization uses the **current DB user** (role + `deletedAt`), not just the JWT role, on **every protected server action and page** (not only those this feature touches). A deactivated user's session stops working everywhere except the JWT-based navigation redirect, which renders nothing useful. |
| D12 | Concurrency: pessimistic row locks for correctness (§10.1) + `Lead.revision` expected-version checks for call and follow-up outcomes so stale tabs of the same user fail instead of double-logging. |

---

## 2. Glossary (use these words in code comments and UI)

| Term | Meaning | Data |
|---|---|---|
| contact | any `Lead` | `Lead` |
| pool | never-called NEW leads nobody holds | `status=NEW, pipelineEnteredAt IS NULL, assignedCallerId IS NULL`, no CALL activity |
| claim / batch | NEW leads assigned to a caller, not called yet | `status=NEW, assignedCallerId=me` |
| call work | a caller's call-stage leads: claims, retries, agreed callbacks, call snoozes | `pipelineEnteredAt IS NULL, status IN (NEW,CALLING,SNOOZED), assignedCallerId=me` |
| deal / client / opportunity | lead that had a positive first call | `pipelineEnteredAt IS NOT NULL` |
| open deal | deal still being worked | deal with `status IN (ACTIVE, SNOOZED)` |
| closed deal | finished deal | deal with `status IN (WON, LOST, UNREACHABLE)` |
| owner | person responsible for the deal | `ownerId` |
| handoff | positive first call turns the lead into a deal | sets `pipelineEnteredAt`, `handedOffById`, `ownerId` |
| task (round 2 wave 3; replaces "request") | rep asks the manager for something on a deal | `DealTask` — `wave-3-task-proposal-final.md` |
| follow-up | a call on a deal (not a first call) | `Activity type=CALL`, `source CLIENTS` (rep) or `PIPELINE` (manager, later) |
| revision | optimistic version of a lead; +1 exactly once per business transaction that changes anything about the lead | `Lead.revision` |
| business day | calendar date in Europe/Bratislava | `lib/domain/businessTime.ts` (§10.3) |

UI (Slovak): pipeline = "Pipeline" (manager), clients page = "Moji klienti", waiting on us = "Čaká na nás", manager
inbox = "Čaká na mňa", unrouted = "Nepriradené", archive = "Archív". (Wave 3 names: "Pre mňa", "Čakám na manažéra".)

---

## 3. Schema changes (additive only)

All new columns are nullable or have constant defaults (Postgres adds constant defaults as metadata only).
No renames, drops or type changes.

```prisma
enum Role {
  SCOUT
  SCOUT_LEADER
  TELESALES
  SALES_REP      // NEW: first calls + follow-ups on own deals
  MANAGER
  ADMIN
}

enum CallOutcome {
  // ...existing values unchanged...
  WANTS_TO_ORDER // NEW: follow-up only – client wants to go ahead (wave 3: an ordinary reply, no request)
}

enum ActivitySource {
  CALL_QUEUE
  PIPELINE
  CONTACTS
  ADMIN
  CLIENTS        // NEW: actions from /dashboard/clients
}

enum ActivityType {
  // ...existing values unchanged...
  CALLER_ASSIGNED   // NEW audit: manual transfer of call work (claims by the caller are NOT logged)
  CALLER_RELEASED   // NEW audit: claim released to pool by manager/deactivation
  CALL_REVERTED     // NEW audit: a call result was reverted (points to the reverted activity in meta)
  REQUEST_CREATED   // NEW business (round-1 requests; retired in wave 3)
  REQUEST_RESOLVED  // NEW business (round-1 requests; retired in wave 3)
  DEAL_REOPENED     // NEW audit: manager reopened a closed deal
}

model Lead {
  // ...existing fields unchanged...

  // Call responsibility (call stage only). null = in pool / not in call stage.
  assignedCaller   User?     @relation("AssignedCaller", fields: [assignedCallerId], references: [id])
  assignedCallerId String?
  assignedCallerAt DateTime? // when assigned (audit/ordering only; never used for expiry)

  // Deal marker. Set once at handoff = createdAt of the positive CALL activity; cleared only by revert (§5.4).
  pipelineEnteredAt DateTime?
  handedOffBy       User?     @relation("HandedOffBy", fields: [handedOffById], references: [id])
  handedOffById     String?   // who made the positive call (routing audit, stats, bulk transfer filter)
  closedAt          DateTime? // deals only: set when status becomes WON/LOST/UNREACHABLE, null while ACTIVE/SNOOZED;
                              // backfilled for historical closed deals (§11.3); always null on non-deals

  revision Int @default(0) // optimistic version; +1 exactly once per business transaction touching this lead (see notes)

  @@index([status, assignedCallerId, createdAt])    // pool + claim
  @@index([assignedCallerId, status, callbackKind]) // personal queue
  @@index([ownerId, status])                        // clients page, owner filter
  @@index([pipelineEnteredAt, status])              // pipeline list
}

model User {
  // ...existing...
  assignedCallLeads    Lead[]        @relation("AssignedCaller")
  handedOffLeads       Lead[]        @relation("HandedOffBy")
  revertedActivities   Activity[]    @relation("ActivityRevertedBy")
}

model Activity {
  // ...existing...
  idempotencyKey String?   @unique // client-generated per outcome submit attempt.
  leadRevision   Int?      // first-call CALL activities only: Lead.revision after this call's single bump; revert requires equality (§5.4)
  revertedAt     DateTime? // set on a CALL activity whose result was reverted (§5.4)
  revertedBy     User?     @relation("ActivityRevertedBy", fields: [revertedById], references: [id])
  revertedById   String?
}

// Round 1 also added DealRequest + DealRequestKind + DealRequestStatus (requests to the manager). Replaced in round 2
// wave 3 by DealTask — see wave-3-task-proposal-final.md §4. Original definition: git commit 1dae205.
```

Notes:

- `lockedById`/`lockedAt` stay unused. Do not build on them.
- TypeScript `Record<Enum, …>` types will force updates in `lib/dictionaries.ts` (`ROLE_LABEL`, `OUTCOME_LABEL`,
  `ACTIVITY_LABEL`, source labels) and `ROLE_PERMISSIONS`. Labels: SALES_REP "Obchodník", WANTS_TO_ORDER "Chcú objednať",
  CLIENTS "Klienti", CALLER_ASSIGNED "Presunuté volanie", CALLER_RELEASED "Uvoľnené do fronty",
  CALL_REVERTED "Výsledok hovoru vrátený", DEAL_REOPENED "Obchod znovu otvorený".
- **Hand-written enum arrays are not type-forced:**
  - `ROLES` in `lib/dictionaries.ts` (the role pickers in `components/admin/NewUserForm.tsx` and
    `components/admin/UserProfileCard.tsx`) must become
    `["SCOUT", "SCOUT_LEADER", "TELESALES", "SALES_REP", "MANAGER", "ADMIN"]`. Otherwise Michal can't create the first SALES_REP.
    Add `ROLE_VARIANT.SALES_REP = "secondary"` (Record, type-forced).
  - `app/dashboard/stats/page.tsx` has `OUTCOME_ORDER` / `GOOD` arrays. Add `WANTS_TO_ORDER` to both, so a follow-up outcome
    that reaches the stats is never silently dropped.
  - The server-side `z.enum(Role)` validators accept the new value automatically.
- Old deployed code keeps working after the push (it never reads rows with new enum values). **Old code does not
  increment `revision`.** That is harmless before the new code is live, because no expected-revision checks exist yet.
- **Revision rule: exactly one increment per lead per business transaction.**
  - A transaction that changes anything concerning a lead increments that lead's `revision` **once**, however many rows it writes
    (Lead fields, activities, tasks, designs).
  - This includes changes that don't otherwise touch Lead columns: Activity inserts (notes, SMS, sent markers), `Design` /
    `DesignVersion` create/update/remove/sent, and task events (wave 3). For these, the transaction runs a dedicated
    `UPDATE "Lead" SET "revision" = "revision" + 1`.
  - The only exception is public tracking ingest (`/api/p` TrackerEvent rows); a client viewing a design is not work on the lead.
  - Bulk statements (claim, transfer, backfill) increment each affected row once.
- Revision helper `lib/domain/revision.ts`:
  - `bumpLeadOnce(tx, leadId)` keeps a per-transaction `Set` of bumped lead ids and does nothing on a second call.
  - `bump = { revision: { increment: 1 } }` is for use inside the single Lead update when the transaction also changes Lead fields.
  - A transaction uses one of the two per lead, never both.
- **`Activity.leadRevision` is bookkeeping, not a change.** After its single bump, `logCall` writes the resulting revision into
  the CALL activity's `leadRevision`. That write is on the Activity row and **must not** bump the Lead again (otherwise the revert
  equality check in §5.4 could never pass). The same holds for `revertedAt` / `revertedById`, written by `revertCallResult` inside
  its own single bump.
- `leadRevision` is written only for **first-call** CALL activities (`source CALL_QUEUE`), the only revertable ones: by `logCall`,
  and by the backfill anchor pass for eligible legacy non-deal calls (§11.3). Follow-up calls and all other historical calls have `null`.
- Phase gate (§13): grep every `lead.update`, `lead.updateMany`, raw `UPDATE "Lead"`, `activity.create`, `design.*`,
  `designVersion.*`, task mutation. Each business transaction must bump each touched lead **exactly once**.

---

## 4. Call work: pool, batches, personal queue

### 4.1 Constant: `lib/domain/callAssignment.ts`

```ts
export const CLAIM_BATCH_SIZE = 10; // size of one batch of NEW contacts; also max uncalled NEW a caller may hold
```

A code constant for v1 (admin-editable is an open question, §16).

Behaviour:

- A caller works a batch of up to 10 NEW contacts. The next batch can be taken only when the caller holds **0** uncalled
  NEW contacts. Having 8 left is fine; you finish them first.
- Retries, callbacks and snoozes never count toward the batch and never block taking a batch.
- **No automatic expiry.** If a caller disappears with an unfinished batch, the manager releases it or transfers it (§4.6).
- **No automatic claims on page load or after calls.** Claiming is always an explicit click. Managers/admins can open
  `/dashboard/calls` without side effects.

### 4.2 Eligibility

```text
pool (claimable):
  deletedAt IS NULL AND status = 'NEW' AND pipelineEnteredAt IS NULL AND assignedCallerId IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = "Lead".id AND a.type = 'CALL')

caller U's batch (uncalled claims):
  deletedAt IS NULL AND status = 'NEW' AND pipelineEnteredAt IS NULL AND assignedCallerId = U

poolCount shown in UI = count(pool)
```

Only NEW leads are ever pooled. CALLING/SNOOZED call work is never pooled (D3).

**Invariant: `status NEW` ⇒ the lead has no CALL activity.**
- New code never creates a violation: revert goes to CALLING RETRY, and old `resetLeadToCalls` is deleted.
- The backfill converts existing violations (§11.3 class NEW_WITH_HISTORY; 0 as of 2026-09-16).
- The `NOT EXISTS` in the pool query is a defensive second guard (uses `Activity(leadId)` index).

### 4.3 Claim action: `claimBatch()` in `lib/actions/calls/claims.ts`

UI: in the "Nové firmy" section, when the caller's batch is empty and `poolCount > 0`, show one button
**"Zobrať ďalších {min(10, poolCount)}"**. Hidden while the batch is non-empty. Disabled while pending (no double click).
After success: `router.refresh()`. No client-side loops, no mount effects.

Algorithm: one Prisma interactive transaction with `tx.$queryRaw` / `tx.$executeRaw`:

1. `requireUser()` (§6.1) for the id (fast pre-check).
2. **Lock the caller's User row**: `SELECT id, role, "deletedAt" FROM "User" WHERE id = $1 FOR UPDATE`.
   Under that lock, re-check `deletedAt IS NULL` and `can({ role }, "calls.claim")`. Otherwise return FORBIDDEN.
   This row lock serializes the same user's tabs and conflicts with deactivation/role change (§9).
3. Count the caller's batch (§4.2). If `> 0` → return `{ claimed: 0, reason: "BATCH_NOT_EMPTY" }`.
4. Claim:

```sql
WITH picked AS (
  SELECT id FROM "Lead"
  WHERE "deletedAt" IS NULL AND status = 'NEW'
    AND "pipelineEnteredAt" IS NULL AND "assignedCallerId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = "Lead".id AND a.type = 'CALL')
  ORDER BY "createdAt", id
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE "Lead" l
SET "assignedCallerId" = $1, "assignedCallerAt" = now(), "revision" = l."revision" + 1
FROM picked
WHERE l.id = picked.id AND l."assignedCallerId" IS NULL
RETURNING l.id;
```

5. No Activity rows for self-claims. Return `{ claimed: n }`.

Guarantees: two callers never get the same row (row lock + SKIP LOCKED + the re-checked `assignedCallerId IS NULL`).
Two tabs of one user can't produce two batches (User row lock + the empty-batch check). A deactivated user can't receive
a batch (re-check under the lock that deactivation also takes). Fewer than 10 rows is valid.

Neon: `DATABASE_URL` is the pooled (pgbouncer transaction mode) endpoint. Row locks inside a transaction work there.

### 4.4 Personal board: `getCallsBoard(user)` rewrite (`lib/queries/calls/index.ts`)

Every list requires `deletedAt IS NULL AND pipelineEnteredAt IS NULL AND assignedCallerId = user.id`:

| Group (UI) | Filter | Order |
|---|---|---|
| Dohodnuté hovory | `status=CALLING, callbackKind=SCHEDULED` | `callbackAt asc` |
| Skúsiť znova | `status=CALLING, callbackKind=RETRY` | `updatedAt asc`, **paginate 50** (Timea holds ~1,200) |
| Spiace | `status=SNOOZED` | `callbackAt asc` |
| Nové firmy (batch) | `status=NEW` | `createdAt asc` |

Each row includes `revision`. Also return `poolCount`, `batchCount`, `retryTotal`, `retryNextCursor`.
Delete `lib/actions/calls/calls-pagination.ts` / `getMoreNew` (no auth, obsolete). Add an authenticated
`getMoreRetries(cursor)` with the same scope.

The page header shows `Voľných v spoločnej fronte: {poolCount}`.

### 4.5 First-call outcomes: `logCall` rewrite + `lib/domain/leadFlow.ts`

Input:

```ts
type Schedule =
  | { kind: "inHours"; hours: number }             // "O hodinu" → instant now + h, hasTime true
  | { kind: "day"; date: "YYYY-MM-DD" }             // day only → 00:00 Europe/Bratislava of that date, hasTime false
  | { kind: "dayTime"; date: "YYYY-MM-DD"; time: "HH:mm" } // wall time in Europe/Bratislava → instant, hasTime true
  | { kind: "daysFromToday"; days: number }         // "Zajtra" = 1, "O týždeň" = 7 → business date + N, hasTime false
  | { kind: "monthsFromToday"; months: number };    // snooze presets → business date + N months, hasTime false

{ leadId, outcome, expectedRevision: number, idempotencyKey: string, note?: string,
  callbackNote?: string, schedule?: Schedule, email?: string }
```

`note` is the drawer textarea. It is both the contact note (`Lead.note`) and the CALL activity note, as today.
The browser never builds day-only instants (today `dayIn()`, `inMonths()` and the custom-date inputs create browser-local
midnights / 09:00). The server converts every `Schedule` with `lib/domain/businessTime.ts` (§10.3). CALL_AGAIN requires a
schedule; SNOOZE requires `day` or `monthsFromToday`.

One interactive transaction, in this order:

1. `requireUser()`, `can(user, "calls.work")`.
2. **Idempotency first** (so a retry of an already-committed submit isn't rejected as stale). If an Activity with
   `idempotencyKey` exists:
   - it matches `userId`, `leadId`, `type CALL`, `source CALL_QUEUE`, `outcome` → return the stored success result
     (including the recipient name for handoffs, read from the lead's owner)
   - otherwise → return error code `IDEMPOTENCY_CONFLICT` (client generates a new key and refreshes)
3. Locks in the §10.1 order (Team → User → Lead):
   - For WANTS_* only: read `caller.teamId` (plain read). If set, lock that Team row `FOR SHARE` and read `leaderId`.
   - Lock User rows `FOR SHARE` in ascending id: always the caller (the **assignee lock**, §10.1 rule 3), plus the team leader
     for WANTS_*.
   - Under those locks, re-read `caller.deletedAt`, role and `teamId`. The caller must be active with `calls.work`, and `teamId`
     must equal the pre-read value (else `RETRYABLE`). Resolve the owner (§5.1).
4. `requireCallLead(tx, user, leadId)` (§6.2): `SELECT … FOR UPDATE` on the Lead, checks call stage + `assignedCallerId = user.id`
   → else `NOT_ASSIGNED`. Then `revision === expectedRevision` → else `STALE`.
5. Create the CALL activity (`source CALL_QUEUE`, `idempotencyKey`, `leadRevision` still null). It is created first for every
   outcome, so handoffs can copy its `createdAt` into `pipelineEnteredAt` (§5.2).
6. Compute state with the pure function `leadStateForOutcome(outcome, schedule, now)` + the assignment effect below. Write the
   Lead **once** with `bump` (the transaction's single increment, §3), and update `Lead.note` in that same update if the note changed.
   The update returns the new `revision`.
7. Write planning/audit activities (none of them bump again), then set the CALL activity's `leadRevision` = the revision
   returned in step 6 (bookkeeping, no bump).
8. If the insert hits a unique violation on `idempotencyKey` (P2002), the transaction is aborted. Outside it, re-read that activity
   and apply step 2's comparison.
9. Return `{ success, recipient?: { id, name } | null }`.

| Outcome | status / callback fields | assignment | deal fields |
|---|---|---|---|
| NO_ANSWER | CALLING, RETRY | keep (= user) | — |
| CALL_AGAIN | CALLING, SCHEDULED, callbackAt/HasTime from schedule, callbackNote | keep | — |
| SNOOZE | SNOOZED, callbackAt = business-day start (hasTime false), callbackNote | keep | — |
| NOT_INTERESTED | LOST, lostReason | clear `assignedCaller*` | — |
| BAD_NUMBER | UNREACHABLE, lostReason | clear | — |
| WANTS_QUOTE / WANTS_EMAIL / WANTS_DESIGN | ACTIVE, callback* cleared | clear | **handoff** (§5.2) |

Changes vs. current code:

- **Remove the separate `updateLeadNote` call from `CallDrawer.fire()`** (today it is fired unawaited before `logCall` and
  would race with the new ownership/stage checks). The note travels inside `logCall`. Delete `updateLeadNote` if nothing
  else uses it (today only CallDrawer does).
- **Call-stage outcomes stop writing `nextAction*`** and stop emitting NEXT_ACTION_SET. Today `CALL_AGAIN` and `SNOOZE`
  duplicate callback data into nextAction, which leaks call-stage leads into manager views. `nextAction*` is for deals only.
- `logCall` rejects `POSITIVE` and `WANTS_TO_ORDER` (follow-up only).
- Client error handling:
  - `NOT_ASSIGNED` / `STALE` → toast "Kontakt sa medzitým zmenil – obnovujem" + `router.refresh()`, no retry button
  - other errors → retry toast that reuses the **same** `idempotencyKey` and `expectedRevision`
- The key is generated when the drawer opens for a lead (`crypto.randomUUID()`) and regenerated after a success or a
  non-retryable error.
- **Handoff recipient preview:** the "Majú záujem" step shows "Pravdepodobne odovzdá: Michal Chovanec" (label says it is a
  preview) from `getHandoffRecipient(user)`. The success toast shows the **actual** recipient returned by `logCall`:
  "Odovzdané: <name>" or "Odovzdané – nepriradené (priradí manažér)". No reconfirmation flow in v1.
- Remove the fake "Vrátiť späť" action from the success toast in `CallQueue` (it only refreshes). Corrections happen in history (§5.4).
- `createContact` never assigns a caller. A future quick-add on the calls page must go through the same User-row-locked
  capacity rule as `claimBatch` (only when the batch is empty).

### 4.6 Manager transfer tool: `/dashboard/calls/assignments`

Permission `calls.assign` (MANAGER, ADMIN). One row per user with call work; deactivated users first, marked "Deaktivovaný":

| Caller | Nové (batch) | Skúsiť znova | Dohodnuté (z toho po termíne) | Spiace | Akcie |
|---|---|---|---|---|---|

Actions in `lib/actions/calls/assignments.ts`:

- `releaseBatch(fromUserId)`: that user's uncalled NEW → pool.
- `transferCallWork({ fromUserId, toUserId, kind: "NEW" | "RETRY" | "SCHEDULED" | "SNOOZED", limit?: number })`
  - `toUserId`: active user with `calls.work` (re-checked under lock).
  - **NEW is capacity-limited:** moved count = `min(limit ?? ∞, CLAIM_BATCH_SIZE − target's current batch)`. If capacity is 0,
    return an error suggesting `releaseBatch` instead. RETRY / SCHEDULED / SNOOZED are unlimited when deliberately requested.
  - Order: oldest first (`createdAt` NEW, `updatedAt` RETRY, `callbackAt` SCHEDULED/SNOOZED).

Execution, race-safe and bounded (both actions):

```text
repeat until moved == requested or no rows:
  BEGIN
    SET LOCAL lock_timeout = '5s'
    lock User rows FOR UPDATE in ascending id (from, to)
      -- waits for every in-flight call-work transaction of either user (they hold FOR SHARE, §10.1 rule 3)
      -- and blocks new ones until COMMIT
    re-check to-user active + calls.work; for NEW recompute capacity
    SELECT id FROM "Lead"
      WHERE "assignedCallerId" = $from AND <kind filter> AND "deletedAt" IS NULL AND "pipelineEnteredAt" IS NULL
      ORDER BY <order>, id LIMIT min(200, remaining)
      FOR UPDATE                                               -- NO SKIP LOCKED: wait (bounded by lock_timeout)
    UPDATE "Lead" SET "assignedCallerId" = $to (or NULL for release), "assignedCallerAt" = now(), "revision" = "revision" + 1
      WHERE id = ANY($ids) AND "assignedCallerId" = $from
      RETURNING id
    assert returned count == selected count, else ROLLBACK → RETRYABLE
    createMany Activity (AUDIT, source ADMIN, CALLER_ASSIGNED | CALLER_RELEASED) ONLY for returned ids
  COMMIT
```

Rows are never skipped. Every mutation of a lead assigned to a caller holds that caller's User row `FOR SHARE` (§10.1 rule 3),
so once this transaction holds the row `FOR UPDATE`, no call work on that caller's leads can be running. A lead lock can only be
held briefly by a transaction that doesn't depend on the assignee: a scout edit attempt that will be rejected, or a manager contact
edit that also takes the assignee lock first. `lock_timeout` turns anything unexpected into `RETRYABLE` ("Skús znova").
Each batch commits on its own. The UI shows the total moved. Re-running is safe.

Use cases: holiday, rebalancing ("presuň 300 najstarších retry"), departures.

### 4.7 Scout lock: `lib/actions/contacts/index.ts`, `lib/queries/contacts/index.ts`

`assertCanManageContact` and `toContactRow().callable` change from `status === "NEW"` to
`status === "NEW" && assignedCallerId === null && no CALL activity`. Use `activities: { none: { type: "CALL" } }` or `_count`.
The mutation locks the Lead row and re-checks the condition inside the write transaction (a claim may happen concurrently).
Manager edits/deletes of a contact (`contacts.deleteAny`) that is currently assigned to a caller follow §10.1 rule 3: read the
assignee, lock their User row `FOR SHARE`, lock the Lead, and re-validate that the assignee is unchanged (else `RETRYABLE`).

---

## 5. Deals: handoff, routing, ownership

### 5.1 Routing: `resolveDealOwner(tx, caller)` in `lib/domain/dealRouting.ts`

```text
1. can(caller, "deals.receive")                        → caller.id      (SALES_REP, MANAGER, ADMIN)
2. caller.teamId && team.leader active (deletedAt null)
   && can(team.leader, "deals.receive")                → team.leader.id
3. otherwise                                           → null  ("Nepriradené")
```

Evaluated inside `logCall` while holding the caller's Team row `FOR SHARE` and the caller + leader User rows `FOR SHARE`
(§4.5 step 3). Every operation that can change the routing result locks the same rows `FOR UPDATE` first, so it either commits
before the handoff reads (the handoff sees the new routing) or waits until the handoff commits (the deal went to the old
recipient, which was correct at that moment):

| Operation | Locks (Team → User order) |
|---|---|
| `setTeamLeader(teamId, leaderId)` (rewrite of `lib/actions/teams/index.ts`) | Team row `FOR UPDATE`; then old and new leader User rows `FOR SHARE` (ascending id); validate the new leader is active; update `leaderId`. A unique violation on `leaderId` (P2002) → "Tento používateľ už vedie iný tím". |
| `setUserTeam(userId, teamId)` | old and new Team rows `FOR UPDATE` (ascending id); then User row `FOR UPDATE`; update `teamId` |
| `deleteTeam(id)` | Team row `FOR UPDATE` **first**; then member User rows `FOR UPDATE` (ascending id); clear `teamId`; delete the team. (Today it updates users before touching the team, which violates the lock order.) |
| deactivation / role change of the leader | User row `FOR UPDATE` (§9) |

Team actions also switch to `requireUser()` + `can(user, "teams.manage")` (D11).

Usage (Teams exist in `/dashboard/admin/teams`):

- **Now:** team "Obchod" with leader **Michal**, member **Timea** → Timea's positive calls go to Michal.
  **Precondition:** Michal must not already lead another team (`Team.leaderId` is unique; `setTeamLeader` rejects it).
  Verify in the admin UI before the rollout (§14 step 0).
- **Later, a SALES_REP takes over Timea's follow-ups:** admin makes the rep the leader of Timea's team (or moves Timea into
  the rep's team). Future handoffs go to the rep. Existing open deals are moved with the bulk deal transfer (§5.5).
- **Limits of v1 (accepted):** one caller routes to one person. There's no per-client recipient choice by the caller and no
  distribution of one caller's handoffs across several reps. The manager reassigns individual deals afterwards. If this
  becomes a real need, add an explicit routing assignment (e.g. round-robin list) later (§16).
- Leading a team gives a `deals.receive` user **no** extra visibility. The team is used for routing only.
- `components/admin/TeamsManager.tsx`: under a team whose leader has `deals.receive`, show
  "Pozitívne hovory členov tímu dostane vedúci".

### 5.2 Handoff (inside `logCall`, same transaction)

```text
status              = ACTIVE
handedOffById       = caller.id
ownerId             = resolveDealOwner(tx, caller)
assignedCallerId/At = null
callbackKind/At/Note = null, callbackHasTime = false
lostReason          = null, closedAt = null
email               = drawer email if provided
note                = drawer note if changed
nextAction*         = by outcome (today = businessTodayStart(), §10.3):
  WANTS_QUOTE  → SEND_QUOTE,  at today, hasTime false, SCHEDULED,   "Poslať cenovú ponuku"
  WANTS_EMAIL  → SEND_EMAIL,  at today, hasTime false, SCHEDULED,   "Napísať email / poslať informácie o nás"
  WANTS_DESIGN → SEND_DESIGN, at today, hasTime false, IN_PROGRESS, "Vytvoriť a poslať dizajnový návrh"
revision            = +1 (the transaction's single bump)
pipelineEnteredAt   = createdAt of the CALL activity created in step 5 of §4.5
                      (so the backfill derivation "earliest non-reverted positive first call" reproduces the exact value)
Activities: CALL (BUSINESS), NEXT_ACTION_SET (PLANNING),
            OWNER_CHANGED (AUDIT) "Priradené automaticky: <name>" when ownerId != null
```

### 5.3 Ownership rules

- `ownerId` changes only through: handoff, manager `changeOwner`, bulk deal transfer, backfill, revert (→ null).
  Never as a side effect.
- Owner candidates: `getDealOwnerOptions()` = active users whose role has `deals.receive`. It replaces `getPipelineUsers`
  (which returns every user including scouts and deactivated accounts).
- `changeOwner` (`pipeline.manage`) locks the target User row `FOR SHARE`, then the Lead row `FOR UPDATE` (§10.1), re-checks the
  target, writes owner + `bump` + OWNER_CHANGED.

### 5.4 Revert a call result (mistake fix), replaces `resetLeadToCalls`

New action `revertCallResult(activityId, expectedRevision)` in `lib/actions/calls/history.ts`. One transaction:

1. Load the activity (plain read). Lock the activity author's User row `FOR SHARE` (the lead will be assigned back to them),
   then lock the Lead row `FOR UPDATE` (§10.1 order). Check `revision === expectedRevision`, else `STALE`.
2. Reject when:
   - it's not `type CALL, source CALL_QUEUE`
   - `revertedAt IS NOT NULL` → "Už bolo vrátené" (**a repeated revert is rejected, no second event**)
   - it's not the lead's latest **non-reverted** CALL activity (any source)
   - the actor isn't the activity's author with `callHistory.revert`, and doesn't have `pipeline.manage`
   - **`activity.leadRevision IS NULL` or `activity.leadRevision !== lead.revision`** → "Kontakt sa od hovoru zmenil – vrátenie
     nie je možné"

   That last check is the main safety rule. Nothing may have happened to the lead since the call's own transaction. Because every
   lead-related change bumps the revision (§3), it rejects without enumerating cases:
   - call-work transfers or releases
   - owner changes
   - next-action edits
   - notes, sent markers, price
   - tasks created after the handoff (wave 3)
   - designs
   - contact edits
   - status changes
   - a later follow-up

   Calls with `leadRevision` null can't be reverted.
   - Pre-feature **non-deal** calls get a revert anchor from the backfill when nothing happened after them (§11.3, anchor pass), so a
     mistaken NOT_INTERESTED / BAD_NUMBER / NO_ANSWER from before the rollout can still be fixed.
   - Pre-feature **handoffs** (historical deals) never get an anchor. Their later pipeline work isn't reflected in `revision`, so a
     revert could wipe it. The manager handles them in the pipeline (e.g. mark LOST).
3. Current state must match what that call produced (defense in depth):
   - deal: `pipelineEnteredAt != null`, `handedOffById = activity.userId`, `status ACTIVE`
   - non-deal: `pipelineEnteredAt IS NULL`, status matches the call outcome (LOST / UNREACHABLE with `assignedCallerId IS NULL`,
     or CALLING / SNOOZED with `assignedCallerId = activity.userId`)
4. Effect:

```text
Activity (reverted one): revertedAt = now(), revertedById = actor
Lead: status = CALLING, callbackKind = RETRY, callbackAt/Note = null, callbackHasTime = false
      assignedCallerId = activity.userId, assignedCallerAt = now()
      pipelineEnteredAt = null, handedOffById = null, ownerId = null, closedAt = null
      nextAction* = null, nextActionMode = SCHEDULED, lostReason = null, revision +1 (single bump for the whole revert)
Activity CALL_REVERTED (AUDIT, source CALL_QUEUE), meta { revertedActivityId, previousOutcome }
```

After the revert the caller logs the correct outcome normally.

- **Never** revert to `status NEW` (the lead would re-enter the pool and become editable by scouts).
- **Assignment on revert when the caller is deactivated:** still assign to them, so it appears as orphaned in §4.6
  (the manager moves it).
- History UI: reverted activities show a "vrátené" badge and no actions.
- Stats (later) exclude reverted activities from outcome counts.

Delete `correctOutcome`, `editActivityNote`, `resetLeadToCalls` (unused or superseded; no permission checks).

`updateLeadContact` (phone/email edit from history and from `InfoDrawer` in the call queue) is a **current-responsibility**
mutation. Past authorship never grants edit rights:

- caller: only via `requireCallLead` (lead is currently assigned to them, call stage), with the assignee lock (§10.1 rule 3)
- manager: `pipeline.manage` (any lead; if assigned, take the assignee lock first)
- deal owner: through the client actions (§7.7), not this action
- otherwise `NOT_FOUND`

Fixing a wrong number on a lead the caller already closed as BAD_NUMBER: revert first (it becomes their retry), then edit.
Once the caller is no longer responsible (transferred, handed off, closed), the history row stays visible but read-only.

History row (`lib/queries/calls/history.ts`): replace the current `locked` calc (it uses `ownerId`, which every deal will have
after backfill) with:
- `canRevert`: per the rules above, including `activity.leadRevision === lead.revision`
- `canEdit`: lead currently assigned to the viewer and in call stage, or the viewer has `pipeline.manage`
- `lead.revision` for the actions

The UI shows "Vrátiť" / "Upraviť" only when the corresponding flag is true. The server re-checks everything.

### 5.5 Bulk deal transfer

In `/dashboard/pipeline`, a "Presunúť obchody" dialog (`pipeline.manage`):

- inputs: `fromOwnerId`, optional `handedOffById`, statuses (default open: ACTIVE, SNOOZED), `toOwnerId` (active, `deals.receive`)
- bounded batch loop like §4.6, but deals may skip rows (they have no assignee invariant): lock the target User row `FOR SHARE`;
  `SELECT … FOR UPDATE SKIP LOCKED LIMIT 200`;
  `UPDATE … SET "ownerId" = $to, revision + 1 WHERE id = ANY($ids) AND "ownerId" = $from AND "pipelineEnteredAt" IS NOT NULL RETURNING id`
- OWNER_CHANGED audit **only for returned ids**; report skipped rows

Main use: "všetky otvorené obchody z Timeiných hovorov: Michal → nový obchodník".

---

## 6. Permissions and access helpers

### 6.1 `requireUser()`: `lib/access/user.ts`

```ts
export type AccessUser = { id: string; role: Role; teamId: string | null; firstName: string; lastName: string };
// Current DB user; null if not logged in or deactivated.
export async function requireUser(): Promise<AccessUser | null>;
```

Takes the id from `auth()`, then runs `prisma.user.findUnique({ where: { id, deletedAt: null } })`.
**Every protected server action and every page under `app/dashboard/**` uses it** instead of `session.user`. This includes
existing code outside this feature. As of 2026-09-17 these files read `session.user` and must be migrated:

- actions: `lib/actions/admin/index.ts`, `lib/actions/teams/index.ts`, `lib/actions/contacts/index.ts`,
  `lib/actions/calls/index.ts`, `lib/actions/calls/history.ts`, `lib/actions/pipeline/index.ts`, `lib/actions/tracking/index.ts`
  (plus the new `clients`, `claims`, `assignments` actions)
- pages: `app/dashboard/page.tsx`, `app/dashboard/admin/page.tsx`, `app/dashboard/admin/teams/page.tsx`,
  `app/dashboard/admin/users/page.tsx`, `app/dashboard/admin/users/new/page.tsx`, `app/dashboard/admin/users/[id]/page.tsx`,
  `app/dashboard/calls/history/page.tsx`, `app/dashboard/contacts/page.tsx`, `app/dashboard/contacts/new/page.tsx`,
  `app/dashboard/stats/page.tsx`, and pages that read data without a session today: `app/dashboard/calls/page.tsx`,
  `app/dashboard/pipeline/page.tsx`, `app/dashboard/pipeline/[id]/page.tsx`
- display only: `components/layout/Header.tsx` renders nav links from `requireUser()` (no links for a deactivated user)

Pages: `if (!user) redirect("/login")`, then check the page's permission with `can(user, …)` and `redirect("/dashboard")` if
missing (don't rely only on the JWT route guard). Actions: `{ error: "Nie si prihlásený.", code: "UNAUTHENTICATED" }`.
Phase gate (§13): grep shows no `session.user` / `session?.user` passed to `can`, `canAny` or `roleOf` anywhere except
`lib/access/user.ts`.

Also delete the dead public `signup` action in `lib/actions/index.ts` and `components/layout/SignUpForm.tsx`. Signup is disabled
(the page redirects), but the action creates SCOUT accounts without auth if it is ever wired up again.

`requireUser` is a fast pre-check without a lock. Operations whose correctness depends on the user's current status
(claims, transfers, routing) re-check under a User row lock (§10.1).
The `auth.config.ts` route guard stays JWT-based (navigation convenience, not security).

### 6.2 Lead access: `lib/access/leads.ts`

All helpers take a transaction client and **lock the Lead row** (`SELECT … FROM "Lead" WHERE id = $1 FOR UPDATE`) when used
for a mutation. Read-only page loads use the non-locking `…ForView` variants.

```ts
class AccessError extends Error { code: "NOT_ASSIGNED" | "NOT_FOUND" | "FORBIDDEN" | "STALE" | "DEAL_CLOSED" }

// Call stage (mutation). Locks the caller's User row FOR SHARE (assignee lock, re-checks deletedAt + calls.work), then the Lead row.
requireCallLead(tx, user, leadId, expectedRevision?)
  deletedAt null, pipelineEnteredAt null, status IN (NEW, CALLING, SNOOZED), assignedCallerId = user.id  else NOT_ASSIGNED
  expectedRevision given and != revision                                                                else STALE

// Deal mutation by manager OR owner. Locks the actor's User row FOR SHARE (re-checks deletedAt + role, so a deactivation
// waits for / blocks it), then the Lead row.
requireDealWork(tx, user, leadId, { expectedRevision?, closedPolicy?: "reject" | "allow" })
  deletedAt null AND pipelineEnteredAt not null                                                         else NOT_FOUND
  can(user,"pipeline.manage") || (can(user,"clients.work") && ownerId === user.id)                      else NOT_FOUND
  closedPolicy (default "reject"):
    "reject"            → status IN (ACTIVE, SNOOZED)                                                    else DEAL_CLOSED
    "allow"             → any deal status; permitted ONLY when can(user,"pipeline.manage") (manager edits of closed deals)
  expectedRevision given and != revision                                                                else STALE

// Manager-only deal mutation (designs, tracking, status select, WON, reopen, owner change). Locks the row.
requireDealManage(tx, user, leadId)   // pipeline.manage + deal marker

// Page loads (no lock).
requireDealView(db, user, leadId)
  deal marker, deletedAt null, and can(pipeline.view) || (can(clients.view) && ownerId === user.id)   else NOT_FOUND
```

Rules:

- The ownership check and the write happen in the **same transaction while the row lock is held**. A manager transfer
  (which also locks the row) therefore cannot slip in between.
- Design actions receive `designId`: read `design.leadId`, then `requireDealManage(tx, user, leadId)` (locks the lead), then
  re-read the design inside the transaction.
- Pages map AccessError to `notFound()`. Actions return `{ error, code }`.

### 6.3 Permissions (`lib/permissions.ts`)

New: `calls.claim`, `calls.assign`, `clients.view`, `clients.work`, `deals.receive`, `requests.resolve` (wave 3: "may
receive and resolve manager tasks").
Made explicit: `pipeline.view` / `pipeline.manage` = **all deals** (manager scope). `callHistory.viewAll` = every caller's
history; without it, own calls only.

| Permission | SCOUT | SCOUT_LEADER | TELESALES | SALES_REP | MANAGER | ADMIN |
|---|---|---|---|---|---|---|
| today.view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| contacts.access | ✓ | ✓ | | | ✓ | ✓ |
| contacts.create | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| contacts.deleteOwnUncalled | ✓ | | | | ✓ | ✓ |
| contacts.viewTeam, contacts.manageTeam | | ✓ | | | | ✓ |
| contacts.viewAll, contacts.deleteAny | | | | | ✓ | ✓ |
| calls.view, calls.work, calls.claim | | | ✓ | ✓ | ✓ | ✓ |
| calls.assign | | | | | ✓ | ✓ |
| callHistory.access, callHistory.revert | | | ✓ | ✓ | ✓ | ✓ |
| callHistory.viewAll | | | | | ✓ | ✓ |
| clients.view, clients.work | | | | ✓ | | ✓ |
| deals.receive | | | | ✓ | ✓ | ✓ |
| pipeline.view, pipeline.manage | | | | | ✓ | ✓ |
| requests.resolve | | | | | ✓ | ✓ |
| stats.view / stats.viewAll / stats.viewTeam | | view+team | | | view+all | ✓ |
| teams.manage, admin.access, users.manage | | | | | | ✓ |

ADMIN keeps `ALL_PERMISSIONS`. Claiming is explicit (§4.3), so managers having `calls.claim` has no side effects.

Route guard `requiredPermissionForPath`: add `/dashboard/calls/assignments` → `calls.assign` (check it **before** the
`/dashboard/calls` prefix, like history) and `/dashboard/clients` → `clients.view`.

**Adding contacts for callers.** TELESALES and SALES_REP have `contacts.create` but not `contacts.access`. Today
`/dashboard/contacts/new` is guarded by the `/dashboard/contacts` prefix (`contacts.access`), so they get redirected, and the
dashboard "Pridať kontakty" button leads nowhere for TELESALES. Fix:

- `requiredPermissionForPath`: `/dashboard/contacts/new` → `contacts.create`, checked **before** the `/dashboard/contacts` prefix.
- `app/dashboard/contacts/new/page.tsx`: `requireUser` + `can(user, "contacts.create")`. Show the back link to `/dashboard/contacts`
  only with `contacts.access`, otherwise back to `/dashboard`. `initialCallable` uses the pool count (§4.2), which callers already see.
- `createContact`: a new contact always goes to the pool unassigned (also when a caller creates it). If the creator lacks
  `contacts.access`, the duplicate-phone error is generic ("Toto číslo už v databáze existuje") without the existing contact's
  number or name, so it can't reveal other people's deals. Users with `contacts.access` keep today's detailed message.
- `app/dashboard/page.tsx`: show the "Pridať kontakty" button only with `contacts.create`.

Header nav (`components/layout/Header.tsx` `NAV`, and the links passed to `MobileNav`): add
`{ href: "/dashboard/clients", label: "Klienti", perm: "clients.view", hideIf: "pipeline.view" }`. Add optional `hideIf` support.

Remove `canManagePipeline` once the tracking actions use `requireDealManage`.

---

## 7. SALES_REP job and `/dashboard/clients`

### 7.1 The rep's day

1. **Dashboard**: own agenda counts (§9).
2. **Volania**: works exactly like TELESALES. Takes batches of 10 NEW, has their own retries, callbacks and snoozes.
   A positive call makes the rep the owner (routing rule 1). The deal appears in Moji klienti immediately.
3. **Moji klienti**: work through "Na dnes" from top to bottom. Call → log the follow-up outcome in the drawer →
   the next step is set automatically or chosen.
4. Quotes and emails are sent from the rep's own mailbox, then marked as sent in the app (creates a 7-day follow-up call).
5. Anything the rep can't do (unsure price, design proposal, handing the client over) → **Požiadať manažéra** — a task
   with a locked step since wave 3 (`wave-3-task-proposal-final.md`). Reopening a closed deal is the manager's; the rep tells him.

### 7.2 Business workflow per interest type

| Client wants | Rep does | App |
|---|---|---|
| Quote | Knows the price → sets it, sends the email, marks sent. Unsure → asks the manager (wave 3 task). | SEND_QUOTE → after sent: CALL +7 days. |
| About-us email | Sends the email, marks sent. | SEND_EMAIL → after sent: CALL +7 days. |
| Design proposal | Nothing technical; the manager builds the design. The rep asks for it (wave 3 task). | SEND_DESIGN; after sent: CALL +7 days for the **owner**. |
| To go ahead / order | Hands the client to the manager (wave 3 handover). | The manager continues and sets WON. |
| Not now | Snooze to a date. | SNOOZED. Returns to "Na dnes" when due. |
| No | Not interested. | LOST (closed; read-only for the rep) |

### 7.3 Page: `app/dashboard/clients/page.tsx`

Mobile-first, same visual language as `/dashboard/calls` (grouped sections of cards, vaul drawer, `UrgencyLabel`,
`DashboardPage` / `DashboardPageHeader`). Deliberately without status tabs, a table view or view filters.

```text
Header  "Moji klienti"
        description: "{open} otvorených · {today} na dnes · {overdue} po termíne"
        actions: search input, RefreshButton

Chips   Na dnes 5 (3 po termíne) · Čaká na nás 2 · Rozpracované 1 · Naplánované 9 · Čaká na klienta 7 · Spiace 4
        (click = scroll to section)

Sections in this order: TODAY, WAITING_ON_US, IN_PROGRESS, PLANNED, WAITING_ON_CLIENT, SNOOZED, CLOSED_RECENT (collapsed)
Footer link: "Archív" → /dashboard/clients?archive=1 (closed deals older than 90 days, paginated 50, searchable)
```

**Search** (`?q=`) searches all of the rep's deals (open, recent, archived) by company / website / phone / email and shows a
flat result list with section badges. This is the path to old closed deals.

### 7.4 Total section classification: `clientSection(deal, now)` in `lib/domain/clientSections.ts`

A pure function that returns exactly one value for every deal. Rules are evaluated **top to bottom, first match wins**:

```text
input: status, nextActionKind, nextActionAt, nextActionHasTime, nextActionMode, closedAt, open task (wave 3; round 1: openRequestCount), now
"due today" = isDueByBusinessDay(nextActionAt, nextActionHasTime, now)   (§10.3)
   hasTime false → businessDate(nextActionAt) <= businessDate(now)
   hasTime true  → nextActionAt <= businessDayEnd(now)   (exact appointments later today still count as today)
recentLimit = businessDayStart(now) - 90 business-calendar days

1. status IN (WON, LOST, UNREACHABLE):
     closedAt IS NOT NULL AND closedAt >= recentLimit → CLOSED_RECENT
     else                                             → ARCHIVED      (not on board; archive + search only)
     (closedAt is always set for closed deals after the backfill; a null here is treated as ARCHIVED, never as recent)
   -- below: status IN (ACTIVE, SNOOZED)
2. open manager task (wave 3; round 1: open request) → WAITING_ON_US
3. status = SNOOZED:
     nextActionAt IS NULL                           → TODAY           badge "chýba dátum"
     due today                                      → TODAY           badge "zobudený"
     else                                           → SNOOZED
   -- below: status = ACTIVE
4. nextActionKind IS NULL                           → TODAY           badge "bez ďalšieho kroku"
5. nextActionMode = IN_PROGRESS                     → IN_PROGRESS
6. nextActionKind = WAITING_FOR_CLIENT:
     nextActionAt IS NOT NULL AND due today         → TODAY           badge "skontrolovať"
     else                                           → WAITING_ON_CLIENT
7. nextActionAt IS NULL                             → TODAY           badge "bez termínu"
8. due today                                        → TODAY
9. else                                             → PLANNED
```

- Status values outside ACTIVE/SNOOZED/WON/LOST/UNREACHABLE on a deal are impossible (§8.2 restricts them). The function throws in
  development and returns TODAY with badge "neplatný stav" in production.
- Sort inside sections: TODAY by `nextActionSort` (overdue first, undated last); WAITING_ON_US by the oldest open task;
  PLANNED/SNOOZED by `nextActionAt`; CLOSED_RECENT by `closedAt` desc.
- "Overdue" (chip "po termíne", red urgency) uses the same business-day rule: day-only is overdue when its business date is before
  today's business date; exact-time is overdue when the instant is past.
- The same function computes the chip counts. Unit-test every rule when a test framework exists; until then it must stay pure,
  with no DB access.

Row card:

```text
#123 Firma s.r.o.                                       [Phone icon-button → tel:]
Ďalší krok: Zavolať, či CP prišla · <UrgencyLabel>      [badge from classification]
Posledný krok: CP odoslaná 3. 9. · 1 290 €   [Návrh otvorený 2×] [⏳ čaká na Michala]
```

Query `getClientsBoard(user, { q?, archive? })` in `lib/queries/clients/index.ts` with base where
`{ deletedAt: null, pipelineEnteredAt: { not: null }, ownerId: user.id }`. The owner id always comes from `user.id`, never from
URL params. The board query excludes archived deals in SQL
(`OR: [{ status: { in: [ACTIVE, SNOOZED] } }, { status: { in: [WON, LOST, UNREACHABLE] }, closedAt: { gte: recentLimit } }]`), then
classifies in JS. The archive query is the complement for closed deals (`closedAt < recentLimit OR closedAt IS NULL`).
Select: pipeline row fields, `revision`, latest BUSINESS activity, the open task (wave 3), and the design tracking
confidence summary (no tokens, no IPs).

### 7.5 Drawer: `components/clients/ClientDrawer.tsx`

Opens on row click. **Closed deals open a read-only drawer**: last step and history link (round 1 also had a reopen
request; removed in wave 3 — reopen is the manager's, backlog BL-01). The full drawer below is for open deals only.
Built like `CallDrawer`.

```text
Header: company · phone link · "Posledný krok: …" · the open task

main
  ✅ Dovolal/a som sa – posun…   → step "progress"
  📵 Nezdvihli                   → NO_ANSWER
  🕐 Dohodnúť čas…               → step "scheduled" (date required, time optional → hasTime)
  💶 Chcú cenovú ponuku          → WANTS_QUOTE
  🎨 Chcú návrh                  → WANTS_DESIGN (note recommended: what they want)
  🤝 Chcú objednať               → WANTS_TO_ORDER (note)
  💤 Ozvať sa neskôr…            → step "snooze" (2 / 4 / 6 months, custom date)
  ✕ Nemajú záujem                → NOT_INTERESTED (optional reason)
  ──
  Označiť ako poslané…           → Cenová ponuka odoslaná | Email „O nás" odoslaný
  Požiadať manažéra…             → kind + note
  Otvoriť detail →               → /dashboard/clients/[id]
  Poznámka (textarea)            → saved with the outcome as the call note

progress: choose the next step: Čakáme na klienta (optional check date) | Poslať CP | Poslať email | Zavolať (date [+time]) + note
```

Action `logFollowUp({ leadId, outcome, expectedRevision, idempotencyKey, schedule?: Schedule, note?, nextKind?, lostReason? })` in
`lib/actions/clients/index.ts` (`Schedule` as in §4.5, converted on the server with §10.3). One transaction:

1. Idempotency lookup first, with a full match on user, lead, `type CALL`, `source CLIENTS`, outcome (same as §4.5).
2. `requireDealWork(tx, user, leadId, { expectedRevision, closedPolicy: "reject" })`.
3. Apply `dealStateForFollowUp` with the single `bump`. Write Activity `type CALL, source CLIENTS, outcome, idempotencyKey`
   (`leadRevision` stays null), plus the PLANNING activity (`describeNextAction`). None of these bump again.

Transitions are a pure function `dealStateForFollowUp(outcome, input, current, now)` in `lib/domain/leadFlow.ts`.
"Today" means `businessTodayStart(now)` and "next working day" means `nextBusinessWorkingDayStart(now)` (§10.3).
**Precondition: `current.status IN (ACTIVE, SNOOZED)`.** Anything else throws; closed deals are never reopened here.

| Follow-up outcome | Deal change |
|---|---|
| POSITIVE | status ACTIVE; nextAction = chosen kind + schedule/note (WAITING_FOR_CLIENT may have no schedule) |
| NO_ANSWER | status unchanged; nextAction CALL at next working day start (Mon–Fri in Europe/Bratislava), hasTime false, note "Nezdvihli – skúsiť znova" |
| CALL_AGAIN | status ACTIVE; nextAction CALL from schedule (required), hasTime per schedule kind |
| WANTS_QUOTE | status ACTIVE; nextAction SEND_QUOTE today |
| WANTS_DESIGN | status ACTIVE; nextAction SEND_DESIGN today IN_PROGRESS (no automatic request since wave 3) |
| WANTS_TO_ORDER | wave 3: an ordinary reply with a chosen next step; handing over is a separate task |
| SNOOZE | status SNOOZED; nextAction CALL at the business-day start of the schedule (`day` or `monthsFromToday`, required), hasTime false |
| NOT_INTERESTED | status LOST, `closedAt = now`, lostReason, nextAction cleared (an open task is cancelled in the same save, wave 3) |
| BAD_NUMBER | status UNREACHABLE, `closedAt = now`, nextAction cleared (likewise) |

Follow-ups use `source CLIENTS`, so first-call statistics (`source CALL_QUEUE`) stay unchanged.

### 7.6 Requests to the manager — replaced

Round 1 specified requests here (`lib/domain/dealRequests.ts`: one open per deal and kind, DONE only through the
business action, automatic closing on price / send / WON / reopen / close / revert, the REOPEN exception for closed
deals). All of it is replaced in round 2 wave 3 by manager tasks with a server-side step lock and no automatic creation
or closing — `wave-3-task-proposal-final.md`. Original text: git commit `1dae205`.

### 7.7 Detail: `app/dashboard/clients/[id]/page.tsx`

`requireDealView(prisma, user, id)`, `notFound()` on failure. Closed deals render read-only (history).
For open deals, in this order:

1. **Ďalší krok**: next-action editor. Extract the form from `PipelineDetail` into a shared component; do not copy it.
2. **Asking the manager**: round 1 had a requests card here; wave 3 has a task card (`wave-3-task-proposal-final.md` §7).
3. **Údaje**: company / web / phone / email / note, with an audit diff like `updateLead`.
4. **Cena**: price + priceNote editable (D7), "Cenová ponuka odoslaná" toggle, "Klient pozná cenu".
5. **Email „O nás"**: mark as sent.
6. **Návrh**: read-only. Label, sent state, tracking confidence ("otvorené 2×, naposledy včera"). No URLs, tokens, versions or IPs.
7. **História**: BUSINESS activities only (calls, notes, sent, tasks), newest first.

Not on this page: status dropdown, owner picker, WON, reopen, design management.

Client actions (`lib/actions/clients/index.ts`; all use `requireDealWork(tx, user, leadId, { closedPolicy: "reject" })` unless
noted, `source CLIENTS`, one bump per transaction):
`logFollowUp` (+ expectedRevision), `setClientNextAction`, `updateClientContact`, `saveClientQuote`, `setClientQuoteSent`,
`setClientPriceDisclosed`, `logClientEmailSent`, `addClientNote` (round 1 also had the request actions; replaced in
wave 3).
All date-only computations inside them, such as the +7-day follow-up after quote/email sent, use §10.3.

Implementation rule: move the transaction bodies of the existing pipeline actions (`updateLead`, `saveQuote`, `setQuoteSent`,
`setPriceDisclosed`, `setNextAction`, `logSent`, `addBusinessNote`, `markLost`, `changeStatus`) into internal functions in
`lib/domain/dealMutations.ts` with signature `(tx, actor, lead, input, source)`. `lead` is the already-locked row returned by the
guard. Pipeline actions (manager guard) and client actions (owner guard) both call them. **Do not** make one action accept both
roles. Shared rules live inside these functions, so both entry points behave the same.

---

## 8. Manager (Michal) oversight

### 8.1 Pipeline list: `lib/queries/pipeline/index.ts`, `app/dashboard/pipeline/page.tsx`

- Base where everywhere: `deletedAt: null, pipelineEnteredAt: { not: null }`. The current list has no `deletedAt` filter,
  and its "Nové"/"Všetky" tabs show raw contacts.
- Status tabs: Aktívne, Spiace, Vyhraté, Stratené, Nedostupné, Všetky. **Remove "Nové".**
- New search param `owner`: `all` (default) | `me` | `unassigned` | `<userId>`, as a select "Rieši".
- Banner when any open deal has `ownerId = null`: "N obchodov nemá vlastníka" with a link to `?owner=unassigned`.
- Row: owner first name (+ the task badge from wave 3).
- "Presunúť obchody" button (§5.5).

### 8.2 Pipeline detail

- The page uses `requireDealView` with `pipeline.view`. Non-deals → `notFound()`.
- Status select limited to ACTIVE / SNOOZED / WON / LOST / UNREACHABLE. `changeStatus` (via `dealMutations`) validates the set and the
  deal marker, and applies the close rules (`closedAt`).
- **Reopen** a closed deal ("Znovu otvoriť", `pipeline.manage`):
  - status ACTIVE, `closedAt = null`, `lostReason = null`
  - nextAction CALL at `businessTodayStart()` (hasTime false) unless the manager sets another
  - uses `requireDealManage`; manager edits of other fields on closed deals use `requireDealWork(…, { closedPolicy: "allow" })`
  - DEAL_REOPENED audit
  - the owner is unchanged (the manager may change it separately)
  - returning a deal to calls is only possible via §5.4
- Owner select uses `getDealOwnerOptions()` and `changeOwner` locking (§5.3).
- The round-1 requests card with per-kind resolving buttons is replaced by the wave-3 task card (`wave-3-task-proposal-final.md` §6.3–§6.9).
- Everything else stays. The manager can perform every rep action on any deal, including closed ones.

### 8.3 Manager blocks on `/dashboard` (users with `pipeline.view`)

```text
"Čaká na mňa"   (wave 3) the manager's open tasks, oldest first: contents, requester, company (link to pipeline detail), text, age.
                Count in title; red when the oldest is > 2 days.

"Obchodníci"    one row per active user with deals.receive, excluding the viewer:
                otvorené obchody | po termíne (deal nextAction overdue) | follow-upy dnes (CALL source CLIENTS on today's business date, §10.3)
                | nové obchody tento týždeň (pipelineEnteredAt) | callbacky po termíne (their call work)
                | posledná aktivita (latest Activity.createdAt by that user)
                Row link → /dashboard/pipeline?owner=<id>

"Nepriradené"   shown only if > 0: open deals with ownerId null → link to /dashboard/pipeline?owner=unassigned

"Volajúci"      shown only if some active caller has an unfinished batch older than 1 day, or deactivated users hold call work
                → link to /dashboard/calls/assignments (this replaces automatic reclaim)
```

Queries in `lib/queries/today/manager.ts`.

---

## 9. Other read/write paths that must change (UI hiding is not security)

| Path | Required change |
|---|---|
| `lib/queries/today/index.ts` `getTodayBoard` | Split into `getCallerToday(user)`: own batchCount, poolCount, own callbacks due/overdue, own retry count, calendar of own `callbackAt`. And `getDealsToday(user)`: deals only (`pipelineEnteredAt not null`), own for `clients.view`, all for `pipeline.view`; nextAction due/overdue + calendar of `nextActionAt`. The current version returns global counts, callbacks and calendar to everyone. Its `startOfDay` / `endOfDay` / `dateKey` use server-local `setHours` / `getDate`; replace them with §10.3 business-day functions. |
| `lib/overdue.ts`, `components/shared/UrgencyLabel.tsx`, `lib/queries/pipeline` `nextActionSort` | Day comparisons (`startOfDay`, `sameDay`, "trvá X dní") use the runtime's local zone. Switch them to §10.3 so server-rendered and client-rendered labels agree with the business calendar. |
| Server-rendered date text (`toLocaleString("sk-SK")` / `toLocaleDateString` in server components and in `describeNextAction`) | Pass `timeZone: "Europe/Bratislava"`, otherwise a UTC server prints wrong hours and days. |
| `app/dashboard/page.tsx` | Compose by permission: calls block if `calls.view`; own-deals block (links to `/dashboard/clients/[id]`) if `clients.view` and not `pipeline.view`; manager blocks (§8.3) + all-deals urgent list if `pipeline.view`. |
| `lib/queries/calls/history.ts` + `app/dashboard/calls/history/page.tsx` | Own calls unless `callHistory.viewAll`. `canRevert` per §5.4; reverted badge. Lead link: pipeline detail if `pipeline.view` and deal; client detail if deal owner with `clients.view`; else plain text. `getCallHistoryUsers` → only users with CALL activities. |
| `app/dashboard/contacts/page.tsx` + `lib/queries/contacts` | The `assignedTo` filter currently uses **ownerId** → switch to `assignedCallerId` (label "Volá"). Optional second filter `owner` ("Rieši obchod"). |
| `lib/queries/stats/index.ts` `getContactPoolStats` | `assignedUncalled` groups NEW by **ownerId** → use `assignedCallerId`. `uncalled` = pool count. |
| `components/calls/CallDrawer.tsx` | Remove the `updateLeadNote` call; pass `note`, `expectedRevision`, `idempotencyKey` to `logCall` (§4.5). |
| `components/calls/InfoDrawer.tsx` → `updateLeadContact` | Scoped + locked per §5.4. |
| `lib/actions/tracking/index.ts` (all) | `requireDealManage` via `design.leadId` (locks the Lead) |
| `lib/actions/pipeline/index.ts` (all) | `requireUser` + `requireDealManage` / `requireDealWork` with `pipeline.manage`; bodies moved to `dealMutations` |
| `lib/actions/admin/index.ts` `adminDeactivateUser`, and `adminUpdateUser` when the role changes | See below. |
| Stats (not this feature) | Later: follow-ups (`source CLIENTS`), handoffs per caller (`handedOffById`), deals per owner. Exclude `revertedAt` activities from outcome counts. |

**Deactivation / role change serialization rule.** One transaction (`SET LOCAL lock_timeout = '10s'`):

1. `UPDATE "User" SET "deletedAt" = now()` (or the new role) `WHERE id = $1`. This takes the User row lock `FOR UPDATE` **first**.
   It waits for every in-flight transaction holding that row `FOR SHARE`:
   - the user's own `logCall` / `updateLeadContact` / `revertCallResult` (assignee lock, §10.1 rule 3) and their deal mutations such
     as `logFollowUp` (actor lock in `requireDealWork`, §6.2)
   - manager edits or reverts of that user's leads
   - handoffs routed to the user as team leader

   It also blocks new ones. After commit, all of them re-check `deletedAt` / role under the lock and stop.
2. If the user no longer has `calls.claim` / `calls.work` (deactivated, or the new role lacks them), release **all** their uncalled NEW:

```sql
SELECT id FROM "Lead"
 WHERE "assignedCallerId" = $1 AND status = 'NEW' AND "pipelineEnteredAt" IS NULL AND "deletedAt" IS NULL
 ORDER BY id
 FOR UPDATE;                         -- NO SKIP LOCKED: wait, bounded by lock_timeout
UPDATE "Lead" SET "assignedCallerId" = NULL, "assignedCallerAt" = NULL, "revision" = "revision" + 1
 WHERE id = ANY($ids) AND "assignedCallerId" = $1
 RETURNING id;
-- CALLER_RELEASED audit only for returned ids
SELECT count(*) FROM "Lead" WHERE "assignedCallerId" = $1 AND status = 'NEW' AND "deletedAt" IS NULL;  -- must be 0
```

   - If the final count is not 0 or `lock_timeout` fires → **ROLLBACK the whole transaction, including the deactivation**. Return
     `RETRYABLE` ("Používateľ práve pracuje – skús znova o chvíľu"). The admin retries. The user is never left deactivated with
     NEW contacts.
   - At most 10 rows (batch cap), so one transaction is enough.
   - Retries, callbacks, snoozes and deals are **not** auto-moved.
3. Return counts; the user detail UI shows "Má X retry, Y dohodnutých, Z obchodov – presuň ich" with links to §4.6 and §5.5.

Why no NEW can stay assigned:
- A concurrent `claimBatch` either commits before step 1 acquires the lock (its rows exist when step 2 selects them, because step 2
  runs after the lock is held and reads committed data), or waits and then sees `deletedAt` / the new role and claims nothing.
- A call on one of those leads that later fails held the user's row `FOR SHARE`, so step 1 waited for it to finish or roll back.
- Manager transfers into this user lock the target row `FOR UPDATE` and re-check `deletedAt`.
- A handoff routed to this user as team leader either commits first or runs after and sees the leader inactive (→ unrouted).

Small related fix: `auth.ts` does `void prisma.user.update(...)`. Prisma queries are lazy and run only when awaited or `.then`-ed,
so `lastLoginAt` has never been written (null for every user). Replace it with `prisma.user.update(...).catch(() => {})`.

---

## 10. Concurrency, locking, stale UI

### 10.1 Locking discipline (mandatory for every mutation in this feature)

1. **Lock order:** `Team` rows (ascending id) → `User` rows (ascending id) → `Lead` rows (ascending id). Never lock backwards in
   the same transaction. When a lead-dependent team/user is needed (current assignee, routing team/leader, owner-change target,
   revert author), read its id without a lock, take the Team/User locks, then lock the Lead and **re-validate** that the id is
   unchanged. If it changed, abort with `RETRYABLE` (or `STALE` when the client sent an `expectedRevision`).
2. **Lead mutations:** always `SELECT … FOR UPDATE` on the Lead row(s) (via the §6.2 helpers), re-check scope/state/revision
   under the lock, write with `bump`, write activities, commit.
   - Only two operations may use `SKIP LOCKED`: `claimBatch` (unassigned pool rows) and the bulk deal transfer (§5.5, where
     skipped rows are reported).
   - Call-work transfers and deactivation never skip rows (§4.6, §9).
   - All bulk writes use `UPDATE … RETURNING` and audit only the returned ids.
3. **Assignee lock:** every mutation of a lead that has `assignedCallerId` set, by anyone, first locks that assignee's User row
   `FOR SHARE`: `logCall`, `updateLeadContact`, `revertCallResult` (author row), manager contact edit/delete. Operations that change
   a user's call work or status take the same row `FOR UPDATE`: `claimBatch`, transfer (source and target), deactivation, role
   change. So a user's call work and changes to that user's assignments/status never interleave.
4. **Other User status-dependent reads** (routing leader, owner-change target, transfer target) lock the User row `FOR SHARE`;
   routing also locks the Team row `FOR SHARE` (§5.1).
5. Transaction options: Prisma interactive transactions with explicit `{ maxWait: 5_000, timeout: 15_000 }` and
   `SET LOCAL lock_timeout = '5s'` (10 s for deactivation). Bulk loops use batches of ≤ 200 rows per transaction.
6. Postgres deadlock (40P01) or lock timeout → return `{ error, code: "RETRYABLE" }` and don't auto-retry server-side. The client
   shows the retry toast with the same idempotency key.

### 10.2 Stale UI and duplicate submits

- **Two tabs of the same user** submitting different outcomes for the same lead: both carry `expectedRevision = r`. The first
  commits (revision → r+1); the second fails `STALE` and refreshes. The same applies to `logFollowUp` and `revertCallResult`.
- **Retry of the same submit** (network error after commit): same idempotency key → the step-2 lookup returns success before the
  revision check.
- Idempotency matches on `userId + leadId + type + source + outcome`; a mismatch is `IDEMPOTENCY_CONFLICT`. The same comparison
  runs after a P2002 race.
- A manager transfer while the caller has the drawer open: the caller's submit fails `NOT_ASSIGNED` (or `STALE`) and refreshes.
- Actions return `{ error, code?: "UNAUTHENTICATED" | "NOT_ASSIGNED" | "NOT_FOUND" | "FORBIDDEN" | "STALE" | "DEAL_CLOSED" | "IDEMPOTENCY_CONFLICT" | "RETRYABLE" }`.
  The client refreshes on NOT_ASSIGNED / NOT_FOUND / STALE / DEAL_CLOSED / IDEMPOTENCY_CONFLICT and offers retry only for RETRYABLE
  and network errors.
- Honest limit: the app cannot stop a person from dialing a number they already saw before a manager transfer. Exposure is capped at
  one batch (10 uncalled NEW) per caller. Numbers never move automatically, and every manual move is audited.
- `CallQueue` keeps its 60-second `router.refresh()`.
- Other edits (notes, contact data, price) don't require `expectedRevision` (last write wins under the row lock). The next-action
  editor and follow-ups do. Because every lead-related change bumps the revision, an open follow-up drawer also goes STALE after a
  manager note on that deal. That is intended: refresh and re-check.

### 10.3 Business calendar: `lib/domain/businessTime.ts`

The team works in Slovakia. Servers (e.g. Vercel) run in UTC; browsers may be anywhere. **Every day-level computation uses the
business zone `Europe/Bratislava`**, implemented with `Intl.DateTimeFormat` (`timeZone`), with no new dependency and DST-safe.

```ts
export const BUSINESS_TZ = "Europe/Bratislava";
businessDate(instant: Date): string                     // "YYYY-MM-DD" in BUSINESS_TZ
businessDayStart(date: string): Date                    // instant of 00:00 BUSINESS_TZ on that date (DST-correct)
businessDayEnd(instant: Date): Date                     // last ms of that instant's business day
businessTodayStart(now = new Date()): Date
addBusinessCalendarDays(date: string, n: number): string
addBusinessCalendarMonths(date: string, n: number): string   // clamps to month end (31.1. + 1 month → 28./29.2.)
nextBusinessWorkingDayStart(now = new Date()): Date     // next Mon–Fri date after today; Slovak public holidays ignored in v1 (§16)
wallTimeToInstant(date: string, time: string): Date     // "2026-10-26" + "13:00" BUSINESS_TZ → instant
isDueByBusinessDay(at: Date, hasTime: boolean, now: Date): boolean
isOverdue(at: Date, hasTime: boolean, now: Date): boolean
```

Storage convention (compatible with existing data, which Slovak browsers created as local midnights / 09:00):

- **Day-only** (`*HasTime = false`): store `businessDayStart(date)`. When reading, compare **only `businessDate(at)`**, never the
  raw instant, so legacy values at 09:00 local (snooze presets) or UTC midnight (the current custom snooze input) land on the
  right day.
- **Exact time** (`*HasTime = true`): store the instant; compare instants.

Rules that use it:

| Rule | Computation |
|---|---|
| handoff next action "today" | `businessTodayStart()` |
| "Zajtra" / "O týždeň" | `businessDayStart(addBusinessCalendarDays(businessDate(now), 1 / 7))` |
| snooze 2 / 4 / 6 months | `businessDayStart(addBusinessCalendarMonths(businessDate(now), n))` |
| custom date / date + time | `businessDayStart(date)` / `wallTimeToInstant(date, time)` |
| follow-up +7 days after quote / email / design sent | `businessDayStart(addBusinessCalendarDays(businessDate(sentAt), 7))`, hasTime false. This replaces today's `setDate(+7)` on the server-local instant. |
| follow-up NO_ANSWER | `nextBusinessWorkingDayStart(now)` |
| "Na dnes", chips, today board, calendar keys, overdue | `isDueByBusinessDay` / `isOverdue` / `businessDate` |
| CLOSED_RECENT limit | `businessDayStart(addBusinessCalendarDays(businessDate(now), -90))` |

Clients send dates as `YYYY-MM-DD` strings and times as `HH:mm` (the `Schedule` type, §4.5); "O hodinu" is the only
client-relative instant (`inHours`, computed on the server from `now`).

---

## 11. Backfill: `prisma/backfill/2026-09-assignments.ts`

Run with `tsx`. Separate from the schema push. **Dry-run by default.** It uses the `pg` driver directly (one connection, explicit
`BEGIN` / `COMMIT`, set-based SQL), not a Prisma interactive transaction.

### 11.1 Target identity (refuse to run on mismatch)

Required flags: `--expect-endpoint <neon endpoint id, e.g. ep-xxxx-yyyy>` and `--expect-db <database name>`.

- The script parses `DATABASE_URL`, takes the first DNS label, strips the `-pooler` suffix → endpoint id. It requires both
  values to match. Neon endpoint ids differ per branch, so a test branch and production can't be confused even with the same db name.
- It requires a **direct** (non-pooler) host for `--apply`.
- It prints: endpoint id, db name, server version, `now()`, total non-deleted lead count. It never prints the URL, user or password.
- `--apply` additionally requires `--confirm <endpoint id>` typed again.
- Flags: `--apply`, `--owner-username <Michal's username>`, `--verify`, `--identity` (print identity only; used before schema commands, §12).
- The owner user must exist, be active, and be ADMIN or MANAGER.

### 11.2 Definitions

Per non-deleted lead, compute these predicates (one SQL CTE; "non-reverted" = `revertedAt IS NULL`):

| Predicate | Definition |
|---|---|
| `pos` | number of **positive first calls**: Activity `type = CALL AND source = CALL_QUEUE AND outcome IN (WANTS_QUOTE, WANTS_DESIGN, WANTS_EMAIL, POSITIVE) AND revertedAt IS NULL` |
| `derivedAt`, `derivedBy` | `createdAt`, `userId` of the earliest positive first call (only when `pos = 1`) |
| `anyCall` | any Activity `type = CALL` exists (reverted or not, any source) |
| `queueCall` | a non-reverted Activity `type = CALL AND source = CALL_QUEUE` exists; `lastQueueCallBy` = author of the latest one |
| `dealAct` | any Activity with `source IN (PIPELINE, CLIENTS)` exists |
| `M` | `pipelineEnteredAt IS NOT NULL` |
| `Mok` | `pipelineEnteredAt = derivedAt AND handedOffById = derivedBy` |
| `A` | `assignedCallerId IS NOT NULL` |
| `ownerOk` | `ownerId IS NULL OR ownerId = <owner user>` |
| `closedOk` | `(status IN (WON, LOST, UNREACHABLE)) = (closedAt IS NOT NULL)` |
| `DEAL_ST` / `CLOSED_ST` / `CALL_ST` / `TERM_ST` | `(ACTIVE, SNOOZED, WON, LOST, UNREACHABLE)` / `(WON, LOST, UNREACHABLE)` / `(CALLING, SNOOZED)` / `(LOST, UNREACHABLE)` |

**Global preconditions** (abort before classifying): no Activity `type = OUTCOME_CORRECTED` exists (0 as of 2026-09-16).

### 11.3 Classification (every non-deleted lead gets exactly one class)

The conditions below are **mutually exclusive**. The script evaluates them as one SQL `CASE` in this order, and additionally asserts
that no lead matches two conditions. **Every combination not listed is CONFLICT.** In particular, a positive first call on a lead
whose status is NEW or CALLING is CONFLICT; it is never turned into a deal by setting a marker.

| # | Class | Exact condition | Action |
|---|---|---|---|
| 1 | DEAL_TO_MIGRATE | `pos = 1 AND NOT M AND status IN DEAL_ST AND ownerOk AND closedAt IS NULL` | `pipelineEnteredAt = derivedAt`, `handedOffById = derivedBy`, `ownerId = COALESCE(ownerId, owner)`, `assignedCallerId/At = NULL`, `closedAt` = (status IN CLOSED_ST ? latest `STATUS_CHANGED` activity `createdAt` on the lead, else `updatedAt` : NULL), `revision + 1` |
| 2 | DEAL_OK | `pos = 1 AND Mok AND status IN DEAL_ST AND NOT A AND closedOk` | none (already migrated or created by new code; any owner incl. NULL is legitimate) |
| 3 | DEAL_CLOSEDAT_FIX | `pos = 1 AND Mok AND status IN DEAL_ST AND NOT A AND NOT closedOk` | closed status → `closedAt` as in row 1; open status → `closedAt = NULL`; `revision + 1` (old code closed or reopened a deal between backfill and deploy) |
| 4 | CALLWORK_TO_MIGRATE | `pos = 0 AND NOT M AND status IN CALL_ST AND NOT A AND queueCall AND NOT dealAct AND closedAt IS NULL` | `assignedCallerId = lastQueueCallBy`, `assignedCallerAt` = that call's `createdAt`, `revision + 1` |
| 5 | CALLWORK_OK | `pos = 0 AND NOT M AND status IN CALL_ST AND A AND anyQueueCall AND NOT dealAct AND closedAt IS NULL`, where `anyQueueCall` = any Activity `type = CALL AND source = CALL_QUEUE`, **including reverted** (a lead whose only first call was reverted is CALLING RETRY assigned to the caller and must stay call work, §15) | none |
| 6 | POOL | `NOT M AND status = NEW AND NOT anyCall AND NOT dealAct AND closedAt IS NULL` (`A` may be either: a claim by new code) | none |
| 7 | NEW_WITH_HISTORY | `pos = 0 AND NOT M AND status = NEW AND NOT A AND queueCall AND NOT dealAct AND closedAt IS NULL` | same as a new-code revert: `status CALLING`, `callbackKind RETRY`, callback* cleared, `assignedCallerId = lastQueueCallBy` (still assigned if deactivated → orphaned in §4.6), `assignedCallerAt = now()`, `revision + 1`, AUDIT `STATUS_CHANGED` (source ADMIN) "Migrácia: nový kontakt s históriou hovorov → Skúsiť znova". 0 as of 2026-09-16. |
| 8 | TERMINAL_OK | `pos = 0 AND NOT M AND status IN TERM_ST AND NOT A AND NOT dealAct AND closedAt IS NULL` | none |
| 9 | STRAY_ASSIGNMENT | `pos = 0 AND NOT M AND status IN TERM_ST AND A AND NOT dealAct AND closedAt IS NULL` | `assignedCallerId/At = NULL`, `revision + 1` (old code closed call work between backfill and deploy) |
| 10 | CONFLICT | anything else | **abort the whole run**, print lead numbers only |

Typical CONFLICT cases (not exhaustive, the rule is "not rows 1–9"):
- `pos > 1`
- `pos ≥ 1` with status NEW or CALLING
- `M` without `Mok` (marker differs from derivation, or `pos = 0`)
- `pos = 1 AND NOT M AND NOT ownerOk` (a different pre-existing owner)
- a deal with `A` set
- `dealAct` without a positive first call
- ACTIVE or WON with `pos = 0`
- NEW whose calls are all reverted, or a CALL_ST lead without any CALL_QUEUE call (an assigned CALL_ST lead with only
  reverted CALL_QUEUE calls is `CALLWORK_OK` under row 5)
- `closedAt` set on a non-deal

**Anchor pass** (same transaction, after the class updates; independent of the class). This gives legacy non-deal calls a revert
anchor (§5.4). For every non-deleted lead with `pipelineEnteredAt IS NULL` whose latest non-reverted `CALL_QUEUE` CALL activity
has `leadRevision IS NULL`, **and** no Activity of any type exists on that lead with a later `createdAt` (the NEW_WITH_HISTORY
audit row written in this run counts as later, so those leads get no anchor): set that activity's `leadRevision` = the lead's
current `revision` (after this run's bumps). Deals get no anchor. It's an Activity write only, with no Lead bump.
Report the count as ANCHOR_PENDING in the dry-run. It must be 0 after apply.

Report only (not classified, not changed): deleted leads with positive calls; count of row-1/row-3 `closedAt` values that used
the `updatedAt` fallback.

Backfill SQL never modifies `updatedAt` (raw SQL doesn't trigger Prisma's `@updatedAt`; don't set it explicitly).

After apply, and on every later run, these must hold, else ROLLBACK:
- the invariant "status NEW ⇒ no CALL activity" (§4.2)
- "closed deal ⇔ `closedAt` set"

### 11.4 Apply

- One transaction: `SET LOCAL statement_timeout = '120s'`, `SET LOCAL lock_timeout = '10s'`.
- Each class runs as **one set-based UPDATE** built from a CTE of the classification query, with guards repeated in the WHERE
  (e.g. `AND "pipelineEnteredAt" IS NULL`, `AND "assignedCallerId" IS NULL`) and `RETURNING id`.
- The returned counts must equal the dry-run counts computed in the same transaction. On mismatch → ROLLBACK.
- After the updates, the script re-classifies inside the transaction. It must find **only** DEAL_OK, CALLWORK_OK, POOL and
  TERMINAL_OK (0 of classes 1, 3, 4, 7, 9, 10) and ANCHOR_PENDING = 0, else ROLLBACK. Then COMMIT.
- A second run must report only those four classes, plus any delta written by old code in between, which rows 1, 3, 4, 7 and 9
  migrate or which aborts as CONFLICT for manual resolution.

### 11.5 Output

The dry-run prints the class counts, per-status breakdown, per-user assignment counts, exceptions by lead `number` (never phone or
email), and "would change N rows". `--verify` prints the current classification only.

Reference counts from a read-only check of production on 2026-09-16 (**sanity only, recompute, never hardcode**):

| Set | Count |
|---|---|
| Deals | 116 = ACTIVE 63 (16 never touched in pipeline) + SNOOZED 6 + WON 1 (already owned by Michal) + LOST 39 + UNREACHABLE 7 |
| Call work | CALLING RETRY 1,207 (Timea 1,206 / Michal 1) + CALLING SCHEDULED 60 (Timea 59 / Michal 1; 58 overdue) + SNOOZED 15 (Timea) |
| Pool | NEW 334 |
| Terminal first call | LOST 1,549, UNREACHABLE 339 |
| Anomalies | none: 0 multi-positive, 0 pipeline-before-positive, 0 OUTCOME_CORRECTED, 0 duplicate phones, 6 deleted (all NEW) |
| Users | Michal ADMIN (all pipeline work), Nikolas MANAGER (observer, creates contacts), Timea TELESALES, scouts Jano/Lukáš/Miloslav, Šimon SCOUT_LEADER |

Team setup is **not** done by the script. It warns if any active user with `calls.work` but without `deals.receive` has no routable
team leader.

---

## 12. Environments and database safety

- **Development never uses the production DB.** Create a Neon branch from production (e.g. `dev-assignments`) and point local
  `.env` `DATABASE_URL` at the branch. Recreate it from production before each rehearsal.
- `prisma.config.ts` reads `DATABASE_URL`. For any schema command, set `DATABASE_URL` to the **direct** URL of the intended target
  in a fresh shell for that command only, and verify the target first:

```powershell
# fresh PowerShell window; paste the direct URL of the intended target (not echoed anywhere)
$env:DATABASE_URL = "<direct url of target>"
npx tsx prisma/backfill/2026-09-assignments.ts --identity --expect-endpoint ep-xxxx --expect-db neondb
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o "$env:TEMP\zvoncek-schema-diff.sql"
```

(The diff file goes outside the repository so it is never committed. `$env:TEMP` is the PowerShell temp directory.)

- Prisma **7.8.0** syntax: `--from-config-datasource` and `--to-schema` (`--from-url` / `--to-schema-datamodel` don't exist in this
  version). `migrate diff` is read-only.
- Review the diff file. Allowed statements only: `CREATE TYPE`, `ALTER TYPE … ADD VALUE`, `CREATE TABLE`,
  `ALTER TABLE … ADD COLUMN` (nullable or constant default), `CREATE [UNIQUE] INDEX`, `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`.
  Any `DROP`, `ALTER COLUMN`, `SET NOT NULL` on existing columns, or a data-loss prompt → stop and ask.
- Push in the same shell: `npx prisma db push`, then `npx prisma generate`. **Never** `--accept-data-loss` or `--force-reset`.
  If `db push` asks for confirmation of anything destructive, answer no and stop.
- Development agents run these commands **only against a Neon dev branch**. Production only in the approved rollout session (§14).

---

## 13. Implementation phases

Each phase ends with `npx tsc --noEmit`, lint, and a manual check on the Neon dev branch.

1. **Schema, dictionaries, permission matrix, revision helper, business calendar** (§3, §6.3, §10.3). No behavior change yet.
   - includes the hand-written `ROLES` array (+ `ROLE_VARIANT`) and the stats `OUTCOME_ORDER` / `GOOD` arrays (§3 notes)
   - check: `/dashboard/admin/users/new` and the user profile card offer "Obchodník" (SALES_REP) on the dev branch
   - `lib/domain/businessTime.ts` with a small self-check script (`prisma/backfill/check-business-time.ts`, branch/local only):
     DST switch days (2026-03-29, 2026-10-25), month-end addition, next working day from Fri/Sat/Sun, and a UTC-process run
     (`$env:TZ="UTC"`) giving the same results as `Europe/Bratislava`
2. **Access helpers + locking utilities**: `requireUser`, `requireCallLead`, `requireDealWork` (with `closedPolicy`),
   `requireDealManage`, `requireDealView`, error codes, `lockUsers(tx, ids, mode)`, `lockTeam(tx, id, mode)`, `bumpLeadOnce`
   (§3, §6, §10.1). `lastLoginAt` fix. Migrate **all** existing actions/pages listed in §6.1 to `requireUser`.
3. **Backfill script** (§11) and first run on the **dev branch**, so every later phase is developed against realistically assigned
   data (Timea's queue, Michal's deals). Re-run it after pulling a fresh production branch.
4. **Calls**: `claimBatch`, personal board, `logCall` rewrite (Schedule input, note inside, single bump, `leadRevision`,
   idempotency, routing, handoff), `CallDrawer` / `CallQueue` changes, `revertCallResult` + reverted markers, remove `getMoreNew` /
   `correctOutcome` / `editActivityNote` / `resetLeadToCalls` / `updateLeadNote`, scoped `updateLeadContact`, history scope, scout
   lock, team action locking, contacts/new route (§4, §5.1–5.4, §6.3).
5. **Pipeline hardening**: `dealMutations` extraction with close rules, marker filters, status restriction, reopen, owner
   options, `changeOwner` locking, tracking guards, owner filter, unassigned banner, bulk deal transfer, +7-day follow-ups
   via the business calendar (§5.5, §8.1–8.2). (Round 1 also built the requests card and view — replaced in wave 3.)
6. **Clients**: client actions, `clientSection`, `/dashboard/clients` + archive + search + drawer + detail, nav (§7).
7. **Dashboards and other paths** (§8.3, §9 incl. time zone fixes), assignments tool (§4.6), deactivation/role-change serialization.
8. **Gate:**
   - grep that every business transaction touching a lead bumps its revision **exactly once**, and that writing
     `Activity.leadRevision` / `revertedAt` never bumps (§3)
   - grep that no `setHours(0` / `getDate()` / `toLocale*` without `timeZone` remains in server-side day logic (§10.3)
   - `ROLES` contains every `Role` value (a one-line runtime assertion in `lib/dictionaries.ts` is fine)
   - grep that `session.user` / `session?.user` is passed to `can` / `canAny` / `roleOf` **nowhere** except `lib/access/user.ts` (D11, §6.1)
   - grep that no Lead mutation skips a §6.2 helper, and every mutation of an assigned lead takes the assignee lock (§10.1 rule 3)
   - grep that `SKIP LOCKED` appears only in `claimBatch` and the bulk deal transfer
   - grep that team actions lock Team → User in that order (§5.1)
   - the `signup` action and `SignUpForm` are deleted
9. **Concurrency scripts** (branch only, `prisma/backfill/check-concurrency.ts`):
   - 2 users × 20 parallel claim transactions → no overlapping ids, each user ≤ 10, a second batch only after empty
   - same user, 2 parallel `logCall` with different keys and the same `expectedRevision` → exactly one CALL activity
   - `claimBatch` racing `adminDeactivateUser` (100 iterations) → a deactivated user never holds NEW
   - `logFollowUp` by the owner racing a bulk owner transfer → no activity by a non-owner after the transfer committed
   - `revertCallResult` twice in parallel → one CALL_REVERTED
   - deactivation while that user has a `logCall` transaction open on a NEW lead that then **rolls back** (inject an error after
     the Lead lock) → deactivation waits, then releases that lead; the user holds 0 NEW afterwards (repeat 100×)
   - deactivation with a lead lock held by an unrelated long transaction past `lock_timeout` → deactivation rolls back entirely
     (user still active, returns RETRYABLE); never deactivated with NEW left
   - transfer a retry from A to B, then A calls `revertCallResult` on their older call → rejected (revision changed); the lead
     stays with B
   - handoff by Timea racing `setTeamLeader` (Michal → rep) 100× → every deal's owner equals the leader committed before that
     handoff's transaction took the Team lock; no deadlock left unhandled (RETRYABLE only)
   - `deleteTeam` racing handoffs → no deadlock errors other than RETRYABLE; deals unrouted after the delete commits
   - a first call immediately followed by `revertCallResult` → allowed (proves `leadRevision` bookkeeping didn't bump)
10. **Rehearsal on a fresh production branch** (same day as the rollout):
    - identity → dry-run → apply → re-run shows only DEAL_OK / CALLWORK_OK / POOL / TERMINAL_OK
    - simulate old-code writes between runs, then re-run; each must migrate exactly that delta:
      - a CALLING lead set LOST with the assignment left → STRAY_ASSIGNMENT
      - a migrated deal set LOST without `closedAt` → DEAL_CLOSEDAT_FIX
      - a NO_ANSWER on a POOL lead → CALLWORK_TO_MIGRATE
      - a positive call on a CALLWORK_OK lead → DEAL_TO_MIGRATE
    - a positive-call lead forced to status CALLING → CONFLICT abort
    - click through as every role (create test users on the branch: TELESALES in team "Obchod", SALES_REP, SCOUT, MANAGER)
11. **Production rollout** (§14), in a separate approved session.
12. **Docs**: remove `[PLANNED]` tags in `context/app-workflow.md`, update `AGENTS.md` (roles, routes, files, locking rule; it still
    points to `docs/app-workflow.md`, which moved to `context/`), update `context/progress-tracker.md`.

---

## 14. Production rollout (separate approved session, evening, nobody calling)

0. **Preconditions:**
   - The admin UI shows Michal leads no team (or the team he leads is the one to use).
   - All callers know calling is paused for the window.
   - Phases 1–10 are done (phase 10 = rehearsal on a fresh production branch the same day).
1. **Independent backup:**
   - `pg_dump --format=custom` of production with a `pg_dump` version ≥ the server major version (server is PostgreSQL 18), stored
     outside Neon.
   - Verify it restores: `pg_restore` into an empty scratch Neon branch or local Postgres 18, then compare row counts of `Lead`,
     `Activity`, `User`, `Design`, `Tracker`, `TrackerEvent`.
2. **Neon restore-point branch** `pre-assignments-YYYYMMDD` from production. This comes **before any production write**, including
   the team change.
3. Admin UI: create team "Obchod", leader Michal, member Timea (harmless for old code).
4. Fresh shell with the direct production URL → `--identity` check → `migrate diff` → review → `db push` → `generate` (§12).
5. Backfill: identity → dry-run → review → `--apply --confirm <endpoint>` → re-run shows only DEAL_OK / CALLWORK_OK / POOL /
   TERMINAL_OK.
6. Deploy the new code.
7. Backfill again: must show only a delta written by old code between steps 5 and 6 (usually none; nobody was calling), then only
   the four OK classes.
8. `--verify`, then log in as Michal: pipeline shows all deals, no "Nepriradené"; `/dashboard/calls/assignments` counts match the
   call-work numbers. Log a test call on a real retry only if agreed.
9. Callers may resume. Watch `/dashboard/calls/assignments` and "Čaká na mňa" for the first day.
10. Only now create the SALES_REP account in `/dashboard/admin/users/new` (role "Obchodník" = SALES_REP; no team needed for their
    own handoffs).
11. Later, when a SALES_REP takes over Timea's follow-ups: make the rep the leader of Timea's team → optional bulk deal transfer
    (`fromOwner = Michal, handedOffBy = Timea, open`) → optionally move part of Timea's retry backlog (§4.6).

### 14.1 If something goes wrong

- **Prefer roll-forward:** fix the bug and redeploy. The schema is additive, so fixes rarely need DB changes.
- **Code rollback to the old version is NOT a transparent fallback.** Old code ignores `assignedCallerId`, `pipelineEnteredAt`,
  `ownerId` scoping and `revision`:
  - it shows the shared global call queue again (duplicate calls)
  - it allows global call mutations
  - it creates deals without markers, owners or revision bumps

  If you must roll back: **pause calling first**, keep it paused while the old code runs, and before re-deploying the new code run
  the backfill again (it migrates the delta or aborts on conflicts, which you resolve manually).
- **Database restore** (restore-point branch or the pg_dump) is the **last resort**. It discards every write after the restore point
  (calls, contacts added by scouts, tracking events). Decide it immediately, and list what will be lost first.

---

## 15. Acceptance checklist

- [ ] Two callers in different browsers never see the same NEW contact.
- [ ] A caller gets exactly one batch of ≤ 10 by clicking, can't get another until the batch is fully called, and nothing is claimed
      by merely opening the page (checked as Michal).
- [ ] An unfinished batch never moves automatically. The manager releases or transfers it, and a NEW transfer respects target capacity.
- [ ] NO_ANSWER / callbacks / call snoozes stay in the caller's own queue and are invisible to other callers.
- [ ] Two tabs of one caller submitting different outcomes for one contact → one recorded, the other refreshes with "zmenil".
- [ ] A network retry of the same submit → recorded once, reported as success.
- [ ] The manager moves 1,000+ retries → done in batches; audit rows exist only for moved leads; no row is silently skipped.
- [ ] Deactivating a caller leaves **0** NEW contacts assigned to them, even with a parallel claim or an in-flight call that fails.
      If that can't be guaranteed within the lock timeout, the deactivation doesn't happen and asks to retry.
- [ ] A deactivated user can't load any dashboard page or call any server action (including stats, teams, admin), without waiting for JWT expiry.
- [ ] The former caller can't edit phone/email of a contact transferred to someone else (history row read-only, direct action call fails).
- [ ] Changing the team leader while handoffs are happening: every deal goes to the leader valid at its commit; nothing is lost or errors silently.
- [ ] TELESALES/SALES_REP can open `/dashboard/contacts/new` and add a contact; it lands in the pool; they can't open `/dashboard/contacts`.
- [ ] No NEW contact with call history exists after the backfill, and the pool never offers one.
- [ ] Timea's WANTS_* → deal owned by the team leader (Michal); the toast shows the actual recipient. After switching the leader →
      owned by the rep.
- [ ] Timea without a team → deal "Nepriradené", visible in the pipeline banner and on the manager dashboard. Timea is not blocked.
- [ ] SALES_REP positive first call → own deal in Moji klienti.
- [ ] SALES_REP gets redirected from `/dashboard/pipeline`, gets 404 on `/dashboard/pipeline/<id>` and on other people's
      `/dashboard/clients/<id>`. Direct server-action calls with foreign ids fail.
- [ ] Manager transfers a deal while the rep has its drawer open → the rep's submit fails and refreshes; no activity by the rep after the transfer.
- [ ] SALES_REP can't log follow-ups or edit a WON/LOST/UNREACHABLE deal; the manager reopens.
- [ ] Every deal appears in exactly one section; old closed deals are reachable via Archív and search.
- [ ] SALES_REP sets price + marks quote sent → CALL +7 days in Naplánované.
- [ ] (Round-1 request checks are replaced by the wave-3 task tests — `wave-3-task-proposal-final.md` §9.)
- [ ] Michal can create a user with role "Obchodník" (SALES_REP) in the admin form and change an existing user to it.
- [ ] With the server process in UTC: a callback / next action for "zajtra" (day-only) created at 23:30 Bratislava time appears in
      "Na dnes" only on the next Bratislava day. "O týždeň" and the +7-day follow-up land on the correct Bratislava date across a DST
      change. Follow-up "Nezdvihli" on Friday → Monday.
- [ ] Right after a first call, the caller can revert it (the `leadRevision` bookkeeping doesn't break the revision equality).
- [ ] Backfill dry-run on a production branch: every lead in exactly one class; a positive-call lead with status NEW or CALLING
      aborts as CONFLICT instead of becoming a deal; historical closed deals get `closedAt`.
- [ ] Manager saving a price on a rep's deal keeps the owner.
- [ ] Pipeline never lists NEW/CALLING/deleted contacts. Timea's "Spiace" no longer shows pipeline deals.
- [ ] SCOUT cannot edit a claimed NEW contact.
- [ ] Revert works only on the latest non-reverted call and only if nothing changed on the lead since that call: no transfer,
      owner change, next-action edit, note, task or design. A second revert is rejected. The lead returns to the original caller
      as RETRY. A later backfill run classifies it as call work, not a deal.
- [ ] First-call statistics don't change when follow-ups are logged.

## 16. Open questions (non-blocking; implement the default in parentheses)

1. May SALES_REP mark a design as sent? (No, the manager does it.)
2. Should a SALES_REP see Timea's call history? (No.)
3. Follow-up NO_ANSWER delay: next working day or configurable? (Next working day.)
4. May SALES_REP mark small deals WON directly? (No — WON is the manager's; wave 3: the rep hands the client over.)
5. Should `CLAIM_BATCH_SIZE` be admin-editable? (No, code constant for v1.)
6. Per-client recipient choice or distributing one caller's handoffs across several reps? (No in v1; the manager reassigns.
   Revisit with an explicit routing list if needed.)
7. "Volajúci" manager warning threshold for an unfinished batch? (Older than 1 day.)
8. Slovak public holidays in "next working day"? (Ignored in v1; Mon–Fri only.)
