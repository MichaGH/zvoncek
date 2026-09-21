# UI Context

Conventions for building screens here. Behaviour lives in `context/app-workflow.md`.

## 1. Two form factors, one component

- **Phone** is the primary device for `/dashboard/calls` (one thumb, standing up). **Desktop** is primary for the deals
  screen. Primary working lists (call queue, contacts, pipeline) use two layouts from one data source: a table at `md`
  and up (`hidden md:block`) and cards below (`md:hidden`). This is not a claim about every admin or assignment list.
  Shared cell content lives in small sub-components so formatting changes hit both.
- **Sheets/modals**: always `components/shared/ResponsiveSheet.tsx` — vaul drawer below `md`, Radix dialog from `md` up.
  Never open a bare `Drawer` for new UI. `data-vaul-no-drag` and `repositionInputs` are vaul-only and are ignored in the
  dialog branch; the first paint is always the drawer branch so hydration stays stable.

## 2. Components

- shadcn/ui from `components/ui/*`; add a primitive there in the same style rather than inlining Radix.
- Icons: `lucide-react`. Standard meanings: `Pencil` edit, `Trash2` delete, `Lock` locked, `Phone` dial, `Info` detail.
- Icon-only buttons: `variant="ghost"` with `size="icon"` (or equivalent tight ghost styling).
- Toasts: `sonner`. Success is short; failures carry the server message, and retryable failures carry a "Skúsiť znova"
  action that reuses the same idempotency key.
- Keep the shared dashboard layout components in `components/dashboard/DashboardPage.tsx`.

## 3. Inputs

- Call/deal scheduling forms use native `date` / `time` inputs, `text-[16px]` (prevents iOS zoom) and
  `[color-scheme:light_dark]` (visible icon in dark mode). They call `showPicker()` on click so a desktop click
  anywhere in the field opens the calendar; this does not describe every date filter in the app.
- Scheduling dates and times travel to the server as `YYYY-MM-DD` / `HH:mm` inside a `Schedule`; never send a `Date`.
- Inside a drawer, interactive fields need `data-vaul-no-drag`.

## 4. Language and labels

- UI is Slovak, including Slovak typographic quotes („ ") — in `.tsx` string literals close them with the typographic
  character, not `"`, or the JSX string breaks.
- General labels come from `lib/dictionaries.ts` (`STATUS_LABEL`, `NEXT_ACTION_LABEL`, `OUTCOME_LABEL`,
  `TASK_CONTENT_LABEL`, `TASK_STATUS_LABEL`, …); pipeline section labels come from `lib/domain/clientSections.ts` (`CLIENT_SECTION_LABEL`).
  Never hardcode a label that already exists in either place.
- Dates are rendered in business time: `timeZone: BUSINESS_TZ`, or the helpers in `lib/domain/businessTime.ts`
  (`businessDayMonth`, `businessHm`). Relative wording ("Dnes", "Zajtra", "Včera") comes from `businessDaysBetween`.
- Urgency uses the shared `components/shared/UrgencyLabel.tsx` + `lib/overdue.ts`; do not invent a second colour scale.

## 5. Rules of thumb

- Row click = act (open the action sheet). An explicit icon = navigate (`i` → detail, phone → dial). Navigation icons
  are real `<Link>`s so ctrl-click works; they `stopPropagation` so they do not trigger the row action.
- A list row shows both **what is next** and **what happened last** — never only one.
- Capability props decide what renders; they are never the permission check.
- A design's tracking URL is never rendered as a link or shown for reading; it is only copied, ready for an email, with
  `components/shared/copyEmailLink.ts`.
- The call queue and pipeline deal list currently auto-refresh (`router.refresh()` on an interval) because urgency
  ages in real time; do not assume every list does.
- Filter state lives in the URL through `lib/domain/dealFilters.ts` (`parseDealParams` / `dealsHref`), so links and the
  server query cannot disagree. Changing a filter resets paging.
- Filter pills with a count compute it with the same predicate and filters as the list, so the number matches what a
  click shows. On the pipeline **every pill has a count** (wave 3): one predicate per pill (`pillFilter` in
  `lib/queries/pipeline`), shared by `getDealList` and `getDealCounts` (`COUNTED_VIEWS`). A new pill gets its count
  from the same predicate, never from a second query written by hand. The pipeline filter has status on top, then two composable levels
  (queue → step kind, only for Aktívne; `components/pipeline/DealFilters.tsx`); the step chips count inside the current queue
  (`getDealStepCounts`), which is why `step` is a separate parameter and not another pill.
- Dialog forms (e.g. `AskManagerDialog`, `FinishTaskDialog`): small uppercase section labels, one decision per
  section, a derived value shown as text with "Zmeniť" instead of an always-open picker, the primary button's label
  stays stable and the reason it is disabled is shown under it. Slovak names are not declined in labels — write
  "Odoslať – Nikolas", not a hand-built dative.
