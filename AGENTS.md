# Zvonček - Agent Instructions

This file is the operational memory for coding agents working on Zvonček.
Keep it short, current, and strict. Detailed product flow lives in
`docs/app-workflow.md`.

## What This App Is

Zvonček is an internal CRM and calling dashboard for The Grand Points, a small
web design company.

Stack:
- Next.js App Router
- TypeScript
- Prisma + Postgres
- NextAuth Credentials
- shadcn/ui
- vaul drawers
- Tailwind CSS

This is a real internal tool and also a learning project. Do not add features
outside the requested scope.

## Core Domain Rule

The central Prisma model is `Lead`. Never rename it.

Business meaning changes by workflow stage:
- `NEW` lead = raw contact prepared for calling
- `CALLING` / `SNOOZED` lead = call queue item
- `ACTIVE` lead = manager pipeline opportunity
- `WON`, `LOST`, `UNREACHABLE` lead = final or inactive result

Routes and UI should use business names such as contacts, calls, pipeline, and
statistics. Do not rename Prisma `Lead` to Contact/Client/Opportunity.

## Roles

There are four roles:

- `SCOUT`
- `TELESALES`
- `MANAGER`
- `ADMIN`

Permission checks must go through `can(user, permission)` from
`lib/permissions.ts`. Do not check roles directly in actions/components unless
the code is explicitly doing role-specific presentation and cannot be expressed
as a permission.

### SCOUT

SCOUT only adds and manages raw contacts.

Allowed workflow:
- sees contacts only
- creates contacts
- sees only their own contacts, scoped server-side by `createdById`
- can edit/delete their own contact only while it is still `NEW`
- once telesales has touched the contact, it is locked/read-only for SCOUT

SCOUT cannot call, cannot see pipeline, and cannot see other users' contacts.

### TELESALES

TELESALES works the call queue at `/dashboard/calls`.

Allowed workflow:
- sees callable contacts
- logs call outcomes
- can view call history
- may quickly create a contact if needed
- hands off interested contacts to pipeline by logging a positive outcome

TELESALES must not manage pipeline data. After a contact becomes an active
pipeline opportunity, TELESALES should not edit pipeline fields. Call-history
revert/correction exists only to fix a mistaken call outcome, and should remain
stage-locked once the manager has meaningfully touched the opportunity.

`Lead.lockedById` / `lockedAt` exists for future multi-telesales contact
assignment. Keep it in mind when changing queue behavior.

### MANAGER

MANAGER works the business pipeline at `/dashboard/pipeline`.

Allowed workflow:
- sees all contacts, call history, and pipeline opportunities
- manages status, owner, project type, price, quote sent state, email sent state
- creates and updates designs/proposals
- manages tracking URLs and design versions
- owns follow-up planning via `nextAction*`

### ADMIN

ADMIN has all permissions and admin pages. Admin functionality is still growing;
keep changes conservative and explicit.

## Main Routes

Current implemented routes:

- `/dashboard` - role-aware home
- `/dashboard/contacts` - contacts database
- `/dashboard/contacts/new` - add contacts
- `/dashboard/calls` - telesales call queue
- `/dashboard/calls/history` - call history
- `/dashboard/pipeline` - manager pipeline table
- `/dashboard/pipeline/[id]` - pipeline detail
- `/dashboard/stats` - statistics page, currently unfinished and expected to be redesigned
- `/dashboard/admin` - admin area
- `/dashboard/admin/users` - user management

If product discussion says `/dashboard/statistics` or `/dashboard/contacts/add`,
map that to the current implementation unless the task explicitly asks to rename
routes.

## Workflow Summary

The app flow is:

`SCOUT adds contacts -> TELESALES calls contacts -> interested contacts move to MANAGER pipeline -> MANAGER closes or loses opportunity`

Detailed workflow is documented in `docs/app-workflow.md`.

Important state split:

- Calls use `callbackKind`, `callbackAt`, `callbackHasTime`, `callbackNote`
- Pipeline uses `nextActionKind`, `nextActionAt`, `nextActionHasTime`, `nextActionNote`

The `*HasTime` flag matters everywhere:

- `false` means the client gave only a day, so UI should show day-level labels
- `true` means the client gave an exact time, so UI should show exact-time urgency

Shared urgency/display logic lives in `lib/overdue.ts` and
`components/shared/UrgencyLabel.tsx`.

## Call Outcomes

TELESALES drawer outcomes:

- interested:
  - wants design
  - wants quote
  - wants email/about-us info
  - optional email collection after this path
- no answer
- agreed callback time
- snooze / contact later
- not interested
- bad or non-functional number
- note

Outcome-to-state transition logic belongs in `lib/domain/leadFlow.ts`.

## Pipeline Detail

Pipeline detail is the manager workspace for one opportunity.

Important sections:
- next action
- last business step
- client/contact data
- quote
- design and tracking
- about-us email
- history

Design tracking flow:
- manager creates a `Design`
- app creates a `Tracker` with token
- public script reads `?p=TOKEN`
- script posts view/engagement events to `/api/p`
- confidence summary is derived in `lib/tracking/confidence.ts`

## Permissions And Security

Single source of truth:

- `lib/permissions.ts`
- `auth.config.ts` route guard via `requiredPermissionForPath(path)`

Rules:
- every server action must authenticate and check permissions before changing data
- role-scoped queries must enforce scope server-side
- UI hiding is not security
- use `notFound()` or redirect only after server-side permission checks

Known code smell to watch: call history correction actions should be checked for
permission coverage before expanding them.

## Database Rules

- Use `prisma db push`, not `prisma migrate dev`
- Schema file: `prisma/schema.prisma`
- Generated Prisma client output: `app/generated/prisma/`
- Import enums from `@/app/generated/prisma/enums`
- Import Prisma client from `@/lib/db`
- After schema changes, run:
  - `npx prisma db push`
  - `npx prisma generate`

Do not modify generated Prisma files manually.

## Important Files

- `prisma/schema.prisma` - database schema
- `lib/db.ts` - Prisma client
- `lib/permissions.ts` - permissions
- `lib/domain/leadFlow.ts` - call outcome state transitions
- `lib/overdue.ts` - shared urgency/date display logic
- `lib/activityLog.ts` - activity payload helpers
- `lib/dictionaries.ts` - UI labels for enums
- `lib/actions/contacts/index.ts` - contact mutations
- `lib/actions/calls/index.ts` - call queue mutations
- `lib/actions/pipeline/index.ts` - pipeline mutations
- `lib/actions/tracking/index.ts` - design/tracking mutations
- `lib/queries/*` - server read models
- `app/api/p/route.ts` - public tracking ingest
- `public/p.js` and `public/scripts/tracker.js` - public tracking snippets

## UI Conventions

- Use shadcn/ui components from `components/ui/*`
- Drawers use vaul
- Icon-only buttons use `variant="ghost"` and `size="icon"` or equivalent tight ghost styling
- Use `Pencil`, `Trash2`, and `Lock` from `lucide-react` for standard edit/delete/locked actions
- Preserve the shared dashboard layout components in `components/dashboard/DashboardPage.tsx`
- Do not introduce broad layout changes unless requested

## Statistics

The statistics page is not finished. Do not treat current stats as final product
truth. Future stats should reflect real role responsibilities; for example,
SCOUT does not make calls, so call-performance stats for SCOUT are not useful.

## Safety Rules

- Preserve existing workflow design unless the task explicitly changes it
- Keep edits scoped
- Do not rename Prisma `Lead`
- Do not manually edit generated files
- Do not rely on client-side hiding for permissions
- Do not add explanatory comments unless the reason is non-obvious
- After code changes, fix imports and run TypeScript/checks when practical
- Summarize changed files and any checks that could not be run
