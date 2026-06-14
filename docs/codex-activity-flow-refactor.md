You are working on my internal CRM/calling dashboard project.

Read `AGENTS.md` first. Then implement this task.

## Project context

Stack:

* Next.js App Router
* TypeScript
* Prisma + Neon Postgres
* NextAuth Credentials
* zod, bcrypt
* shadcn/ui

This is a real internal CRM/calling dashboard for a small webdesign company.

The Prisma model is currently called `Lead`.

IMPORTANT:

* You MAY edit `schema.prisma` for this task.
* I am okay with resetting the database after this refactor.
* But do NOT rename the Prisma model `Lead`.
* Do NOT rename `leadId`, existing relations, or the general meaning of `Lead`.
* `Lead` remains the central CRM record.
* In the UI, the business concepts are:
  * `/dashboard/calls` = marketing call queue
  * `/dashboard/calls/history` = marketing call history
  * `/dashboard/pipeline` = manager/developer opportunity pipeline
  * `/dashboard/pipeline/[id]` = full opportunity detail
  * future `/dashboard/contacts` = master contact database

## Goal

Refactor the activity/history/next-action system so it can support this workflow cleanly:

1. A contact starts in `/dashboard/calls`.
2. Marketing calls the contact.
3. Depending on the call outcome, the `Lead` changes state.
4. If the contact is interested, it moves into `/dashboard/pipeline`.
5. In pipeline, the manager/developer tracks:
   * what already happened,
   * what the current next step is,
   * when the next step is due,
   * who is responsible,
   * communication/business history,
   * internal edits/audit history.

The system must not over-micromanage every possible situation. It should be flexible enough for custom notes and custom next actions.

## Core concept

Separate these concepts clearly:

### 1. Current state of the record

Stored on `Lead`.

Examples:

* `status`
* `nextActionKind`
* `nextActionAt`
* `nextActionNote`
* `ownerId`
* `price`
* `quoteSentAt`
* `designSentAt`
* `aboutUsSentAt`

This tells us what the current situation is.

### 2. Business history

Stored as `Activity`.

This is what really happened in the business workflow.

Examples:

* called the client
* client did not answer
* client wants quote
* quote was sent
* design proposal was sent
* email was sent
* client promised to send materials
* materials did not arrive
* custom business note

These activities are shown as “last step” in pipeline.

### 3. Planning history

Stored as `Activity`.

This is when we set/change/clear the next action.

Examples:

* next action set to “Send quote”
* next action changed to “Call on 15.8”
* next action set to “Waiting for client until Tuesday”
* next action cleared

Planning activities should be visible in full detail/history if needed, but they should NOT become the pipeline table “last step”.

### 4. Audit/internal edits

Stored as `Activity`.

This is for system/internal corrections.

Examples:

* contact phone number edited
* email edited
* owner changed
* status manually changed
* call outcome corrected because the user clicked the wrong outcome earlier

Audit activities should NOT become the pipeline table “last step”.

## Required schema design

Inspect the current schema first, then modify only what is needed.

Add or update enums similar to this:

```prisma
enum ActivityCategory {
  BUSINESS
  PLANNING
  AUDIT
}

enum ActivitySource {
  CALL_QUEUE
  PIPELINE
  CONTACTS
  ADMIN
}

enum ActivityType {
  CALL
  QUOTE_SENT
  DESIGN_SENT
  EMAIL_SENT
  SMS_SENT
  NOTE

  NEXT_ACTION_SET
  NEXT_ACTION_CHANGED
  NEXT_ACTION_CLEARED

  CONTACT_UPDATED
  STATUS_CHANGED
  OWNER_CHANGED
  OUTCOME_CORRECTED
}

enum NextActionKind {
  CALL
  SEND_QUOTE
  SEND_DESIGN
  SEND_EMAIL
  WAITING_FOR_CLIENT
  CUSTOM
}
```

Update `Activity` so every activity has:

* `id`
* `leadId`
* `userId`
* `type`
* `category`
* `source`
* `note`
* `outcome` if relevant
* `createdAt DateTime @default(now())`

Every activity MUST have a timestamp. This is required for sorting and history.

Update `Lead` so it can store the current next action:

* `nextActionKind NextActionKind?`
* `nextActionAt DateTime?`
* `nextActionNote String?`

If `nextActionAt` and `nextActionNote` already exist, keep them and add only `nextActionKind`.

Do not add a separate `Task` model yet. We only need one main current next action per lead for now.

## Important behavior rules

### Pipeline table

Pipeline list/table must show:

* `Last step` = latest `Activity` where `category = BUSINESS`
* `Next step` = current `Lead.nextActionKind + Lead.nextActionAt + Lead.nextActionNote`

Do NOT use planning or audit activities as “last step”.

Example:

Activities:

* BUSINESS: Email sent
* PLANNING: Next action set to “Call on 15.8”
* AUDIT: Phone changed

Pipeline table should show:

* Last step: Email sent
* Next step: Call on 15.8

NOT:

* Last step: Next action set
* Last step: Phone changed

### Calls history

`/dashboard/calls/history` should show marketing call work only.

It should query activities like:

* `type = CALL`
* `source = CALL_QUEUE`
* `userId = current user` unless manager/admin is explicitly filtering another user

It should NOT show later pipeline work done by manager/developer.

### Natural workflow is not correction

Do not confuse normal progress with correction.

Example natural workflow:

* CALL NO_ANSWER
* CALL CALL_AGAIN
* CALL WANTS_QUOTE

This creates three normal BUSINESS call activities.

This is NOT `OUTCOME_CORRECTED`.

`OUTCOME_CORRECTED` is only for cases where the user clicked the wrong result and later fixes the old activity.

Example correction:

* user accidentally clicked `WANTS_DESIGN`
* later fixes it to `WANTS_QUOTE`
* create AUDIT activity `OUTCOME_CORRECTED`

## Call outcome behavior

When a call is logged from `/dashboard/calls`, it should usually create:

1. A BUSINESS activity:
   * `type = CALL`
   * `category = BUSINESS`
   * `source = CALL_QUEUE`
   * `outcome = selected CallOutcome`
   * `note = user note`
2. A Lead state update based on outcome.
3. If the outcome creates a next action, also create a PLANNING activity.

Example mappings:

### NO_ANSWER

* Create BUSINESS CALL activity with outcome `NO_ANSWER`
* Lead should remain in calling workflow
* next action may be retry / call later depending on current app logic

### CALL_AGAIN

* Create BUSINESS CALL activity with outcome `CALL_AGAIN`
* Lead stays in calling workflow
* Set:
  * `nextActionKind = CALL`
  * `nextActionAt = chosen callback date`
  * `nextActionNote = callback note`
* Create PLANNING activity describing the scheduled callback

### BAD_NUMBER

* Create BUSINESS CALL activity with outcome `BAD_NUMBER`
* Lead status becomes `UNREACHABLE`
* Clear next action

### NOT_INTERESTED

* Create BUSINESS CALL activity with outcome `NOT_INTERESTED`
* Lead status becomes `LOST`
* Clear next action

### WANTS_QUOTE

* Create BUSINESS CALL activity with outcome `WANTS_QUOTE`
* Lead status becomes `ACTIVE`
* Set:
  * `nextActionKind = SEND_QUOTE`
  * `nextActionAt = now`
  * `nextActionNote = "Poslať cenovú ponuku"`
* Create PLANNING activity

### WANTS_DESIGN

* Create BUSINESS CALL activity with outcome `WANTS_DESIGN`
* Lead status becomes `ACTIVE`
* Set:
  * `nextActionKind = SEND_DESIGN`
  * `nextActionAt = now`
  * `nextActionNote = "Vytvoriť a poslať dizajnový návrh"`
* Create PLANNING activity

### WANTS_EMAIL

* Create BUSINESS CALL activity with outcome `WANTS_EMAIL`
* Lead status becomes `ACTIVE`
* Set:
  * `nextActionKind = SEND_EMAIL`
  * `nextActionAt = now`
  * `nextActionNote = "Napísať email / poslať informácie o nás"`
* Create PLANNING activity

### SNOOZE

* Create BUSINESS CALL activity with outcome `SNOOZE`
* Lead status becomes `SNOOZED`
* Set:
  * `nextActionKind = CALL`
  * `nextActionAt = chosen future date`
  * `nextActionNote = "Znovu osloviť neskôr"`
* Create PLANNING activity

### POSITIVE

* Create BUSINESS CALL activity with outcome `POSITIVE`
* Lead status becomes `ACTIVE`
* Do not force a specific next action unless UI provides one

## Pipeline actions

Pipeline must allow flexible next action updates.

Implement or refactor actions so manager/developer can set/change next action:

Possible next action kinds:

* `CALL`
* `SEND_QUOTE`
* `SEND_DESIGN`
* `SEND_EMAIL`
* `WAITING_FOR_CLIENT`
* `CUSTOM`

When next action is set or changed:

* update `Lead.nextActionKind`
* update `Lead.nextActionAt`
* update `Lead.nextActionNote`
* create PLANNING activity:
  * `NEXT_ACTION_SET` if previously empty
  * `NEXT_ACTION_CHANGED` if it already existed
  * `NEXT_ACTION_CLEARED` if cleared

This planning activity must not be used as pipeline `last step`.

## Business completion actions

When a current next action is completed, create a BUSINESS activity and then set a new next action if appropriate.

Examples:

### Quote sent

When user clicks “Quote sent”:

* Create BUSINESS activity:
  * `type = QUOTE_SENT`
  * `category = BUSINESS`
  * `source = PIPELINE`
* Set `Lead.quoteSentAt = now`
* Then set a sensible next action:
  * `nextActionKind = CALL`
  * `nextActionAt = now + 7 days`
  * `nextActionNote = "Zavolať, či cenová ponuka prišla"`
* Create PLANNING activity for that next action

But do not hardcode this in a way that prevents the user from changing the next action to something else, for example:

* send design
* send email
* wait for client
* custom action

### Design sent

When user clicks “Design sent”:

* Create BUSINESS activity:
  * `type = DESIGN_SENT`
  * `category = BUSINESS`
  * `source = PIPELINE`
* Set `Lead.designSentAt = now`
* Set a sensible default next action:
  * `nextActionKind = CALL`
  * `nextActionAt = now + 7 days`
  * `nextActionNote = "Zavolať, či si návrh pozreli"`
* Create PLANNING activity

### Email sent / about us sent

When user clicks “Email sent”:

* Create BUSINESS activity:
  * `type = EMAIL_SENT`
  * `category = BUSINESS`
  * `source = PIPELINE`
* Set `Lead.aboutUsSentAt = now`
* Set a sensible default next action:
  * `nextActionKind = CALL`
  * `nextActionAt = now + 7 days`
  * `nextActionNote = "Zavolať, či email prišiel / či si ho pozreli"`
* Create PLANNING activity

## Waiting for client

This is important.

Often the client says:

* “I will send materials”
* “I will send logo”
* “I will send text”
* “I will look at the design”
* “I will reply by Tuesday”

This should be represented as:

Current next action on Lead:

* `nextActionKind = WAITING_FOR_CLIENT`
* `nextActionAt = expected date`
* `nextActionNote = e.g. "Čakáme na podklady / logo / odpoveď"`

If the client does not send it:

* user should be able to log a BUSINESS NOTE, e.g. `"Podklady neprišli"`
* then set a new next action, usually:
  * `CALL`
  * due soon
  * note like `"Pripomenúť podklady"`

Do not create many enum types like `CLIENT_DID_NOT_SEND_DATA`. Use BUSINESS `NOTE` with free text for custom real-world cases.

## Custom business notes

Support a simple way to create a BUSINESS note from pipeline.

Example:

* `type = NOTE`
* `category = BUSINESS`
* `source = PIPELINE`
* `note = "Klient sľúbil poslať logo do piatku"`
* timestamp automatically via `createdAt`

This should be visible in business history and can become the pipeline table last step.

## Audit activities

Internal edits should create AUDIT activities, not BUSINESS.

Examples:

* contact phone updated
* contact email updated
* company name changed
* owner changed
* status manually changed
* outcome corrected

These should not become pipeline last step.

## Helper/service layer

Please avoid duplicating logic across actions.

Create or refactor small shared helpers under `lib`, for example:

* `lib/leadFlow.ts`
  * outcome → lead state/next action mapping
  * maybe default next action helpers
* `lib/activityLog.ts`
  * create business activity payload
  * create planning activity payload
  * create audit activity payload
* `lib/dictionaries.ts`
  * enum labels

Do not over-abstract. Keep helpers simple and readable.

Suggested helper concepts:

```ts
createBusinessActivity(...)
createPlanningActivity(...)
createAuditActivity(...)
applyNextAction(...)
clearNextAction(...)
leadStateForCallOutcome(...)
```

Use Prisma transactions for actions that update Lead and create Activity together.

Example:

* log call = create business activity + update lead + maybe create planning activity
* send quote = update lead + create business activity + set next action + create planning activity
* edit contact = update lead + create audit activity

## Shared dictionaries

Update `lib/dictionaries.ts` or create it if missing.

It should include labels for:

* `LeadStatus`
* `CallOutcome`
* `ActivityType`
* `ActivityCategory`
* `ActivitySource`
* `NextActionKind`

Use correct Slovak UTF-8 text, not mojibake.

Do not copy broken encoded text like `NovĂ˝`.

Use proper text:

* `Nový`
* `Volá sa`
* `Aktívny`
* `Zlé číslo`
* `Máme napísať`
* `Poznámka`

## UI behavior requirements

Do not redesign the whole UI unless required.

But update existing pages/components so they use the new model correctly:

### `/dashboard/calls`

* logging a call should create BUSINESS activity with source `CALL_QUEUE`
* if next action is created, create PLANNING activity
* call queue behavior should remain working

### `/dashboard/calls/history`

* show only call activities from call queue
* filter by current user unless admin/manager filtering already exists
* do not show pipeline work after the lead moved forward

### `/dashboard/pipeline`

* list/table should show:
  * latest BUSINESS activity as last step
  * current Lead next action as next step
* planning and audit activities should not appear as last step

### `/dashboard/pipeline/[id]`

* show business history clearly
* optionally show all activities or audit/planning behind a section/toggle if easy
* allow setting/changing next action
* allow logging/sending:
  * quote sent
  * design sent
  * email sent
  * custom business note
  * waiting for client
* keep current functionality working

## Database reset

Since this is still in development, it is okay if this requires a migration and database reset.

But:

* do not randomly delete models
* do not remove useful existing fields unless clearly replaced
* explain what migration/reset command I should run
* do not run destructive DB reset unless explicitly approved by me

## Final checks

After implementation:

* run TypeScript check / lint / build according to package scripts
* fix broken imports
* fix generated enum imports if needed
* ensure Prisma schema is valid
* ensure `/dashboard/calls`, `/dashboard/calls/history`, `/dashboard/pipeline`, `/dashboard/pipeline/[id]` compile

## Final summary

At the end, summarize:

1. Schema changes
2. New enums/fields
3. Activity logging rules implemented
4. Query changes:
   * calls history
   * pipeline last step
5. Actions changed:
   * log call
   * set next action
   * send quote/design/email
   * custom note
   * audit edits
6. UI changes
7. What is intentionally left for later
8. Exact commands I should run for Prisma migration/reset/checks
