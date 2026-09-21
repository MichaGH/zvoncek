# Wave 4 Part A implementation review partA-R03 — response

Date: 2026-09-21. Answers `partA-R03.md` in this folder (kept unchanged as the review record). Branch
`feature/wave5-workflow-fix`, test database only. **No schema change, nothing committed or pushed, production not touched.**

| # | partA-R03 finding | Verdict | Fix |
|---|---|---|---|
| 1 | The detail restyle removed the only UI for correcting "Chceli" | **Valid** — my mistake | Restored: pencil in "Chcú teraz" + the same sheet, same `setClientAsks` command |
| 2 | Partially returned task missing from "Na spracovanie" | **Not a bug** — decision by Michal | Queues stay exclusive while a part is `REQUESTED`; no code change |
| 3 | "Klient už dostal" keeps a hidden step filter | **Valid** | Entering those views clears `step` (as suggested, first option) |
| 4 | "Chcú teraz" shows manager-only work as client intent | **Not a bug** — decision by Michal | Label and behaviour kept; no code change |
| 5 | `operations.md` documents the old flat filter contract | **Valid** | `dealFilters.ts` row rewritten |
| 6 | Live migration still at Phase 0 | **Separate next step** | Not handled in this round, deliberately |

## 1. "Chceli" correction restored

The restyle removed the pencil and its sheet because I judged it a duplicate of receipt correction. It is not: correcting
what the client *asked for* (a `LeadRequest`) and correcting what they *received* (an `OFFER_SENT` receipt) are different
operations, and a wrongly recorded open ask kept driving "Na spracovanie", the send headline and the unsent-work warning
with no way out. `CenovaPonukaCard` again has the pencil (small, in the header of the "Chcú teraz" panel, hidden when the
card is read-only) and the original `ClientAsksSheet`, taken unchanged from the previous version: add what they now want,
withdraw open rows with a required reason, the "manager task stays open" warning, the stale-revision and idempotency
handling. Who may use it is decided by the command, not the UI, so the manager on a rep's deal keeps working.
`revision` is passed to the card again. No new server code.
The existing test `w5Pencil` (W5-8) covers the command: add, withdraw, reason required, a satisfied row refused, foreign
rep `NOT_FOUND`, the same key saves once, changed body = conflict, an open task never cancelled, manager OK. It passed.
Not covered: the sheet itself (no component test exists in this project) — needs the human click-through.

## 2. Partial return and "Na spracovanie" — no change

Michal's decision: the queues are intentionally exclusive while any part is `REQUESTED`; the normal workflow is to wait
for every part and send together; the rare partial send from the detail keeps working and does not need its own queue in
this wave. Documented behaviour already matches (nothing said the deal appears in both). Revisit only if real usage asks.

## 3. Hidden step in the "Klient už dostal" / "Neoverené" views

`NO_STEP_VIEWS` (`lib/domain/dealFilters.ts`) now also holds `got_pricelist`, `got_price`, `got_design`, `unverified`.
`viewAllowsStep` is the single rule used by `parseDealParams`, `dealsHref` and the query's `pillFilter`, so a link into these
views drops the step, a hand-written `?view=got_price&step=call` is normalised the same way, and the list can no longer be
narrower than its displayed count. The step row was already hidden there; nothing changes visually.
Test **W4A-F-5**: from `work`, `today` and `all` with `step=call` into each of the four views, no link contains `step=`;
parsing a hand-made URL clears it; the `got_price` list is the same with and without the stale step and equals the count.
W4A-F-2 no longer loops over `got_price` (it has no step chips any more). Weak spot: in that test's data there are no
"Dostali cenu" deals, so the count/list equality is checked at 0 = 0 — the link/parse assertions are the real proof.

## 4. "Chcú teraz" — no change

Michal's decision: creating PRICE / DESIGN manager work implies a client-facing deliverable the client wants when ready,
so the operational panel may show open requests plus PRICE / DESIGN being made or returned and not yet sent. It is a UI
projection only; "Čo klient pýtal" (in the history dropdown) stays the strict ledger of explicit requests. Label kept.

## 5. Documentation

`context/domain/operations.md`: the `dealFilters.ts` row now describes status → queue → step, `statusHasQueues`,
`AUTO_VIEW` / `resolveView` (default is `auto`, never a raw `today`), `DEAL_STEPS`, which queues drop the step
(including the four above), and `getDealCounts` vs `getDealStepCounts` sharing `pillFilter`. `app-workflow.md`: the extra
views have no step row, the pencil is at "Chcú teraz", and the detail's "Cena & ponuky" / action bar are described as they
are now. The progress tracker has the R03 section and corrects the earlier "UI only" entry that had recorded the removal
as intended. The wave-4 proposal was not edited (protected feature file); its note about the task fallback from R02 is still owed.

## 6. Production migration

Not part of this round; it is a separate next step. Nothing here changes its status or waives any of its gates.

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npx eslint .` | only the known `MobileNav.tsx` error |
| `check-concurrency --only w4aFilterLevels,w3InboxHref,w3LockParity,w1TodayParity,w5Pencil,w5AskAgain,w5ManagerWork --iterations 20` | **14/14** (incl. new W4A-F-5) |
| `check-concurrency` full, `--iterations 100` | **not re-run** after these edits |
| `check-backfill-delta`, `check-business-time`, `check-client-sections`, `next build` | not re-run after these edits |
| Human click-through (phone + desktop): the "Chceli" sheet, partial-send confirmation, `/calls` cards, filter layout, restyled detail | still owed |
