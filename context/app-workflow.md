# App Workflow

What the app does, in the order people use it. Written for an AI agent picking up work: read this for *behaviour*,
`context/domain/*` for the data and operations that exist today, `context/project-overview.md` for roles, routes and
permissions, `context/architecture.md` for layers, `context/code-standards.md` for the rules you must follow.

**Markers**

- no marker = shipped and verified on the test branch
- wave 3 (manager tasks, step lock, handover, História, pill counts —
  `context/features/01-salesrep/wave-3-task-proposal-final.md`) is **built on the test branch** (2026-09-19); what it
  still owes is listed in `context/progress-tracker.md`
- wave 5 (what the client asked for vs. what they got — `context/features/01-salesrep/wave-5-proposal.md`) is
  **built on the test branch** (2026-09-20); its production data migration is written but **not executed**
  (`context/domain/db-changes.md` §5)
- wave 4 Part A (one manager task with several **parts**, delivered one at a time —
  `context/features/01-salesrep/wave-4-proposal.md`) is **built on the test branch** (2026-09-20), together with its
  two prerequisite fixes (§7 P0 / P1) and Part D's price history (D5). Parts B (notes) and C (order note) are still
  only designed — they wait on Michal's answers to Q5 / Q6. The pre-wave-5 draft is kept as
  `wave-4-proposal-v1-2026-09-19.md` — history, not a plan.
- **implementation order (decision 2026-09-19): wave-3 human checks → wave 5 → wave 4.** The numbers are stable
  feature identifiers, not chronological renames.
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
| **Majú záujem** + a tick per thing they asked for | becomes a deal (`pipelineEnteredAt`), `ACTIVE`, owner selected by current routing, one `LeadRequest` row per tick, next step derived from them |

**What they asked for is a list, not one button** (wave 5). "Majú záujem…" opens the ticks **Info / ukážky · Cenník ·
Konkrétna cena · Návrh · Rozbor webu**; at least one is required, several are normal. Each tick is an event with its
own time, so asking again months later is new work, not a rewritten label. The call outcome is the single value
`INTERESTED` — it says the call went well, never *what* they wanted; the history line shows the contents
("Chceli: Cenník + Konkrétna cena"). The next step follows the ticks: a návrh wins over a price, a price over an
email. The old outcomes `WANTS_QUOTE` / `WANTS_DESIGN` / `WANTS_EMAIL` stay readable in the history and still count as
interest, but no new call writes them.

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

**Status on top, then two composable levels** (a rep's day: call 20 numbers in /calls → *Na spracovanie* to finish what the calls
promised → *Na dnes* for deadlines; a manager uses the same screen for his own deals, and for a telesales caller's
deals when he acts as their rep):

0. **Status** (subtle switch at the very top) — **Aktívne** (default) · Spiace · Vyhraté · Stratené · Nedostupné · Všetky.
   Queues and steps below exist **only for Aktívne**; every other status is a plain list of its deals.
1. **Queue** (big pills with counts, Aktívne only) — (manager) **Pre mňa** · **Čakám na manažéra** │ **Na spracovanie** · **Na dnes**
   · **Všetko**. *Na spracovanie* = open client promises the owner can act on now (after a first call, before the
   manager is asked); *Na dnes* = the day's deadlines; *Čakám na manažéra* = locked by a manager task; *Všetko* = every
   active deal. With no `view` in the URL the screen opens on **Na spracovanie while it is not
   empty, otherwise Na dnes** (`resolveView`); every link the screen builds carries an explicit queue.
2. **Step kind** (chips under the queue, Aktívne only, counts *inside that queue*) — Volať · Poslať cenu · Poslať návrh · Poslať email
   · Čaká na klienta. It **narrows the queue you are in**: *Všetko → Volať* = every deal whose step is Volať, *Na dnes →
   Volať* = whom to call today. It survives switching between queues, and is not offered in *Čakám na manažéra* / *Pre
   mňa* (a locked deal has no step of its own). Old `?view=call` links mean *Všetko + Volať*.
Plus: owner — ja (default) / všetci / nepriradené / a person, and "Od:" (who handed the deal over); search (firma, web,
telefón, email); a rarely used disclosure "Klient už dostal" (Dostali cenník / cenu / návrh) (these views have no
step row; entering them clears any step). **Every count** is computed by the same predicate and filters as its list, so the number matches what a
click shows.

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
for what the client already has (cenník, cena, návrh). Row click
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

- Checkboxes **Info / ukážky · Cenník · Cena · Návrh · Rozbor webu**. Pre-ticked: **only** what the client asked for
  and has not received yet, what the manager returned and nobody sent, and "Cena" / a návrh when that is the current
  step. Nothing is ticked merely because it was never sent before — a first email containing only a návrh must not
  record info and cenník that were not in it (wave 5 review R01-4). Any box can be unticked — unticking needs no
  explanation, the row simply stays outstanding. "Rozbor webu" (what is wrong with their current site) is a full
  content: it can be asked for and sent, and it is usually sent without being asked.
- **A návrh with no `Design` row** (a PDF, a plain link, an old deal): when the deal has no design at all the dialog
  shows one plain "Návrh — bez záznamu v systéme" box. It records `DESIGN` with `untrackedDesign` and no design id,
  satisfies the request, and never touches a `Design.sentAt`. A deal that has a `Design` must use it.
- The price sent is **frozen** with its hand-written breakdown; changing the deal's price later does not change what
  the client received, and the card warns "Aktuálna cena sa líši od poslanej".
- The next step is never replaced silently: when the email completes the current "poslať…" step **and nothing is left
  outstanding**, the dialog offers "Zavolať, či prišlo" (default in 7 days, the day can be changed); otherwise it
  offers to keep the current step and names what is still outstanding.
- **A partial send drops what went out.** The stored step kind then follows the rest (návrh outstanding →
  "Poslať návrh", else price → "Poslať cenu", else "Poslať úvodný email"). Only a step the app chose itself is
  recomputed: a call, "Čakáme na klienta" and a custom step are the user's decision and are never overwritten.
- The manager recording a send on someone else's deal is asked first whether they really sent it.
- **Návrh link:** "Odkaz do emailu" copies a ready link — visible text `smrek1.thegrandpoints.com`, target the
  tracking URL. Nobody opens or builds the tracking link by hand.
- **Mistakes:** "Opraviť" on a history entry (author or manager, with a reason) crosses it out; what the client knows is
  recalculated. Crossing out an **SMS** also crosses out the price that was written in it (same transaction, one
  revision); crossing out only the price leaves the SMS text in the history. On an **unlocked** deal the next step is not touched — the user fixes it by hand if needed. While a manager task is **open** the step is locked and derived, so a correction re-derives it (P6) — the user could not fix it by hand.
- **Old deals** (sends from V1): the one-time conversion turned them into ordinary sends at their original time
  (Info / Info + Cena / Info + Návrh, `.ai/migrations/v1-to-v2-live/02-data-mapping.md`). The history shows each one
  once, labelled "zo starého systému" (the raw V1 row is hidden). **[ROLLOUT]** on production.
- **"Doplniť starý záznam"** (manager, in Cena & ponuky): records a send that happened outside the app with its
  original date — no next step, no task change, not "Naposledy".

### 5b. What the client asked for — "Chceli"

Design: `context/features/01-salesrep/wave-5-proposal.md`. Rules: `lib/domain/clientRequests.ts` (pure),
`lib/domain/requestMutations.ts` (writes), `lib/commands/requests.ts` (the pencil).

- Each ask is a **row with a time** (`LeadRequest`), never a permanent label. The same client asking for the same
  thing again is a new row and new work, even if they received it in June.
- A row is satisfied by a valid `OFFER_SENT` of the matching content whose instant is **not earlier** than the ask.
  An old June price does not satisfy a September ask, and a send backdated to July does not either. A price **heard
  on the phone counts as received** — seeing and hearing an exact amount are the same fact.
- The state is never toggled by hand: every operation that touches asks or sends ends with one reconciliation under
  the `Lead` lock, so a crossed-out send reopens a row only when no other valid send still satisfies it.
- **Outstanding work has three sources**, grouped into one row per content: the client asked and has not received it
  (*treba poslať*), the manager is making it (*robí sa*), the manager returned it and it has not been sent
  (*pripravené*). The checklist, the step headline, the send dialog's pre-ticks, "Požiadať manažéra" and the list all
  read that one grouped set. A returned price therefore keeps holding the step even when nobody asked for it.
- **The headline names the work, the stored kind stays one category.** "Poslať návrh + cenu + cenník" is derived;
  `Lead.nextActionKind` remains `SEND_DESIGN` / `SEND_QUOTE` / `SEND_EMAIL` for pills, filters, sorting and "Na dnes".
- **The warning appears only where the step does not already say it.** "Poslať návrh" covers a návrh and the price
  (a návrh email carries the price), "Poslať cenu" covers the price, "Poslať úvodný email" covers info, cenník and
  rozbor. A rep who deliberately keeps "Poslať cenu" while a návrh is also outstanding sees her own step plus
  "⚠ Chceli návrh – ešte nedostali". A call or "Čakáme na klienta" covers nothing, so everything outstanding warns.
- **The pencil** at "Chcú teraz" (in Cena & ponuky) adds what they now want or withdraws what they no longer want (a short reason is
  required for a withdrawal, and it is shown in the history). Only **open** rows can be withdrawn — a row the client
  already received keeps its link to the send. The pencil never cancels an open manager task; that is "Zmeniť krok
  (zruší úlohu)".
- **The call sheet** says which price the client actually saw: "Klient videl 1 285 € (telefonicky) 22. 9. · aktuálna
  1 400 € ešte neodišla", or "Videl len cenník" / "Klient cenu ešte nevidel".
- **Snoozing or closing from the action sheet** ("Ozvať sa o pár mesiacov", "Nemajú záujem", "Zlé číslo") with open
  asks lists what the client asked for and will not be sent, requires a short reason, and **withdraws every open row**
  in the same save (the sheet sends the exact row ids it showed; the server compares them with what is open now and
  refuses with a refresh if another tab changed them). The history shows "Nepošle sa – …". The same applies to a manager
  **snoozing** the deal in the detail and to a manager closing it as LOST / UNREACHABLE ("Nemajú záujem", the status select): reason required, open
  requests withdrawn by exact id. **WON** leaves them as history (the client ordered) and refuses a withdraw. Reopening opens the deal on the outstanding send step, due today; "Zavolať" only when nothing is
  outstanding — a withdrawn row never comes back by itself.
- **"Pozreli, chcú zmeny" and "Cena je vysoká"** (the two answers where a rep usually needs the manager) offer
  **"Požiadať manažéra"** as the default next step — a custom step due today, and saving it opens the ask dialog
  straight away; a call or "Čakáme na klienta" is still one tap away. "Chcú zmeny" also records a `DESIGN` request
  (they asked for a reworked návrh). Only for the deal's owner, and not while the step is locked by a task.
- **"Poslali sme SMS"** has the same "price given" screen as a call. A price written in the SMS is recorded as an
  `OFFER_SENT` (channel `PHONE`, `via: "SMS"`, linked to the SMS row): it satisfies open price requests and shows as
  "Klient videl … (SMS)". It is never an email and never plans "Zavolať, či prišlo". The next-step screen after an SMS offers
  **"Ponechať aktuálny krok"** (shows the real headline, e.g. "Poslať návrh + cenu"; pre-selected only for a deliberately planned step — a call, waiting, custom — never for a system "Poslať …" step, and not offered at all when the SMS price has just satisfied that send step): only the SMS — and a price in it — is written,
  the step, its date and the status stay, one revision bump (`keepStep`). "Chcú niečo poslať" is deliberately **not**
  available from an SMS: it would overlap with the call/reply path.
- **"Chcú niečo poslať" chooses no step.** After the requests and any price told on the same call are written, the
  server derives the step from what is still outstanding ("Poslať info", "Poslať návrh"…). If the told price covered
  everything they asked for, nothing is left to send and the sheet goes to "Kedy ďalej?" instead.
- Reverting a first call deletes the rows that call created, and is refused when the client already received one of
  them.

`/dashboard/calls` has no SMS or send recording: telesales keep one simple flow.

## 6. Asking the manager — tasks with a step lock

Design, situations and reasons: `context/features/01-salesrep/wave-3-task-proposal-final.md`. Rules in code:
`lib/domain/tasks.ts`, `lib/domain/taskMutations.ts`, `lib/commands/tasks.ts`.

### 6.1 The rep asks

- **"Požiadať manažéra"** (detail task card, or the action sheet) — the rep picks **what she needs: Cena · Návrh ·
  Otázka / konzultácia** (any combination of 1–3 parts, see Wave 4 below), writes a **message for the manager** (only for this task — it never changes the company note or
  the step note) and sends it. The manager is **pre-selected**: the leader of her team, else the manager she asked last;
  "Zmeniť" shows the list of all managers.
- **The next step is not chosen — it follows from what she asked for.** She asks for a price because her step is to
  send a price: Cena → **"Poslať cenu"**, Návrh → **"Poslať návrh"**; the step note stays when the step does not change.
  Otázka / konzultácia → her current step stays; "Zmeniť" lets her pick another (while the task is open the step is locked; a system "Poslať …" step is never restored once its work has gone out — the safe step after the task is "Zavolať", see Wave 4). If an earlier návrh is still waiting to be sent, the
  step is "Poslať návrh" (a návrh carries the price too).
- **Wave 5:** the locked step is derived from **all** outstanding work, not only from what is being asked of the
  manager. A rep who asks for "Iné" on a deal where the client is waiting for a price still gets "Poslať cenu"; a
  price task on a deal whose client wants a návrh is locked on "Poslať návrh" (§5b).
- **Wave 4: one task, several parts.** She ticks **any combination** of Cena · Návrh · Otázka / konzultácia and it stays **one**
  task — one **part** per kind. The manager delivers, declines or withdraws them one at a time (he could not save
  two at once anyway), and the card shows each part's own state. The rep may add a kind to a running task
  ("+ Pridať", with a message the manager reads) or take one back ("Už netreba", with a reason); the rest of the
  task runs on. Parts fill wave 5's *robí sa* / *pripravené* lists and nothing else: a delivered part is
  **prepared**, never **received** — only a valid `OFFER_SENT` means received.
- **The step after the task.** A step the rep chose herself (Zavolať, Čakáme na klienta, a custom one) comes back when
  nothing client-facing is left. A step the **app** had set (Poslať cenu / návrh / email) or no step at all is never
  restored — its work has gone out meanwhile — the safe step is **"Zavolať"** with the note "Pokračovať s klientom
  po odpovedi manažéra", locked while the task is open and due today when it closes. While only the question is
  left the deal reads **"Čaká na <manažér> – otázka / konzultácia"**, never "Poslať …" or an actionable "Zavolať";
  the returned answer stays visible on the task card. A web review for the client is a separate deliverable (a
  future REVIEW task part, not this one).
- **Sending only part** (a returned price while the návrh is still being made) shows a summary first — what is being
  sent, what the manager still makes, what the locked step will be — and needs an explicit "Áno, poslať len …".
- Never created or closed automatically; telesales never create tasks; the manager never asks himself (on his own
  deal it is just his step). At most one open task per deal.

### 6.2 While the task is open

- **The step locks.** It is frozen on the server without a date, and the deal shows "⏳ čaká na …" in **"Čakám na
  manažéra"** — it is actionable nowhere else ("Na dnes", step pills, the dashboard due list). The detail's task card
  shows the request, "Po vybavení: Poslať cenu", and an internal message thread (rep ↔ manager; never a client contact).
- Every real client contact (hers or the manager's) is still recorded and moves "Naposledy" without touching the step.
  A send that overlaps a part the manager is **still making** asks first: let him finish it, or take just that part
  back as no longer needed — the rest of the task keeps running. Sending a part he has already delivered asks
  nothing: that is the ordinary way to get the ready price out while the návrh is still being drawn, and the locked
  step then drops what went out ("Poslať návrh + cenu" → "Poslať návrh") without ever becoming freely replannable.
  Snoozing, closing or replanning cancels the task in the same save — her decision, with a reason, no approval.
  "Zrušiť úlohu…" does the same from the card. A manager cancels a task only by closing the deal.

### 6.3 The manager

- sees the task in **"Pre mňa"** (count on the pill) and **"Čaká na mňa"** on the dashboard (oldest first, red after
  two business days);
- **"Hotovo…"**: he **ticks which parts he is handing over now** and fills only those — the price (saved on the deal
  as well), the návrh, the answer. A pre-filled field is never a decision: an untouched price is not delivered.
  Unticked parts stay open and the step stays locked; when nothing is left, her step becomes due **today**;
- **"Poslal som to sám…"**: the same selection plus the send to the client in one save. "Zavolať, či prišlo" is
  planned **only** when that save closes the task *and* the client is owed nothing else — otherwise the step becomes
  what is still to send ("Poslať info + cenník"), so the deal never tells her to phone about an email that is still
  half-written;
- **"Toto nerobím…"** on one part with a reason, or **"Zamietnuť všetko…"** for everything he still has. A declined
  part says he will not do that piece of work — it never says the client stopped wanting it, so her checklist keeps
  the ask open until the client really gets it;
- **"Presunúť…"** to another manager, or takes the client over. A `HANDOVER` he does not want is
  **"Nie, pokračuj ty…"**.

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
is still pending. Closed tasks stay under "História úloh", still broken down by part.

**A task that ended is "Vybavené" as soon as anything came back**, even if the rest was declined or withdrawn — the
per-part marks tell the whole truth ("cena odovzdaná, návrh zrušený"). There is no "Čiastočne vybavené" state: the
task is closed, and if they need that part again it is a new task. A badge saying "Zrušené" while a delivered price
is still waiting to be sent would be the real lie.

Each returned item keeps its **own** fate: waiting, sent to the client on a date, or deliberately not sent with a
reason. One návrh of two can be sent and the other dropped, and the card says exactly that — a dropped návrh is
never shown as something the client received.

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
- **Cena & ponuky** — current price + breakdown (the pencil opens a small price popup; it sends nothing), "Chcú teraz" (what still
  waits; its pencil corrects what the client wants) beside "Klient dostal" (o nás · cenník · cena · návrh, with dates,
  "?" on unverified old deals), the price-mismatch warning, a history dropdown (past requests, price changes) and for the
  manager the old-deal review panel. "Zaznamenať odoslanie" lives in the action bar under "Ďalší krok · Naposledy"
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

One rule is already fixed (wave 5): **"Čo chceli" counts `LeadRequest` rows, never the call outcome.** The outcome
says only that the call went well, so one call can count in two contents and "only the cenník" is finally countable.
Rows migrated from old data (`origin <> LIVE`) are excluded — they would inflate a period nobody called in.

## 11. Rules that hold everywhere

Business calendar, locking, revision and retry rules: `context/project-overview.md` §5. What a user notices: a stale
tab refuses to save and refreshes itself; a busy row offers "Skúsiť znova".
