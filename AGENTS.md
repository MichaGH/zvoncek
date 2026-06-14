<!-- BEGIN:nextjs-agent-rules --
# AGENTS.md

## Project overview

This is an internal CRM / calling dashboard for a small webdesign company.

Stack:

* Next.js App Router
* TypeScript
* Prisma + Neon Postgres
* NextAuth Credentials
* zod, bcrypt
* shadcn/ui

The app is both:

* a real internal company tool,
* and a learning project.

Prefer readable, maintainable code over clever abstractions.

## Next.js version warning

This project may use a newer Next.js App Router version than older examples.

Before changing route handlers, server components, `params`, `searchParams`, server actions, caching, or revalidation behavior:

* inspect the existing code style in this repository first,
* prefer the patterns already used in this project,
* if unsure, check the installed Next.js docs in `node_modules/next/dist/docs/`,
* do not blindly rewrite working App Router code to older conventions.

## Critical database naming rule

The Prisma model is called `Lead`.

Do NOT rename:

* Prisma model `Lead`,
* `leadId`,
* Prisma relations,
* database fields,
* generated Prisma enum/type imports,
* `schema.prisma` model names,

unless explicitly asked.

In this project, `Lead` is the central CRM record. In business terms it may represent:

* a raw company/contact to call,
* a call target,
* an interested opportunity,
* a lost/won record,
* later maybe a client/project.

Route and UI names should describe business views, not necessarily Prisma model names.

It is okay for implementation variables to still be named `lead` when working with the Prisma `Lead` model.

## Main business views

### `/dashboard/calls`

Marketing call queue.

Marketing users call assigned contacts here.

This page should show contacts that are currently meant to be called.

Call results can move a record through the workflow:

* `NO_ANSWER` → stays in calling workflow / retry
* `CALL_AGAIN` → stays in calling workflow with scheduled callback
* `BAD_NUMBER` → becomes unreachable
* `NOT_INTERESTED` → becomes lost
* `WANTS_QUOTE` → becomes active opportunity in pipeline
* `WANTS_DESIGN` → becomes active opportunity in pipeline
* `WANTS_EMAIL` → becomes active opportunity in pipeline
* `SNOOZE` → postponed / snoozed
* `POSITIVE` → active opportunity in pipeline

When a user logs a call result:

* create an `Activity`,
* update the current `Lead` state,
* update or clear the current next action if needed,
* make sure the record appears in the correct business view afterwards.

### `/dashboard/calls/history`

Marketing call history.

This is not the full history of the lead.

It should show marketing call work, usually filtered to the current user or selected user.

It should primarily show:

* `Activity.type = CALL`
* `Activity.source = CALL_QUEUE`

It should not show later pipeline work done by manager/developer.

### `/dashboard/pipeline`

Manager/developer view for active business opportunities.

This replaces the old `/dashboard/leads` UI concept.

Records enter pipeline when the company showed interest, for example:

* wants quote,
* wants design,
* wants email,
* positive progress.

Pipeline is where the manager/developer tracks:

* current next action,
* quote/design/email status,
* price,
* owner,
* follow-up,
* opportunity status,
* business history.

### `/dashboard/pipeline/[id]`

Full detail/edit view for one business opportunity.

This page can still use Prisma `Lead` internally, but component and route naming should use `Pipeline`.

### Future `/dashboard/contacts`

Master database of all company/contact records.

Future features should go here:

* create new contact/company,
* import CSV,
* edit basic contact data,
* detect duplicates,
* assign contacts to callers,
* manage raw contacts before they enter calls.

Do not build contacts unless explicitly requested.

## Core domain model

Separate these concepts clearly.

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

* called the client,
* client did not answer,
* client wants quote,
* quote was sent,
* design proposal was sent,
* email was sent,
* client promised to send materials,
* materials did not arrive,
* custom business note.

Business activities can be shown as the pipeline “last step”.

### 3. Planning history

Stored as `Activity`.

This is when we set, change, or clear the next action.

Examples:

* next action set to “Send quote”,
* next action changed to “Call on 15.8”,
* next action set to “Waiting for client until Tuesday”,
* next action cleared.

Planning activities may be visible in full detail/history, but they should not become the pipeline table “last step”.

### 4. Audit / internal edits

Stored as `Activity`.

This is for system/internal corrections.

Examples:

* contact phone number edited,
* email edited,
* owner changed,
* status manually changed,
* call outcome corrected because the user clicked the wrong outcome earlier.

Audit activities should not become the pipeline table “last step”.

## Activity rules

Every activity must have a timestamp via `createdAt`.

Activity should generally include:

* `id`
* `leadId`
* `userId`
* `type`
* `category`
* `source`
* `note`
* `outcome` if relevant
* `createdAt`

Use these conceptual categories:

* `BUSINESS` = something real happened in the business/client workflow
* `PLANNING` = the next action was set, changed, or cleared
* `AUDIT` = internal edit, correction, or admin/system change

Use these conceptual sources:

* `CALL_QUEUE`
* `PIPELINE`
* `CONTACTS`
* `ADMIN`

## Pipeline table rule

Pipeline list/table should show:

* `Last step` = latest `Activity` where `category = BUSINESS`
* `Next step` = current `Lead.nextActionKind + Lead.nextActionAt + Lead.nextActionNote`

Do not use planning or audit activities as the pipeline “last step”.

Example activities:

* BUSINESS: Email sent
* PLANNING: Next action set to “Call on 15.8”
* AUDIT: Phone changed

Pipeline table should show:

* Last step: Email sent
* Next step: Call on 15.8

Not:

* Last step: Next action set
* Last step: Phone changed

## Natural workflow is not correction

Do not confuse normal progress with correction.

Example natural workflow:

* CALL `NO_ANSWER`
* CALL `CALL_AGAIN`
* CALL `WANTS_QUOTE`

This creates three normal business call activities.

This is not `OUTCOME_CORRECTED`.

`OUTCOME_CORRECTED` is only for cases where the user clicked the wrong result and later fixes the old activity.

Example correction:

* user accidentally clicked `WANTS_DESIGN`
* later fixes it to `WANTS_QUOTE`
* create AUDIT activity `OUTCOME_CORRECTED`

## Next action rules

The current next action lives on `Lead`.

Expected fields:

* `nextActionKind`
* `nextActionAt`
* `nextActionNote`

Possible next action kinds may include:

* `CALL`
* `SEND_QUOTE`
* `SEND_DESIGN`
* `SEND_EMAIL`
* `WAITING_FOR_CLIENT`
* `CUSTOM`

When next action is set or changed:

* update the fields on `Lead`,
* create a PLANNING activity,
* do not show that planning activity as pipeline “last step”.

When a current next action is completed:

* create a BUSINESS activity,
* update relevant `Lead` fields,
* usually set a sensible new next action.

Example:

Quote sent:

* create BUSINESS activity `QUOTE_SENT`
* set `Lead.quoteSentAt = now`
* set next action:

  * `nextActionKind = CALL`
  * `nextActionAt = now + 7 days`
  * `nextActionNote = "Zavolať, či cenová ponuka prišla"`
* create PLANNING activity for that new next action

But do not hardcode flows too rigidly. The user should still be able to change the next action to:

* send design,
* send email,
* wait for client,
* custom action.

## Waiting for client

Often the client says:

* “I will send materials”
* “I will send logo”
* “I will send text”
* “I will look at the design”
* “I will reply by Tuesday”

Represent this as current next action:

* `nextActionKind = WAITING_FOR_CLIENT`
* `nextActionAt = expected date`
* `nextActionNote = "Čakáme na podklady / logo / odpoveď"`

If the client does not send it:

* create BUSINESS NOTE, e.g. `"Podklady neprišli"`
* then set a new next action, usually:

  * `CALL`
  * due soon
  * note like `"Pripomenúť podklady"`

Do not create many enum types like `CLIENT_DID_NOT_SEND_DATA`.

Use BUSINESS `NOTE` with free text for custom real-world cases.

## Folder conventions

Prefer feature folders with `index.ts` for queries/actions.

Examples:

* `lib/queries/calls/index.ts`
* `lib/queries/calls/history.ts`
* `lib/queries/pipeline/index.ts`
* `lib/actions/calls/index.ts`
* `lib/actions/calls/history.ts`
* `lib/actions/pipeline/index.ts`

Components should be named by feature:

* call-related components should use `Call...`
* pipeline-related components should use `Pipeline...`
* future contact-related components should use `Contact...`

Shared reusable things should go into clear shared files:

* `lib/dictionaries.ts` for enum labels
* `lib/formatters.ts` for reused formatting helpers
* `lib/leadFlow.ts` for outcome → lead state / next action transitions
* `lib/activityLog.ts` for simple activity payload helpers
* `lib/utils.ts` for general utilities

Do not over-abstract helpers that are used only once.

## Shared dictionaries

Do not duplicate enum label dictionaries inside components if they are reused by multiple features.

Shared labels such as these should live in `lib/dictionaries.ts`:

* `STATUS_LABEL`
* `STATUS_VARIANT`
* `OUTCOME_LABEL`
* `ACTIVITY_LABEL`
* `ACTIVITY_CATEGORY_LABEL`
* `ACTIVITY_SOURCE_LABEL`
* `NEXT_ACTION_KIND_LABEL`

Use proper UTF-8 Slovak text.

Do not output mojibake strings like:

* `NovĂ˝`
* `ZlĂ© ÄŤĂ­slo`
* `MĂˇme napĂ­saĹĄ`

Use:

* `Nový`
* `Zlé číslo`
* `Máme napísať`

## Server action rules

Server actions that change a `Lead` should usually also create an `Activity`.

Use Prisma transactions when an action updates a `Lead` and creates one or more `Activity` records together.

Examples:

* log call = create BUSINESS activity + update Lead + maybe create PLANNING activity
* send quote = update Lead + create BUSINESS activity + set next action + create PLANNING activity
* edit contact = update Lead + create AUDIT activity
* set next action = update Lead + create PLANNING activity

Do not rely only on UI hiding for permissions. Permission-sensitive rules should also be enforced in server actions.

## Query rules

Queries should select only what the page/component needs.

List pages should not load full detail data.

Detail pages may load richer data, including related activities and owner/user info.

Avoid N+1 queries. Prefer Prisma `include` or `select` when related data is needed.

For pipeline list:

* last step should come from latest BUSINESS activity
* next step should come from current Lead next action fields

For calls history:

* use call activities from source `CALL_QUEUE`
* usually filter by current user unless admin/manager filter exists

## UI / route naming rules

Use business route names:

* `/dashboard/calls`
* `/dashboard/calls/history`
* `/dashboard/pipeline`
* `/dashboard/pipeline/[id]`
* future `/dashboard/contacts`

Do not reintroduce `/dashboard/leads` unless explicitly requested.

Do not add redirects from `/dashboard/leads` to `/dashboard/pipeline` unless explicitly requested.

This project is still in development, so clean moves are preferred over old route compatibility.

## Refactor rules

When refactoring old `leads` UI to `pipeline`:

* move routes from `/dashboard/leads` to `/dashboard/pipeline`
* rename UI components from `Lead...` to `Pipeline...`
* update links from `/dashboard/leads` to `/dashboard/pipeline`
* do not rename the Prisma model or DB fields
* avoid changing business behavior unless the task asks for it
* run checks after refactor

## Prisma / database rules

Do not change `schema.prisma` unless the task explicitly allows it.

If schema changes are needed:

* explain why,
* keep changes minimal,
* do not rename `Lead`,
* do not delete useful existing fields unless clearly replaced,
* do not run destructive DB reset unless explicitly approved.

If a migration/reset is needed, provide exact commands for the user to run.

## Validation and checks

After significant changes:

* run TypeScript check, lint, or build according to available package scripts,
* fix broken imports,
* check route links,
* check Prisma schema validity if schema changed,
* summarize changed files and TODOs.

## Coding style

Prefer readable code.

Avoid clever abstractions.

Keep helpers small.

Use descriptive function names.

Prefer feature-specific files until logic is genuinely shared.

When logic is shared by multiple features, move it to a clear shared module under `lib`.

Do not create vague catch-all files like `tools.ts` unless there is no better name.

## Final response expectations for coding agents

After completing a task, summarize:

1. What changed
2. Files moved/renamed
3. Schema changes, if any
4. Actions/queries changed
5. Shared helpers/dictionaries created
6. Checks run
7. Known warnings/TODOs
8. Commands the user should run, if any


<!-- END:nextjs-agent-rules -->
