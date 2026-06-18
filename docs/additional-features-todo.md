# Additional Features Todo

This is a product-oriented todo list for important future work. It is not a
promise to build everything at once. Keep the core workflow stable:

`SCOUT -> TELESALES -> MANAGER -> ADMIN`

## Priority 1 - Workflow Correctness

### Tighten Server Permissions

Some server actions should be reviewed for explicit permission checks before
they grow further.

Focus areas:
- call history correction actions
- calls pagination / load-more actions
- any future action that returns shared queue data

Goal: every mutation or sensitive read should authenticate and check `can(...)`
server-side.

### Pipeline List Should Show Pipeline Data

The pipeline table should be explicit about which lead states belong there.

Recommended behavior:
- hide soft-deleted leads
- default to active/open opportunities
- keep filters for won/lost/all if the manager needs them

Goal: `/dashboard/pipeline` should not accidentally become a raw contact list.

### Keep Route Names Aligned With Code

Use the implemented routes in docs and UI:
- `/dashboard/stats`
- `/dashboard/contacts/new`

Do not document `/dashboard/statistics` or `/dashboard/contacts/add` unless the
routes are intentionally renamed.

## Priority 2 - Telesales Queue

### Multi-Telesales Locking

Use existing fields:

```prisma
lockedById
lockedAt
```

Open questions to decide:
- does a contact lock when a telesales user opens the drawer?
- how long before an abandoned lock expires?
- can manager/admin unlock a contact?
- should users see "my locked contacts" separately from free contacts?

Goal: multiple callers can work without stepping on the same contact.

### Better Call Queue Counts

Show clear counts:
- free contacts ready to call
- scheduled callbacks today
- overdue callbacks
- retry/no-answer contacts
- snoozed contacts

Goal: telesales always knows how much work is ready now.

### Call History Filters

Useful filters:
- date range
- caller
- outcome
- only revertable rows
- only interested handoffs

Goal: history becomes a working tool, not just a log.

## Priority 3 - Manager Pipeline

### Manager Daily Agenda

Create a focused list of manager tasks from `nextAction*`.

Sections could be:
- overdue
- today
- this week
- waiting for client
- send quote
- send design

Goal: manager opens the app and immediately knows what to do next.

### Pipeline Saved Filters

Useful filters/views:
- active
- overdue
- waiting for client
- quote to send
- design to send
- quote sent, waiting follow-up
- design sent, waiting follow-up
- won
- lost

Goal: pipeline becomes easier to work as volume grows.

### Activity Timeline Polish

Current history mixes different kinds of events. The manager primarily needs the
client/business story, while audit details should be available but quieter.

Recommended split:
- Business timeline: calls, notes, quote sent, design sent, email sent, client-relevant events
- Planning timeline: next action set/changed/cleared
- Audit timeline: contact edits, status changes, owner changes, corrections

Default UI should show business history first. Planning and audit can be
collapsed, filtered, or shown in an "all history" mode.

Goal: the history should answer "what happened with this client?" before it
answers "what database fields changed?"

## Priority 4 - Statistics Redesign

The current stats page should be redesigned around real business questions.

Useful metrics:
- free contacts ready to call
- contacts added by SCOUT
- calls made by TELESALES
- reached vs not reached
- interested outcomes
- handoffs to pipeline
- pipeline conversion
- won/lost count and value
- overdue callbacks
- overdue manager next actions

Avoid meaningless metrics:
- SCOUT call performance, because SCOUT cannot call
- generic totals that do not drive an action

Goal: statistics should help decide what to do next.

## Priority 5 - Contact Data Quality

### CSV / Spreadsheet Import

Add bulk contact import with preview.

Important behavior:
- validate required fields
- normalize websites
- detect duplicate phones
- show skipped/duplicate rows before saving

Goal: adding contacts should scale beyond manual row entry.

### Duplicate Handling / Merge

When a phone or website already exists, offer a clear path:
- open existing contact
- skip duplicate
- merge missing info

Goal: keep the contact pool clean.

## Priority 6 - Design Tracking

### Tracking Follow-Up View

Useful tracking statuses:
- sent but not opened
- opened but not engaged
- engaged
- viewed after latest version
- multi-day engagement

Goal: manager knows which client to follow up with and why.

### Design Version Clarity

Make it easier to see:
- current version
- previous versions
- which version the client viewed
- whether a new version was viewed after update

Goal: tracking should support real sales follow-up, not just analytics.

## Priority 7 - Admin

Admin can grow gradually.

Possible admin features:
- manage users
- deactivate/reactivate users
- unlock stuck call locks
- configure call outcome presets
- configure snooze presets
- view system health / recent errors
- basic export

Goal: admin should support operations without becoming a second product.
