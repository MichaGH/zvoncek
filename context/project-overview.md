# Project Overview

Zvonček — the internal CRM and calling dashboard of **The Grand Points**, a small web design company. Real internal tool,
also the owner's learning project. Do not add features outside the requested scope.

Read next: `context/app-workflow.md` (how it is used), `context/architecture.md` (layers), `context/code-standards.md`
(rules), `context/domain/*` (current data and operations).

## 1. Domain core

The central Prisma model is **`Lead`** — a contact and, later, the deal made from it. **Never rename it.** UI and routes
use business words (kontakty, volania, pipeline, štatistiky); the model stays `Lead`.

The stage is decided by `Lead.pipelineEnteredAt`, not by status alone:

- `pipelineEnteredAt IS NULL` → **call stage**: `NEW` (pool or a caller's batch), `CALLING`, `SNOOZED`, or closed
  `LOST` / `UNREACHABLE`
- `pipelineEnteredAt` set → **deal**: `ACTIVE`, `SNOOZED`, `WON`, `LOST`, `UNREACHABLE`

Three responsibilities, never mixed:

| Field | Meaning |
|---|---|
| `assignedCallerId` | who does the call-stage work |
| `ownerId` | who owns the deal |
| `createdById` | who added the contact (scout statistics only) |

Invariant: `status NEW` ⇒ the lead has no CALL activity.

## 2. Roles

`SCOUT`, `SCOUT_LEADER`, `TELESALES`, `SALES_REP`, `MANAGER`, `ADMIN`.

- **SCOUT** — adds contacts, sees only their own (`createdById`), may edit/delete only untouched ones (NEW, unclaimed,
  no call history).
- **SCOUT_LEADER** — the same for the team they lead, plus team statistics.
- **TELESALES** — first calls in `/dashboard/calls` (claims batches of 10 from the pool, own retries/callbacks/snoozes),
  own call history, may add contacts. Positive calls are routed to their team leader, or stay unassigned.
- **SALES_REP** — TELESALES plus follow-ups on **own** deals in `/dashboard/pipeline` (scope `own`): price,
  quote/email sent, tasks for the manager (price / návrh / other, or a handover). Their own positive first call becomes their own deal. No WON, no reopen,
  no design management, no other people's deals.
- **MANAGER** — everything on all deals, the assignment tool, resolving tasks ("Pre mňa"), taking clients over, global read access.
- **ADMIN** — all permissions plus the admin pages.

Today there is exactly one manager (Michal, account role `ADMIN`). `deals.viewTeam` is a permission prepared for a
possible sales-team leader; no role holds it. A developer role is future design (its own project feature, `context/features/backlog.md` BL-04), not current
schema or behaviour.

## 3. Permissions

Code checks **permissions**, never roles. `can(user, permission)` from `lib/permissions.ts`, where `user` is the current
**DB** user from `requireUser()` — never `session.user`. Changing an existing role's permissions is a matrix edit.
Adding a new role also changes the Prisma `Role` enum, role dictionaries, relevant UI, checks and rollout order.

Deal permissions (round 2 naming; `clients.*` and `pipeline.*` no longer exist):

| Permission | Meaning |
|---|---|
| `deals.view` | may open the deals screen |
| `deals.work` | may act on deals in scope (next step, interaction, price, contact data, tasks for the manager) |
| `deals.viewAll` | scope = every deal |
| `deals.viewTeam` | scope = own + team (no role holds it yet) |
| `deals.manage` | status, owner, project type, WON, reopen, designs, takeover, bulk transfer |
| `deals.receive` | may own deals (handoff targets, owner selects) |

Others: `today.view`, `calls.*`, `callHistory.*`, `contacts.*`, `requests.resolve` (receives and resolves manager tasks; the name predates tasks), `stats.*`, `teams.manage`,
`admin.access`, `users.manage`.

The hand-written `ROLES` array in `lib/dictionaries.ts` must contain every `Role` (asserted at startup).

## 4. Routes

All app routes are under `app/`. "Guard" = the effective access requirement. The proxy checks the route-level
permission; a page may add a more specific check (for example, `teams.manage` on the teams page).

| Route | Guard | Notes |
|---|---|---|
| `/` | public | redirects to `/dashboard` or `/login` |
| `/login` | public | |
| `/signup` | public | public registration is **disabled** — redirects to `/login`; accounts are created by an admin |
| `/dashboard` | logged in | composed by permission |
| `/dashboard/contacts` | `contacts.access` | |
| `/dashboard/contacts/new` | `contacts.create` | |
| `/dashboard/leads/new` | logged in | legacy URL, only redirects to `/dashboard/contacts/new` |
| `/dashboard/calls` | `calls.view` | personal call queue |
| `/dashboard/calls/history` | `callHistory.access` | |
| `/dashboard/calls/assignments` | `calls.assign` | manager tool |
| `/dashboard/pipeline`, `/dashboard/pipeline/[id]` | `deals.view` | **the one deal workspace for every role**, labelled "Pipeline" for everyone; scope from `dealScope()` |
| `/dashboard/pipeline/historia` | `deals.view` | "História": deals that moved away from me (handover, takeover, transfer); no link to the live deal |
| `/dashboard/stats` | `stats.view` | unfinished |
| `/dashboard/admin`, `/admin/users`, `/admin/users/new`, `/admin/users/[id]` | `admin.access` | |
| `/dashboard/admin/teams` | `admin.access` + `teams.manage` | the page checks `teams.manage` itself |
| `/api/p` | public | tracking ingest; excluded from the proxy matcher |
| `/dev/proposal` | public | dev-only test page for the tracker; `notFound()` in production |

The route guard is `requiredPermissionForPath()` in `lib/permissions.ts`, run by NextAuth from `proxy.ts` (the Next 16
name for middleware) via `auth.config.ts`, on the JWT. It checks more specific paths before parent prefixes. It is
convenience, not the security boundary: pages still call `requireUser()` + `can()`, and commands re-check under the
row lock.

## 5. Concurrency rules — mandatory for mutations of an existing `Lead`

Contact creation inserts a new `Lead` at revision 0 using named fields; no existing lead row can be locked or bumped.

1. **Lock order: `Team` → `User` → `Lead`**, each ascending by id. Read a dependent id without a lock, lock, then
   re-validate under the lock.
2. Every mutation of an existing `Lead` locks the row `FOR UPDATE` through the access guards and re-checks scope and state under it.
3. **Assignee lock**: mutating a lead that has `assignedCallerId` first locks that user row `FOR SHARE`. Claims,
   transfers, deactivation and role changes lock the user row `FOR UPDATE`.
4. `SKIP LOCKED` only in `claimBatch` and the bulk deal transfer. Call-work transfers and deactivation never skip rows.
5. **`Lead.revision`: exactly one increment per business transaction per lead** (`bump` + `markLeadBumped`, or
   `bumpLeadOnce`). Writing `Activity.leadRevision` / `revertedAt` never bumps. Tracking ingest never bumps.
6. Outcome writes and the next-action editor send `expectedRevision` + an idempotency key. `STALE` / `NOT_ASSIGNED` /
   `IDEMPOTENCY_CONFLICT` refresh the UI; `RETRYABLE` offers a retry with the same key.
7. Every day-level rule goes through `lib/domain/businessTime.ts`; server-rendered dates pass `timeZone: BUSINESS_TZ`
   (Europe/Bratislava).

## 6. Design tracking

The manager creates a `Design` on a deal → the app issues a `Tracker` token → the public script reads `?p=TOKEN` and
posts to `/api/p` → `lib/tracking/confidence.ts` turns raw events into a confidence level. Design commands guard through
`design.leadId` with `requireDealManage`. Reps see the summary (confidence, views, last view); the tracked URL reaches
them only inside the "Odkaz do emailu" copy button, never rendered as a link — no IPs, no version history. Marking a
design sent is part of "Čo sme poslali" (`recordOfferSentAs`), open to the deal owner.

## 7. Statistics

`/dashboard/stats` is **unfinished** and still buckets days in server-local time. Do not treat current numbers as
product truth. For a redesign: first calls = `Activity.source CALL_QUEUE`; deal follow-ups = `CLIENTS` (owner without
`deals.manage`) or `PIPELINE` (manager) — the source follows the actor, not the screen; exclude reverted / crossed-out
activities (`revertedAt`). Calls are `CALL` only — written replies (`CLIENT_REPLIED`), SMS and "bez kontaktu" are not
calls. The cenník-vs-price experiment groups each deal by its **first verified offer email** and excludes
`hadLegacySends` deals and historical entries in the **current test implementation**. **[ROLLOUT]** After the chosen
old-send conversion, exclude migrated deals by `meta.migrated` instead; see `context/domain/db-changes.md` §3.3.

## 8. Environments

Development and tests run only against the Neon **test** branch; production is never touched by a development session.
What production still lacks is tracked in `context/domain/db-changes.md`; clear applied entries after a production
rollout while retaining the procedure.
