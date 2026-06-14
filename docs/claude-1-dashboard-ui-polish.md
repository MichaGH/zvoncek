# Dashboard UI polish + Pipeline UX cleanup

Read `<span>AGENTS.md</span>` first.

This task is focused on dashboard layout consistency, pipeline table behavior, search/pagination preparation, and improving `<span>/dashboard/pipeline/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span></span>`.

Do not rename Prisma model `<span>Lead</span>`.
Do not change database schema unless absolutely necessary.
Do not change the core business workflow unless required to fix the UI issues below.
Preserve existing behavior for:

* `<span>/dashboard/calls</span>`
* `<span>/dashboard/calls/history</span>`
* `<span>/dashboard/pipeline</span>`
* `<span>/dashboard/pipeline/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span></span>`

## Project context

This is an internal CRM/calling dashboard for a small webdesign company.

Main dashboard views:

* `<span>/dashboard/calls</span>` = marketing call queue
* `<span>/dashboard/calls/history</span>` = history of marketing call work
* `<span>/dashboard/pipeline</span>` = manager/developer view of active opportunities
* `<span>/dashboard/pipeline/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span></span>` = full detail/edit view of one opportunity
* future `<span>/dashboard/contacts</span>` = master contact database

The app already works functionally. This task should improve consistency and UX without overengineering.

## 1. Create consistent dashboard page layout

Currently, dashboard pages have inconsistent vertical spacing/header positions. For example, the heading on `<span>/dashboard/calls</span>` and `<span>/dashboard/pipeline</span>` starts at different vertical positions, so switching between pages feels jumpy.

Create or refactor a reusable dashboard page layout/header component.

Suggested component names:

* `<span>DashboardPage</span>`
* `<span>DashboardPageHeader</span>`
* `<span>DashboardPageTitle</span>`
* or similar

Possible location:

* `<span>components/dashboard/DashboardPageHeader.tsx</span>`
* or `<span>components/layout/DashboardPageHeader.tsx</span>`

Use whatever fits the current project structure.

The layout should support:

* consistent max-width
* consistent horizontal padding
* consistent top/bottom spacing
* title
* optional subtitle/description
* optional right-side actions
* optional secondary content below title, such as tabs/search

Example usage concept:

```
<DashboardPageHeader
    title="Volania"
    description="Prvý kontakt s firmami."
    actions={...}
/>
```

```
<DashboardPageHeader
    title="Pipeline"
    description="Firmy, ktoré sa posunuli do reálneho riešenia."
    actions={...}
/>
```

The important goal:

* page title should not jump vertically between dashboard pages
* the working content below the header should start consistently
* right-side buttons like History / Refresh should have a stable place in the header

## 2. Header action area

The header should have a clean right-side action area.

Examples of actions:

* Refresh
* History
* New item later
* Import later
* Other page-specific actions later

For `<span>/dashboard/calls</span>`:

* keep existing History action
* keep or add refresh if currently present
* place them in the new consistent header action area

For `<span>/dashboard/pipeline</span>`:

* add a Refresh button in the same header action area
* keep the design simple, clean, and consistent with `<span>/dashboard/calls</span>`

Do not make the header visually heavy.

## 3. Pipeline list/table layout stability

The `<span>/dashboard/pipeline</span>` table currently changes width/layout depending on the selected tab/filter. This causes the UI to shift, including the title/section area.

Fix this.

Requirements:

* pipeline page should have stable width/container
* table should not shrink/grow wildly depending on content
* changing tabs should not move the main page title or overall layout
* use stable table layout where appropriate
* use truncation, fixed/min column widths, or responsive wrappers as needed
* keep it readable on desktop
* do not over-optimize mobile yet, but do not break it

If using a table:

* consider `<span>table-fixed</span>`
* wrap in a stable `<span>overflow-x-auto</span>` container
* set sensible widths for key columns
* truncate long notes/next actions instead of letting them stretch the table

## 4. Pipeline filters: lost vs unreachable

We have two different “bad/red” outcomes:

1. Not interested
   * business result: they do not want it
   * usually `<span>Lead.status = LOST</span>`
2. Bad/unreachable number
   * number is wrong / broken / unreachable
   * usually `<span>Lead.status = UNREACHABLE</span>`

These are conceptually different and should not be merged as one vague red state.

Update pipeline filters/tabs/labels so this distinction is clear.

Suggested tabs:

* Active
* Snoozed
* Won
* Lost
* Unreachable
* All

Use Slovak UI labels if the surrounding UI is Slovak, for example:

* Aktívne
* Odložené
* Vyhrané
* Stratené
* Nedostupné
* Všetky

Do not change enum names unless already required by existing schema.

## 5. Search bar + pagination preparation

Add a search bar to `<span>/dashboard/pipeline</span>`.

It should search by existing fields such as:

* company name
* website
* phone
* maybe email if currently selected/available

Use URL search params if the existing code already uses that pattern.

Example:

* `<span>/dashboard/pipeline?q=autoservis</span>`
* keep the selected filter tab when searching
* keep search value visible in the input

Pagination / load more:

* prepare the query/UI for loading more records later
* for now, it is OK to use a simple limit like 50
* if there is already a “load more” pattern in the project, reuse it
* do not build a complex pagination system now unless easy
* it is acceptable to add a clear TODO in code/final summary

Goal:

* the page should be ready for “show next 50” later
* do not overbuild full pagination yet

## 6. Improve `<span>/dashboard/pipeline/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span></span>` page layout

The detail page currently looks useful but visually messy. The style is okay, but the layout/structure should be improved.

Problems to fix:

* page heading starts at different vertical position than other pages
* it is not immediately obvious that this page belongs to Pipeline
* next action UI is too stretched / awkward
* next action note persists in a confusing way when saving a new next action
* business action buttons feel visually awkward
* “custom business note” is unclear
* sections feel randomly arranged

Refactor `<span>/dashboard/pipeline/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span></span>` to use the same dashboard page header style.

The header should show:

* back link to Pipeline
* title: company name / website / fallback
* small identifier like `<span>#number</span>`
* current status badge
* optional phone call button if phone exists

Make it clear that this is a Pipeline detail page.

Suggested page structure:

### A. Overview / Current status card

Show the most important current information:

* status
* owner
* current next action
* phone/email/website quick info

### B. Next action card

This should be a dedicated, clear section.

It should allow:

* choosing next action kind:
  * Call
  * Send quote
  * Send design
  * Send email
  * Waiting for client
  * Custom
* choosing date/time if relevant
* writing note
* saving
* clearing the current next action

Important UX requirement:

* If the user is setting a new next action, do not accidentally keep an old note as if it belonged to the new action.
* Either:
  * explicitly show current next action separately from the edit form,
  * or add a clear “Clear” button,
  * or reset the edit form after save,
  * or make the UI clearly indicate that the note currently shown is the saved current next action.
* Avoid the current confusing behavior where old note text stays and must be manually deleted without clarity.

### C. Business actions card

These are actions that mean something was completed or happened.

Examples:

* Quote sent
* Design sent
* Email sent / about us sent
* Add business note
* Waiting for client / client promised something
* Client did not send materials / no response

These should create BUSINESS activities according to the current app logic.

Do not make these buttons visually ugly or randomly placed.
Use a clean compact layout.

Important:

* “Custom business note” should be renamed/explained better.
* A better label could be:
  * “Pridať obchodnú poznámku”
  * “Zaznamenať krok”
  * “Zaznamenať udalosť”
* It should be clear that this adds an item to business history.
* It is independent from quote/design/email being sent.
* It is for real-world custom cases like:
  * “Klient sľúbil poslať podklady”
  * “Podklady neprišli”
  * “Návrh si ešte nepozreli”
  * “Máme sa ozvať po porade”

If possible, allow adding a business note and optionally setting a next action afterwards, but do not overbuild.

### D. Contact / deal details card

Editable fields:

* company name
* website
* phone
* email
* note
* price
* price note
* design URL

Keep this section usable but not dominant.

### E. History card

Show business history clearly.

If planning/audit activities exist, either:

* show them separately,
* or behind a simple section/toggle,
* or keep current behavior if already working and mention TODO.

Important:

* Pipeline “last step” should come from latest BUSINESS activity, not planning/audit.
* Do not let audit edits like phone changes become the last business step.

## 7. Activity and next-action behavior

Do not redesign the full activity system in this task unless the current code already supports it.

But when touching pipeline queries/components, preserve this concept:

* Last step = latest BUSINESS activity
* Next step = current Lead next action fields
* Planning/audit activities should not become last step

If the current schema/actions already support:

* `<span>ActivityCategory</span>`
* `<span>ActivitySource</span>`
* `<span>NextActionKind</span>`

then use them properly.

If they do not exist yet, do not do a schema refactor in this UI task unless absolutely necessary. Mention what should be done later.

## 8. Refresh behavior

Add/keep refresh actions where useful.

For pages:

* `<span>/dashboard/calls</span>`
* `<span>/dashboard/pipeline</span>`

Refresh can simply call `<span>router.refresh()</span>` from a small client button component.

If a reusable component makes sense, create it:

* `<span>RefreshButton</span>`
* `<span>DashboardRefreshButton</span>`

Do not over-abstract.

## 9. Keep UI style consistent

Use existing design language:

* shadcn/ui
* Tailwind
* clean spacing
* simple cards
* readable tables
* subtle muted text
* no overdesigned gradients
* no excessive decoration

This is an internal dashboard, not a marketing landing page.

## 10. Do not over-refactor

Do not rewrite the entire app.

Do not rename Prisma model `<span>Lead</span>`.

Do not move unrelated features.

Do not build `<span>/contacts</span>` now.

Do not change auth behavior.

Do not change role/permission behavior.

Focus on:

* consistent dashboard layout/header
* pipeline table stability
* pipeline filters/search
* pipeline detail layout/UX
* minor reusable components only where obvious

## 11. Checks

After implementation:

* run available TypeScript/lint/build checks from package scripts
* fix broken imports
* fix route links
* make sure these compile:
  * `<span>/dashboard/calls</span>`
  * `<span>/dashboard/calls/history</span>`
  * `<span>/dashboard/pipeline</span>`
  * `<span>/dashboard/pipeline/<span data-placeholder-token="true" class="text-token-text-primary cursor-text rounded-sm">[id]</span></span>`

## Final summary

At the end, summarize:

1. Layout/header changes
2. Pipeline table changes
3. Pipeline filters/search changes
4. Pipeline detail page changes
5. Reusable components created
6. Activity/next-action behavior preserved or changed
7. Checks run
8. Any TODOs left for later
