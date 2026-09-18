# App Workflow

What the app does, in the order people use it. Written for an AI agent picking up work: read this for *behaviour*,
`context/domain/*` for the data and operations that exist today, `context/project-overview.md` for roles, routes and
permissions, `context/architecture.md` for layers, `context/code-standards.md` for the rules you must follow.

**Markers**

- no marker = shipped and verified on the test branch
- `[WAVE 3]` = designed and agreed, **not built**; full design in `context/features/01-salesrep/round2-deal-workspace.md` §2b
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
            → manager completes the request; rep continues, or manager takes the deal over [WAVE 3]
            → after the client's final yes, the deal is handed fully to the manager [WAVE 3]
       → manager completes the sale and may mark WON; a deal may also end LOST
```

The manager may become involved earlier: for example, the rep can request a design or `[WAVE 3]` a technical client
call. The manager can do that work and return the next step to the rep, or `[WAVE 3]` take over the deal. A ticket is
not automatically a transfer of deal ownership.

`[FUTURE ROUTING]` A TELESALES-only caller may later work under a SALES_REP: telesales does the initial call, the rep
owns follow-ups, and the manager receives requests or the final handover. Other combinations may be needed. Today's
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

`[WAVE 3]` every pill gets a count — today only "Na dnes" and "Požiadavky" have one, which makes "Všetko" look empty.

**Layout**: desktop table (`# | Firma | Typ | [Stav] | Ďalší krok | Naposledy | Cena | [Rieši] | akcie`), phone cards.
Every row shows the next step **and** the last contact, e.g. `Naposledy: Nezdvihli · dnes · 3. pokus`, plus small icons
for what the client already has (cenník, cena, návrh) and ⚠ for an old deal whose sends are not verified yet. Row click
opens the action sheet, the `i` icon opens the detail, the phone icon dials.

**Manager-only** (hidden without `deals.manage`, refused server-side regardless): status, owner, project type, WON,
reopen, design & tracker management, resolving tickets, bulk transfer, the unassigned banner.

## 5. Working a deal — the interaction

The action sheet is a drawer on a phone and a dialog on desktop. One interaction is three steps, written in a single
transaction with a revision check and an idempotency key:

1. **Čo sa stalo** — dovolal/a som sa · nezdvihli · odpísali / ozvali sa · bez kontaktu (len naplánovať) ·
   📨 poslali sme ponuku (opens "Čo sme poslali", §5a) · 💬 poslali sme SMS (optional note, then the next step).
   Separate paths park or end the deal: ozvať sa o pár mesiacov (2/4/6 or a date), nemajú záujem, zlé číslo.
   The history records what really happened: a call, a written reply (`CLIENT_REPLIED`), an SMS, or — for "bez
   kontaktu" — only the changed next step. After "dovolal/a som sa" the user can tick **"Povedal/a som cenu"**; the
   price is then recorded as told by phone and the next step defaults to "Poslať cenu" (confirm by email).
2. **Čo povedali** — ešte sa nepozreli · pozreli, chcú zmeny · neprišlo im to · ozvú sa sami · majú poradu ·
   rieši to niekto iný · cena je vysoká · chcú info (o nás, cenník) · chcú konkrétnu cenu · chcú návrh · chcú objednať. The last three are outcomes
   in themselves; the rest pre-fill a next step and a date. The key goes to `Activity.meta.reply`, the label into the note.
3. **Ďalší krok** — zavolať (date required) · čakáme na klienta (date = check day) · poslať CP / email (empty date =
   today) · poslať návrh (in progress) · vlastný krok. The detail's "Ďalší krok" editor additionally offers
   **objednávka – potvrdiť** (`ORDER`); the interaction does not, because "chcú objednať" already sets it together with
   an `ORDER` request. Both lists come from `lib/domain/nextStepOptions.ts`.

**The rule that makes it work: the contact result survives the next step.** "Nezdvihli" is stored as `NO_ANSWER` even
when the user picks something other than the suggested "zavolať ďalší pracovný deň", so a row never loses the fact that
somebody called. The attempt counter counts consecutive non-reverted `NO_ANSWER` calls and resets on real contact
(a call that got through or a written reply). It is only a label; nothing closes a deal automatically.

The sheet also offers: ask the manager, open detail. A closed deal is read-only for the rep,
who can ask for a reopen. A manager can still work on a closed deal and can reopen it in the detail. The same flow
sits on the detail behind "Zaznamenať kontakt".

## 5a. What the client received — "Čo sme poslali"

Every email to the client is an "about us" email; what varies is the attachment: the cenník, a calculated price, or
both, and later a návrh. The app records each send once, in one dialog, opened from the action sheet ("📨 Poslali sme
ponuku", from the list it opens the deal detail with the dialog), from the detail's **Cena & ponuky** card
("Zaznamenať odoslanie"), or from a návrh ("Odoslané…").

- Checkboxes **O nás · Cenník · Cena · Návrh**. Pre-ticked only what was not sent yet ("o nás", "cenník"), "Cena" when
  the next step is "Poslať cenu", a návrh when the step is "Poslať návrh". Any box can be unticked.
- The price sent is **frozen** with its hand-written breakdown; changing the deal's price later does not change what
  the client received, and the card warns "Aktuálna cena sa líši od poslanej".
- The next step is never replaced silently: when the email completes the current "poslať…" step, the dialog offers
  "Zavolať, či prišlo · o 7 dní"; otherwise it offers to keep the current step.
- The manager recording a send on someone else's deal is asked first whether they really sent it.
- **Návrh link:** "Odkaz do emailu" copies a ready link — visible text `smrek1.thegrandpoints.com`, target the
  tracking URL. Nobody opens or builds the tracking link by hand.
- **Mistakes:** "Opraviť" on a history entry (author or manager, with a reason) crosses it out; what the client knows is
  recalculated. The next step and tickets are not touched — the user fixes the next step by hand if needed.
- **Old deals** (sends from before this change): contents are unknown, so the card shows "?" instead of "no" and a ⚠
  panel. The manager fills in what was really sent with its original date ("Doplniť starý záznam" — no next step, no
  ticket change, not shown as "Naposledy") and then confirms "Hotovo – toto je všetko". The "Neoverené" pill lists
  such deals.

`/dashboard/calls` has no SMS or send recording: telesales keep one simple flow.

## 6. Asking the manager — tickets

### 6.1 Today

A rep raises a `DealRequest` (`PRICE`, `DESIGN`, `EMAIL`, `ORDER`, `REOPEN`, `OTHER`); at most one open per (deal, kind)
and a second create appends its note to the open one. `WANTS_DESIGN` and `WANTS_TO_ORDER` create one automatically from
the call outcome. The manager resolves each with the business action that actually does the work (fill the price,
record the send, mark WON, reopen); manual `DONE` exists only for `OTHER`, and declining requires a reason the rep sees.

**Known faults — fixed by `[WAVE 3]`, do not patch ad hoc:**

- the `Požiadavky` pill means "my deals carrying an open request", so a rep sees their own outbox as a to-do list
  ("Požiadavky (4)" after four first calls) and the manager sees nothing until switching the owner filter;
- an open request drags the whole deal into that bucket (`clientSection` → "Čaká na nás") and keeps it there whatever
  else happens on the deal;
- the note is required on the manual path and not on the automatic one.

### 6.2 `[WAVE 3]` The ticket model

**A ticket is a ticket; the next step says where the ball is.**

- `Požiadavky` becomes an **inbox of tickets**, not a filter over deals: kind · deal · who asked · age · text · the
  resolving action, with tabs **Pre mňa / Od mňa / Vybavené**, ignoring the owner filter.
- The deal list stops filtering by open ticket and shows a badge instead.
- The deal parks itself through its next step: `WAITING_FOR_MANAGER` with the reason from the ticket
  ("Čaká na manažéra · návrh"). `clientSection()` loses its open-request rule and the "Na dnes" SQL loses its
  `NOT EXISTS (open request)` clause **in the same commit**.

**Kinds** follow how the work splits — the rep owns the relationship, the manager owns artifacts and technical talks:

| Kind | Meaning |
|---|---|
| `PRICE` | naceň to (the rep is unsure of the price) |
| `DESIGN` | sprav návrh — raised by the deal owner; **no ticket is ever created automatically** (the owner who cannot make designs sees "Požiadať manažéra o návrh") |
| `CALL_CLIENT` | zavolaj im, sú tam technické detaily |
| `HANDOVER` | prevezmi si klienta — after the návrh ("ideme do toho"), or manually at any time |
| `OTHER` | anything else |

`ORDER` disappears as a kind: "áno, ideme do toho" is not an order specification, it is a handover. **WON stays a
manager-only action on the deal.** The note is required only for `OTHER`, pre-filled from the last call note, and both
creation paths go through one function.

**Tickets are a conversation**: the author may edit the text while it is open (logged), both sides append comments, and
age is set at creation and does not reset on edit. Cancelling clears the next step, so the deal resurfaces in "Na dnes"
as "bez ďalšieho kroku".

**Resolving is two switches** — *kto posiela klientovi* (manažér / obchodník) × *kto pokračuje* (obchodník / manažér),
shown as three buttons: "Vrátiť obchodníkovi" · "Vybavil som to sám" (opens "Čo sme poslali" and closes the ticket in
the same save) · "Preberám klienta". For a PRICE ticket the price is typed in the ticket, saved on the deal and posted
into the ticket thread. From wave 3 on no business action closes a ticket silently — only these endings do:

| Ending | Result |
|---|---|
| rep sends, rep continues | rep's next step := "Poslať návrh" |
| manager sends, rep continues | rep's next step := "Zavolať – overiť, či videli návrh" |
| manager sends, manager continues | owner moves to the manager; the ticket closes as "prevzal som si klienta" |

The manager can also take a deal over directly, at any time, with one click and an optional note. **After a takeover the
rep loses access**; a `DealOwnership` record keeps the fact and powers the rep's **História** list
(`prevzaté 18. 9. · Michal` — names and dates only), statistics, and future rep → rep transfers. The transfer asks once
whether to close the deal's open tickets (default yes).

No manager → rep tickets in this wave: work handed back arrives as the rep's next step in "Na dnes".

## 7. Deal detail — `/dashboard/pipeline/[id]`

Wide left column + "Údaje" on the right; one column on a phone with "Údaje" first. Same page for everyone, gated by
capabilities:

- **Požiadavky** — manager: each open request with the action that completes it, and "Zamietnuť" with a reason;
  rep: their requests with the manager's answer, "Zrušiť" on their own, and a new-request form
- **Ďalší krok** — shared editor; day vs exact time, or in progress; a stale tab is refused and refreshed
- **Naposledy** + "Zaznamenať kontakt" + quick events
- **Cena & ponuky** — current price + breakdown, what the client received (o nás · cenník · cena · návrh, with dates,
  "?" on unverified old deals), the price-mismatch warning, "Zaznamenať odoslanie", and for the manager the old-deal
  review panel
- **Návrh** — full management for the manager, confidence summary for the rep; both get "Odkaz do emailu" and
  "Odoslané…"
- **Výsledok** (manager), **História** (rep: business steps; manager: audit too; crossed-out entries stay visible with
  their reason, "Opraviť" on sends / SMS / replies), **Údaje** with diff

## 8. Dashboard — `/dashboard`

Composed by permission: callers see their batch, the queue, callbacks and a calendar; deal owners see their open deals
and what is due; the manager additionally gets "Čaká na mňa" (open requests, oldest first, red past two days),
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
