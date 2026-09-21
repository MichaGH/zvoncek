# Wave 4 Part A implementation review partA-R02 — response

Date: 2026-09-21. Answers `partA-R02.md` in this folder. Branch `feature/wave5-workflow-fix`, test database only.
**No schema change, nothing committed or pushed, production not touched.**

| # | partA-R02 finding | Verdict | Fix |
|---|---|---|---|
| 1 | Fallback can be an already-completed system send step | **Valid** | Michal's rules (below), not the reviewer's "CALL + locked representation" wording |
| 2 | Regular email closing the last part uses bare `unlockStep` | **Valid** | As suggested |
| 3 | Partial-send confirmation missing | **Valid** | As suggested |
| 4 | Latest full verification not run | **Valid, release gate** | Partly done — see Checks; the 100-iteration run and delta are still owed |
| 5 | Docs describe pre-fix behaviour | **Valid** | `app-workflow.md`, `operations.md` |
| 6 | No executable production migration | **Valid, not code** | Untouched; branch stays NO-GO |

## 1. System fallback (decision by Michal)

Rules he gave, as built:
- A **manually chosen** pre-task step (Zavolať, Čakáme, custom) stays the fallback as before.
- A **system** step (`SEND_QUOTE` / `SEND_DESIGN` / `SEND_EMAIL`) or no step becomes `CALL` with the note
  "Pokračovať s klientom po odpovedi manažéra" (`helpFallback`, `lib/domain/tasks.ts`). Stored at ask time
  (`createTask`) **and** applied on read (`lockedStepFor`), so tasks created before this fix are covered. HANDOVER tasks
  are unchanged.
- While client-facing work remains, the headline still lists it ("Poslať návrh + cenu + cenník", then "Poslať návrh").
- When only OTHER keeps the task open the list and the detail show **"Čaká na <manažér> – otázka / konzultácia"**
  (`waitingOnQuestionHeadline`, wired into `requestViewOf`), never "Poslať …" or an actionable "Zavolať". The stored
  step is a locked CALL with no date; when the last part closes it unlocks CALL due today.
- The returned OTHER answer is shown on the task card. The visible label of `OTHER` is now "Otázka / konzultácia"
  (`TASK_CONTENT_LABEL` only; project-type "Iné" untouched). A web review as a task part is **not** built — noted as
  BL-14 in `backlog.md` (needs a new enum value).

Tests `w4ReviewR02` (W4A-R02-1), all starting from a real Wave 5 step: `SEND_QUOTE → PRICE + OTHER → price sent →
locked CALL + waiting headline → OTHER resolved → CALL today with the neutral note`; the same from `SEND_DESIGN`; a
still-outstanding INFO keeps `SEND_EMAIL`; a manual `WAITING_FOR_CLIENT` still returns.
Three older expectations encoded the old behaviour and were updated on purpose: W3-4 (decline from a system step now
ends on CALL, not `SEND_QUOTE`), W4-9 (the locked step is the neutral CALL, asserted by "no `Zavolať, či cena prišla`"),
and R02-1 in `w5ManagerSnooze` (now passes the required `snoozeUntil`).

## 2. Email final-part withdrawal

`recordOfferSentAs` no longer calls `unlockStep` before the send is reconciled. Without a follow-up the send is recorded
(fact only) and `stepOnTaskClose` runs afterwards; with a follow-up the requested call wins as before. In the dialog
"Ponechať" now names the step that will really result (post-send outstanding, else the task fallback, "· dnes"), using
the new `openTask.fallbackKind`.
Tests W4A-R02-2 (system fallback / manual CALL / with follow-up): task `CANCELLED`, receipt `SENT`, no `SEND_QUOTE`,
one revision bump, one keyed event, two concurrent identical saves + replay = OK, changed body = conflict.
Not covered: a one-part DESIGN variant of the email withdrawal and a stale-revision case.

## 3. Partial-send confirmation

`OfferSentDialog` has a second stage when the task stays open after the save: "Úloha pre X ostáva otvorená · Posielaš
teraz · X ešte robí · Tvoj krok ostane zamknutý" with "Áno, poslať len …" / "Späť". Same idempotency key, and it chains
after the foreign-deal confirmation. **Not verified in a browser** — a human click-through on phone + desktop is owed.

## 5. Docs

`app-workflow.md`: the manager-help choice is 1–3 parts (Cena · Návrh · Otázka / konzultácia); a correction re-derives
the step only while a task is open; new paragraphs for the step after the task and for the partial-send confirmation.
`operations.md`: `correctRecord` / `correctRecordAs` and the pencil corrected, fallback policy and the new helpers
described. The wave-4 proposal was **not** edited (protected feature file) — it still calls the fallback "the user's own
step" and should get a decision note when Michal next opens it.

## Also done this round (not a review item)

Michal asked for the five "Čo chceli" cards of the pipeline dialog in the `/calls` "Majú záujem" step. They are now one
shared component (`components/shared/OptionCard.tsx`: `OptionCard`, `InfoPanel`, `RequestContentPicker`) used by the
pipeline action sheet and `CallDrawer`: same icons, tone colours and hints, the same "Môžeš vybrať viac možností" note,
equal card heights (`auto-rows-fr`), one column on phone. The first step of the call dialog (with the emoji) is
unchanged. Not verified visually.

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npx eslint .` | only the known `MobileNav.tsx` error |
| `npx next build` | passed |
| `check-concurrency` all wave 3/4/5 tests, `--iterations 20` | 163/166 → the 3 failures were the outdated expectations above; the three tests then re-run: **10/10** |
| `check-concurrency` full, `--iterations 100` | **not run** |
| `check-backfill-delta`, `check-business-time`, `check-client-sections` | not run this round |
| Human click-through (phone + desktop) incl. the new confirmation and `/calls` cards | still owed |
