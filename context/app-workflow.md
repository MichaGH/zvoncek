# Zvonček: how the CRM is used

Business map of the app for coding agents. `AGENTS.md` is the short operational guide; this file explains who
does what, in which order, and which data represents it.

Markers:
- no marker = implemented in code
- **[ROLLOUT]** = implemented in code, but the production database still needs the approved rollout (schema push + backfill,
  `context/new-feature/planning.md` §14) before it is true in production
- `context/new-feature/planning.md` (rev. 4) is the design source for caller assignment, SALES_REP, the deals screen and
  manager requests; `context/progress-tracker.md` lists what shipped and every deviation from the plan.

Last reviewed: 2026-09-17 (after implementing plan rev. 4 on the test database).

---

## 1. The company and the funnel

The Grand Points is a small web design company. Zvonček finds companies with weak or missing websites, calls
them, and turns interested ones into web projects (website, e-shop, catalog, web app).

End-to-end responsibility:

```text
SCOUT adds contact (lands in the shared pool)
  → caller takes a batch and makes the FIRST CALL (TELESALES or SALES_REP)
      no answer / call me later / snooze  → stays in the caller's own call work
      not interested / bad number         → closed (LOST / UNREACHABLE)
      interested (quote / email / design) → HANDOFF → becomes a DEAL with an owner
  → deal OWNER does FOLLOW-UPS (send quote/email, call a week later, repeat)
      design proposal wanted → DESIGN request → manager/technician (Michal) builds and sends it
      client says no         → LOST
      client goes ahead      → ORDER request → manager sets WON
```

Real sales rhythm: first call → send what the client asked for (price, about-us email, design) → call about a week
later to check they received it → repeat until yes or no. The goal is always to get the client to want a design proposal.

---

## 2. People and roles

| Role | Who (2026-09) | Job |
|---|---|---|
| `SCOUT` | Jano, Lukáš, Miloslav | Search online databases and add contacts |
| `SCOUT_LEADER` | Šimon | Leads a team of scouts; also adds contacts; checks the team's output (for pay) |
| `TELESALES` | Timea | First calls only. Positive results are routed to someone else (team leader) |
| `SALES_REP` ("Obchodník") | not hired yet | First calls **and** follow-ups on their own deals until closed |
| `MANAGER` | Nikolas | Observer with global access; also adds many contacts. Nothing is built specifically for him |
| `ADMIN` | Michal | The actual business manager and technician: builds designs, sets prices, resolves requests, manages users and teams. Owner of historical deals **[ROLLOUT]** |

The code checks **permissions**, never roles (`lib/permissions.ts`, `can(user, permission)`).
Treat "manager" in business text as "a user with `deals.manage`" (Michal, Nikolas).

Authorization reads the **current DB user** (role + deactivation) via `requireUser()` on every dashboard page and server
action, not only the login token. A deactivated user's session stops working immediately (pages redirect to
`/login?deactivated=1`, actions return `UNAUTHENTICATED`).

---

## 3. Lead lifecycle and data meaning

One Prisma model, `Lead`, carries a contact from creation to close. Never rename it.

| Status | Call stage | Deal stage |
|---|---|---|
| `NEW` | added, never called (pool or a caller's batch) | — |
| `CALLING` | no answer (`callbackKind RETRY`) or agreed callback (`SCHEDULED`) | — |
| `SNOOZED` | "call us in a few months" after a first call | deal paused until a date |
| `ACTIVE` | — | deal being worked |
| `WON` | — | client goes ahead |
| `LOST` | not interested on the first call | lost deal |
| `UNREACHABLE` | bad number on the first call | deal became unreachable |

`SNOOZED`, `LOST` and `UNREACHABLE` exist in both stages, so status alone does not tell the stage.
`Lead.pipelineEnteredAt` decides it: `null` = call stage, set = deal. It is set at handoff (= `createdAt` of the positive call)
and cleared only by reverting that call. Invariant: `status NEW` ⇒ no CALL activity.

Responsibility fields:

| Field | Meaning |
|---|---|
| `createdById` | who added the contact (scout statistics and pay). Never used for call or deal responsibility |
| `assignedCallerId`, `assignedCallerAt` | who is responsible for the call-stage work on this contact (`null` = pool / not in call stage) |
| `ownerId` | who is responsible for the deal. Set at handoff by routing; `null` = "Nepriradené" (manager assigns) |
| `handedOffById` | who made the positive call |
| `closedAt` | deals only: when the deal became WON/LOST/UNREACHABLE; `null` while open |
| `revision` | optimistic version; +1 exactly once per business transaction touching the lead |
| `Activity.userId` | who actually did an action (history, statistics). Never rewritten |
| `lockedById`, `lockedAt` | unused legacy placeholders. Do not build on them |

Scheduling fields are deliberately separate:

- Call stage: `callbackKind`, `callbackAt`, `callbackHasTime`, `callbackNote`
- Deal stage: `nextActionKind`, `nextActionAt`, `nextActionHasTime`, `nextActionMode`, `nextActionNote`

Call-stage outcomes never write `nextAction*`.

`*HasTime = false` means the client gave only a day → day-level labels. `true` means an exact time → exact-time urgency.
`nextActionMode IN_PROGRESS` means work in progress (e.g. a design being built) → "trvá X dní", not a deadline.

**Business calendar:** every "day" rule (today, tomorrow, +7 days, next working day, overdue by day, "Na dnes") is computed
in **Europe/Bratislava** (`lib/domain/businessTime.ts`), independent of server or browser time zone. Day-only dates are stored
as 00:00 Bratislava and compared by business date; exact times are instants. Browsers send dates as `YYYY-MM-DD` / `HH:mm`
(`Schedule`, `lib/domain/schedule.ts`). Shared display logic: `lib/overdue.ts`, `components/shared/UrgencyLabel.tsx`.
Statistics (`/dashboard/stats`) still bucket days in server-local time (not part of this change).

Activity log (`Activity`): `category` BUSINESS (client story), PLANNING (next action changes), AUDIT (data edits, status/owner
changes, assignment moves, reverts); `source` CALL_QUEUE (first calls), CLIENTS (rep actions), PIPELINE (manager), CONTACTS,
ADMIN. Helpers in `lib/activityLog.ts`.

---

## 4. SCOUT and SCOUT_LEADER

Pages: `/dashboard/contacts`, `/dashboard/contacts/new`, `/dashboard/stats` (leader).

- A contact needs a company name or website, plus a phone. Websites are normalized. A duplicate phone is rejected; users with
  contact-list access see the existing contact's number and name, callers (without it) only a generic message.
- A new contact always lands in the shared pool, unassigned (also when a caller adds it).
- SCOUT sees only contacts they created (`createdById`, enforced server-side).
- SCOUT_LEADER sees contacts and statistics of their team (the team they lead + members), via `getTeamScopeForLeader`.
- Edit/delete is allowed only while the contact is untouched: `NEW`, not claimed by any caller, and without call history.
  Checked inside the write transaction under the lead lock (a claim can happen at the same moment).
- Delete is a soft delete (`deletedAt`).

Teams (`Team`, `/dashboard/admin/teams`): one leader, members; a user is a member of max one team and leads max one.
Teams are role-neutral. Teams also **route deals**: see 5.2.

---

## 5. First calls: `/dashboard/calls`

Used by TELESALES, SALES_REP, and managers when they call. Opening the page never changes anything.

### 5.1 Personal queue

- **Nové firmy (dávka)**: the caller clicks **"Zobrať ďalších N"** to claim up to 10 (`CLAIM_BATCH_SIZE`) never-called NEW
  contacts from the shared pool. The button appears only when their batch is empty; they must call the whole batch first
  (10 → 10 → 10). The header shows only the aggregate pool count ("Voľných v spoločnej fronte").
- **Dohodnuté hovory**: the caller's agreed callbacks.
- **Skúsiť znova**: the caller's no-answer retries (paginated by 50).
- **Spiace**: the caller's call-stage snoozes.
- Retries, callbacks and snoozes stay with the caller who has them, because clients call back the person who rang them.
- Claims never expire and nothing moves automatically. When someone is on holiday or leaves, the manager moves their work
  in `/dashboard/calls/assignments` (5.4).

The page refreshes itself every 60 seconds.

### 5.2 Call drawer outcomes (transitions in `lib/domain/leadFlow.ts`, action `logCall`)

| Button | Outcome | Result |
|---|---|---|
| Majú záujem → Chcú návrh / cenovú ponuku / máme napísať (+ optional email) | `WANTS_DESIGN` / `WANTS_QUOTE` / `WANTS_EMAIL` | **Handoff**: ACTIVE deal, next action SEND_DESIGN (in progress) / SEND_QUOTE / SEND_EMAIL for today; assignment cleared |
| Nezdvihli | `NO_ANSWER` | CALLING, RETRY (stays with caller) |
| Dohodnúť presný čas (1 h / tomorrow / week / custom date ± time) | `CALL_AGAIN` | CALLING, SCHEDULED, `callbackAt` + `callbackHasTime` |
| Ozvať sa o pár mesiacov (2/4/6 months, custom) | `SNOOZE` | SNOOZED, date only |
| Nemajú záujem | `NOT_INTERESTED` | LOST, assignment cleared |
| Zlé / nefunkčné číslo | `BAD_NUMBER` | UNREACHABLE, assignment cleared |
| Note field | — | saved on the contact (if changed) and as the call note, in the same transaction |

Handoff details:

- The owner is chosen automatically (`lib/domain/dealRouting.ts`): if the caller can own deals (SALES_REP, MANAGER, ADMIN),
  the caller; otherwise the active leader of the caller's team if the leader can own deals; otherwise "Nepriradené".
- Setup: team "Obchod" led by Michal with Timea as a member → Timea's interested clients go to Michal **[ROLLOUT: team not
  created in production yet]**. When a SALES_REP takes over, the admin makes the rep the team leader.
- The drawer shows "Pravdepodobne odovzdá: …" (a preview); the success toast shows who actually received the deal.
- `WANTS_DESIGN` also creates a DESIGN request for the manager.
- Every submit carries the lead's `revision` and an idempotency key: a stale second tab gets "Kontakt sa medzitým zmenil"
  and refreshes; a network retry of the same submit is recorded once and reported as success.

### 5.3 Call history: `/dashboard/calls/history`

- Callers see their own calls; users with `callHistory.viewAll` filter by caller (only people who ever called) or see all.
- Reverted calls show a "vrátené" badge and no actions.
- **Vrátiť** undoes only the latest non-reverted first-call result, and only if nothing changed on the lead since that call
  (`Activity.leadRevision == Lead.revision`). The contact returns to the original caller as a retry, never to NEW; open requests
  are cancelled; then the correct outcome is logged normally. Historical deals (before the rollout) cannot be reverted.
- **Upraviť** (phone/email) requires current responsibility: the contact is assigned to the viewer in call stage, or the viewer
  is a manager. A former caller of a transferred or handed-off contact sees the row read-only.
- The company name links to the deal detail the viewer may open (pipeline for managers, client detail for the owning rep).

### 5.4 Manager assignment tool: `/dashboard/calls/assignments` (`calls.assign`)

- Per caller: batch (NEW), retries, callbacks (overdue), snoozes. Deactivated users holding work are listed first.
- **Uvoľniť dávku**: the caller's uncalled NEW back to the pool.
- **Presunúť**: move NEW / retries / callbacks / snoozes to another active caller, all or the N oldest. NEW respects the
  target's free batch capacity. Moves run in batches of 200, never skip rows, and write an audit row per moved lead.

---

## 6. Deals

A deal is a lead after a positive first call (`pipelineEnteredAt` set), whatever its status later becomes. A handoff may leave
`ownerId = null` when no eligible recipient is configured; the manager sees and assigns these ("Nepriradené").

- Historical deals (before the rollout) → owner Michal, via the backfill **[ROLLOUT]**.
- Timea's new handoffs → her team leader. SALES_REP's own handoffs → the rep.

Business follow-up cycle for every deal:

| Client wants | What happens | App |
|---|---|---|
| Quote | Owner sets the price (or asks the manager: PRICE request), sends the email, marks the quote sent | `quoteSentAt`, `priceDisclosed`; next action CALL in 7 business-calendar days; saving a price or marking the quote sent completes an open PRICE request |
| About-us email | Owner sends it, marks it sent | `aboutUsSentAt`; CALL in 7 days; completes an open EMAIL request |
| Design proposal | DESIGN request → Michal builds the design, attaches a tracked link, marks it sent | `Design` + `Tracker`; `designSentAt`; CALL in 7 days for the owner; DESIGN request DONE |
| Later | snooze to a date | SNOOZED, next action CALL on that date |
| No | not interested (with reason) | LOST, `closedAt`, open requests cancelled |
| Yes | ORDER request → manager sets WON | WON, `closedAt`, ORDER DONE, other requests cancelled |

Requests (`DealRequest`, kinds PRICE / DESIGN / EMAIL / ORDER / REOPEN / OTHER):

- Max one OPEN request per deal and kind; asking again appends the note.
- DONE only through the business action that does the work (price saved/quote sent, design sent, email sent, WON, reopen).
  Only OTHER has a manual "Vybavené". Declining ("Zamietnuť") requires a reason the rep sees. A rep can cancel their own.
- Closing a deal leaves no OPEN request; the only request a rep can create on a closed deal is REOPEN.

---

## 7. Deals workspace: `/dashboard/pipeline` (one screen, every role)

Since round 2 (`context/new-feature/round2-deal-workspace.md`, wave 1) there is **one** deal screen. `/dashboard/clients`
and `/dashboard/clients/[id]` only redirect to it. The menu label differs ("Pipeline" for managers, "Moji klienti" for
reps), the screen does not.

**Who sees which rows** is decided by `dealScope(viewer)` (`lib/domain/dealScope.ts`) on the server:

| Scope | Who | Rows |
|---|---|---|
| `all` | `deals.viewAll` (MANAGER, ADMIN) | every deal |
| `team` | `deals.viewTeam` (prepared for a future sales-team leader; no role holds it yet) | own + team members' deals |
| `own` | everyone else with `deals.view` (SALES_REP) | `ownerId = viewer.id` |

`?owner=` is a filter **within** that scope and is validated server-side (`resolveOwnerFilter`): a viewer whose scope is
`own` is forced back to themselves whatever the URL says. Scope is never read from the path or from the query.

**Filters** (identical for both roles; the owner/handoff selects render only when the scope can contain other people):

1. owner - ja (default) / všetci / nepriradené / a person, plus "Od:" (who handed the deal over, `handedOffById`)
2. status tabs - Aktívne (default), Spiace, Vyhraté, Stratené, Nedostupné, Všetky
3. view pills - Požiadavky (count; with a request-kind filter), **Na dnes** (default), Všetko, Volať, Poslať CP,
   Poslať email, Návrh v procese, Čaká na klienta, Odoslaná CP, Odoslaný návrh

"Na dnes" replaces the old card sections: open deals with no open request that need attention today - due or overdue,
woken snoozes, missing next step, missing date, a due "check with client" date. The SQL predicate mirrors
`clientSection()` and a parity test asserts they agree over every open deal. "Požiadavky" and "Na dnes" span statuses;
the other pills work inside the status tab. Search covers company, web, phone and email.

Ordering and paging happen in SQL over the whole filtered set (urgency rank, then `nextActionAt`, then `id`;
the requests view by oldest open request), 50 rows per page with "Načítať ďalších 50".

**Layout:** desktop table (`# | Firma | Typ | [Stav] | Ďalší krok | Naposledy | Cena | [Rieši] | akcie`), phone cards.
Every row shows both the next step and the last contact. Clicking a row opens the action sheet (record what happened and
what is next); the `i` icon opens the detail; the phone icon dials.

**Manager-only** (hidden without `deals.manage`, and refused server-side regardless): status, owner and project type
selects, WON/close, "Znovu otvoriť", design & tracker management, resolving requests, "Presunúť obchody" (bulk owner
transfer in batches of 200, skipping rows being edited), the unassigned-deals banner.

Detail `/dashboard/pipeline/[id]` (non-deals and out-of-scope deals → 404) - same page for everyone, wide left column +
"Údaje" on the right:

- `Požiadavky`: for the manager, each open request with the action that completes it (price field, jump to design, mark
  email sent, mark WON, reopen, "Vybavené" only for OTHER) and "Zamietnuť" with a required reason; for the rep, the list
  of their requests with the manager's answer, "Zrušiť" on their own, and a new-request form. `ORDER`, `DESIGN` and
  `OTHER` require a note (enforced in the command) - the ORDER note is where "what did they actually order" lives.
- `Ďalší krok`: shared editor (`components/deals/NextActionEditor.tsx`), day vs exact time, or in progress;
  stale tab → refresh
- `Naposledy` + quick events, `Cena`, design (full management for the manager, read-only confidence summary for the rep),
  `Email "O nás"`, `Výsledok` (manager), `História` (rep sees business steps, manager sees the audit trail too), `Údaje`

Activity `source` follows the actor, not the route: `deals.manage` writes `PIPELINE`, everyone else `CLIENTS`.

Manager dashboard blocks on `/dashboard`:

- "Čaká na mňa": all open requests, oldest first (red when the oldest is older than 2 days)
- "Obchodníci": per other deal owner: open deals, overdue next actions, follow-ups today, new deals this week, overdue callbacks,
  last activity; row → the deals screen filtered to that owner
- "Nepriradené": open deals without an owner
- "Volajúci": callers holding an unfinished batch older than 1 day, or deactivated users with call work → assignment tool

---

## 8. Working a deal (rep and manager)

Row click opens the action sheet - a drawer on the phone, a dialog on the desktop (`ResponsiveSheet`). One
interaction is recorded in three steps (`logFollowUp`, one transaction, carries revision + idempotency key):

1. **Čo sa stalo** - dovolal/a som sa · nezdvihli · odpísali / ozvali sa · bez kontaktu (len naplánovať).
   Plus the paths that end the deal or park it: ozvať sa o pár mesiacov (2/4/6 or a date), nemajú záujem / zlé číslo.
2. **Čo povedali** (`lib/domain/clientReplies.ts`) - ešte sa nepozreli · pozreli, chcú zmeny · neprišlo im to ·
   ozvú sa sami · majú poradu · rieši to niekto iný · cena je vysoká · chcú cenovú ponuku · chcú návrh · chcú objednať.
   The last three are outcomes in themselves (quote / design request / order request); the others pre-fill a next step
   and a date. The key lands in `Activity.meta.reply`, the label is copied into the note.
3. **Ďalší krok** - from the shared list (`lib/domain/nextStepOptions.ts`): zavolať (date required), čakáme na klienta
   (date = check day), poslať CP / email (empty date = today), poslať návrh (in progress), vlastný krok.

The key rule: **the contact result survives the next step.** "Nezdvihli" is recorded as `NO_ANSWER` even when the caller
picks something other than the suggested "zavolať ďalší pracovný deň", so the row keeps showing
`Naposledy: Nezdvihli · dnes · 3. pokus` next to `Ďalší krok`. The streak counts consecutive non-reverted `NO_ANSWER`
calls and resets on any real contact.

The sheet also has: mark quote / email sent, ask the manager (kind + note; ORDER/DESIGN/OTHER require the note), open
detail. A closed deal opens read-only - the rep gets "Požiadať o znovuotvorenie", the manager reopens it in the detail.
The deal detail has the same flow behind "Zaznamenať kontakt" in the `Naposledy` card, for both roles.

"Chcú objednať" parks the deal on the `ORDER` next step ("Objednávka - potvrdiť") and opens an ORDER request, so the
board says we are waiting for the manager, not for the client.

Rep rules: sets prices and marks quotes/emails sent on own **open** deals; asks the manager when unsure; never sees other
people's deals; closed deals are read-only except the REOPEN request. The manager may act on any deal in any state.

First calls (`/dashboard/calls`) keep their own menu - there, picking up is implicit - but they use the same responsive
sheet.

---

## 9. Dashboard `/dashboard`

Composed by permission:

- no calls / deals / pipeline permission (SCOUT, SCOUT_LEADER): a welcome page
- callers (`calls.view`): own batch, pool count, own callbacks due/overdue, own retries; urgent own callbacks
- deal owners (`deals.view` without `deals.viewAll`): own open deals, next actions due today / overdue, links to the deal detail
- managers (`deals.viewAll`): the blocks from section 7, all deals due/overdue, calendar
- "Pridať kontakty" only with `contacts.create`

---

## 10. Design tracking

- Managers create a `Design` on a deal → the app creates a `Tracker` with a unique token → the client gets the design URL
  with `?p=TOKEN`.
- The public scripts `/p.js` and `/scripts/tracker.js` read the token, strip it from the address bar, and post events to `/api/p`.
- Events: PAGE_VIEW (weak signal, may be a scanner) and ENGAGED_VIEW (active time/scroll).
- `DesignVersion` records updates; events store which version was seen.
- `lib/tracking/confidence.ts` summarizes the events into a confidence signal. It is a hint, not proof.
- Reps see only the confidence summary for their own deals (no URLs, tokens, versions or IPs).
- Tracking ingest is the only lead-related write that does not bump `Lead.revision`.

---

## 11. Admin `/dashboard/admin` (Michal)

- Users: create (with role, including "Obchodník" = SALES_REP), edit profile/role, reset password, deactivate/reactivate.
  Public signup is disabled (the signup action was removed).
- Teams: create, rename, delete, set leader, set membership (from user detail). The team card says when positive calls of
  members go to the leader.
- Deactivating a user (or changing their role to one without call rights) waits for their in-flight work, releases their
  uncalled NEW contacts to the pool in the same transaction, and never leaves them assigned (otherwise it does not happen and
  asks to retry). The user detail then shows remaining retries, callbacks, snoozes and deals with links to move them.

---

## 12. Statistics `/dashboard/stats`

Unfinished; expected to be redesigned. Current data: first calls by user and outcome, contacts added per user/day, contact pool
(pool vs. callers' batches), team scoping for leaders.

Principles:

- measure each role on its real job (no call stats for scouts)
- first calls = `Activity source CALL_QUEUE`; follow-ups = `source CLIENTS`; handoffs per caller = `handedOffById`;
  deals per owner = `ownerId` (the last three are available in data, not yet shown)
- exclude activities with `revertedAt` from outcome counts (not yet done)

---

## 13. Known issues to keep in mind

- Production is not migrated yet: schema push, backfill (`prisma/backfill/2026-09-assignments.ts`), team "Obchod" and the
  deploy are the separate, approved rollout (planning §14). Old code must not run against a backfilled database while people
  call (planning §14.1).
- `prisma db push` stops with a data-loss warning for the new unique index on `Activity.idempotencyKey` (a new, all-NULL column);
  the reviewed diff was applied with `prisma db execute` on the test database instead (see progress tracker).
- Statistics still use server-local days.
- `components/layout/MobileNav.tsx` has a pre-existing lint error (setState in effect).
