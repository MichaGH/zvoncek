<!-- BEGIN:nextjs-agent-rules --

# Next.js version warning

This project may use a newer Next.js/App Router version than examples in older training data.

Before changing route handlers, server components, `params`, `searchParams`, server actions, caching, or revalidation behavior:

- inspect the existing code style in this repository first
- prefer the patterns already used in this project
- if unsure, check the installed Next.js docs in `node_modules/next/dist/docs/`
- do not blindly rewrite working App Router code to older conventions

## Project overview

This is an internal CRM/calling dashboard for a small webdesign company.

Stack:

- Next.js App Router
- TypeScript
- Prisma + Neon Postgres
- NextAuth Credentials
- zod, bcrypt
- shadcn/ui

The app is both a learning project and a real internal company tool.

## Critical naming rule

The Prisma model is called `Lead`.

Do NOT rename:

- Prisma model `Lead`
- `leadId`
- Prisma relations
- database fields
- generated Prisma enum/type imports
- schema.prisma

In this project, `Lead` is the central CRM record. In business terms it may represent:

- a raw company/contact to call,
- a call target,
- an interested opportunity,
- a lost/won record,
- later maybe a client/project.

Route/UI names should describe business views, not necessarily Prisma model names.

## Main business views

### `/dashboard/calls`

Marketing call queue.

Marketing users call assigned contacts here. This page should show contacts that are currently meant to be called.

Typical outcomes:

- `NO_ANSWER` → stays in calling workflow / retry
- `CALL_AGAIN` → stays in calling workflow with scheduled callback
- `BAD_NUMBER` → becomes unreachable
- `NOT_INTERESTED` → becomes lost
- `WANTS_QUOTE` → becomes active opportunity in pipeline
- `WANTS_DESIGN` → becomes active opportunity in pipeline
- `WANTS_EMAIL` → becomes active opportunity in pipeline
- `SNOOZE` → postponed/snoozed
- `POSITIVE` → active opportunity in pipeline

When a user logs a call result:

- create an `Activity`
- update the current `Lead` state
- make sure the record appears in the correct business view afterwards

### `/dashboard/calls/history`

Marketing call history.

This is not the full history of the lead. It is the history of marketing call work, usually filtered to the current user or selected user.

It should primarily show `CALL` activities from the call workflow.

### `/dashboard/pipeline`

Manager/developer view for active business opportunities.

This replaces the old `/dashboard/leads` UI concept.

Records enter pipeline when the company showed interest, for example:

- wants quote
- wants design
- wants email
- positive progress

Pipeline is where the manager/developer tracks:

- next action
- quote/design/email status
- price
- owner
- follow-up
- opportunity status

### `/dashboard/pipeline/[id]`

Full detail/edit view for one business opportunity.

This page can still use Prisma `Lead` internally, but component and route naming should use `Pipeline`.

### Future `/dashboard/contacts`

Master database of all company/contact records.

This is where future features should go:

- create new contact/company
- import CSV
- edit basic contact data
- detect duplicates
- assign contacts to callers
- manage raw contacts before they enter calls

Do not build contacts unless explicitly requested.

## Folder conventions

Prefer feature folders with `index.ts` for queries/actions.

Examples:

- `lib/queries/calls/index.ts`
- `lib/queries/calls/history.ts`
- `lib/queries/pipeline/index.ts`
- `lib/actions/calls/index.ts`
- `lib/actions/calls/history.ts`
- `lib/actions/pipeline/index.ts`

Shared reusable things should go into clear shared files:

- `lib/dictionaries.ts` for enum labels
- `lib/formatters.ts` for date/format helpers if reused
- `lib/leadFlow.ts` for outcome → lead state transitions
- `lib/utils.ts` for general utilities

Do not over-abstract helpers that are used only once.

## Shared dictionaries

Do not duplicate enum label dictionaries inside components if they are reused by multiple features.

Shared labels such as `STATUS_LABEL`, `STATUS_VARIANT`, `OUTCOME_LABEL`, and `ACTIVITY_LABEL` should live in `lib/dictionaries.ts`.


## Safety / behavior rules

Preserve existing behavior unless the task explicitly asks to change it.

After changes:

- run TypeScript/build/lint checks if available
- fix broken imports
- check route links
- summarize changed files and any TODOs

<!-- END:nextjs-agent-rules -->
