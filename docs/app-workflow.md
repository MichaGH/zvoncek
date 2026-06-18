# Zvonček App Workflow

This document describes the product workflow. `AGENTS.md` is the short
operational guide; this file is the longer business map.

## Roles

Zvonček has four roles:

- `SCOUT`
- `TELESALES`
- `MANAGER`
- `ADMIN`

The product flow is:

`SCOUT adds contacts -> TELESALES calls contacts -> interested contacts move to MANAGER pipeline -> MANAGER handles the opportunity`

## SCOUT Workflow

SCOUT adds raw contacts.

Pages:
- `/dashboard/contacts`
- `/dashboard/contacts/new`

SCOUT sees their own recently added contacts. They can edit or delete a contact
only while it is still uncalled (`Lead.status === "NEW"`). Once a contact enters
telesales/calling work, it becomes locked for SCOUT.

This lock is a business rule, not just a UI rule. It must be enforced
server-side.

## TELESALES Workflow

TELESALES works `/dashboard/calls`.

The main call queue has a column/group for new contacts. A contact opens in a
drawer with call outcomes.

`Lead.lockedById` and `lockedAt` exist for future multi-user calling, where
contacts may be assigned or locked to a specific telesales person.

### Outcome: Interested

The caller chooses what the client wants:

- design proposal
- quote
- email/about-us information

After this path, the drawer may ask for an optional email address.

The contact moves to manager pipeline. From that point, TELESALES should not edit
pipeline fields. Call-history revert/correction still exists as a mistake-fix
tool, but only while the opportunity is not stage-locked by real manager work
such as owner assignment, price, sent quote/design/email, design records, or a
final won/lost state.

### Outcome: No Answer

The contact stays in the calls world and is shown as not answered/retry. The UI
should show when it was last called.

### Outcome: Agreed Callback Time

Used when the person says something like "call me in an hour", "call tomorrow",
or "call Wednesday at 13:00".

This writes to the calls fields:

```prisma
callbackKind    CallbackKind?
callbackAt      DateTime?
callbackHasTime Boolean       @default(false)
callbackNote    String?
```

Important time concept:

- if only a date is chosen, `callbackHasTime` is `false`
- if date and time are chosen, `callbackHasTime` is `true`

All UI warning labels and urgency styling should respect this distinction.

### Outcome: Contact Later / Snooze

Used when the client says something like "we do not have time now, contact us in
September".

This is long-term snooze. Presets may be things like one month, three months, or
six months. This path should use date-only planning; there is no exact time.

### Outcome: Not Interested

The contact becomes lost/not interested.

### Outcome: Bad Number

The contact becomes unreachable/bad number.

### Notes

The caller can add a note. Notes should be preserved in activity/contact history
as appropriate.

## Calls vs Pipeline Time Fields

Calls and pipeline intentionally have separate scheduling fields.

Calls use:

```prisma
callbackKind
callbackAt
callbackHasTime
callbackNote
```

Pipeline uses:

```prisma
nextActionKind
nextActionAt
nextActionHasTime
nextActionNote
```

The design principle is the same in both places:

- date only = a day-level promise
- date + time = exact-time promise

Shared urgency/date display should stay centralized so all pages describe time
the same way.

## MANAGER Workflow

MANAGER works `/dashboard/pipeline`.

The pipeline contains active business opportunities that came from positive
telesales outcomes or were otherwise created as opportunities.

The manager handles:

- next step
- last step
- contact/company data
- project type
- owner
- quote and quote-sent status
- design proposal
- about-us email
- final status such as won/lost

Each row can be opened at `/dashboard/pipeline/[id]`.

## Pipeline Detail

Pipeline detail is the full workspace for one opportunity.

Main concepts:

- `Ďalší krok` - what should happen next
- `Posledný krok` - latest business activity
- `Údaje` - contact/company data
- `Cenová ponuka` - price, price note, sent status
- `Dizajn & Tracking` - designs, versions, tracking URLs, history
- `Email "O nás"` - about-us/reference email sent state
- `História` - activity log, still not fully polished

## Design Tracking

Managers can attach designs/proposals to a lead.

Tracking concepts:

- `Design` is the proposal record
- `DesignVersion` records version updates
- `Tracker` has a unique token
- `TrackerEvent` records page views and engaged views

Public scripts:

- `/p.js`
- `/scripts/tracker.js`

The script reads `?p=TOKEN`, strips the token from the visible URL, and posts
events to `/api/p`.

Confidence is derived from events and current design version. It is a signal,
not proof.

## ADMIN Workflow

ADMIN has all permissions.

Admin pages are still early. Current user-management exists, and more admin
features may be added gradually.

## Statistics

Statistics are currently unfinished and should be redesigned around useful
business questions.

Avoid meaningless stats. Example: SCOUT cannot call, so "calls made by SCOUT" is
not a useful metric.

Likely useful future statistics:

- number of free contacts ready to call
- contacts added by SCOUT
- calls made by TELESALES
- reach rate
- interested outcomes
- pipeline conversion
- won/lost value
- overdue callbacks / overdue next actions
