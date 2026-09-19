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
| `offerAboutUsAt?`, `offerPricelistAt?`, `offerPriceAt?` | **what the client received**: first "about us", first cenník, **last** calculated price (email or phone). A summary of the valid `OFFER_SENT` activities, always recomputed by `recomputeOffers` — never written directly |
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
is set exactly when a deal reaches a closed status.

### LeadStatus

`NEW` (added, never called) · `CALLING` (caller is working it: retry or scheduled callback) · `ACTIVE` (open deal) ·
`SNOOZED` (sleeping, wakes by date — used in both phases) · `WON` · `LOST` · `UNREACHABLE`.

### NextActionKind / NextActionMode

`CALL`, `SEND_QUOTE` ("Poslať cenu"), `SEND_DESIGN`, `SEND_EMAIL` ("Poslať úvodný email"), `WAITING_FOR_CLIENT`, `ORDER`,
`CUSTOM`.
`ORDER` = "objednávka – potvrdiť": the client wants in and the manager has to confirm. Set by the follow-up outcome
`WANTS_TO_ORDER` (with an `ORDER` request) or chosen in the detail editor.

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
| `meta?` (jsonb) | structured extras: `{ reply: "<key>" }` for a client reply, request details (`requestId`, `kind`, `status`), call-assignment ids (`fromUserId`, `toUserId`, `kind`), revert details (`revertedActivityId`, `previousOutcome`), the `OFFER_SENT` record below, and `correction: { reason, byId, at }` on a crossed-out record |
| `idempotencyKey?` | **unique**; one client attempt at storing a result (CALL, CLIENT_REPLIED, SMS_SENT, OFFER_SENT, or the planning row of a "bez kontaktu" interaction), used to replay instead of double-writing |
| `leadRevision?` | written only by `logCallAs` (first calls): `Lead.revision` after that call — a revert is allowed only while it still equals `Lead.revision` |
| `revertedAt?`, `revertedById?` | a first call's result was undone, **or** an `OFFER_SENT` / `SMS_SENT` / `CLIENT_REPLIED` record was crossed out (correction). Crossed-out rows stay visible and are ignored by every summary |
| `createdAt` | |

Indexes: `leadId` · `(userId, createdAt)` · `(category, createdAt)` · `(source, type, createdAt)`.

`ActivityType`: `CALL`, `QUOTE_SENT`, `DESIGN_SENT`, `EMAIL_SENT`, `SMS_SENT`, `NOTE`, `NEXT_ACTION_SET`,
`NEXT_ACTION_CHANGED`, `NEXT_ACTION_CLEARED`, `CONTACT_UPDATED`, `STATUS_CHANGED`, `OWNER_CHANGED`,
`OUTCOME_CORRECTED`, `TRACKER_ATTACHED`, `TRACKER_UPDATED`, `TRACKER_OPENED`, `CALLER_ASSIGNED`, `CALLER_RELEASED`,
`CALL_REVERTED`, `REQUEST_CREATED`, `REQUEST_RESOLVED`, `DEAL_REOPENED`, `OFFER_SENT`, `CLIENT_REPLIED`.

What an interaction writes (truthfully since round 2 wave 3a): a call (also "nezdvihli") = `CALL`; the client wrote
back = `CLIENT_REPLIED` (carries `outcome` and the reply); an SMS = `SMS_SENT` (note, no outcome, does not change what the
client knows); "bez kontaktu" = no contact row, only the planning row. `QUOTE_SENT`, `EMAIL_SENT` and `DESIGN_SENT` are
**no longer written** — every existing row of those types is a legacy record whose contents are unknown.

**`OFFER_SENT`** — "the client received offer material". `meta`:
`{ channel: "EMAIL" | "PHONE", contents: ["ABOUT_US" | "PRICELIST" | "PRICE" | "DESIGN"…], price?: { amount: "1285.00"
(decimal string), note }, designs?: [{ id, label, url, version }], sentOn: "YYYY-MM-DD", historical: bool,
callActivityId? (phone price → the CALL it belongs to), correction? }`. `createdAt` = when it was recorded, `sentOn` =
when the client got it. `historical: true` = a legacy send entered later by the manager (no next step, no request
change). Order of sends: `sentOn`, then a historical entry before a normal one on the same day, then `createdAt`; the
latest price is what the client knows (`lib/domain/offers.ts`).

`CallOutcome`: `NO_ANSWER`, `BAD_NUMBER`, `NOT_INTERESTED`, `CALL_AGAIN`, `WANTS_QUOTE` ("Chcú konkrétnu cenu"),
`WANTS_DESIGN`, `WANTS_EMAIL` ("Chcú info emailom"), `SNOOZE`, `POSITIVE`, `WANTS_TO_ORDER`. The last two exist only on
deal follow-ups.

---

## DealRequest — asking the manager

| Field | Meaning |
|---|---|
| `leadId` | the deal (cascade) |
| `kind` | `PRICE` · `DESIGN` · `EMAIL` · `ORDER` · `REOPEN` · `OTHER` |
| `status` | `OPEN` · `DONE` · `CANCELLED` |
| `note?` | what is needed; a second create of the same open kind appends here |
| `createdById` | who asked |
| `resolvedById?`, `resolvedAt?`, `resolutionNote?` | the answer, visible to the requester |
| `createdAt` | drives "oldest first" and the 2-day alert |

Indexes: `(status, createdAt)` · `(leadId, status, kind)`.

Rules in code: **at most one OPEN per (leadId, kind)**, enforced under the `Lead` row lock — not by a partial unique
index. `DONE` is reached only through the business action that does the work (manual `DONE` only for `OTHER`);
declining is `CANCELLED` with a reason. Closing a deal closes its open requests. There is **no direction column**: every
open request means "for the manager".

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

- one open request per (deal, kind)
- exactly one `revision` bump per business transaction
- `status NEW` ⇒ no CALL activity
- `closedAt` consistency with closed statuses
- scope (who may see which lead) — always in the query, never in a constraint
- `Lead.offer*`, `Lead.designSentAt` and `Design.sentAt` equal the recompute of the valid `OFFER_SENT` rows (+ legacy
  design dates); the frozen legacy send fields are never written
