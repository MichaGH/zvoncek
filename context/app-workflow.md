# App Workflow

What the app does, in the order people use it. Written for an AI agent picking up work: read this for *behaviour*,
`context/domain/*` for the data and operations that exist today, `context/project-overview.md` for roles, routes and
permissions, `context/architecture.md` for layers, `context/code-standards.md` for the rules you must follow.

**Markers**

- no marker = shipped and verified on the test branch
- `[WAVE 3]` = designed and agreed, **not built**; full design in `context/features/01-salesrep/wave-3-task-proposal-final.md`
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
            → manager delivers it; rep continues, or manager takes the deal over [WAVE 3]
            → after the client's final yes, the deal is handed fully to the manager [WAVE 3]
       → manager completes the sale and may mark WON; a deal may also end LOST
```

The manager may become involved earlier: the rep can ask for a price or a design (today a request, `[WAVE 3]` a task).
The manager does that work and the rep continues, or `[WAVE 3]` he takes the deal over — on the rep's handover request
or on his own. Asking for work is never a transfer of deal ownership.

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
3. view pills — Požiadavky · **Na dnes** (default) · Všetko · Volať · Poslať cenu · Poslať email · Návrh v procese ·
   Čaká na klienta · Dostali cenník · Dostali cenu · Dostali návrh · (manager) Neoverené; inside Požiadavky, a
   sub-filter by request kind
4. search (firma, web, telefón, email)

"Na dnes" is the day's work: due or overdue, woken snoozes, missing next step, missing date, a due check date. Its SQL
mirrors `clientSection()` and a parity test asserts they agree over every open deal. Ordering and paging are done in SQL
over the whole filtered set, 50 rows per page.

`[WAVE 3]` "Požiadavky" is replaced by **"Pre mňa"** (open tasks assigned to me, any owner) and **"Čakám na
manažéra"** (my deals whose step waits on a task), and every pill gets a count computed by the same predicate as its
list — today only "Na dnes" and "Požiadavky" have one, which makes "Všetko" look empty.

**Layout**: desktop table (`# | Firma | Typ | [Stav] | Ďalší krok | Naposledy | Cena | [Rieši] | akcie`), phone cards.
Every row shows the next step **and** the last contact (a real client contact: call, reply, SMS, email we sent —
edits, requests / tasks and back-filled old entries never count), e.g. `Naposledy: Nezdvihli · dnes · 3. pokus`, plus small icons
for what the client already has (cenník, cena, návrh) and ⚠ for an old deal whose sends are not verified yet. Row click
opens the action sheet, the `i` icon opens the detail, the phone icon dials.

**Manager-only** (hidden without `deals.manage`, refused server-side regardless): status, owner, project type, WON,
reopen, design & tracker management, resolving requests (`[WAVE 3]` tasks), bulk transfer, the unassigned banner.

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
   = today) · poslať návrh (in progress) · vlastný krok (`lib/domain/nextStepOptions.ts`). "Chcú objednať" sets the
   `ORDER` step together with an `ORDER` request; `ORDER` is not offered as a choice. `[WAVE 3]` "Chcú objednať"
   becomes an ordinary reply with a chosen next step; the `ORDER` step and request disappear, and handing the client
   over is a separate, explicit action.

**The rule that makes it work: the contact result survives the next step.** "Nezdvihli" is stored as `NO_ANSWER` even
when the user picks something other than the suggested "zavolať ďalší pracovný deň", so a row never loses the fact that
somebody called. The attempt counter counts consecutive non-reverted `NO_ANSWER` calls and resets on real contact
(a call that got through or a written reply). It is only a label; nothing closes a deal automatically.

The sheet also offers: ask the manager, open detail. A closed deal is read-only for the rep,
who can ask for a reopen (`[WAVE 3]` removed with the requests: the rep tells the manager; a later "request" concept is
in `context/features/backlog.md`). A manager can still work on a closed deal and can reopen it in the detail. The same flow
sits on the detail behind "Zaznamenať kontakt".

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
  recalculated. The next step and requests are not touched — the user fixes the next step by hand if needed.
- **Old deals** (sends from before this change): contents are unknown, so the card shows "?" instead of "no" and a ⚠
  panel. The manager fills in what was really sent with its original date ("Doplniť starý záznam" — no next step, no
  request change, not shown as "Naposledy") and then confirms "Hotovo – toto je všetko". The "Neoverené" pill lists
  such deals. **[ROLLOUT]** This is the current test behaviour, not the chosen production end state: before rollout,
  old sends will be converted on a duplicate of production, verified, and the permanent "?" layer removed
  (`context/domain/db-changes.md` §3.3).

`/dashboard/calls` has no SMS or send recording: telesales keep one simple flow.

## 6. Asking the manager

### 6.1 Today (round-1 requests, replaced by `[WAVE 3]`)

A rep raises a `DealRequest` (`PRICE`, `DESIGN`, `EMAIL`, `ORDER`, `REOPEN`, `OTHER`); at most one open per (deal, kind)
and a second create appends its note to the open one. `WANTS_DESIGN` and `WANTS_TO_ORDER` create one automatically from
the call outcome. The manager resolves each with the business action that actually does the work (fill the price,
record the send, mark WON, reopen); manual `DONE` exists only for `OTHER`, and declining requires a reason the rep sees.

**Known faults — fixed by `[WAVE 3]`, do not patch ad hoc:**

- the `Požiadavky` pill means "my deals carrying an open request", so a rep sees their own outbox as a to-do list
  ("Požiadavky (4)" after four first calls) and the manager sees nothing until switching the owner filter;
- an open request drags the whole deal into that bucket (`clientSection` → "Čaká na nás") and keeps it there whatever
  else happens on the deal, while the rep can still edit a step nobody sees;
- the note is required on the manual path and not on the automatic one;
- requests are created and closed automatically, behind the user's back.

### 6.2 `[WAVE 3]` Manager tasks with a step lock

Design, situations and reasons: `context/features/01-salesrep/wave-3-task-proposal-final.md`. In short:

- **A task** = the rep asks the manager for a **price**, a **návrh** or something else ("Iné"); price and návrh needed
  together are one task; at most one open task per deal. Never created or closed automatically; telesales never create
  tasks; the manager never asks himself (on his own deal it is just his step).
- **The step locks.** When asking, the rep chooses what she will do when the manager delivers ("Poslať cenu", "Poslať
  návrh", any step); that step is frozen on the server (without a date) while the task is open, and the deal shows
  "⏳ čaká na Michala" in **"Čakám na manažéra"** — actionable nowhere else. Every real client contact (hers or the
  manager's) is still recorded and moves "Naposledy" without touching the step. A send that overlaps what the task is
  producing asks first: keep the task, or cancel it as no longer needed. Snoozing, closing or replanning cancels the
  task in the same save — her decision, no approval.
- **The manager** sees the task in **"Pre mňa"** (and "Čaká na mňa" on the dashboard), exchanges short internal
  messages ("Posledná správa: Jana"), and finishes it with the price (saved on the deal), the návrh or an answer — the
  rep's step becomes due at once. What came back is shown as "✓ cena 1 285 € · ✓ návrh Variant A (od Michala)" until
  she sends it through "Čo sme poslali" (the send records which result it used) or says "Neposielam" with a reason —
  until then her step stays the send step, so nothing returned can be forgotten. He
  can also send it himself, decline with a reason (her step stays), reassign the task to another manager, or take the
  client over.
- **Handover**: the rep asks "Odovzdať manažérovi" (with a note — e.g. what they want to order); the manager accepts
  (he becomes the owner, the rep loses access and keeps a **História** line) or declines. **Takeover**: the manager
  takes any deal at any time. Moving a deal to another rep keeps its task; moving it to a manager ends the task — an
  open handover then counts as accepted. Bulk transfer keeps its batches of 200.
- **Reopen** is not a task (a later "request" concept, `context/features/backlog.md`); **deactivating** a user (or a
  role change that removes deal or task work) is refused while they still own open deals or hold open tasks.

## 7. Deal detail — `/dashboard/pipeline/[id]`

Wide left column + "Údaje" on the right; one column on a phone with "Údaje" first. Same page for everyone, gated by
capabilities:

- **Požiadavky** — manager: each open request with the action that completes it, and "Zamietnuť" with a reason;
  rep: their requests with the manager's answer, "Zrušiť" on their own, and a new-request form. `[WAVE 3]` replaced by
  one **task card**: the open task with its messages and actions, closed tasks with their results (§6.2)
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
and what is due; the manager additionally gets "Čaká na mňa" (open requests, oldest first, red past two days;
`[WAVE 3]` open tasks assigned to him),
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
