# Zvonček - Agent Instructions

This file is the operational memory for coding agents working on Zvonček.
Keep it short, current, and strict. Detailed product flow lives in
`context/app-workflow.md`. Feature design history lives in `context/new-feature/planning.md`,
implementation status in `context/progress-tracker.md`.

## What This App Is

Zvonček is an internal CRM and calling dashboard for The Grand Points, a small
web design company.

Stack:
- Next.js App Router
- TypeScript
- Prisma + Postgres (Neon)
- NextAuth Credentials
- shadcn/ui
- vaul drawers
- Tailwind CSS

This is a real internal tool and also a learning project. Do not add features
outside the requested scope.

## Core Domain Rule

The central Prisma model is `Lead`. Never rename it.

The stage is decided by `Lead.pipelineEnteredAt`, not by status alone:
- `pipelineEnteredAt IS NULL` = call stage: `NEW` (pool or a caller's batch), `CALLING`, `SNOOZED`, or closed `LOST` / `UNREACHABLE`
- `pipelineEnteredAt` set = deal (opportunity), any of `ACTIVE`, `SNOOZED`, `WON`, `LOST`, `UNREACHABLE`

Responsibility is split, never mix them:
- `assignedCallerId` = who does the call-stage work
- `ownerId` = who owns the deal
- `createdById` = who added the contact (scout stats only)

Invariant: `status NEW` ⇒ the lead has no CALL activity.

Routes and UI use business names (contacts, calls, pipeline, clients, statistics). Do not rename Prisma `Lead`.

## Roles

`SCOUT`, `SCOUT_LEADER`, `TELESALES`, `SALES_REP`, `MANAGER`, `ADMIN`.

Deal permissions (round 2): `deals.view` = may open the deals screen, `deals.work` = may act on deals in scope,
`deals.viewAll` / `deals.viewTeam` = scope, `deals.manage` = status/owner/WON/reopen/designs/requests/bulk transfer.
(`clients.*` and `pipeline.*` no longer exist.)

Permission checks go through `can(user, permission)` from `lib/permissions.ts`, where `user` is the **current DB user**
from `requireUser()` (`lib/access/user.ts`), never `session.user`. The hand-written `ROLES` array in `lib/dictionaries.ts`
must contain every `Role` (asserted at startup).

- **SCOUT**: adds contacts, sees only own contacts (`createdById`), may edit/delete only untouched contacts
  (NEW, unclaimed, no call history).
- **SCOUT_LEADER**: same for the team they lead + team statistics.
- **TELESALES**: first calls in `/dashboard/calls` (claims batches of 10 from the pool, own retries/callbacks/snoozes),
  own call history, may add contacts. Positive calls are routed to the leader of their team (or stay unassigned).
- **SALES_REP**: like TELESALES plus follow-ups on **own** deals in `/dashboard/pipeline` (scope `own`); may set price, mark quote/email sent,
  create requests to the manager. No pipeline, no WON, no reopen, no design management.
- **MANAGER**: everything on all deals (`/dashboard/pipeline`), assignment tool, resolves requests; global read access.
- **ADMIN**: all permissions plus admin pages.

## Main Routes

- `/dashboard` - dashboard composed by permission (caller / deal owner / manager blocks)
- `/dashboard/contacts`, `/dashboard/contacts/new` (`contacts.create`, also callers)
- `/dashboard/calls` - personal call queue; `/dashboard/calls/history`; `/dashboard/calls/assignments` (`calls.assign`)
- `/dashboard/pipeline`, `/dashboard/pipeline/[id]` - **the one deal workspace for every role** (`deals.view`); menu label is
  "Pipeline" for managers and "Moji klienti" for reps. Which rows you get is decided by `dealScope()` on the server, never
  by the path or by `?owner=`.
- `/dashboard/clients`, `/dashboard/clients/[id]` - **redirects** to the merged screen (kept only for old links)
- `/dashboard/stats` - unfinished statistics
- `/dashboard/admin`, `/dashboard/admin/users`, `/dashboard/admin/teams`

`requiredPermissionForPath` (route guard, JWT-based convenience) checks more specific paths before parent prefixes.
Pages still check `requireUser()` + `can()` themselves.

## Architecture

- `lib/actions/**` - `"use server"` files. **Thin**: `requireUser()`, call a command, `revalidatePath`. Never export helpers
  from a `"use server"` file (every export is a public endpoint).
- `lib/commands/**` - transaction bodies taking an `AccessUser` (`logCallAs`, `claimBatchAs`, `revertCallResultAs`,
  `transferCallWorkAs`, `deactivateUserAs`, pipeline/dealWork/tracking/teams commands). Scripts and tests call these.
  Deal mutations are split by guard: `commands/dealWork.ts` = owner **or** manager (`requireDealWork`),
  `commands/pipeline.ts` = manager only (`requireDealManage`, any deal state). The activity `source` follows the actor
  (`deals.manage` → `PIPELINE`, otherwise `CLIENTS`), not the route.
- `lib/access/**` - `requireUser`, locking helpers (`withLockTx`, `lockUsers`, `lockUserModes`, `lockTeams`), lead guards
  (`requireCallLead`, `requireDealWork` with `closedPolicy`, `requireDealManage`, `requireDealView`, `lockLeadWithUsers`),
  error codes (`AccessError`, `toActionError`).
- Client-supplied objects are validated with **strict** zod schemas where they are used (`dealMutations.ts`, commands); never
  spread an input object into a Prisma `update` – build the write from named fields only.
- `lib/domain/**` - pure rules and shared mutation bodies: `leadFlow.ts` (outcome transitions), `dealMutations.ts`
  (deal changes shared by both guards), `dealScope.ts` (**the only place deal scope is decided**), `dealCapabilities.ts`
  (rendering hint, never a permission), `dealFilters.ts` (filter/URL model + view pills), `dealRequests.ts`,
  `dealRouting.ts`, `clientSections.ts`, `nextStepOptions.ts` (**the one next-step list** – editor and sheet share it,
  and `dealStateForFollowUp` takes its date/mode rules from it), `clientReplies.ts` ("what the client said" menu;
  stored as `Activity.meta.reply` + label in the note, deliberately not an enum),
  `businessTime.ts` + `schedule.ts` (Europe/Bratislava calendar), `revision.ts`, `idempotency.ts`, `callAssignment.ts`.
- `lib/queries/**` - server read models, always scoped server-side.

## Concurrency Rules (mandatory for every Lead mutation)

- Lock order: `Team` → `User` → `Lead`, each ascending by id. Read a dependent id without a lock, lock, then re-validate.
- Every Lead mutation locks the Lead row `FOR UPDATE` via the guards and re-checks scope/state under the lock.
- Assignee lock: mutating a lead that has `assignedCallerId` first locks that user row `FOR SHARE`. Claims, transfers,
  deactivation and role changes lock the user row `FOR UPDATE`.
- `SKIP LOCKED` only in `claimBatch` and the bulk deal transfer. Call-work transfers and deactivation never skip rows.
- `Lead.revision`: exactly one increment per business transaction per lead (`bump` in the lead update + `markLeadBumped`,
  or `bumpLeadOnce`). Writing `Activity.leadRevision` / `revertedAt` never bumps. Tracking ingest does not bump.
- Call and follow-up outcomes and the next-action editor send `expectedRevision` + idempotency key; `STALE` / `NOT_ASSIGNED` /
  `IDEMPOTENCY_CONFLICT` refresh the UI, `RETRYABLE` offers retry with the same key.
- Every day-level rule uses `lib/domain/businessTime.ts`; server-rendered dates pass `timeZone: BUSINESS_TZ`.

## Workflow Summary

`SCOUT adds contacts → caller claims a batch and calls → positive call hands off a deal to the routed owner →
owner follows up in /dashboard/pipeline (rep sees own deals, manager everyone's) → requests to the manager → WON / LOST`

- Calls use `callbackKind`, `callbackAt`, `callbackHasTime`, `callbackNote`; call-stage outcomes never write `nextAction*`.
- Deal follow-ups are one **interaction**: contact result → what the client said → next step, written by `logFollowUp`
  in a single transaction. `NO_ANSWER` keeps its outcome even when the user picks a different next step, so a row always
  shows both "Ďalší krok" and "Naposledy … N. pokus" (the streak counts consecutive non-reverted `NO_ANSWER` calls).
- Deals use `nextActionKind`, `nextActionAt`, `nextActionHasTime`, `nextActionMode`, `nextActionNote`, and `closedAt`.
- `*HasTime = false` → day-level labels; `true` → exact-time urgency. Shared display: `lib/overdue.ts`,
  `components/shared/UrgencyLabel.tsx`.
- `DealRequest`: one OPEN per (deal, kind); DONE only via the business action (manual DONE only for OTHER); decline needs a reason.

## Design Tracking

Manager creates a `Design` → `Tracker` token → public script reads `?p=TOKEN` → posts to `/api/p` → confidence in
`lib/tracking/confidence.ts`. Design commands guard through `design.leadId` with `requireDealManage`.

## Database Rules

- Use `prisma db push`, not `prisma migrate dev`. Never `--accept-data-loss` or `--force-reset`.
- Before any schema command: verify the target (`npx tsx prisma/backfill/2026-09-assignments.ts --identity ...`) and review
  `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o <file outside repo>`.
- If `db push` stops on a data-loss **warning** for purely additive changes, do not accept it; apply the reviewed diff with
  `npx prisma db execute --file <diff>` and confirm `db push` reports "in sync" (production only with explicit approval).
- Schema file: `prisma/schema.prisma`; generated client: `app/generated/prisma/` (never edit); import enums from
  `@/app/generated/prisma/enums`, the client from `@/lib/db`. After schema changes run `npx prisma generate`.
- Development and tests run only against a Neon dev/test branch, never production.

## Checks

- `npx tsc --noEmit`, `npx eslint .` (known pre-existing error: `components/layout/MobileNav.tsx`)
- `npx tsx prisma/backfill/check-business-time.ts` (also with `TZ=UTC`)
- `npx tsx prisma/backfill/check-client-sections.ts`
- `npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint <dev endpoint>` (creates and removes its own fixtures;
  includes the regression tests for `context/new-feature/revision.md` and the wave-1 scope/parity tests `w1*`)
- `npx tsx prisma/backfill/check-backfill-delta.ts --expect-endpoint <dev endpoint> --expect-db <db> --owner-username <admin>`
- Backfill: dry-run by default; `--apply` needs a direct host and `--confirm <endpoint>`.

## UI Conventions

- Use shadcn/ui components from `components/ui/*`
- Sheets/modals go through `components/shared/ResponsiveSheet.tsx`: vaul drawer below `md`, Radix dialog from `md` up.
  Do not open a bare `Drawer` for new UI. `data-vaul-no-drag` / `repositionInputs` are vaul-only and are ignored in the
  dialog branch; the first paint is always the drawer branch, so hydration stays stable.
- Icon-only buttons use `variant="ghost"` and `size="icon"` or equivalent tight ghost styling
- Use `Pencil`, `Trash2`, and `Lock` from `lucide-react` for standard edit/delete/locked actions
- Preserve the shared dashboard layout components in `components/dashboard/DashboardPage.tsx`
- Do not introduce broad layout changes unless requested

## Statistics

The statistics page is not finished and still buckets days in server-local time. Do not treat current stats as final product
truth. First calls = `source CALL_QUEUE`, follow-ups = `source CLIENTS`; exclude reverted activities when redesigning.

## Safety Rules

- Preserve existing workflow design unless the task explicitly changes it
- Keep edits scoped; do not rename Prisma `Lead`; do not manually edit generated files
- Do not rely on client-side hiding for permissions
- Do not add explanatory comments unless the reason is non-obvious
- After code changes, fix imports and run TypeScript/checks when practical
- Summarize changed files and any checks that could not be run
