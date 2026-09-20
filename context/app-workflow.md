# App Workflow

What the app does, in the order people use it. Written for an AI agent picking up work: read this for *behaviour*,
`context/domain/*` for the data and operations that exist today, `context/project-overview.md` for roles, routes and
permissions, `context/architecture.md` for layers, `context/code-standards.md` for the rules you must follow.

**Markers**

- no marker = shipped and verified on the test branch
- `[WAVE 4]` / `[WAVE 5]` = agreed direction, **not built** (e.g. one task carrying both a price and a návrh, §6.1)
- wave 3 (manager tasks, step lock, handover, História, pill counts —
  `context/features/01-salesrep/wave-3-task-proposal-final.md`) is **built on the test branch** (2026-09-19); what it
  still owes is listed in `context/progress-tracker.md`
- **planned implementation order (decision 2026-09-19): finish wave-3 human checks → wave 5 → wave 4.** The numbers
  are stable feature identifiers, not chronological renames. Wave 5 is the next design/build; wave 4 Part A is blocked
  until wave 5's remaining-to-send operation is shipped and documented.
- `[ROLLOUT]` = exists in code, still missing in production (production is on the pre-round-1 schema; see
  `context/domain/db-changes.md`)
- `[FUTURE ROUTING]` = desired operating arrangement; its complete team/recipient policy is not yet decided

---

## 1. The funnel

Zvonček is the internal CRM of The Grand Points (web design, small team, one manager = Michal).

```
SCOUT adds a contact → TELESALES or SALES_REP claims and makes the initial call
  ├─ no interest / bad number → closes in the call phase
  └─ interested → becomes a deal in /dashboard/pipeline
       ├─ TELESALES-only caller → manager's pipeline today (or unassigned if routing is unavailable)
       └─ SALES_REP caller → that rep's own pipeline
            → rep continues client communication and can handle a straightforward price / quote / email
            → rep asks the manager for work they cannot do (e.g. price, design)
            → manager delivers it; rep continues, or manager takes the deal over
            → after the client's final yes, the rep hands the deal fully to the manager
       → manager completes the sale and may mark WON; a deal may also end LOST
```

The manager may become involved earlier: the rep can ask for a price, a návrh or something else (a **task**, §6.2).
The manager does that work and the rep continues, or he takes the deal over — on the rep's handover request or on his
own. Asking for work is never a transfer of deal ownership.

`[FUTURE ROUTING]` A TELESALES-only caller may later work under a SALES_REP: telesales does the initial call, the rep
owns follow-ups, and the manager receives tasks or the final handover. Other combinations may be needed. Today's
generic routing can already give a TELESALES caller's deal to an eligible SALES_REP team leader, but that alone does
not define the future operating policy: who leads which team, when the rep retains ownership, and when the manager
takes over are **not decided**. Do not assume the team leader must always be the final owner. Preserve the separate
caller, deal owner and creator fields so this can be designed without changing their meanings.

Two phases, one `Lead` row, three separate responsibility fields — see `context/project-overview.md` §1.

## 2. Adding contacts

`SCOUT` adds contacts in `/dashboard/contacts/new` and sees only their own (`createdById`). They may edit or delete only
untouched ones (NEW, unclaimed, no call history). `SCOUT_LEADER` sees the same for their team plus team statistics.
Callers may also add contacts (`contacts.create`).

The note written here is the first thing a caller reads: the scout's observation about the company
("stránka im občas nejde", "čítal som o nich").

## 3. First calls — `/dashboard/calls`

Used on a phone, standing up, one thumb.

**The queue is personal.** The caller presses "Vziať ďalších 10" and claims a batch from the shared pool
(`claimBatchAs`, `SKIP LOCKED`, batch of 10). Claimed contacts carry `assignedCallerId` while they remain the caller's
call-stage work. A manager transfer, a terminal result, a positive handoff, or account deactivation clears or changes
that assignment. There is no time-based expiry, and nobody else sees assigned contacts in the pool. There is no "someone has this open" lock;
`Lead.lockedById` / `lockedAt` are dead legacy columns.

The board shows: the batch (NEW), retries (`callbackKind = RETRY`), scheduled callbacks (`SCHEDULED`, due first) and
snoozed contacts that woke up.

**One call = one outcome.** Picking up is implicit — if they answered, you click what they want.

| Outcome | Result |
|---|---|
| Nezdvihli | stays with the caller, `CALLING` + `RETRY` |
| Zavolať neskôr | `CALLING` + `SCHEDULED` + date (time optional) |
| Ozvať sa o X mesiacov | `SNOOZED` + date (day only) |
| Nemajú záujem | `LOST`, closed |
| Zlé číslo | `UNREACHABLE`, closed |
| Chcú konkrétnu cenu / Chcú návrh / Chcú info emailom (o nás, cenník) | becomes a deal (`pipelineEnteredAt`), `ACTIVE`, owner selected by current routing, next step pre-filled ("Poslať cenu" / "Poslať návrh" / "Poslať úvodný email") |

**Routing today:** if the caller may own deals (SALES_REP, MANAGER, ADMIN), the caller becomes the owner. Otherwise an
eligible leader of the caller's team becomes the owner; without one, the deal stays unassigned and the manager sees it
in "Nepriradené". Thus today's TELESALES-only employee passes positive calls to Michal through the "Obchod" team,
while a SALES_REP who makes the first call keeps the deal. `[ROLLOUT]` That team and leader must exist in production
for the TELESALES → manager path; otherwise those deals land unassigned. The later TELESALES → SALES_REP arrangement
above is `[FUTURE ROUTING]`, not a claim about current code.

Non-handoff call outcomes never write `nextAction*`. A positive first call enters the deal phase and pre-fills the deal's
next step; deals never use `callback*`.

**History** (`/dashboard/calls/history`): own calls, or everyone's for a manager. A result can be **reverted** only if
nothing touched the lead since (`Activity.leadRevision == Lead.revision`); reverting also undoes the handoff.

**Assignments** (`/dashboard/calls/assignments`, `calls.assign`): who holds how much unfinished work, transfers of call
work, releasing a batch back to the pool, and deactivation (which must end with 0 NEW contacts left on the user).

## 4. The deals screen — `/dashboard/pipeline`

One screen for every role that works deals, under one name: **Pipeline**, in the navbar and in the page title, for the
manager and the rep alike. `/dashboard/clients` and its components were deleted after the merge — the route no longer
exists (404), and nothing links to it.

**Scope** is decided server-side by `dealScope(viewer)`: `all` (`deals.viewAll`), `team` (`deals.viewTeam` — prepared,
no role holds it) or `own`. `?owner=` filters *within* that scope and is validated: a rep passing another user's id is
forced back to themselves. Scope never comes from the path or the URL.

**Filters** (identical for both roles; owner controls render only when the scope can contain other people):

1. owner — ja (default) / všetci / nepriradené / a person · plus "Od:" (who handed the deal over)
2. status — Aktívne (default) · Spiace · Vyhraté · Stratené · Nedostupné · Všetky
3. view pills — (manager) **Pre mňa** · Čakám na manažéra · **Na dnes** (default) · Všetko · Volať · Poslať cenu ·
   Poslať email · Návrh v procese · Čaká na klienta · Dostali cenník · Dostali cenu · Dostali návrh · (manager)
   Neoverené. **Every pill shows a count** computed by the same predicate and filters as its list, so the number
   matches what a click shows
4. search (firma, web, telefón, email)

"Na dnes" is the day's work: due or overdue, woken snoozes, missing next step, missing date, a due check date. Its SQL
mirrors `clientSection()` and a parity test asserts they agree over every open deal. Ordering and paging are done in SQL
over the whole filtered set, 50 rows per page.

**"Pre mňa"** (managers) = open tasks assigned to me, on any owner's deal; the link ignores the owner / status / "Od:"
filters so nothing assigned to me can hide behind them. **"Čakám na manažéra"** = deals in my filter whose step is
locked by an open task ("⏳ čaká na …"); such a deal appears in no step pill ("Na dnes", "Poslať cenu", …) until the
task ends.

**Layout**: desktop table (`# | Firma | Typ | [Stav] | Ďalší krok | Naposledy | Cena | [Rieši] | akcie`), phone cards.
Every row shows the next step **and** the last contact (a real client contact: call, reply, SMS, email we sent —
edits, task messages and back-filled old entries never count), e.g. `Naposledy: Nezdvihli · dnes · 3. pokus`, plus small icons
for what the client already has (cenník, cena, návrh) and ⚠ for an old deal whose sends are not verified yet. Row click
opens the action sheet, the `i` icon opens the detail, the phone icon dials.

**Manager-only** (hidden without `deals.manage`, refused server-side regardless): status, owner, project type, WON,
reopen, design & tracker management, resolving tasks, taking a client over, bulk transfer, the unassigned banner.

## 5. Working a deal — the interaction

The action sheet is a drawer on a phone and a dialog on desktop. One interaction is three steps, written in a single
transaction with a revision check and an idempotency key:

1. **Čo sa stalo** — dovolal/a som sa · nezdvihli · odpísali / ozvali sa · bez kontaktu (len naplánovať) ·
   📨 poslali sme ponuku (opens "Čo sme poslali" in place, §5a) · 💬 poslali sme SMS (optional note, then the next step).
   Separate paths park or end the deal: ozvať sa o pár mesiacov (2/4/6 or a date), nemajú záujem, zlé číslo.
   The history records what really happened: a call, a written reply (`CLIENT_REPLIED`), an SMS, or — for "bez
   kontaktu" — only the changed next step. After "dovolal/a som sa" the user can tick **"Povedal/a som cenu"**; the
   price is then recorded as told by phone and the next step defaults to "Poslať cenu" (confirm by email).
2. **Čo povedali** — ešte sa nepozreli · pozreli, chcú zmeny · neprišlo im to · ozvú sa sami · majú poradu ·
   rieši to niekto iný · cena je vysoká · chcú info (o nás, cenník) · chcú konkrétnu cenu · chcú návrh · chcú objednať. The last three are outcomes
   in themselves; the rest pre-fill a next step and a date. The key goes to `Activity.meta.reply`, the label into the note.
3. **Ďalší krok** — zavolať (date required) · čakáme na klienta (date = check day) · poslať cenu / email (empty date
   = today) · poslať návrh (in progress) · vlastný krok (`lib/domain/nextStepOptions.ts`). Each step carries its own
   short **step note** (pre-filled, e.g. "Poslať cenu"), separate from the contact note. "Chcú objednať" is an ordinary
   reply (default "Zavolať" tomorrow); after saving it the sheet offers "Odovzdať manažérovi" (§6.2).

**The rule that makes it work: the contact result survives the next step.** "Nezdvihli" is stored as `NO_ANSWER` even
when the user picks something other than the suggested "zavolať ďalší pracovný deň", so a row never loses the fact that
somebody called. The attempt counter counts consecutive non-reverted `NO_ANSWER` calls and resets on real contact
(a call that got through or a written reply). It is only a label; nothing closes a deal automatically.

The sheet also offers: "Požiadať manažéra…", open detail. **While a task is open** the sheet records contacts as
facts only (the locked step stays); "bez kontaktu – len naplánovať", snoozing and closing are offered as "(zruší
úlohu)" and cancel the task in the same save, with a reason. A closed deal is read-only for the rep; asking for a
reopen is not built (the rep tells the manager; a later "request" concept is in `context/features/backlog.md`). A
manager can still work on a closed deal and can reopen it in the detail. If the deal's owner has since been
deactivated or can no longer own deals, the reopening manager becomes the owner (recorded as an owner change). The same flow sits on the detail behind
"Zaznamenať kontakt".

## 5a. What the client received — "Čo sme poslali"

The **first offer email** contains "about us"; it may also contain the cenník, a calculated price, or
both. A later offer email may contain only a price or a návrh. Routine correspondence is not tracked here. The app
records each offer send once, in one dialog, opened from the action sheet ("📨 Poslali sme
ponuku" — in place, from the list or the detail), from the detail's **Cena & ponuky** card
("Zaznamenať odoslanie"), or from a návrh ("Odoslané…").

- Checkboxes **O nás · Cenník · Cena · Návrh**. Pre-ticked only what was not sent yet ("o nás", "cenník"), "Cena" when
  the next step is "Poslať cenu", a návrh when the step is "Poslať návrh". Any box can be unticked.
- The price sent is **frozen** with its hand-written breakdown; changing the deal's price later does not change what
  the client received, and the card warns "Aktuálna cena sa líši od poslanej".
- The next step is never replaced silently: when the email completes the current "poslať…" step, the dialog offers
  "Zavolať, či prišlo" (default in 7 days, the day can be changed); otherwise it offers to keep the current step.
- The manager recording a send on someone else's deal is asked first whether they really sent it.
- **Návrh link:** "Odkaz do emailu" copies a ready link — visible text `smrek1.thegrandpoints.com`, target the
  tracking URL. Nobody opens or builds the tracking link by hand.
- **Mistakes:** "Opraviť" on a history entry (author or manager, with a reason) crosses it out; what the client knows is
  recalculated. The next step and tasks are not touched — the user fixes the next step by hand if needed.
- **Old deals** (sends from before this change): contents are unknown, so the card shows "?" instead of "no" and a ⚠
  panel. The manager fills in what was really sent with its original date ("Doplniť starý záznam" — no next step, no
  task change, not shown as "Naposledy") and then confirms "Hotovo – toto je všetko". The "Neoverené" pill lists
  such deals. **[ROLLOUT]** This is the current test behaviour, not the chosen production end state: before rollout,
  old sends will be converted on a duplicate of production, verified, and the permanent "?" layer removed
  (`context/domain/db-changes.md` §3.3).

`/dashboard/calls` has no SMS or send recording: telesales keep one simple flow.

## 6. Asking the manager — tasks with a step lock

Design, situations and reasons: `context/features/01-salesrep/wave-3-task-proposal-final.md`. Rules in code:
`lib/domain/tasks.ts`, `lib/domain/taskMutations.ts`, `lib/commands/tasks.ts`.

### 6.1 The rep asks

- **"Požiadať manažéra"** (detail task card, or the action sheet) — the rep picks **what she needs: Cena · Návrh ·
  Iné** (one choice), writes a **message for the manager** (only for this task — it never changes the company note or
  the step note) and sends it. The manager is **pre-selected**: the leader of her team, else the manager she asked last;
  "Zmeniť" shows the list of all managers.
- **The next step is not chosen — it follows from what she asked for.** She asks for a price because her step is to
  send a price: Cena → **"Poslať cenu"**, Návrh → **"Poslať návrh"**; the step note stays when the step does not change.
  Iné → her current step stays; "Zmeniť" lets her pick another. If an earlier návrh is still waiting to be sent, the
  step is "Poslať návrh" (a návrh carries the price too).
- `[WAVE 5 — NEXT]` The price / návrh / email selection is remade as several things the client asked for versus what
  the client actually received. It supplies the derived combined checklist, partial sending and correction/revival;
  the stored step remains one broad headline used for scheduling and filters. It works with today's one-content task.
  Draft: `context/features/01-salesrep/wave-5-proposal.md` (BL-13).
- `[WAVE 4 — AFTER WAVE 5]` One task will be able to ask the manager for **both** a price and a návrh (any order);
  the manager may prepare one part first and the rep may send that ready subset while the other part is still being
  made. The task contributes manager-work readiness to wave 5's checklist but never becomes the source of client
  intent or proof of sending. Today it is one content per task; sending while it is open already works. Draft, blocked
  pending post-wave-5 re-review: `context/features/01-salesrep/wave-4-proposal.md` §2 (BL-12).
- Never created or closed automatically; telesales never create tasks; the manager never asks himself (on his own
  deal it is just his step). At most one open task per deal.

### 6.2 While the task is open

- **The step locks.** It is frozen on the server without a date, and the deal shows "⏳ čaká na …" in **"Čakám na
  manažéra"** — it is actionable nowhere else ("Na dnes", step pills, the dashboard due list). The detail's task card
  shows the request, "Po vybavení: Poslať cenu", and an internal message thread (rep ↔ manager; never a client contact).
- Every real client contact (hers or the manager's) is still recorded and moves "Naposledy" without touching the step.
  A send that overlaps what the task is producing asks first: keep the task, or cancel it as no longer needed.
  Snoozing, closing or replanning cancels the task in the same save — her decision, with a reason, no approval.
  "Zrušiť úlohu…" does the same from the card. A manager cancels a task only by closing the deal.

### 6.3 The manager

- sees the task in **"Pre mňa"** (count on the pill) and **"Čaká na mňa"** on the dashboard (oldest first, red after
  two business days);
- **"Hotovo…"**: enters the price (saved on the deal as well), picks the návrh, or writes the answer. Her step becomes
  due **today**;
- **"Poslal som to sám…"**: records the result and the send to the client in one save; the rep's step becomes
  "Zavolať, či prišlo" (the day can be changed, the call cannot be switched off — otherwise the deal would still say
  "Poslať…" for something already sent). Only if an older returned price / návrh is still unsent does the step stay
  "Poslať…";
- **"Zamietnuť…"** with a reason (she sees it, her step is unlocked), **"Presunúť…"** to another manager, or takes the
  client over.

### 6.4 What came back

What came back is listed on the task card ("Od manažéra – ešte neposlané klientovi": "Cena 1 285 € · Nikolas · 19.9.")
and on the list row ("✓ cena 1 285 € (od Nikolas)") until the rep deals with each item:

- only the **owner** decides about returned items (on an ownerless deal a manager). A manager recording a call or a
  send on the rep's deal records the fact only; nothing is acknowledged or dropped on the rep's behalf;
- **price / návrh** → "Poslať klientovi…" opens "Čo sme poslali" with the item pre-ticked (the send records which
  result it used), or **"Neposielam…"** with a reason. Until then her step stays "Poslať…", so nothing returned can be
  forgotten;
- **answer / decline** → "Beriem na vedomie".

The manager sees the same items as "Vrátené obchodníkovi – ešte neposlané klientovi". Closing the deal dismisses what
is still pending. Closed tasks stay under "História úloh".

### 6.5 Handover, takeover, owner changes

- **Handover**: the rep asks "Odovzdať manažérovi" (with a note — e.g. what they want to order); her step stays locked.
  The manager accepts ("Preberám klienta…": he becomes the owner, the rep loses access and keeps a line in
  **História**, `/dashboard/pipeline/historia`) or declines ("Nie, pokračuj ty…").
- **Takeover**: the manager takes any deal at any time with his own next step.
- Moving a deal to another rep keeps its task (optionally for another manager); moving it to a manager ends the task —
  an open handover then counts as accepted; leaving it without an owner cancels the task. Bulk transfer does the same
  per deal, in batches of 200, and can be repeated safely.
- **Reopen** is not a task (a later "request" concept, `context/features/backlog.md`). **Deactivating** a user (or a
  role change) is refused while they still own open deals or hold open tasks ("Najprv presuň N obchodov/úloh").

## 7. Deal detail — `/dashboard/pipeline/[id]`

Wide left column + "Údaje" on the right; one column on a phone with "Údaje" first. Same page for everyone, gated by
capabilities:

- **Úloha pre manažéra** — one task card (§6): "Požiadať manažéra…" / "Odovzdať manažérovi…" for the owner-rep;
  the open task (request, locked step, message thread, actions by role); what came back and is not sent yet, with
  "Poslať klientovi…" / "Neposielam…" / "Beriem na vedomie"; closed tasks collapsed under "História úloh"
- **Ďalší krok · Naposledy** — one card, two tiles (what is next with its urgency, the last real contact with
  "N. pokus" and, below it, the last thing we sent — "Odoslané: návrh smrek1 · 15. 9."; the list row and the sheet
  header show the same line), one "Zaznamenať kontakt" button (the action sheet). "Zmeniť krok" opens the same sheet directly at the
  next-step screen, pre-filled, as "bez kontaktu – len naplánovať" (status unchanged). There is no separate step editor
  and no free-note field.
- **Cena & ponuky** — current price + breakdown (the pencil opens a small price popup; it sends nothing), what the
  client received (o nás · cenník · cena · návrh, with dates,
  "?" on unverified old deals), the price-mismatch warning, "Zaznamenať odoslanie", and for the manager the old-deal
  review panel
- **Návrh** — full management for the manager, confidence summary for the rep; both get "Odkaz do emailu" and
  "Odoslané…"
- **Výsledok** (manager), **História** (rep: business steps; manager: audit too; crossed-out entries stay visible with
  their reason, "Opraviť" on sends / SMS / replies), **Údaje** with diff

## 8. Dashboard — `/dashboard`

Composed by permission: callers see their batch, the queue, callbacks and a calendar; deal owners see their open deals
and what is due (locked deals are not "due"); the manager additionally gets "Čaká na mňa" (open tasks assigned to
him, oldest first, red past two days, linking to "Pre mňa"),
"Obchodníci" (per owner: open deals, overdue, follow-ups today, new this week, overdue callbacks, last activity),
"Nepriradené", and "Volajúci" (stale batches, deactivated users still holding work).

## 9. Design tracking

The manager creates a design for a deal; whoever sends it to the client (rep or manager) copies the ready email link
("Odkaz do emailu") and records the send. The deal then shows whether the client really looked at it ("videli to") and
whether they came back after a new version. The rep sees that summary, never the raw tracking link.
Mechanics: `context/project-overview.md` §6.

## 10. Statistics — `/dashboard/stats`

Unfinished; see `context/project-overview.md` §7 before touching it.

## 11. Rules that hold everywhere

Business calendar, locking, revision and retry rules: `context/project-overview.md` §5. What a user notices: a stale
tab refuses to save and refreshes itself; a busy row offers "Skúsiť znova".
