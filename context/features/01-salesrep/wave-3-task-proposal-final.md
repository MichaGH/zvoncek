# Wave 3 — manager tasks with a step lock, handover, história, counters

Status: **the official wave-3 design (Michal, 2026-09-19); nothing implemented.** It replaces the round-1
"požiadavky" (`DealRequest`) and every earlier wave-3 draft: `round2-deal-workspace.md` §2b, `planning.md` and
`context/app-workflow.md` §6 point here. Two external review rounds and Michal's answers are folded in; every finding
and how it was resolved is logged in §13 (round 1, W3-R01…R18), §14 (round 2, W3-R2-01…15) and §15 (round 3,
W3-R3-01…13). The earlier drafts
(models v1/A, B, C, C′) were deleted on 2026-09-19; §1c keeps why each was rejected. Michal keeps copies in `backup/`
(never edit or delete them without asking).

Audience: an AI implementing or reviewing this. Read `AGENTS.md`, `context/code-standards.md` (database rules),
`context/domain/database-map.md`, `context/domain/operations.md` and `context/ui-context.md` first. The decisions in §2
are Michal's; do not re-open them without asking. Anything this file does not cover → ask Michal, do not invent.
Ideas that are explicitly *later* live in `context/features/backlog.md`. The database ledger is
`context/domain/db-changes.md` (the authoritative record of what test and production differ by).

---

## 1. The problem

An SR works her deals alone, except where she needs the manager:

1. **Price.** She does not know how to price a complicated project → the manager calculates it → she sends it.
2. **Návrh.** Only the manager can make a návrh (verified: `createDesignAs` and all design commands use
   `requireDealManage`, `lib/commands/tracking.ts`) → the manager makes it → she sends it.
3. **Price and návrh together** (has happened) → both from the manager → she sends both at once.
4. **Handover.** The client wants details / technical talk / is ready to go ahead → the deal should go to the manager
   completely; he talks to the client from then on.
5. **Takeover.** The manager can take any deal at any time.
6. **Reopen is not a task** (D13). On a closed deal (WON/LOST/UNREACHABLE) the SR can do nothing; only the manager
   reopens (`reopenDealAs`, `requireDealManage`). Asking for it belongs to a later, separate concept — a *request*
   (backlog BL-01).

Visibility requirements: the manager sees everything waiting for him in one place, regardless of whose deal it is; the
SR sees which of her deals wait for the manager, and clearly sees when the manager's work came back.

What went wrong before (current `DealRequest`, round 1): requests were a second object next to the deal and had to stay
in sync with the step. They were created and closed automatically behind the user's back, an open request hid a due SR
call (`clientSections.ts:68`), and the SR could keep editing a step that the app was hiding. Every later design (a
request object with a parked step, the "ball" on the step, independent tasks) failed on the same sync question. This
design removes the question with a **lock**: while the manager works, the SR's step cannot change. Background:
§1a–§1d.

### 1a. Michal's workflow — the situations every part of this design must serve

INITIATE = telesales or an SR clicks a number in `/dashboard/calls`, calls, and picks what the client wants (návrh,
email, cena). SR = sales rep; "manager" = the manager, or Michal (ADMIN acting as manager).

**Situation A — price.**
1. INITIATE → "Chcú konkrétnu cenu" (step "Poslať cenu").
2. The SR finds out it is a more complicated project and is unsure how to determine the exact price.
3. The SR asks the manager for the price.
4. The manager gives the price back; the SR **must see it**, then sends the email.
5. The app plans the follow-up call (standard 3–7 days after the send — already done by "Čo sme poslali").

**Situation B — návrh.**
1. INITIATE → "Chcú návrh". A návrh can only be made by the manager (later by a developer — a separate feature, D10).
2. The SR cannot make it, so she asks the manager.
3. The manager sees it must be done, makes it and uploads the link (design card).
4. The SR sees the návrh is ready, sends it and records the send.
5. The SR contacts the client: did they see it, do they like it.
6. Yes / they want a different design → the SR passes the client or the manager takes the lead and communicates from
   then on (the client is already interested, easy for the manager).
   - Deeper details from the client → the manager takes over completely.
   - Small details ("make it blue") → the SR keeps the client (a new návrh task with the wish).

**Situation C — details / technical questions.**
1. INITIATE → návrh.
2. After the first call the client says "I have things I want there, where can I tell them?" or has technical
   questions.
3. The deal is handed to the manager completely (handover, §6.8).

**Also real:** price and návrh asked together; price and návrh needed at different times; the client calls the SR while
the manager is still working ("chce modrú"); the client gives up while the SR waits; a client asks the SR to talk to
the manager directly while the manager is already working on a task (§6.2).

**Always:** the SR may ask for help with a price or a návrh; the manager can take over at any point; the UX must make
it obvious — the SR sees which deals wait for the manager and which came back finished; the manager sees his tasks in
one place, whoever owns the deal.

**Division of work** (Michal: *"until client asks for CP or about us email, its managed by sales rep"*): the SR owns
the relationship and the introductions; the manager owns the artifacts (price calculation, návrh) and any technical
conversation. **WON is only ever the manager's action** (Michal: *"won is only mine"*); an order / WON step with the
products and end prices is later work (backlog BL-09).

### 1b. What went wrong with the current requests (found in use, 2026-09-18)

Michal, as SALES_REP `sales`, made four first calls (email, CP, CP, návrh) and then saw **"Požiadavky (4)"** on his own
screen. Three faults, one root:

1. **The pill counted the wrong thing.** It meant "my deals that carry an open request" — an *outbox* — but read like a
   to-do list. For the manager the same pill was empty by default, because requests sit on other people's deals and
   the default owner filter is "ja".
2. **A request swallowed the deal.** The requests view filtered deals with an open request, and `clientSection()` sent
   any such deal to "Čaká na nás" — the deal left the rep's normal work and stayed there whatever else happened
   (call → "chcú CP" → still in Požiadavky).
3. **Two doors, one lock.** The manual path required a note for ORDER/DESIGN/OTHER, the automatic path from a call
   outcome (`ensureOpenRequest`) required nothing, so "chcú návrh" from `/calls` created a note-less request.

Root: `DealRequest` did three jobs at once — a work item ("make me a price"), a state marker (the deal leaves the
list) and an implied handover. Here they are three separate things: the **task** (work item), the **lock** (state,
derived, never stored) and the **handover / takeover** (an explicit owner change).

Also found: automatic creation (telesales raising requests they never meant to raise; an SR finding requests she did
not raise) and automatic closing (a saved price or a send closing a request behind the user's back) — hence D9.

### 1c. Designs considered and rejected

| Design | Idea | Why not |
|---|---|---|
| v1 / A — request object + parked step | inbox Pre mňa / Od mňa / Vybavené, comment thread, a `WAITING_FOR_MANAGER` step kept in line with the open request, "two switches" resolution | the invariant "open request ⇔ parked step" broke in every review (parking, un-parking, several open requests, a request closed while the step said otherwise) |
| B — "the ball" on the step | no task object; the deal's step gets an assignee | one slot only; a reopen step is impossible (closed deals have no step and are read-only for the owner); no structured history for statistics; a developer would need deal access |
| C — independent task, no parking | the task never touches the owner's step | returned work solved three ways at once (conditional step rewrite + `acknowledgedAt` + "Hotové" pill); opening a task silently cleared the step |
| C′ — the ball on the task | the task carries "whose turn" and comes back to the SR | Michal: it is the same request object anyway; the SR's step and the returned work are still two things to watch |
| step + "agreed appointment" slot | a second date for "call me Monday" | real but rare; the app is a next-step machine, not a calendar (D11, backlog BL-02) |

What decided it (Michal): the step is **"send the price"** — the SR's action, which exists with or without the manager;
the task is **"get the price from the manager"** — created only when she finds out she needs help, never at the first
call. Instead of keeping the two in sync, **lock the step** while the task is open (D2); the locked step is the
follow-up of the task (D3).

### 1d. Kept from the earlier designs (still wanted)

- **Takeover at any time**, with or without a task; **after a takeover the SR loses access** (Michal: *"I dont see
  reason except curiosity, and when there will be hundreds of contacts its just clutter"*). Out of scope = `NOT_FOUND`.
- **História** for the SR from an ownership record (`DealOwnership`): for now only *"prevzaté 18. 9. · Michal"*
  (Michal: *"for now, only prevzaté michal, in future we maybe change it"*). The same record keeps statistics honest
  ("she brought 14 deals" survives the takeover) and serves later rep → rep transfers.
- **Counters on every pill** (Michal spent a session believing "Všetko" was empty), computed exactly like the list they
  open (§7).
- **No automatic tasks**; the ask text is **pre-filled from the last call note** (Michal: *"the note is possibly
  already after telesales call"*); the SR sees a prominent "Požiadať manažéra" where she needs it.
- **"Chcú objednať" is not a kind of work** — it does not say what is being built. It is an ordinary reply; an explicit
  handover may follow (§6.8).
- **Order details** (what they ordered, agreed price, system, addons such as "EN jazyk") must stay on the deal: in the
  handover note now, as a pinned `FOR_BUILD` note from wave 4 (round 2 D-07/D-08).

## 2. Decisions (Michal, 2026-09-18/19)

| # | Decision |
|---|---|
| D1 | A **task** = the SR asks the manager for something. It is its own table with history. It is **not** the SR's next step. |
| D2 | **Step lock.** While a task is open, the deal's next step is frozen, enforced **on the server** (not only in the UI). To change the step, the task must be closed — in the same dialog and the same transaction (§5.1). |
| D3 | The frozen step **is the follow-up of the task**: when asking, the SR chooses what she will do when the manager delivers. For a task with a price or a návrh this is the send step ("Poslať cenu" / "Poslať návrh" — kind fixed, note free), because what comes back must be sent or explicitly declined (§6.13, review W3-R3-01); only an "Iné"-only task allows any step kind, including a custom one. When the task closes, that step becomes active and due now. |
| D4 | **One open task per deal.** Price and návrh needed together = one task with both contents ticked. Needed at different times = two tasks one after the other; results that were not sent yet stay visible side by side (§6.13). |
| D5 | The SR may still snooze, close ("nemajú záujem") or replan while a task is open — **her decision, no manager approval** (Michal: otherwise *"i will just be doing clicking for them"*). The dialog says which task it cancels, and cancel + change are one transaction. Recording a contact (call, reply, SMS) and a send remain allowed without cancelling; they are facts. A send that overlaps what the task is producing asks first (§5.1). |
| D6 | Transferring the deal to another **SR** keeps the task; the new owner inherits it and its lock. Transferring it to a **manager** (a resolver) or to nobody ends the task and leaves the step as a plain step (§6.10). |
| D7 | On the **manager's own deal** there are no tasks. He simply has the step "Poslať cenu" / "Poslať návrh" and does it himself. |
| D8 | The **handover** ("kontaktujte ma kvôli detailom", "idú do toho") is a request the manager accepts or declines — a task of type HANDOVER. The manager can also take over any deal directly, without a task, and give it back later by a normal owner change. However the manager ends up owning a deal with an open HANDOVER task, it counts as an accepted handover (§6.10). |
| D9 | No task is ever created or closed automatically by a call outcome, a send or a saved price. Telesales never create tasks. |
| D10 | The future developer role will get **its own project/communication feature**, not these tasks (backlog BL-04). |
| D11 | A client's fixed appointment ("pošlite cenu a zavolajte v pondelok") is **not modelled**. The app is a next-step machine, not a calendar; known limit (§12, backlog BL-02). The relative follow-up after a send already exists. |
| D12 | Ownership history (`DealOwnership`), the SR's História page and counters on every pill stay as agreed. |
| D13 | **Reopen is not a task.** Later, a separate concept *request* (backlog BL-01): placeable on any lead, even one that was reassigned away and sits in the SR's História; it asks the manager to do something (reopen; reopen and reassign). Wave 3 deletes the round-1 REOPEN request with `DealRequest`; until BL-01 the SR tells the manager outside the app. `ClosedPolicy "reopenRequestOnly"` loses its only caller and is removed. |
| D14 | **Deactivating an account is blocked** while the user owns open deals or has open tasks as assignee; the admin transfers them first (count + link shown). A role change that removes `deals.receive` or `requests.resolve` is blocked the same way — Michal prefers a new account over demoting someone with hundreds of leads. A rogue employee: change the password, transfer, then deactivate. |
| D15 | **"Chcú objednať" means nothing special now** (Michal: ORDER was pre-made for later products — SEO, marketing, social media — or as a step before WON; to be remade later, backlog BL-09). It stays a truthful reply but is no longer terminal: it records the contact and a normal next step; handing over is a separate, explicit action (§6.8). The `ORDER` step kind and ORDER request are removed. |
| D16 | A declined task leaves the SR's step as it was ("Poslať cenu" still has to happen), now unlocked and due, with the decline reason shown (§6.6). |
| D17 | "Iné" stays as task content. Tasks may be **reassigned** to another manager. |
| D18 | **No `--accept-data-loss`, no exception** (Michal, 2026-09-19). Before wave 3 is built, the test database is wiped and re-seeded minimally (§10 step 0), so the schema change runs on an empty old-request world; anything destructive goes through a reviewed SQL diff. |
| D19 | Everything the SR decides about a returned result is **history**, item by item: using it is recorded by the send that carries it, not using it by an explicit "Neposielam" with a reason (§6.13). Until every returned price / návrh is sent or declined, the deal's step stays the send step — one next step, no second reminder queue. |

## 3. Concepts (use these words consistently)

| Term (UI) | Meaning | Stored in |
|---|---|---|
| **Ďalší krok** (step) | the deal owner's next action. Unchanged meaning. | `Lead.nextAction*` (existing) |
| **Úloha** (task) | a request from the deal owner to a manager. Types HELP / HANDOVER. | new `DealTask` |
| **Zámok** (lock) | derived state: the deal has an OPEN task → the step is frozen | nothing extra — derived from `DealTask` |
| **Výsledok** (result) | what the manager delivered: price, návrh, answer | `DealTask.result` + the `TASK_DONE` activity's meta |
| **Správy** (messages) | short internal back-and-forth on an open task; never a client contact | `Activity` rows with `taskId` |

UI wording: the SR clicks **"Požiadať manažéra"**; the manager's list is **"Pre mňa"**; the SR's waiting list is
**"Čakám na manažéra"**. The word *požiadavka* never appears in the UI.

## 4. Data (schema proposal — review before applying on test)

### 4.1 `DealTask` (replaces the test-only `DealRequest`; production never had it)

| Field | Type | Meaning |
|---|---|---|
| `id` | cuid | the UI says "úloha od 18. 9.", no number |
| `leadId` | FK Lead | the deal |
| `type` | `DealTaskType` = `HELP` · `HANDOVER` | no REOPEN (D13) |
| `contents` | `DealTaskContent[]` = `PRICE` · `DESIGN` · `OTHER` | HELP: ≥ 1, any combination. HANDOVER: empty. |
| `status` | `DealTaskStatus` = `OPEN` · `DONE` · `DECLINED` · `CANCELLED` | DONE = delivered / handover accepted; DECLINED = the manager said no; CANCELLED = the owner withdrew it, or it ended with the deal / an owner change |
| `text` | String (required, ≤ 2000) | what is asked ("e-shop, 200 produktov, SK+EN") |
| `requestedById` | FK User | who asked; never changes |
| `assigneeId` | FK User | the named manager who must act (active user with `requests.resolve`; pre-selected when there is one); can be reassigned (D17) |
| `createdAt` | DateTime | age in "Pre mňa"; never reset |
| `closedAt?`, `closedById?` | | when / who closed it (`closedById` is the actual resolver — may differ from the assignee) |
| `closeReason?` | String | required for DECLINED and CANCELLED; fixed text for endings caused by another action ("obchod uzavretý", "klienta prevzal Michal") |
| `result?` | Json, strict zod | `{ price?: { amount: moneyString, note: string \| null }, designs?: [{ id, label, url, version }], answer?: string }` — immutable record of what was delivered (the current `Lead.price` / design may change later) |

Indexes: `(assigneeId, status, createdAt)` for "Pre mňa"; `(leadId, status)` for the lock and row badges.

**One OPEN task per deal** (D4): enforced in the command under the `Lead` row lock (race-safe: tasks are only created
inside the Lead-locked transaction). A partial unique index `("leadId") WHERE status = 'OPEN'` is a second guard only if
it can be kept without schema drift under the project's `db push` workflow — decide at schema review; never `migrate dev`.

### 4.2 Task history = `Activity` rows

- New nullable `Activity.taskId` (FK `DealTask`, indexed). Every task event writes one Activity row with `taskId`, the
  actor, the time and the text. **Every user mutation has exactly one keyed primary Activity**; secondary audit rows
  written in the same transaction (e.g. `TASK_CANCELLED` inside cancel + change, `TASK_RESULT_DISMISSED` inside a
  close) carry `taskId` and the operation's metadata but no key of their own (`Activity.idempotencyKey` is unique). The task's history is `WHERE taskId = ?` ordered by
  `(createdAt, id)`; the same rows appear in the deal history.
- New `ActivityType` values: `TASK_CREATED`, `TASK_MESSAGE`, `TASK_DONE`, `TASK_DECLINED`, `TASK_CANCELLED`,
  `TASK_REASSIGNED`, `TASK_RESULT_DISMISSED` (category BUSINESS, not client contact). `REQUEST_CREATED` /
  `REQUEST_RESOLVED` exist on test only (verify in `db-changes.md`) and are removed with `DealRequest`.
- `TASK_*` rows are **not** in `LAST_TOUCH_TYPES` → they never change "Naposledy".
- `TASK_DONE.meta` carries the result snapshot (history rendering without a join). Every keyed row stores the canonical
  fingerprint of what was submitted in `meta.fp` (§5.5).
- **Returned results are items** (§6.13): a PRICE item per task, a DESIGN item per (task, design), an OTHER item and a
  DECLINED item per task. A send that uses items says so: `OFFER_SENT.meta.fulfils = [{ taskId, kind: "PRICE" |
  "DESIGN", designId? }]` (strict zod, optional, never on historical entries; also allowed on a phone-price row for a
  PRICE item). A dismissal names its items the same way: `TASK_RESULT_DISMISSED.meta.items = [{ kind: "PRICE" |
  "DESIGN" | "OTHER" | "DECLINED", designId? }]` + `reason` (one row per task). These two are the only things that
  consume an item.

### 4.3 Other schema

| id | Change |
|---|---|
| S-08 | `DealTask` + `DealTaskType`, `DealTaskContent`, `DealTaskStatus`; drop `DealRequest`, `DealRequestKind`, `DealRequestStatus` (test only) |
| S-09 | `Activity.taskId` + index; `ActivityType += TASK_*`; `ActivityType − REQUEST_*` |
| S-10 | `DealOwnership` (`leadId`, `fromUserId?`, `toUserId?`, `byUserId`, `reason` = `HANDOFF` · `CHANGE` · `BULK` · `TAKEOVER` · `HANDOVER` · `REVERT`, `note?`, `createdAt`); indexes `(leadId, createdAt)`, `(fromUserId, createdAt)` |
| S-11 | `NextActionKind − ORDER` |

No new `Lead` columns. For production, only the **net** difference counts: production never received round 1's
`DealRequest`, `REQUEST_*` or wave 2's `ORDER`, so they are simply **never added there** (W3-R2-02). The production
change is generated from the measured live schema to the final target, not by replaying the intermediate test schemas —
§10 "Production".

## 5. Rules

### 5.1 The lock (D2, D3, D5)

- **Locked** ⇔ the deal has an OPEN task. A closed deal never has one (I7).
- **While locked the step's date is empty.** The ask stores the chosen step kind + note with `nextActionAt = NULL`,
  `nextActionMode = SCHEDULED`; any kind is allowed without a date (including `CALL`, which normally requires one) —
  the date is set when the lock ends: business today by default (D3), or the date picked in the cancel / takeover
  dialog. So a locked deal can never look overdue anywhere.
- Every write of `Lead.nextAction*` or `Lead.status` goes through one guard `assertStepUnlocked(tx, leadId)` under the
  Lead lock (error `STEP_LOCKED`, "Krok čaká na úlohu pre manažéra."), except the task commands and the explicit forms
  below.
- **Fact-only branch** (R04): while locked, `logFollowUpAs` records the contact exactly as today (CALL /
  CLIENT_REPLIED / SMS_SENT, reply, phone-price `OFFER_SENT`) but writes **no** status, step or planning activity — the
  submit carries `keepLockedStep: true`, and the server rejects any step/status input in that mode. "Naposledy" moves;
  the step does not. `recordOfferSentAs` while locked records the send with `followUp = false`, forced on the server.
  This is also how the **manager records his own real call** to the SR's client (W3-R2-06).
- **Overlap with the open task** (W3-R2-05): a send or a phone price whose contents overlap the open task (PRICE with a
  PRICE task; any návrh with a DESIGN task) must carry an explicit choice, or the server rejects it (`TASK_OVERLAP`):
  - *"Úloha ostáva otvorená"* — Michal is still producing something different; the send is recorded fact-only;
  - *"Už to netreba — zrušiť úlohu"* — cancel + send + the send's follow-up as the new step, atomically;
  - for a manager (resolver) only: *"Vybavil som to sám"* — the finish + send command (§6.5).
  Unrelated contents (e.g. "o nás" while waiting for a price) need no choice.
- **Pending returned items fix the step kind** (D19, W3-R3-01): while a returned PRICE or DESIGN item is pending
  (§6.13) on an open deal, the step kind must be `SEND_DESIGN` if any DESIGN item is pending, otherwise `SEND_QUOTE` or
  `SEND_DESIGN` (a návrh send can carry the price). Date and note stay free — "call first, then send" goes into the
  step note and date. Every step / status writer checks this under the Lead lock (`RESULT_PENDING`), unless the same
  save explicitly dismisses the remaining items; closing the deal dismisses them itself (§6.12). This also covers the
  ask dialog's follow-up, the takeover dialog and the send dialog's follow-up.
- **Cancel + change** (D5): the same commands accept `cancelTask: { taskId, reason }`. Then, in one transaction: the
  task becomes CANCELLED (`TASK_CANCELLED`), the lock ends, and the chosen outcome / status / step is applied as
  today (snooze, "nemajú záujem", "zlé číslo", "Zmeniť krok"). The manager's status select and "Stratené" use the same
  parameter. The `taskId` must be the deal's OPEN task, else `STALE`.
- Writers to cover (the inventory in §13.2 is the checklist): `logFollowUpAs`, "Zmeniť krok" (contact NONE),
  `recordOfferSentAs` / `recordOffer` follow-up, `changeStatusAs`, `markLostAs`, `setNextActionAs`, owner change and
  bulk transfer (§6.10), takeover (§6.9), first-call revert (cannot happen after a task — §6.12), deactivation (blocked,
  D14).

### 5.2 Who may do what

| Action | Who |
|---|---|
| create HELP / HANDOVER | the current deal owner with `deals.work`, not a resolver on their own deal (D7); never telesales (D9); deal ACTIVE or SNOOZED |
| message on an OPEN task | the current owner, the assignee, any user with `deals.manage` |
| finish (DONE) / decline / reassign | the assignee or any user with `requests.resolve` + `deals.manage` |
| cancel | the current owner (reason required), or anyone with `deals.manage` inside an explicit action that names the task (close, takeover, transfer) |
| "Neposielam" / "Beriem na vedomie" on returned items | the current owner (a manager when he owns the deal); any user with `deals.manage` while the deal has no owner |
| record a contact / send while locked | as today: the owner, or a manager (`requireDealWork`) |
| take over directly | `deals.manage` |

Assignee eligibility = active user with `requests.resolve` (manager/admin) — not "team leader" (a leader may be an SR or
a scout leader). Out-of-scope deal/task → `NOT_FOUND`. A former owner never regains access through a task.

### 5.3 Sections and every other place that shows the step (R05)

`clientSection()` and `TODAY_SQL` together (parity test is the gate). The current order already has "open request →
Čaká" right after "closed" (`clientSections.ts:68`, SQL `NOT EXISTS` at `queries/pipeline/index.ts:124`); keep the
position, change the source:

1. closed → closed;
2. an OPEN task → **Čaká na manažéra**;
3. everything else exactly as today.

**Locked ⇒ not actionable, everywhere.** A TS predicate `isStepLocked` (in the pure `lib/domain/tasks.ts`) and its SQL
twin `STEP_LOCKED_SQL` (= `EXISTS (open task)`, server-only, next to `TODAY_SQL` in `lib/queries/pipeline`) are used by:
the pipeline sections and `DEAL_RANK_SQL` (locked deals rank with "Čaká"), the step-kind pills ("Poslať cenu" etc.
exclude locked deals — they are in "Čakám na manažéra"), the row urgency (shows "⏳ čaká na Michala (2 dni)" instead of
a date), the dashboard due list and calendar (`lib/queries/today/index.ts`), and the manager's per-rep overdue counts
(`lib/queries/today/manager.ts`). They are deliberate twins, like `clientSection` ↔ `TODAY_SQL`; the parity and
"actionable nowhere" tests are the guard (W3-R2-12). The empty locked date (§5.1) is the second safety net.

A SNOOZED deal cannot keep a locked step: creating a task on a SNOOZED deal sets it ACTIVE in the same transaction
(the ask dialog says "Obchod sa zobudí").

### 5.4 Invariants (test each)

- I1 At most one OPEN task per deal.
- I2 While a task is OPEN, `Lead.nextAction*` and `Lead.status` change only through task commands or the explicit
  cancel + change / overlap forms (§5.1).
- I3 Every task event = exactly one Activity row with `taskId`; every user mutation (including "Neposielam") = one
  transaction, one revision bump, exactly one keyed primary Activity with a canonical fingerprint (§5.5); secondary
  rows in that transaction have no key.
- I4 No task row is written by a call outcome, a send, a saved price or a design save (D9).
- I5 A DONE HELP task has a result for every ticked content (PRICE → amount; DESIGN → ≥ 1 non-deleted design with a
  URL; OTHER → answer text).
- I6 Task creation, assignment and messages never change the deal owner. HANDOVER acceptance, direct takeover, owner
  change, bulk transfer, first-call handoff and first-call revert do — and each actual owner change writes exactly one
  `DealOwnership` row in the same transaction. Today these are four separate code paths (`calls.ts` handoff,
  `history.ts` revert, `pipeline.ts` raw bulk update, `deal.changeOwner`); the owner-to-owner ones go through one shared
  transition (§6.10), and all four call `recordOwnership`.
- I7 No OPEN task on a closed deal; no OPEN task whose assignee is the current owner.
- I8 A locked step has `nextActionAt = NULL`.
- I9 A returned item is consumed only by a non-reverted `OFFER_SENT` whose `meta.fulfils` names exactly that item, or
  by a `TASK_RESULT_DISMISSED` row whose `meta.items` names it (§6.13). One send fulfils at most one PRICE item and
  each design id at most once.
- I10 While a PRICE / DESIGN item is pending on an open deal, the step kind is `SEND_QUOTE` / `SEND_DESIGN` (§5.1).

### 5.5 Freshness, retries and locks (R10, R18, W3-R2-07, W3-R2-10)

**Freshness.** Every command that changes a deal's status, owner, step or task carries the `expectedRevision` the
screen was rendered with; a mismatch returns `STALE` and the screen refreshes. This adds `expectedRevision` to
`changeStatusAs`, `markLostAs`, `reopenDealAs`, `changeOwnerAs`, takeover and all task commands.

**Retries.** Each command has one idempotency key on its one primary Activity row, and `meta.fp` = a canonical string of
what the user **submitted** (never recomputed current values). The key is looked up **before** the revision check (the
existing pattern): same key + same `fp` → the earlier success is returned, so a double click never shows a false
error; same key + different `fp` → `IDEMPOTENCY_CONFLICT` (`activityReplay` with `fingerprint`/`want`).

| Command | Primary row | `fp` contains |
|---|---|---|
| ask | `TASK_CREATED` | type, sorted contents, assignee, text, locked step kind + note |
| message | `TASK_MESSAGE` | text |
| finish | `TASK_DONE` | price amount + note, sorted design ids + versions, answer |
| "Vybavil som to sám" (finish + send) | `TASK_DONE` (the `OFFER_SENT` in the same transaction has no key) | the finish fields + send contents, `sentOn`, follow-up choice + date |
| decline | `TASK_DECLINED` | reason |
| cancel + change | the command's own row as today (contact or planning row), plus `TASK_CANCELLED` without a key | the command's fields + `cancelTask.taskId` + reason |
| contact / step change with "Beriem na vedomie" or dismissals | the command's own row as today, plus `TASK_RESULT_DISMISSED` without a key | the command's fields + the dismissed items + reasons |
| reassign | `TASK_REASSIGNED` | new assignee |
| "Neposielam" / "Beriem na vedomie" | `TASK_RESULT_DISMISSED` | taskId, the sorted items, reason |
| handover accept / direct takeover | `OWNER_CHANGED` | new owner, the manager's step + date + note |
| owner change (single) | `OWNER_CHANGED` | new owner, task assignee choice |
| status change / "Stratené" | `STATUS_CHANGED` | new status, reason, `cancelTask` if any |
| reopen | `DEAL_REOPENED` | the step chosen |
| send with overlap choice / `fulfils` | `OFFER_SENT` (as today) | the existing send fields + price amount + note + follow-up choice/date + overlap choice + `fulfils` |
| bulk transfer | none per operation — see below | `bulkFp` |

**Bulk transfer.** One `operationId` per submit, written into `meta.bulkOpId` of every `OWNER_CHANGED` it produces,
together with `meta.bulkFp` = the canonical operation: source owner, target owner, statuses, handed-off-by filter, task
assignee choice, limit. A retry with the same id first compares `bulkFp` with the existing rows (a mismatch →
`IDEMPOTENCY_CONFLICT`), then skips leads already carrying that id and returns the cumulative count moved by the
operation. Batches stay at 200 (§6.10).

Two existing gaps are closed in the same wave, because the lock makes them reachable (W3-R3-07):
- `offerFingerprint` adds the price amount + note, the follow-up choice + date, the overlap choice and `fulfils`.
- `logFollowUpAs` gets **one canonical full fingerprint** of every business field submitted: contact, outcome, reply,
  "Čo povedali", step kind + date + time + "Poznámka ku kroku", lost reason, phone price amount + note + `fulfils`,
  `keepLockedStep`, overlap choice, `cancelTask` (id + reason), dismissed / acknowledged items. Only retry mechanics
  (`expectedRevision`, the key itself) are left out. The CALL replay (`idempotentReplay` for `source ≠ CALL_QUEUE`)
  and `activityReplay` compare this fingerprint; the first-call path is unchanged.

**Locks** (lock order Team → User → Lead; Users sorted by id, `FOR SHARE` unless stated):

| Command | Users locked, then the Lead |
|---|---|
| ask | actor, assignee |
| message, finish, decline, cancel, "Neposielam" | actor |
| reassign | actor, old assignee, new assignee |
| handover accept, takeover, owner change | actor, old owner, new owner, the task's assignee if the task ends, the new assignee if the dialog changes it |
| bulk transfer | pre-read the candidate leads, their owners and task assignees plus the target and new assignee; lock that whole User set sorted; lock the Leads sorted; re-read each lead and skip (count as skipped) any whose owner or task changed since the pre-read |
| deactivation / role change | the user `FOR UPDATE` first (existing), then count open deals owned and OPEN tasks assigned; refuse when either is > 0 |

Every command that creates or moves work onto a user holds that user `FOR SHARE`, so a concurrent deactivation waits for
it and then counts it, and new work waits for a running deactivation (D14 is race-safe).

### 5.6 Ordering (R16)

Everything that says "last" or "latest" orders by `(createdAt, id)`: task history, the 💬 line, História. This is for
display only — no rule consumes or hides anything by comparing timestamps (§6.13).

## 6. Flows

### 6.1 Asking (HELP)

On the SR's own deal, button **"Požiadať manažéra"** (prominent when the step is "Poslať návrh", because an SR can never
make a návrh; also offered after "Chcú cenu/návrh" replies; never created automatically):

```
Čo potrebuješ?   ☑ Cena   ☐ Návrh   ☐ Iné
Popis:           [e-shop, 200 produktov, SK+EN]           (pre-filled from the last call note, editable, required)
Pre:             Michal                                   (pre-selected when one resolver)
Keď Michal dodá: [Poslať cenu ▾]  poznámka [          ]   (Cena/Návrh: the send step, note free; Iné only: any step)
                 🔒 Krok bude zamknutý, kým úloha nie je vybavená.
```

Follow-up step (D3): PRICE only → `SEND_QUOTE`; DESIGN (with or without PRICE) → `SEND_DESIGN` (these kinds are fixed;
with PRICE only, `SEND_DESIGN` may be chosen too); OTHER only → `CALL` by default, any kind allowed. If older returned
items are still pending, the choice is limited by §5.1. No date field (§5.1). The send dialog completes a `SEND_DESIGN` step when a návrh is ticked and pre-ticks the
price from the task result (§6.4), so price + návrh needs no new step kind.

Transaction: guard (owner, ACTIVE/SNOOZED, no OPEN task, not own-deal resolver, `expectedRevision`) → write the chosen
step with an empty date (`NEXT_ACTION_*` planning row as today) → create `DealTask` + `TASK_CREATED` → wake a snoozed
deal → one bump.

Rows after asking:
- SR: `🔒 Poslať cenu · ⏳ čaká na Michala (0 dní)` — in "Čakám na manažéra".
- Manager, "Pre mňa": `Cena · Jana · Kvetinárstvo Lipa · od 18. 9. · „e-shop, 200 produktov…"`.

### 6.2 Messages while waiting — and "the client wants to talk to you" (R01, W3-R2-06, W3-R2-13)

- Either side: **"Napísať"** on the task → `TASK_MESSAGE` ("chce modrú", "koľko jazykov?"). Messages are internal.
- The row shows the last message neutrally: "💬 Posledná správa: Jana" / "💬 Posledná správa: Michal". There is no
  read state, so the UI never says "nové".
- **Every real contact with the client is recorded as a contact**, never as a message: the SR's call with "chce
  modrú" is a fact-only contact (§5.1) plus, if Michal needs it, a message. "Naposledy" moves; the locked step does not.
- **The client wants to discuss details with the manager while a task is open**: no second task (D4). The SR writes it
  as a message (quick chip "Klient chce riešiť detaily priamo s tebou"). The manager decides, as Michal described:
  - he calls the client and **records that call** on the deal (fact-only; "Naposledy" shows his call), gets the
    details, finishes the task, and the SR continues;
  - or he takes the client over (§6.9: the task ends in the same transaction, he sets his own step, e.g. "Zavolať –
    zistiť detaily k návrhu"); he can hand the deal back to the SR later with a normal owner change.

### 6.3 Manager finishes (DONE)

**"Hotovo"** on the task. The dialog asks for each ticked content:
- Cena → amount + breakdown (pre-filled from `Lead.price`/`priceNote`); saved to `Lead.price`/`priceNote` (same rules
  as the price popup: a new amount without a breakdown clears the old breakdown) and into `result.price`.
- Návrh → pick one or more non-deleted designs **with a URL** (created in the design card; revalidated under the Lead
  lock) → `result.designs` with the current version.
- Iné → answer text → `result.answer`.
- It shows what the owner gets: "Jana dostane: **Poslať cenu · teraz**".

Transaction: status DONE, result, `TASK_DONE` (meta = result + `fp`) → unlock: step date = business today → one bump.
The deal leaves "Čaká" and lands in the owner's Na dnes (Michal: the time is tracked normally from that moment; the
manager does not pick a date).

### 6.4 SR sends (R07, W3-R2-03)

"Čo sme poslali" on a deal with unconsumed results (§6.13):
- **Offers each pending item** as a line — "☑ Posielam cenu od Michala (1 285 €)", "☑ Posielam návrh od Nikolasa
  (Variant A)" — and pre-ticks the matching contents and exactly the returned designs (not "all unsent designs"). Every
  ticked line becomes an entry in `meta.fulfils`; unticking it means the send does not use that item.
- **One send, one price** (W3-R3-03): at most one PRICE item can be ticked (the newest is pre-ticked); an older pending
  PRICE item is offered as "☑ Neposielam — nahradená novšou cenou" in the same save. The same for two items of the same
  design id (an older version returned earlier). Two different returned prices never both count as sent.
- **What remains pending decides the next step** (§5.1, W3-R3-01): if items stay pending after this send (e.g. the
  price is sent, the návrh not yet), the dialog does not offer the usual "Zavolať, či prišlo"; the step stays "Poslať
  návrh" (date and note editable) and the dialog says "Ostáva: návrh Variant A". The SR can instead dismiss the rest in
  the same save ("Neposielam" + reason), and then the follow-up call is offered as usual.
- **Compares with the current state** before saving:
  - the deal's price differs from the returned one → "Michal vrátil 1 285 €, aktuálna cena je 1 300 €" — the send uses
    the current price only after the SR ticks "Posielam aktuálnu cenu";
  - a returned design was deleted or has no URL → it cannot be ticked; the dialog says why;
  - a returned design has a newer version → shown as information; the send snapshots the current version.
- The server validates `fulfils` under the Lead lock: the task is a DONE HELP task of the same lead, each named content
  is in its result **and** in the send, each design id is in both. Historical entries never carry `fulfils`.
- `OFFER_SENT` remains the truth of what the client got. The send's follow-up becomes the next step as today.

### 6.5 Manager does it himself

**"Vybavil som to sám"** on an OPEN HELP task = the "Čo sme poslali" dialog (with the result fields) as **one command**
(key on `TASK_DONE`, §5.5): the result is saved, the send is recorded as his with `fulfils` naming this task, the task
is DONE, the lock ends, and the send's follow-up becomes the owner's step ("Zavolať · +N dní"). If any part fails,
nothing is committed.

### 6.6 Manager declines (D16)

**"Zamietnuť"** with a required reason → DECLINED, `TASK_DECLINED`, unlock: the SR's step stays what it was ("Poslať
cenu" — it still has to happen), date = business today. Row: `Poslať cenu · ✗ Michal: „zavolaj im a zisti, čo
chcú" · dnes`. (Michal would rarely decline — he would call the client and then fill the price; declining exists so
nothing gets stuck.)

### 6.7 SR cancels

**"Zrušiť úlohu"** with a required reason, in the dialog that also offers the new step and date (default: the locked
step, today). One command (cancel + change, §5.1).

### 6.8 Handover request (HANDOVER, D8) and "Chcú objednať" (D15)

- SR: **"Odovzdať manažérovi"** on her deal when **no task is open** (with a HELP task open, see §6.2) → required note
  ("chce riešiť technické detaily", what they want to order) → HANDOVER task, her step stays and is locked.
- Manager **"Preberám"** → the shared owner transition (§6.10): owner = manager, task DONE, `DealOwnership(HANDOVER)` +
  `OWNER_CHANGED`, and in the same dialog he sets **his own** step and date (default: the locked step, today). The SR
  loses access immediately; the deal appears in her História.
- Manager **"Nie, pokračuj ty"** with a reason → DECLINED, unlock, her step due today, row shows the reason.
- **"Chcú objednať" / "Idú do toho"** reply: recorded as the contact it is (outcome `WANTS_TO_ORDER`), **not
  terminal** — the SR picks a normal next step like for any other reply (the manager on his own deal likewise). After
  saving, the sheet offers "Odovzdať manažérovi" — a separate command with its own key. The intermediate state (deal
  with a step, no task) is valid, so a failure between the two needs no recovery. The automatic ORDER request and the
  `ORDER` step kind are removed; every writer of `ORDER` goes (`leadFlow.ts`, `clientReplies.ts`).

### 6.9 Direct takeover (no task needed)

Manager on any deal: **"Preberám klienta"** → note, his step and date (default: the current step, today) → the shared
owner transition (§6.10) with reason `TAKEOVER`, unless a HANDOVER task is open (then it is an accepted handover). The
dialog names an open task and what happens to it. He can give the deal back later with a normal owner change.

### 6.10 The shared owner transition: takeover, owner change, bulk transfer (R09, D6, W3-R2-08, W3-R2-11)

Every owner change of a deal — handover accept, direct takeover, the owner select, bulk transfer — goes through **one**
domain transition, so the same business outcome is always recorded the same way:

| New owner | Open HELP task | Open HANDOVER task | `DealOwnership.reason` |
|---|---|---|---|
| another SR (not a resolver) | stays OPEN, lock continues, requester stays; the dialog shows "Úlohy pôjdu: [Michal ▾]" to change the assignee | stays OPEN (the new owner's deal still waits for a manager's decision) | `CHANGE` / `BULK` |
| a manager / admin (resolver) | CANCELLED "klienta prevzal X"; the locked step stays as his plain step, date today (Michal: *"it will be just Poslať cenu"*) | **DONE — an accepted handover**, whichever control he used | `HANDOVER` when a HANDOVER task was open, else `TAKEOVER` (his own action) / `CHANGE` / `BULK` |
| nobody (nepriradené) | CANCELLED "obchod bez vlastníka"; the step stays as a plain step | CANCELLED "obchod bez vlastníka" | `CHANGE` / `BULK` |

Returned results (DONE, not yet used) follow the deal to the new owner. Each lead's owner change, task transition,
`OWNER_CHANGED` and `DealOwnership` row are **atomic together, with one revision bump per lead**.

**Bulk transfer keeps its batches of 200** (as today, `transferDealsAs`): one click already moves everything that
matches, batch after batch; each batch is its own transaction; a failure reports how many were already moved, and a
retry with the same `operationId` (and the same `bulkFp`) continues (§5.5). Whole-operation atomicity is not wanted.

### 6.11 Reopen — not a task (D13)

The manager reopens a closed deal with the existing "Znovu otvoriť" (`reopenDealAs`, now with `expectedRevision`). The
SR has no in-app way to ask in wave 3; a future *request* covers it (backlog BL-01).

### 6.12 Closing, deactivation, role change, revert

- Closing (WON / LOST / UNREACHABLE) with an OPEN task → the dialog names the task; cancel + close in one command
  ("obchod uzavretý"). The same save dismisses every still-pending returned item with the fixed reason "obchod
  uzavretý" (secondary `TASK_RESULT_DISMISSED` rows, W3-R3-04). Reopening revives neither the task nor the items.
- A deal moved to **nobody** keeps its pending items (the step stays the send step); a manager may send or dismiss them
  while it is unassigned (§5.2).
- **Deactivation and role change** (D14): `lib/commands/admin.ts` today releases only uncalled NEW contacts and merely
  *counts* deals. Wave 3 adds a refusal (locks: §5.5): the user owns open deals (ACTIVE/SNOOZED) → "Najprv presuň N
  obchodov"; the user is the assignee of OPEN tasks → "Najprv presuň N úloh" (reassign). The same for a role change that
  removes `deals.receive` or `requests.resolve`. Closed deals keep their owner (history, statistics).
- **First-call revert** cannot happen once a task exists: task creation bumps `Lead.revision`, and
  `revertCallResultAs` requires the CALL's `leadRevision == Lead.revision`. No task handling is added to revert; the
  revert itself writes `DealOwnership(REVERT)`.

### 6.13 What the SR sees after a task closes (R06, W3-R2-03, W3-R2-04, W3-R2-09)

A result that came back is **unconsumed** until the SR uses it or says she will not:

| Item | Pending while | Consumed by |
|---|---|---|
| PRICE (one per task) | no non-reverted `OFFER_SENT` fulfils it and no dismissal names it | that send (email or phone price), or "Neposielam" |
| DESIGN (one per returned design) | the same, for that design id | that send, or "Neposielam" |
| OTHER (an answer) | no dismissal names it | "Beriem na vedomie" — a button, or a pre-ticked line in the SR's next contact / step change (below) |
| DECLINED (a reason) | the same rule as OTHER | the same |

- **All pending items are shown together** — one row line aggregates them, grouped by who returned them
  (`closedById`): `✓ cena 1 285 € (Michal) · ✓ návrh Variant A (Nikolas)`; one name at the end when all are from the
  same person. The task card lists them separately. A newer task closing never hides an older item (Michal: this way it
  resolves without re-asking).
- **Every item is decided on its own** (W3-R3-02): "Neposielam" (PRICE / DESIGN, reason required, e.g. "klient už
  nechce") and "Beriem na vedomie" (OTHER / DECLINED) write `TASK_RESULT_DISMISSED` naming exactly the chosen items —
  dismissing návrh B leaves the price and návrh A untouched. History, like every other decision (D19).
- **The deal cannot forget a pending price or návrh**: its step stays the send step until every such item is sent or
  dismissed (§5.1, I10), so it keeps appearing in Na dnes by its date like any other step.
- Crossing out the send that consumed a result ("Opraviť") makes the result unconsumed again; re-recording the send
  offers it again.
- **Nothing is inferred from timestamps.** For OTHER / DECLINED the action sheet and "Zmeniť krok" show a pre-ticked
  line "☑ Beriem na vedomie: odpoveď od Michala"; saving writes `TASK_RESULT_DISMISSED` in the same transaction (no key
  of its own; part of that command's `fp`). Unticked, the line stays. (A rule like "the next step change after the
  task closed" would be wrong: `createdAt` is the transaction's start time, so a save that waited on the lock can look
  older than the task it follows.)
- Unlocking (finish, decline, cancel) writes no planning row of its own; the `TASK_*` row records it.
- The results themselves stay readable forever on the task card (closed tasks listed under the open one, collapsed).
- Later, "what they want" and "what I sent" are planned as tick lists (backlog BL-03); this aggregation already matches
  that direction.

## 7. Lists, counters, dashboard, História (R11, R12, R16, W3-R2-14)

**One predicate per pill, shared by its list and its count.** Each pill is a function
`(viewer, scope, filters) → where/SQL`; the list query and the count query call the same function with the same
inputs, so they cannot disagree. `getDealCounts` receives the same inputs as the list (scope, owner, status, search,
handed-off-by) — today it takes only scope/owner/handed-off-by.

| Pill | Rows | Honours |
|---|---|---|
| Na dnes, Všetko, step-kind pills, "Dostali …" | deals | scope, owner, status, search, handed-off-by; step-kind pills exclude locked deals (§5.3) |
| **Čakám na manažéra (n)** | deals in my scope with an OPEN task | scope, owner, search; all open statuses |
| **Pre mňa (n)** — shown only to resolvers | OPEN tasks where `assigneeId = me`, any owner, oldest first, age red after 2 business days; shows contents, owner, company, text, 💬 | search only; its link **explicitly clears** every filter it ignores — owner, status, handed-off-by (`from`), paging — because an inbox is not a slice of my deals (`dealsHref()` keeps `from` unless told to clear it) |

Manager dashboard "Čaká na mňa" = the "Pre mňa" query (replaces `prisma.dealRequest` in
`lib/queries/today/manager.ts`). Tests compare every count with the full unpaginated list under search, every status
and every owner filter — not just the defaults.

**História (SR)** — `/dashboard/pipeline/historia`: deals that moved away from me. The query itself enforces
`DealOwnership.fromUserId = me`, `reason ≠ REVERT`, the row belongs to the deal's current pipeline period
(`DealOwnership.createdAt >= Lead.pipelineEnteredAt`), current owner ≠ me **and** the canonical deal predicate
`DEAL_WHERE` (`pipelineEnteredAt IS NOT NULL AND deletedAt IS NULL`). So a reverted first call never appears — not
even when the same contact later becomes a deal again for someone else — and neither does a deleted contact. **One row per deal** (its latest move away from me, `(createdAt, id)` order): company, date,
who, note; no link to the live deal. Opening a handed-over deal would need a **new** permission `deals.viewHandedOver`
(no role holds it) — it does **not** exist in code today. Ownership history starts at rollout; no invented backfill
rows.

Deal detail: one **task card** (the open task with text, messages, actions; unconsumed results; closed tasks collapsed).

## 8. What disappears

`DealRequest` and everything around it: `lib/domain/dealRequests.ts` (`ensureOpenRequest`, `resolveOpenRequests`,
`closeRequestsForStatus`), `createDealRequestAs`, `cancelOwnDealRequestAs`, `resolveDealRequestAs`,
`lib/queries/pipeline/requests.ts` (`openRequestsWhere`), `RequestsCard`, the request step inside `InteractionSheet`
(`REQUEST_NOTE_REQUIRED`, `requestNote`), `REQUIRE_NOTE` in `dealWork.ts`, the requests view/pill and kind sub-filter,
the automatic DESIGN request on `WANTS_DESIGN` (`lib/commands/calls.ts:142`, `dealWork.ts:218`) and ORDER on
`WANTS_TO_ORDER`, the auto-closing in send / price / WON / reopen / revert, `REQUEST_KIND_LABEL`, the `request` field
of `DealFollowUpState`, `openRequestCount`, the terminal handling of `WANTS_TO_ORDER`, `NextActionKind.ORDER`, the
REOPEN request and `ClosedPolicy "reopenRequestOnly"` (D13). `caps.createRequests` / `resolveRequests` become "may
ask" / "is a resolver". UI text that names requests changes too: the manager's warning in `OfferSentDialog.tsx`
("…vybav radšej požiadavku") points to the task's "Hotovo".

## 9. Tests (add to `prisma/backfill/check-concurrency.ts` and the parity/unit checks)

- create: owner only; not telesales; not a resolver on own deal; not on a closed deal; second OPEN task → error;
  snoozed deal wakes; locked date empty; one bump; retries per §5.5 (same key same `fp` / changed text, contents,
  assignee, step).
- lock: every writer from §13.2 returns `STEP_LOCKED` while locked; fact-only contact of every kind (call, no answer,
  reply, SMS, phone price) and a send succeed, move "Naposledy" and leave the step unchanged — including a contact the
  manager records on the SR's deal; cancel + change (snooze, lost, bad number, replan, manager status select) = one
  transaction, one bump.
- overlap: a PRICE send / phone price on an open PRICE task, a návrh send on an open DESIGN task, and both on a combined
  task → rejected without a choice; "keep open" records fact-only; "už to netreba" cancels + sends + sets the follow-up
  atomically; unrelated contents need no choice.
- finish: PRICE without amount / DESIGN without a valid URL-bearing design → error; DONE saves `Lead.price` and the
  result; step date = today; "Vybavil som sám" writes exactly one `OFFER_SENT` with `fulfils` and closes the task
  atomically; retry with a changed amount / design / follow-up date → conflict.
- decline / cancel: reason required; unlock; decline keeps the step.
- results (§6.13): PRICE done → DESIGN done → neither sent: both shown; sending the price with `fulfils` consumes only the
  price; a backdated historical price send consumes nothing; a generic send without `fulfils` consumes nothing; crossing
  out the consuming send brings the result back; "Neposielam" needs a reason, writes `TASK_RESULT_DISMISSED`, one bump,
  retry-safe; an OTHER answer / decline reason stays until "Beriem na vedomie" (button or the pre-ticked line in the next
  contact), including when that save waited on the lock behind the decline; `fulfils` naming another lead's task, a non-DONE task or a content not in the result → rejected.
- handover: accept via the task card **and** via the owner select both give task DONE + `DealOwnership(HANDOVER)`;
  decline unlocks; "Chcú objednať" is non-terminal and creates no task.
- owner transition (§6.10): to SR / manager / nobody with HELP and with HANDOVER open, single and bulk; one
  `DealOwnership` row per changed owner; per-lead atomicity within each batch; a failing later batch reports the moved
  count; a retry with the same `operationId` continues without moving anything twice.
- locks (§5.5): create vs deactivation of the assignee; reassign vs deactivation / role change; finish vs reassign; bulk
  transfer vs a task reassignment; deactivation / role change refused with open deals or assigned OPEN tasks.
- freshness and double submit: every status / owner / step / task command with an old `expectedRevision` → `STALE`; a
  double click on takeover, owner change, status change, reopen, dismiss → the second returns the first success.
- sections & views: `clientSection` ↔ `TODAY_SQL` and `isStepLocked` ↔ `STEP_LOCKED_SQL` parity over {no task, OPEN
  HELP, OPEN HANDOVER, DONE, DECLINED, CANCELLED} × {ACTIVE, SNOOZED, closed}; a locked deal appears in no actionable
  view (§5.3); every pill count = its full list under all filters; an SR never sees a foreign task.
- História: immediate first-call revert, the revert → later re-entry as another owner's deal (must not appear for the
  first SR), the deal moving back to the SR, a deleted call-stage contact — none appears wrongly; one row per deal.
- pending items (W3-R3-01…04): price sent, návrh not → the step stays "Poslať návrh" and a step change to a call is
  rejected unless the návrh is dismissed in the same save; dismissing one design of two leaves the other and the price
  pending; dismissing the price leaves the návrh; two pending prices → one send can fulfil only one, the other is
  dismissed as superseded; closing dismisses all pending items with "obchod uzavretý" and reopening does not revive
  them; a manager can dismiss on an unassigned deal; a phone price can fulfil a PRICE item.
- bulk: a retry with the same `operationId` and a different target / filter / assignee choice → `IDEMPOTENCY_CONFLICT`.
- follow-up fingerprint: same key with a changed phone price, overlap choice, `cancelTask`, step note or dismissed
  items → `IDEMPOTENCY_CONFLICT`.
- inbox link: from any filter state, "Pre mňa" produces a URL without owner / status / `from` / page (URL normalisation
  test).
- sheet notes: "Čo povedali" rejected for "bez kontaktu"; "Poznámka ku kroku" rejected for closing outcomes and in
  fact-only mode.
- `TASK_*` rows never change "Naposledy".
- HTTP role checks: SR, manager, admin, telesales, scout, scout leader on the new actions and pages.
- sheet notes (F1): "Čo povedali" lands only in the contact's history row, "Poznámka ku kroku" only in
  `Lead.nextActionNote`, for every outcome; an empty step note falls back to the step's default text; in fact-only mode
  (locked) the step note is not accepted; a retry with a changed step note → `IDEMPOTENCY_CONFLICT`.

## 10. Order of implementation

0. **Fresh test database (D18, Michal 2026-09-19).** Before any wave-3 schema work:
   - **Verify the target is the test branch** — endpoint `…nhww8x`, database `neondb`, different from the commented
     production URL in `.env`, test-only schema fingerprint present — exactly the triple guard of
     `prisma/dummySeeds/seedTestWorld.ts`. Never print the connection string.
   - Delete the whole content (all app tables).
   - Seed **users** `admin` (ADMIN), `sales` (SALES_REP), `manager` (MANAGER), `telesales` (TELESALES), `scout`
     (SCOUT), `scoutleader` (SCOUT_LEADER), all with password `password123`. Teams: the scout is a member of the scout
     leader's team; `telesales` is a member of a team led by `manager`, so its positive first calls route to the
     manager (today's real setup, Timea → Michal).
   - Seed **contacts only** — about 50 contacts as a scout adds them (`createdById = scout`, NEW, unclaimed, no calls,
     no deals). No leads in the call or deal stage, no requests, no sends.
   - Build it as a minimal mode of the existing seed script (same guard). Record the run in the progress tracker.
1. **Schema on test.** Re-run the endpoint check. After step 0 there are no `DealRequest` rows, no `REQUEST_*`
   activities and no lead with `nextActionKind = ORDER` — verify these three counts are 0. **Never** use
   `--accept-data-loss` (no exception). If `prisma db push` still refuses (e.g. an enum value removal), generate the SQL
   diff outside the repository, review every statement (enum recreation: check every remaining value and every default
   / cast), apply it with `prisma db execute`, and then `db push` must report "already in sync". Generate the client,
   then record the verified test delta in `db-changes.md`.
2. Domain: `lib/domain/tasks.ts` — **pure and client-safe** (types, contents → default step, result and `fulfils`
   schemas, `fp` builders, `isStepLocked`; no Prisma import); `lib/domain/taskMutations.ts` (create / message / finish /
   finish+send / decline / cancel / reassign / dismiss / accept handover, `assertStepUnlocked`, the shared owner
   transition, `recordOwnership`); `STEP_LOCKED_SQL` server-only in `lib/queries/pipeline`; remove the request machinery;
   the section rule + SQL twin + every actionable view (§5.3) with parity.
3. Commands + actions (`lib/commands/tasks.ts`), `expectedRevision` and keys on the manager commands (§5.5), the
   fact-only, overlap and cancel + change branches (§5.1), the lock sets (§5.5), the deactivation / role-change refusal
   (§6.12), the replay fingerprints, bulk `operationId`.
4. Queries: task on rows/detail, lock state, unconsumed results (§6.13), "Pre mňa", "Čakám", shared pill predicates and
   counts (§7), História, dashboard.
5. UI: ask dialog, task card, finish / decline / cancel / reassign / "Neposielam" dialogs, handover / takeover dialogs,
   owner-change and bulk-transfer dialogs with the task column, lock and overlap prompts in the sheet and the send
   dialog, the `fulfils` lines in "Čo sme poslali", pills, the two note fields in the sheet (F1). Fix
   `DesignTrackingCard` on the way (R17): check every
   command result, show the error, keep the inputs open on failure, and tell the manager a návrh needs a URL before
   "Hotovo".
6. Docs (domain files describe what exists), progress tracker with honest check results, full check pass
   (`code-standards.md` §7), HTTP role checks, a two-account click-through (SR + manager) on desktop and phone.

**Production** (later, a separate approved session; W3-R2-02). `db-changes.md` is the only ledger. After wave 3 is
verified on test: remove the round-1 `DealRequest` / `REQUEST_*` rows and the wave-2 `ORDER` row from the owed delta
(production will never receive them), then measure the live schema on a fresh production duplicate and generate the
change from that baseline to the **final target**. The data steps still keep their order — the round-1 assignment
backfill, then the wave-3a conversion of old sends and the removal of the old send columns (`db-changes.md` §3.3) —
and the rehearsal states which app version runs at each point (freeze, deploy, contraction). Some earlier waves changed
data shapes that need reordering on the live data; that is planned in the ledger, not here.

## 11. Answered questions (Michal, 2026-09-19)

1. **Reopen** — not a task; later *request* concept (D13, BL-01).
2. **Iné** — stays (D17).
3. **Date after "Hotovo"** — none to pick; the step is due from the moment the task is finished and tracked normally.
4. **Reassigning a task to another manager** — yes (D17, `TASK_REASSIGNED`).
5. **`--accept-data-loss`** — never, no exception; the test database is wiped and re-seeded instead (D18).
6. **Not using a returned result** — must be history (D19, "Neposielam").
7. **Price and návrh at different times** — both results stay visible together until used (§6.13).
8. **Two note fields in the sheet (F1)** — yes, in wave 3.

## 12. Known limits (accepted) and related findings

**Known limits.**
- A fixed client appointment cannot be planned while the step is locked, nor next to a "send" step in general (D11,
  BL-02). The SR writes it into a task message, visibly — it is not scheduled or alerted.
- One open task per deal: a second, unrelated ask waits until the first closes (or is added as a message).
- A combined PRICE + DESIGN task has one completion time; no separate time-to-price / time-to-návrh (BL-07).

**Finding F1 — the step note (verified in code, 2026-09-19; decided: fix in wave 3).** The interaction sheet has a single note
field (`InteractionSheet.tsx`, `note`). `logFollowUpAs` writes it as the contact's note (history) **and**, through
`dealStateForFollowUp` (`lib/domain/leadFlow.ts`), as `Lead.nextActionNote` for `POSITIVE`, `NO_ANSWER`, `CALL_AGAIN`
and `SNOOZE`. For `WANTS_QUOTE` / `WANTS_DESIGN` / `WANTS_TO_ORDER` the step note is a fixed text ("Poslať cenu", …)
and the typed note goes only to the history. "Zmeniť krok" (contact NONE) writes it only to the step. So "what the
client said" and "what I will do" share one field, and whether the typed text reaches the step depends on the outcome.
**Fix (wave 3, Michal 2026-09-19):** the follow-up sheet (`InteractionSheet`, incl. "Zmeniť krok") gets two fields —
**"Čo povedali"** (saved only as the contact's note in the history) and **"Poznámka ku kroku"** (saved only as
`Lead.nextActionNote`, for every outcome; pre-filled with the step's current note when the step is kept, otherwise with
the kind's default text such as "Poslať cenu", which is also used when the field is left empty). `logFollowUpAs`
gains a separate `stepNote` input; `dealStateForFollowUp` uses it instead of the contact note; both go into the replay
fingerprint (§5.5). While the step is locked the sheet shows no step note (fact-only). The first-call screen
(`/dashboard/calls`) is unchanged. The ask dialog in §6.1 already has its own step note. Fields that have nowhere to
go are hidden and rejected by the server (W3-R3-09): "Čo povedali" for "bez kontaktu – len naplánovať" (no contact row
exists), "Poznámka ku kroku" for outcomes that close the deal (no step) and in fact-only mode. No fake contact or note
rows are created.

**Finding F2 — price and návrh together (verified).** One `OFFER_SENT` row already holds `contents` (e.g.
`[PRICE, DESIGN]`), the price snapshot and the design snapshots (`lib/domain/offers.ts`); "Čo sme poslali" can tick
both; a `SEND_DESIGN` step is completed when a návrh is ticked (`OfferSentDialog.tsx:82-83`). Missing: one `Lead.price`
per deal — **no price per návrh**; the "Cena & ponuky" card does not show which price went with which návrh. A core
offer-model change — **not in wave 3** (backlog BL-03). Michal's direction for it: pick what the client **wants** by
ticking contents, and what **I sent** by ticking contents.

---

## 13. External review round 1 (2026-09-19) — resolution log

Source-only review by ChatGPT. Michal's answers are summarised in the table.

### 13.1 Findings

| ID | Finding (short) | Michal | Resolution |
|---|---|---|---|
| W3-R01 | a HELP task blocks an urgent handover (one-task rule) | the manager closes the task and takes over / or calls, finishes, lets the SR continue / can give the deal back later | no second task: SR writes a message; manager records his call and finishes, or takes over — §6.2, §6.9 |
| W3-R02 | deactivated owners are not reassigned; work can return to nobody | block deactivation until deals and tasks are moved; demotion = new account; later a "transferred" marker + filter | D14, §6.12; marker → BL-11 |
| W3-R03 | "Chcú objednať" → handover has no retry contract | order means nothing now; remake later | D15, §6.8: non-terminal reply + separate handover command; ORDER removed; BL-09 |
| W3-R04 | the lock cannot simply guard the current commands | why can't the SR snooze/close? | she can (D5): fact-only branch + explicit cancel + change — §5.1 |
| W3-R05 | a locked step still looks actionable elsewhere | fix | one lock predicate (TS + SQL twin) in every actionable view + empty locked date — §5.1, §5.3 |
| W3-R06 | "✓ od Michala" disappears after an unrelated call | valid, do it | explicit consumption, `closedById` — §6.13 (reworked in round 2) |
| W3-R07 | send can silently use a different price/design than returned | fix | offer returned items, compare and confirm — §6.4 |
| W3-R08 | decline/cancel activates an impossible step | the step should stay "Poslať cenu" — it still must happen | D16, §6.6 |
| W3-R09 | transfer to another manager / nobody undefined | bulk: choose where tasks go; to a manager the task disappears, the step stays | D6, §6.10 |
| W3-R10 | cancel + change and manager selects are not stale-safe | fix simply, no slop | `expectedRevision` on every such command; one combined command — §5.1, §5.5 |
| W3-R11 | wrong claims (`deals.viewHandedOver`, deactivation, revert) | fix the docs | §6.12, §7 |
| W3-R12 | pill counts need exact predicates | do it | shared predicate per pill — §7 |
| W3-R13 | only wave 3 alone is additive; the test drop may need data-loss acceptance | first allowed on test only — **withdrawn in round 2** | D18, §10 steps 0–1 |
| W3-R14 | I6 wording wrong | fix | I6 — §5.4 |
| W3-R15 | undated CALL conflicts with the picker | fix | locked steps have no date; date set on unlock — §5.1, I8 |
| W3-R16 | ordering, História duplicates, metrics | fix | `(createdAt, id)`; one História row per deal; index; BL-07 — §5.6, §7 |
| W3-R17 | design card discards failed input | do it | fix in the wave-3 UI step — §10 step 5; URL revalidated at finish — §6.3 |
| W3-R18 | fingerprints need an exact payload | fix | table in §5.5 incl. the two existing replay gaps |

### 13.2 Writer inventory (checklist for §5.1 and I6)

| Current path | Writes | Wave 3 treatment |
|---|---|---|
| `lib/commands/calls.ts:93-147` | first-call `status`, `nextAction*`, `ownerId` | no task can exist in the call stage; add `DealOwnership(HANDOFF)`; remove the automatic DESIGN request |
| `lib/commands/dealWork.ts:140-219` + `lib/domain/leadFlow.ts:197-299` | every follow-up contact / status / step, snooze, close, phone price | fact-only, overlap and cancel + change branches (§5.1); remove request / ORDER writes; "Chcú objednať" non-terminal (§6.8) |
| `lib/domain/dealMutations.ts:191-209,240-268,282-333` | direct step, close / lost, reopen, status | guard + cancel + change; `expectedRevision` and keys on status, lost, reopen |
| `lib/domain/offerMutations.ts:97-198` via `lib/commands/offers.ts:61-88` | send, optional follow-up step, current price | while locked `followUp = false`; overlap choice; `fulfils`; finish + send is its own command (§6.5) |
| `lib/domain/dealMutations.ts:335-353`; `lib/commands/pipeline.ts:70-87,149-220` | single and batched bulk owner changes | the shared owner transition (§6.10), one `DealOwnership` row per changed owner, `expectedRevision` + key on single changes, `operationId` on bulk |
| `lib/commands/history.ts:63-120` | first-call revert resets status / owner / step | unreachable after a task (§6.12); writes `DealOwnership(REVERT)` |
| `lib/commands/admin.ts:16-47,62-120` | releases uncalled NEW contacts only | refuse deactivation / role change with open deals or assigned OPEN tasks (D14, locks §5.5) |
| `lib/commands/tracking.ts:38-117`; `lib/domain/dealMutations.ts:139-168`; `lib/domain/offerMutations.ts:203-220` | designs, current price, send corrections | no lock conflict; the returned result may become stale → reconciled at send (§6.4); a crossed-out send un-consumes (§6.13) |
| `lib/domain/clientSections.ts:69-74` | none (a due SNOOZED deal is classified as awake) | no new wake-up write; the ask on a SNOOZED deal sets ACTIVE explicitly (§5.3) |

### 13.3 Future compatibility (from the review, still valid)

- **Several managers:** `assigneeId` is the accountable inbox owner, `closedById` the actual resolver; the UI never
  claims the assignee delivered something another resolver did. An SR never gains access because she once created a
  task on a deal that later moved.
- **Developer feature:** a separate object with its own access and queue (D10); it must not inherit SR deal visibility
  from `DealTask.assigneeId`.
- **Per-návrh price and notes:** `DealTask.result.price` is a snapshot of a manager answer, not an offer model (F2).
  Task messages belong to one request and must not become the only place for client requirements; wave-4 notes stay
  deal-level.
- **No generic task engine** and no second independent next-step queue for future-proofing.

## 14. External review round 2 (2026-09-19) — resolution log

Second source-only review by ChatGPT (re-read the context files, round 2, this proposal and every writer of
`Lead.status`, `Lead.ownerId`, `Lead.nextAction*`). Verdict: accept the task + lock model with fixes. Michal's answers
are summarised; where a simpler fix than the reviewer's was chosen, the table says so.

| ID | Finding (short) | Michal | Resolution |
|---|---|---|---|
| W3-R2-01 | the test step allowed `--accept-data-loss`, which the repository forbids | remove the exception; wipe the test DB and seed users + scout contacts first, after checking it is test | D18, §10 steps 0–1; reviewed SQL via `db execute` if `db push` still refuses |
| W3-R2-02 | production would install `DealRequest` / `ORDER` only to drop them | yes; `db-changes.md` is the main ledger; compare with the live DB before pushing; some waves need data reordering | §4.3, §10 "Production"; round 2 §4 now defers to the ledger |
| W3-R2-03 | result consumption inferred from `createdAt` + contents is wrong (backdated or generic sends) | fix | explicit `OFFER_SENT.meta.fulfils`, validated under the lock; crossing out un-consumes (simpler than a second `taskId` on the send: one send can use results of two tasks) — §4.2, §6.4, §6.13, I9 |
| W3-R2-04 | a newer closed task hid an older unused result | aggregate, so it resolves without re-asking; later "they want / we sent" ticks | all unconsumed results shown together — §6.13, D4 |
| W3-R2-05 | sending exactly what the task is producing strands the manager's work | fix | overlap choice required: keep open / cancel as not needed / finish + send — §5.1 |
| W3-R2-06 | the manager's real call must not become a task message | great catch; "Naposledy" can move without changing the step | every real contact is recorded fact-only; messages are internal — §5.1, §6.2 |
| W3-R2-07 | user locks for D14 not race-safe | fix | lock table per command, bulk pre-read + sorted locks + re-read — §5.5 |
| W3-R2-08 | handover accepted via the owner select was recorded as CANCELLED | fix | one shared owner transition: to a resolver with an open HANDOVER = DONE + `HANDOVER` — §6.10, D8 |
| W3-R2-09 | "Skryť" had no command / audit / retry contract | didn't know what it was; dismissal must be history | replaced by "Neposielam" / "Beriem na vedomie" = `TASK_RESULT_DISMISSED` with reason, key, bump — D19, §6.13 |
| W3-R2-10 | double submit undefined for takeover, owner, status, reopen, dismiss, bulk | fix, definitely | full matrix; key looked up before the revision check; bulk `operationId` — §5.5 |
| W3-R2-11 | "one transaction" contradicted the batched bulk transfer | keep batches of 200; maybe a "transfer all" button later | per-lead atomic within batches; partial progress kept — §6.10 (the "transfer all" idea turned out to exist already — W3-R3-11) |
| W3-R2-12 | a client-safe module cannot export Prisma SQL | fix | pure `tasks.ts` + server-only `STEP_LOCKED_SQL`, twins with parity — §5.3, §10 |
| W3-R2-13 | "nové" badge without a read state | — | neutral "Posledná správa: …" — §6.2 |
| W3-R2-14 | História could show reverted or deleted contacts | fix | `DEAL_WHERE` in the query + tests — §7, §9 |
| W3-R2-15 | other docs still point at rejected behaviour | clean up | round 2 ORDER sentence and planning status corrected; the old progress-tracker entry marked SUPERSEDED (Michal's OK) |

## 15. External review round 3 (2026-09-19) — resolution log

Third source-only review by ChatGPT. Verdict: accept the task + step-lock architecture; no redesign; findings 1–7
before coding. All thirteen were checked against this file and the code and accepted.

| ID | Finding (short) | Resolution |
|---|---|---|
| W3-R3-01 | a partly used result (price sent, návrh not) left the návrh only as a row marker — a hidden second queue | pending PRICE / DESIGN items fix the step kind to the send step until sent or dismissed; D3 narrowed accordingly — D3, D19, §5.1, §6.4, §6.13, I10 |
| W3-R3-02 | dismissal was per task, results are per item | items: PRICE per task, DESIGN per design, OTHER, DECLINED; `meta.items` on dismissals — §4.2, §6.13, I9 |
| W3-R3-03 | one send could claim two different returned prices | one PRICE item and each design id at most once per send; the older one dismissed as superseded in the same save — §6.4, I9 |
| W3-R3-04 | no lifecycle for pending results on close / unassign | closing dismisses them ("obchod uzavretý"), reopening does not revive; unassigned: a manager may send or dismiss — §6.12, §5.2 |
| W3-R3-05 | História could show a reverted handoff after a later re-entry | exclude `REVERT` and rows from before the current `pipelineEnteredAt` — §7 |
| W3-R3-06 | bulk `operationId` not bound to its payload | `bulkFp` checked before continuing — §5.5 |
| W3-R3-07 | the follow-up fingerprint was incomplete | one canonical full fingerprint for `logFollowUpAs` — §5.5 |
| W3-R3-08 | "every task Activity has a key" contradicted keyless secondary rows | exactly one keyed primary row per user mutation — §4.2, I3 |
| W3-R3-09 | two-note fields undefined for "bez kontaktu" and closing outcomes | hidden and rejected where they have nowhere to go — §12 F1 |
| W3-R3-10 | the inbox link kept filters it ignores | explicitly clears owner / status / `from` / paging; URL test — §7 |
| W3-R3-11 | "transfer everything" already exists (the batch loop runs until done) | statement and backlog BL-12 removed — §6.10 |
| W3-R3-12 | aggregated results attributed to one person | grouped by `closedById` — §6.13 |
| W3-R3-13 | `ui-context.md` pointed at the old D-22; round 2 §4 promised a clean additive `db push` | both corrected to point here and to `db-changes.md` |

