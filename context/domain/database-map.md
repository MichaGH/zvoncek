# Database Map

What the database holds **right now** on the test branch (`prisma/schema.prisma`). Current state only — no plans.
Anything production is still missing is in `db-changes.md`; anything designed but unbuilt is in `../app-workflow.md`
with a marker.

Conventions: Prisma model names are the table names. `?` = nullable. Every id is `cuid()`. Bare Prisma `DateTime`
maps to PostgreSQL `timestamp(3)` **without a time zone**; this app stores and interprets those values as UTC.
**All day-level meaning is Europe/Bratislava** and is computed in code
(`lib/domain/businessTime.ts`), never by the database.

---

## Lead — the central model

One row per contact, and the same row later as a deal. **Never renamed.** Soft-deleted with `deletedAt`.

**Stage is decided by `pipelineEnteredAt`, not by status:** `NULL` = call stage, set = deal.

| Field | Meaning |
|---|---|
| `id`, `number` | `number` is a human-facing autoincrement (`#412`), unique |
| `companyName?`, `phone?`, `website?`, `email?` | contact data; all optional, a lead may be only a phone number |
| `note?` | single mutable free-text field, initially the contact-entry note; contact edits overwrite it (with a `CONTACT_UPDATED` diff), and a supplied first-call note also replaces it. There is no separate authored-note history today |
| `status` | `LeadStatus` — see below |
| `origin` | `LeadOrigin`, default `MARKETING_CALL` |
| `projectType?` | `ProjectType`, manager-set |
| `ownerId?` | **who owns the deal** (`User`) |
| `createdById?` | who added the contact — scout statistics only |
| `assignedCallerId?`, `assignedCallerAt?` | **who does the call-stage work**; set by a claim or a manager transfer, never expires |
| `pipelineEnteredAt?` | set at the positive first call = "this is a deal"; cleared only by reverting that call |
| `handedOffById?` | who made that positive call (drives the "Od:" filter) |
| `closedAt?` | deals only: `WON`/`LOST`/`UNREACHABLE`; `NULL` while open |
| `revision` | optimistic version, `+1` **exactly once per business transaction** |
| `nextActionKind?`, `nextActionAt?`, `nextActionHasTime`, `nextActionMode`, `nextActionNote?` | **deal phase only** — what happens next |
| `callbackKind?`, `callbackAt?`, `callbackHasTime`, `callbackNote?` | **call phase only** — why this is in a caller's queue |
| `offerAboutUsAt?`, `offerPricelistAt?`, `offerPriceAt?`, `offerReviewAt?` | **what the client received**: first "about us", first cenník, **last** calculated price (email or phone), first rozbor webu. A summary of the valid `OFFER_SENT` activities, always recomputed by `recomputeOffers` — never written directly |
| `designSentAt?` | latest sent date among the lead's designs; recomputed with the above, also when a design is deleted. A lead without any `Design` row keeps its old value, and the screens show that value as "návrh sent" |
| `hadLegacySends` | `true` = the lead had sends under the old system (set once by `prisma/backfill/2026-09-offer-legacy.ts`, never changed after). Default `false` for every new lead |
| `legacySendsReviewedAt?` | the manager confirmed what such a lead really received; until then empty contents show as "?" |
| `quoteSentAt?`, `aboutUsSentAt?`, `priceDisclosed` | **frozen legacy**: "CP marked sent" (possibly without a price), "email o nás marked sent", "client knows a price". No code writes them any more; they are only shown as what the old record claimed, never as "yes" |
| `designUrl?` | legacy column; the current app does not read or write it. Keep it until a separately reviewed migration |
| `price?` (`Decimal(10,2)`), `priceNote?` | the **current** quoted total and its hand-written breakdown; what the client actually received is the snapshot in `OFFER_SENT` |
| `lostReason?` | why it ended |
| `lockedById?`, `lockedAt?` | **dead columns.** A leftover from a pre-claim design; written and read nowhere. Kept on purpose — dropping them is a destructive migration for no gain |
| `createdAt`, `updatedAt` | |

Indexes: `status` · `(status, callbackKind)` · `deletedAt` · `(createdById, createdAt)` ·
`(status, assignedCallerId, createdAt)` · `(assignedCallerId, status, callbackKind)` · `(ownerId, status)` ·
`(pipelineEnteredAt, status)`.

**Invariants** (enforced in code, not by constraints): `status NEW` ⇒ no CALL activity · non-handoff call outcomes never
write `nextAction*` (the positive call that enters the pipeline pre-fills it) · deals never use `callback*` · `closedAt`
is set exactly when a deal reaches a closed status · an `OPEN` task ⇒ `nextActionAt IS NULL` and mode `SCHEDULED` ·
while a returned price / návrh is still pending (see `DealTask`), the step is `SEND_QUOTE` / `SEND_DESIGN` (I10).

### LeadStatus

`NEW` (added, never called) · `CALLING` (caller is working it: retry or scheduled callback) · `ACTIVE` (open deal) ·
`SNOOZED` (sleeping, wakes by date — used in both phases) · `WON` · `LOST` · `UNREACHABLE`.

### NextActionKind / NextActionMode

`CALL`, `SEND_QUOTE` ("Poslať cenu"), `SEND_DESIGN` ("Poslať návrh"), `SEND_EMAIL` ("Poslať úvodný email"),
`WAITING_FOR_CLIENT`, `CUSTOM`. (`ORDER` was removed in wave 3: "chcú objednať" is an ordinary positive follow-up; the
rep hands the client over with a `HANDOVER` task instead.)

**Locked step (wave 3).** While the deal has an `OPEN` `DealTask`, the next step is locked: `nextActionKind` +
`nextActionNote` say what the rep will do once the manager delivers, `nextActionAt` is `NULL` and `nextActionMode` is
`SCHEDULED`. Nothing extra is stored — "locked" is derived from the open task (`isStepLocked` in `lib/domain/tasks.ts`,
SQL twin `STEP_LOCKED_SQL` in `lib/queries/pipeline`). When the task ends (done, declined, cancelled, owner change) the
step is unlocked to **today** (`nextActionAt` = start of the business day).

`NextActionMode`: `SCHEDULED` (the date is a deadline, urgency is computed) · `IN_PROGRESS` (work in progress, the date
is when it started, shown as "trvá X dní").

`nextActionHasTime` / `callbackHasTime`: `false` = day-level meaning, `true` = an exact moment.

### Other lead enums

`CallbackKind`: `RETRY` (nobody picked up) · `SCHEDULED` (an agreed time).
`LeadOrigin`: `MARKETING_CALL` · `DIRECT` · `REFERRAL` · `OTHER`.
`ProjectType`: `WEBSITE` · `ESHOP` · `CATALOG` · `WEBAPP` · `PORTFOLIO` · `OTHER`.

---

## Activity — append-oriented history

Business events are added as new rows. Two call-history metadata updates are allowed: `leadRevision` is filled after a
first call, and a revert sets `revertedAt` / `revertedById`. The original outcome and note are not rewritten.

| Field | Meaning |
|---|---|
| `leadId`, `userId` | who did it, to which lead (`Lead` cascade-deletes activities) |
| `type` | `ActivityType` |
| `category` | `BUSINESS` (the client story) · `PLANNING` (next-step changes) · `AUDIT` (field/owner/assignment changes) |
| `source` | `CALL_QUEUE` (first calls) · `PIPELINE` · `CLIENTS` · `CONTACTS` · `ADMIN`. On deals the source **follows the actor**: `deals.manage` writes `PIPELINE`, a deal owner without it writes `CLIENTS` (the name is left over from the removed `/dashboard/clients` screen) |
| `outcome?` | `CallOutcome` for CALL rows |
| `note?` | human text; for an interaction it is `"<reply label> – <user note>"`, for `OFFER_SENT` a readable summary ("Poslali sme: o nás + cenník") |
| `meta?` (jsonb) | structured extras: `{ reply: "<key>" }` for a client reply, call-assignment ids (`fromUserId`, `toUserId`, `kind`), revert details (`revertedActivityId`, `previousOutcome`), the `OFFER_SENT` record below, the task rows below, owner-change details, `fp` (see `idempotencyKey`), and `correction: { reason, byId, at }` on a crossed-out record |
| `taskId?` | the `DealTask` this row belongs to (all `TASK_*` rows; FK, `SET NULL` on task delete). Other types leave it `NULL` |
| `idempotencyKey?` | **unique**; one client attempt at storing a result, used to replay instead of double-writing. Written on: CALL, CLIENT_REPLIED, SMS_SENT, OFFER_SENT, the planning row of a "bez kontaktu" interaction, and (wave 3) the one main row of every keyed deal command — `TASK_CREATED`, `TASK_MESSAGE`, `TASK_DONE`, `TASK_DECLINED`, `TASK_REASSIGNED`, `TASK_RESULT_DISMISSED`, `STATUS_CHANGED`, `DEAL_REOPENED`, `OWNER_CHANGED`. Those main rows also store `meta.fp` = the canonical fingerprint of what the user submitted; the same key with a different `fp` is `IDEMPOTENCY_CONFLICT` |
| `leadRevision?` | written only by `logCallAs` (first calls): `Lead.revision` after that call — a revert is allowed only while it still equals `Lead.revision` |
| `revertedAt?`, `revertedById?` | a first call's result was undone, **or** an `OFFER_SENT` / `SMS_SENT` / `CLIENT_REPLIED` record was crossed out (correction). Crossed-out rows stay visible and are ignored by every summary |
| `createdAt` | |

Indexes: `leadId` · `taskId` · `(userId, createdAt)` · `(category, createdAt)` · `(source, type, createdAt)`.

`ActivityType`: `CALL`, `QUOTE_SENT`, `DESIGN_SENT`, `EMAIL_SENT`, `SMS_SENT`, `NOTE`, `NEXT_ACTION_SET`,
`NEXT_ACTION_CHANGED`, `NEXT_ACTION_CLEARED`, `CONTACT_UPDATED`, `STATUS_CHANGED`, `OWNER_CHANGED`,
`OUTCOME_CORRECTED`, `TRACKER_ATTACHED`, `TRACKER_UPDATED`, `TRACKER_OPENED`, `CALLER_ASSIGNED`, `CALLER_RELEASED`,
`CALL_REVERTED`, `DEAL_REOPENED`, `OFFER_SENT`, `CLIENT_REPLIED`, `TASK_CREATED`, `TASK_MESSAGE`, `TASK_DONE`,
`TASK_DECLINED`, `TASK_CANCELLED`, `TASK_REASSIGNED`, `TASK_RESULT_DISMISSED`, `CLIENT_ASK_CHANGED`. (`REQUEST_CREATED` /
`REQUEST_RESOLVED` were removed with `DealRequest`; the test branch had no rows of them when they were dropped.)

**Task rows** (`category BUSINESS`, `taskId` set). `TASK_*` rows are internal communication with the manager — they are
**never** a client contact and never move "Naposledy" (last touch). `meta`:

| Type | `meta` |
|---|---|
| `TASK_CREATED` | `{ fp, type: "HELP" \| "HANDOVER", contents: [...], assigneeId }` |
| `TASK_MESSAGE` | `{ fp }` — the text is `note` |
| `TASK_DONE` | `{ result, fp? }` — `result` is the same snapshot as `DealTask.result`; a HANDOVER accepted by an owner change has no meta |
| `TASK_DECLINED` | `{ fp }` — the reason is in `note` and `DealTask.closeReason` |
| `TASK_CANCELLED` | none — the reason is in `note` and `DealTask.closeReason` |
| `TASK_REASSIGNED` | `{ fromUserId, toUserId, fp? }` |
| `TASK_RESULT_DISMISSED` | `{ items: [{ kind: "PRICE" \| "DESIGN" \| "OTHER" \| "DECLINED", designId? }], reason, fp? }` — one row per task; the items it names are consumed ("Neposielam" / "Beriem na vedomie"); closing a deal writes one with reason "obchod uzavretý" |

**`OWNER_CHANGED`** `meta` (wave 3): `{ reason: DealOwnershipReason, fromUserId, toUserId, fp? , bulkOpId?, bulkFp? }` —
`bulkOpId` / `bulkFp` mark rows of one bulk transfer (`transferDealsAs`), so a repeat with the same `operationId`
continues instead of moving twice. `STATUS_CHANGED` / `DEAL_REOPENED` main rows carry `{ status?, fp }`.

What an interaction writes (truthfully since round 2 wave 3a): a call (also "nezdvihli") = `CALL`; the client wrote
back = `CLIENT_REPLIED` (carries `outcome` and the reply); an SMS = `SMS_SENT` (note, no outcome, does not change what the
client knows); "bez kontaktu" = no contact row, only the planning row. `QUOTE_SENT`, `EMAIL_SENT` and `DESIGN_SENT` are
**no longer written** — every existing row of those types is a legacy record whose contents are unknown.

**`OFFER_SENT`** — "the client received offer material". `meta`:
`{ channel: "EMAIL" | "PHONE", contents: ["ABOUT_US" | "PRICELIST" | "PRICE" | "DESIGN" | "REVIEW"…], price?: { amount: "1285.00"
(decimal string), note }, designs?: [{ id, label, url, version }], sentOn: "YYYY-MM-DD", historical: bool,
callActivityId? (phone price → the CALL it belongs to), fulfils?: [{ taskId, kind: "PRICE" | "DESIGN", designId? }],
fp?, correction? }`. `createdAt` = when it was recorded, `sentOn` = when the client got it. `historical: true` = a
legacy send entered later by the manager (no next step, never fulfils a task item). `fulfils` = the returned task
items this send used (wave 3): at most one price, each návrh at most once, only items still pending. Order of sends: `sentOn`, then a historical entry before a normal one on the same day, then `createdAt`; the
latest price is what the client knows (`lib/domain/offers.ts`).

`CallOutcome`: `NO_ANSWER`, `BAD_NUMBER`, `NOT_INTERESTED`, `CALL_AGAIN`, `INTERESTED` ("majú záujem" — what they
wanted is in `LeadRequest`), `WANTS_QUOTE` ("Chcú konkrétnu cenu"), `WANTS_DESIGN`, `WANTS_EMAIL`
("Chcú info emailom"), `SNOOZE`, `POSITIVE`, `WANTS_TO_ORDER`. `POSITIVE` and `WANTS_TO_ORDER` exist only on deal
follow-ups. The three `WANTS_*` values are **frozen**: existing rows stay valid and still count as interest, but no
new call writes them — the call queue sends `INTERESTED` and the ticks (wave 5). A first call with `INTERESTED`
carries `meta.asked` (the canonical sorted tick list) and `meta.fp`, so the same key with a different selection is
`IDEMPOTENCY_CONFLICT`.

**`CLIENT_ASK_CHANGED`** (wave 5) — the pencil at "Chceli". `meta`: `{ added: RequestContent[], withdrawn: [{ id,
content }], reason, fp }`. History only: it is not a client contact and never moves "Naposledy".

---

## DealTask — a task for the manager (wave 3)

A deal owner (a sales rep) asks a manager for help (`HELP`: price, návrh, other) or asks the manager to take the client
over (`HANDOVER`). Replaces the removed `DealRequest`. Rules: `lib/domain/tasks.ts` (pure) and
`lib/domain/taskMutations.ts` (writes); commands in `lib/commands/tasks.ts`.

| Field | Meaning |
|---|---|
| `leadId` | the deal (cascade) |
| `type` | `DealTaskType`: `HELP` · `HANDOVER` |
| `contents` | `DealTaskContent[]`: `HELP` has at least one of `PRICE` · `DESIGN` · `OTHER`; `HANDOVER` has none. The UI sends exactly one content today (a combined price + návrh task is `[WAVE 4]`); the command accepts several |
| `status` | `DealTaskStatus`: `OPEN` · `DONE` (delivered / handover accepted) · `DECLINED` (manager said no, with a reason) · `CANCELLED` (owner cancelled, deal closed, owner changed, deal left without an owner) |
| `text` | the rep's message for the manager — **only for this task**; it never changes `Lead.note` or the step note |
| `requestedById` | the rep who asked (`RESTRICT`) |
| `assigneeId` | the manager who has to act (`requests.resolve`); can be reassigned (`RESTRICT`) |
| `createdAt` | drives "oldest first" and the age alert (red after `TASK_AGE_ALERT_DAYS` = 2 business days) |
| `closedAt?`, `closedById?` | when and by whom it really ended (may differ from the assignee) |
| `closeReason?` | required for `DECLINED` / `CANCELLED` (e.g. "obchod uzavretý", "klienta prevzal X", "obchod bez vlastníka") |
| `result?` (jsonb) | immutable snapshot of what the manager delivered: `{ price?: { amount: "1285.00", note }, designs?: [{ id, label, url, version }], answer? }` (`taskResultSchema`). The deal's current price / design may change later; this does not |

Indexes: `(assigneeId, status, createdAt)` ("Pre mňa", "Čaká na mňa") · `(leadId, status)`. Its events are `Activity`
rows with `taskId` (see the task rows above).

Rules in code (under the `Lead` row lock, not constraints):

- **at most one `OPEN` task per deal**; only the owner creates it, only if the owner is a rep (`deals.work` without
  `requests.resolve`); a manager never has a task on his own deal;
- an `OPEN` task **locks the next step** (see `Lead`). When the task is created the step becomes: `PRICE` → `SEND_QUOTE`,
  `DESIGN` → `SEND_DESIGN`, `OTHER` → the current step stays (the rep may change it); the note stays when the kind does
  not change (`stepAfterTask`);
- **returned items**: a `DONE` `HELP` task returns one `PRICE` item, one `DESIGN` item per návrh, one `OTHER` item (the
  answer); a `DECLINED` task returns one `DECLINED` item. An item is **pending** until an `OFFER_SENT` names it in
  `meta.fulfils` or a `TASK_RESULT_DISMISSED` names it in `meta.items`. A crossed-out send does not count. Pending price
  / návrh force the step to "Poslať…" (I10). Closing the deal dismisses everything still pending;
- an owner change ends or keeps the task (`ownerTransition`): new owner is a rep → the task stays (optionally moved to
  another manager); new owner is a manager → `HELP` `CANCELLED`, `HANDOVER` `DONE`; no owner → `CANCELLED`;
- a user holding open deals or assigned `OPEN` tasks cannot be deactivated or change role (D14).

## LeadRequest — what the client asked for (wave 5)

One row per **ask**, not per label: the same client asking for the same thing again months later is a new row and new
work. Rules: `lib/domain/clientRequests.ts` (pure) and `lib/domain/requestMutations.ts` (writes); commands in
`lib/commands/requests.ts`, `calls.ts`, `dealWork.ts`, `offers.ts`.

| Field | Meaning |
|---|---|
| `leadId` | the deal (cascade) |
| `content` | `RequestContent`: `INFO` (Info / ukážky) · `PRICELIST` · `PRICE` (a price for *this* client) · `DESIGN` · `REVIEW` (rozbor webu) |
| `state` | `RequestState`: `OPEN` · `SENT` (a valid `OFFER_SENT` satisfied it) · `WITHDRAWN` (they no longer want it) |
| `origin` | `RequestOrigin`: `LIVE` (recorded in the app) · `MIGRATED_RECEIPT` · `MIGRATED_OPEN_STEP` (both from the old data, §11 of the wave-5 design) |
| `requestedAt` | the **instant** of the source activity, not a rounded business day |
| `requestedById?` | who recorded it; `NULL` on a migrated row — the historical actor is unknown and is never attributed to today's owner |
| `sourceActivityId?` | the call / reply it came from (`SET NULL`); reverting a first call deletes its rows |
| `resolvedAt?`, `resolvedById?`, `resolvedActivityId?` | **recomputed, never toggled**: the `OFFER_SENT` that satisfied it, or the moment of a manual withdrawal |
| `reason?` | required when a row is withdrawn by hand |
| `migrationKey?` | **unique**, deterministic key of the migration source — a rerun or an interrupted run cannot duplicate a row |
| `provenance?` (jsonb) | source columns / activity ids, confidence, approved exception |
| `createdAt`, `updatedAt` | |

Indexes: `(leadId, state)` · `(leadId, content, state)` · `migrationKey` **UNIQUE**.

Rules in code (under the `Lead` row lock, not constraints):

- **the state is always the result of one recomputation** (`reconcileRequests`): every operation that changes requests
  or receipts replays the lead's rows against its **valid** `OFFER_SENT` activities in instant order. A receipt
  satisfies a row only if its instant is **not earlier** than the ask, the earliest eligible receipt wins, and a
  crossed-out send reopens a row only when no other valid receipt still satisfies it;
- a **withdrawn** row is never revived by a receipt; only an `OPEN` row may be withdrawn, and only by id;
- a foreign key cannot prove a linked activity belongs to the same lead, so every command asserts same-`leadId`,
  expected type and not-crossed-out under the lock;
- satisfaction mapping: `INFO` → `ABOUT_US`, `PRICELIST` → `PRICELIST`, `PRICE` → `PRICE` (email **or** phone),
  `DESIGN` → `DESIGN`, `REVIEW` → `REVIEW`;
- there is **no** summary column on `Lead` for asks — one place only.

## DealOwnership — owner history (wave 3)

One row per **real** owner change, in the same transaction as the change. Written by the first-call handoff, the
revert of that call, and every owner change (single, bulk, takeover, accepted handover).

| Field | Meaning |
|---|---|
| `leadId` | the deal (cascade) |
| `fromUserId?`, `toUserId?` | previous / new owner (`NULL` = nobody); `SET NULL` if a user row were ever deleted |
| `byUserId` | who made the change (`RESTRICT`) |
| `reason` | `DealOwnershipReason`: `HANDOFF` (positive first call) · `CHANGE` (manager picked an owner) · `BULK` (bulk transfer) · `TAKEOVER` (manager took the client himself) · `HANDOVER` (manager accepted a `HANDOVER` task) · `REVERT` (the first call's result was undone) |
| `note?` | optional reason typed by the manager |
| `createdAt` | |

Indexes: `(leadId, createdAt)` · `(fromUserId, createdAt)` (the rep's História: deals that moved away from me, excluding
`REVERT`, rows before the deal's current `pipelineEnteredAt`, and deals I own again).

---

## User, Team, Invite

**User**: `username` (unique), `email?` (unique), `firstName`, `lastName`, `password` (bcrypt), `role`, `phone?`,
`emailVerifiedAt?`, `phoneVerifiedAt?` (verification flow not built), `deletedAt?` (**soft delete = deactivated**),
`lastLoginAt?`, `note?` (admin's internal note), `createdAt`, `teamId?` (member of at most one team), and `leadsTeam`
(leads at most one team). Indexes: `deletedAt`, `role`, `teamId`.

Deactivation is `deletedAt`, never a hard delete: activities and ownership must keep resolving.

**Role**: `SCOUT`, `SCOUT_LEADER`, `TELESALES`, `SALES_REP`, `MANAGER`, `ADMIN`. Code checks permissions, never roles
(`lib/permissions.ts`).

**Team**: `name`, `leaderId?` (**unique** — one leader leads one team), `members`, `createdAt`, `updatedAt`. Deliberately role-neutral: what a
leader may see is decided by permissions, not by a team type. Used for handoff routing (a caller who cannot own deals
routes a positive call to an eligible team leader) and for team-scoped statistics.

**Invite**: `token` (unique), `expiresAt`, `usedAt?`, `createdById?`, `forEmail?`, `forRole` (default `SCOUT`). **No code
reads or writes this table**: public signup is disabled and accounts are created by an admin.

---

## Design tracking

**Design** (per lead, cascade): `label?`, `targetUrl?`, `repoUrl?`, `isLive`, `currentVersion`, `sentAt?`, `legacySentAt?`,
`createdById?`, `deletedAt?` (soft delete). Indexes: `leadId`, `deletedAt`. `sentAt` = when this design was **first**
sent: recomputed as the earlier of the first valid `OFFER_SENT` containing it and `legacySentAt`. `legacySentAt` = the
sent date under the old system, copied once by `prisma/backfill/2026-09-offer-legacy.ts` and never changed.

**DesignVersion**: `(designId, version)` unique, `url?`, `note?`, `markedAt`, `createdById?`.

**Tracker**: `token` **unique** (the ingest API finds it with one indexed query), `designId` **unique** (1:1 with a
design).

**TrackerEvent**: `trackerId`, `versionId?` + `versionAtView` (which version the client had open), `type`
(`PAGE_VIEW` = weak signal, could be a scanner · `ENGAGED_VIEW` = real attention, carries `durationMs`), `ip?` (raw, for
coarse geo only), `uaShort?`, `botFlag`, `occurredAt`. Indexes: `(trackerId, occurredAt)`, `(type, occurredAt)`.

Ingest never bumps `Lead.revision`. Reps see the confidence summary from `lib/tracking/confidence.ts`; they receive a
design's tracked URL only inside the "Odkaz do emailu" copy button (never rendered as a link) — no tokens shown, no IPs,
no version history.

---

## What the database does **not** enforce

These live in code and must be preserved by every new mutation:

- one `OPEN` `DealTask` per deal, and the locked step while it is open (`nextActionAt` NULL)
- the step stays "Poslať…" while a returned price / návrh is pending (I10)
- a `DealOwnership` row for every real owner change, in the same transaction
- exactly one `revision` bump per business transaction
- `status NEW` ⇒ no CALL activity
- `closedAt` consistency with closed statuses
- scope (who may see which lead) — always in the query, never in a constraint
- `Lead.offer*`, `Lead.designSentAt` and `Design.sentAt` equal the recompute of the valid `OFFER_SENT` rows (+ legacy
  design dates); the frozen legacy send fields are never written
- `LeadRequest.state` and its resolver equal the recompute of the lead's rows against its valid `OFFER_SENT` rows
- only a step the app chose itself (`SEND_QUOTE` / `SEND_DESIGN` / `SEND_EMAIL`, or none) is re-derived from the
  outstanding work; a call, "Čakáme na klienta" and a custom step are the user's decision
