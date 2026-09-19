# Wave 3 — manager tasks with a step lock, handover, história, counters

Status: **the official wave-3 design (Michal, 2026-09-19); nothing implemented.** It replaces the "ticket" /
"požiadavky" design everywhere: `round2-deal-workspace.md` §2b, `planning.md` (round-1 `DealRequest`) and
`context/app-workflow.md` §6 point here instead of describing tickets. The external review (W3-R01…R18) and Michal's
answers are folded in; the resolution of every finding is logged in §13. Kept for the reasoning trail:
`wave-3-tickets-proposal.md` (models A/B/C/C′ and why each was rejected), Michal's backups in `backup/` (never edit or
delete them without asking; `backup/wave-3-task-proposal-final.md` holds the full review text with Michal's comments).

Audience: an AI implementing or reviewing this. Read `AGENTS.md`, `context/code-standards.md` (database rules),
`context/domain/database-map.md`, `context/domain/operations.md` and `context/ui-context.md` first. The decisions in §2
are Michal's; do not re-open them without asking. Anything this file does not cover → ask Michal, do not invent.
Ideas that are explicitly *later* live in `context/features/backlog.md`.

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
call (`clientSections.ts:68`), and the SR could keep editing a step that the app was hiding. Every later design
(tickets with a parked step, the "ball" on the step, independent tasks) failed on the same sync question. This design
removes the question with a **lock**: while the manager works, the SR's step cannot change. Background: §1a–§1d.

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

**Also real:** price and návrh asked together; the client calls the SR while the manager is still working ("chce
modrú"); the client gives up while the SR waits; a client asks the SR to talk to the manager directly while the manager
is already working on a task (§6.2).

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

### 1c. Designs considered and rejected (details: `wave-3-tickets-proposal.md`)

| Design | Idea | Why not |
|---|---|---|
| v1 / A — tickets + parked step | inbox Pre mňa / Od mňa / Vybavené, comment thread, a `WAITING_FOR_MANAGER` step kept in line with the open ticket, "two switches" resolution | the invariant "open ticket ⇔ parked step" broke in every review (parking, un-parking, several open tickets, a ticket closed while the step said otherwise) |
| B — "the ball" on the step | no task object; the deal's step gets an assignee | one slot only; a reopen step is impossible (closed deals have no step and are read-only for the owner); no structured history for statistics; a developer would need deal access |
| C — independent task, no parking | the task never touches the owner's step | returned work solved three ways at once (conditional step rewrite + `acknowledgedAt` + "Hotové" pill); opening a task silently cleared the step |
| C′ — the ball on the task | the task carries "whose turn" and comes back to the SR | Michal: it is a ticket anyway; the SR's step and the returned work are still two things to watch |
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
- **ORDER is not a kind of work** — "áno, ideme do toho" does not say what is being built; it is a handover (§6.8).
- **Order details** (what they ordered, agreed price, system, addons such as "EN jazyk") must stay on the deal: in the
  handover note now, as a pinned `FOR_BUILD` note from wave 4 (round 2 D-07/D-08).

## 2. Decisions (Michal, 2026-09-18/19)

| # | Decision |
|---|---|
| D1 | A **task** = the SR asks the manager for something. It is its own table with history. It is **not** the SR's next step. |
| D2 | **Step lock.** While a task is open, the deal's next step is frozen, enforced **on the server** (not only in the UI). To change the step, the task must be closed — in the same dialog and the same transaction (§5.1). |
| D3 | The frozen step **is the follow-up of the task**: when asking, the SR chooses what she will do when the manager delivers (default "Poslať cenu" / "Poslať návrh"; any step kind, including a custom one). When the task closes, that step becomes active and due now. |
| D4 | **One open task per deal.** Price and návrh together = one task with both contents ticked. |
| D5 | The SR may still snooze, close ("nemajú záujem") or replan while a task is open — **her decision, no manager approval** (Michal: otherwise *"i will just be doing clicking for them"*). The dialog says which task it cancels, and cancel + change are one transaction. Recording a contact (call, reply, SMS) and a send remain allowed without cancelling; they are facts. |
| D6 | Transferring the deal to another **SR** keeps the task; the new owner inherits it and its lock. Transferring it to a **manager** (a resolver) or to nobody closes the task and leaves the step as a plain step (§6.10). |
| D7 | On the **manager's own deal** there are no tasks. He simply has the step "Poslať cenu" / "Poslať návrh" and does it himself. |
| D8 | The **handover** ("kontaktujte ma kvôli detailom", "idú do toho") is a request the manager accepts or declines — a task of type HANDOVER. The manager can also take over any deal directly, without a task, and give it back later by a normal owner change. |
| D9 | No task is ever created or closed automatically by a call outcome, a send or a saved price. Telesales never create tasks. |
| D10 | The future developer role will get **its own project/communication feature**, not these tasks (backlog BL-04). |
| D11 | A client's fixed appointment ("pošlite cenu a zavolajte v pondelok") is **not modelled**. The app is a next-step machine, not a calendar; known limit (§12, backlog BL-02). The relative follow-up after a send already exists. |
| D12 | Ownership history (`DealOwnership`), the SR's História page and counters on every pill stay as agreed. |
| D13 | **Reopen is not a task.** Later, a separate concept *request* (backlog BL-01): placeable on any lead, even one that was reassigned away and sits in the SR's História; it asks the manager to do something (reopen; reopen and reassign). Wave 3 deletes the round-1 REOPEN request with `DealRequest`; until BL-01 the SR tells the manager outside the app. `ClosedPolicy "reopenRequestOnly"` loses its only caller and is removed. |
| D14 | **Deactivating an account is blocked** while the user owns open deals or has open tasks as assignee; the admin transfers them first (count + link shown). A role change that removes `deals.receive` or `requests.resolve` is blocked the same way — Michal prefers a new account over demoting someone with hundreds of leads. A rogue employee: change the password, transfer, then deactivate. |
| D15 | **"Chcú objednať" means nothing special now** (Michal: ORDER was pre-made for later products — SEO, marketing, social media — or as a step before WON; to be remade later, backlog BL-09). It stays a truthful reply but is no longer terminal: it records the contact and a normal next step; handing over is a separate, explicit action (§6.8). The `ORDER` step kind and ORDER request are removed. |
| D16 | A declined task leaves the SR's step as it was ("Poslať cenu" still has to happen), now unlocked and due, with the decline reason shown (§6.6). |
| D17 | "Iné" stays as task content. Tasks may be **reassigned** to another manager. |

## 3. Concepts (use these words consistently)

| Term (UI) | Meaning | Stored in |
|---|---|---|
| **Ďalší krok** (step) | the deal owner's next action. Unchanged meaning. | `Lead.nextAction*` (existing) |
| **Úloha** (task) | a request from the deal owner to a manager. Types HELP / HANDOVER. | new `DealTask` |
| **Zámok** (lock) | derived state: the deal has an OPEN task → the step is frozen | nothing extra — derived from `DealTask` |
| **Výsledok** (result) | what the manager delivered: price, návrh, answer | `DealTask.result` + the closing activity's meta |
| **Správy** (messages) | short back-and-forth on an open task | `Activity` rows with `taskId` |

UI wording: the SR clicks **"Požiadať manažéra"**; the manager's list is **"Pre mňa"**; the SR's waiting list is
**"Čakám na manažéra"**. The words *ticket* and *požiadavka* never appear in the UI.

## 4. Data (schema proposal — review before applying on test)

### 4.1 `DealTask` (replaces the test-only `DealRequest`; production never had it)

| Field | Type | Meaning |
|---|---|---|
| `id` | cuid | the UI says "úloha od 18. 9.", no number |
| `leadId` | FK Lead | the deal |
| `type` | `DealTaskType` = `HELP` · `HANDOVER` | no REOPEN (D13) |
| `contents` | `DealTaskContent[]` = `PRICE` · `DESIGN` · `OTHER` | HELP: ≥ 1, any combination. HANDOVER: empty. |
| `status` | `DealTaskStatus` = `OPEN` · `DONE` · `DECLINED` · `CANCELLED` | DONE = delivered / handover accepted; DECLINED = the manager said no; CANCELLED = the owner withdrew it, or it closed with the deal / an owner change |
| `text` | String (required, ≤ 2000) | what is asked ("e-shop, 200 produktov, SK+EN") |
| `requestedById` | FK User | who asked; never changes |
| `assigneeId` | FK User | the named manager who must act (active user with `requests.resolve`; pre-selected when there is one); can be reassigned (D17) |
| `createdAt` | DateTime | age in "Pre mňa"; never reset |
| `closedAt?`, `closedById?` | | when / who closed it (`closedById` is the actual resolver — may differ from the assignee) |
| `closeReason?` | String | required for DECLINED and CANCELLED; fixed text for closings caused by another action ("obchod uzavretý", "klienta prevzal Michal") |
| `result?` | Json, strict zod | `{ price?: { amount: moneyString, note: string \| null }, designs?: [{ id, label, url, version }], answer?: string }` — immutable record of what was delivered (the current `Lead.price` / design may change later) |
| `resultDismissedAt?` | DateTime | the owner hid the "✓ od …" line without sending (§6.13) |

Indexes: `(assigneeId, status, createdAt)` for "Pre mňa"; `(leadId, status)` for the lock and row badges.

**One OPEN task per deal** (D4): enforced in the command under the `Lead` row lock (race-safe: tasks are only created
inside the Lead-locked transaction). A partial unique index `("leadId") WHERE status = 'OPEN'` is a second guard only if
it can be kept without schema drift under the project's `db push` workflow — decide at schema review; never `migrate dev`.

### 4.2 Task history = `Activity` rows

- New nullable `Activity.taskId` (FK `DealTask`, indexed). Every task event writes one Activity row with `taskId`, the
  actor, the time, the text and the idempotency key. The task's history is `WHERE taskId = ?` ordered by
  `(createdAt, id)`; the same rows appear in the deal history.
- New `ActivityType` values: `TASK_CREATED`, `TASK_MESSAGE`, `TASK_DONE`, `TASK_DECLINED`, `TASK_CANCELLED`,
  `TASK_REASSIGNED` (category BUSINESS, not client contact). `REQUEST_CREATED` / `REQUEST_RESOLVED` are test-only
  (production never had them — verify in `db-changes.md`): remove them together with `DealRequest` after the
  inventory in §10, otherwise leave them unused.
- `TASK_*` rows are **not** in `LAST_TOUCH_TYPES` → they never change "Naposledy".
- `TASK_DONE.meta` carries the result snapshot (history rendering without a join). Every keyed task event stores the
  canonical fingerprint of what was submitted in `meta.fp` (§5.5).

### 4.3 Other schema

| id | Change |
|---|---|
| S-08 | `DealTask` + `DealTaskType`, `DealTaskContent`, `DealTaskStatus`; drop `DealRequest`, `DealRequestKind`, `DealRequestStatus` (test only) |
| S-09 | `Activity.taskId` + index; `ActivityType += TASK_*`; `ActivityType − REQUEST_*` if the inventory allows |
| S-10 | `DealOwnership` (`leadId`, `fromUserId?`, `toUserId?`, `byUserId`, `reason` = `HANDOFF` · `CHANGE` · `BULK` · `TAKEOVER` · `HANDOVER` · `REVERT`, `note?`, `createdAt`); indexes `(leadId, createdAt)`, `(fromUserId, createdAt)` |
| S-11 | `NextActionKind − ORDER` |

No new `Lead` columns. Net production delta of wave 3 alone (if the live-baseline comparison confirms production never
had `DealRequest`, `REQUEST_*`, `ORDER`): new `DealTask`, `DealOwnership`, their enums, `Activity.taskId`, new
`ActivityType` values — additive. The **whole pending release** is not additive: it also contains the separately
approved wave-3a conversion and removal of the old send columns (`db-changes.md` §3.3). Record the verified delta in
`db-changes.md` only after applying on test; then remove the round-1 `DealRequest` rows and the wave-2 `ORDER` row
from the ledger.

## 5. Rules

### 5.1 The lock (D2, D3, D5)

- **Locked** ⇔ the deal has an OPEN task. A closed deal never has one (I7).
- **While locked the step's date is empty.** The ask stores the chosen step kind + note with `nextActionAt = NULL`,
  `nextActionMode = SCHEDULED`; any kind is allowed without a date (including `CALL`, which normally requires one) —
  the date is set when the lock ends: business today by default (D3), or the date picked in the cancel / takeover
  dialog. So a locked deal can never look overdue anywhere.
- Every write of `Lead.nextAction*` or `Lead.status` goes through one guard `assertStepUnlocked(tx, leadId)` under the
  Lead lock (error `STEP_LOCKED`, "Krok čaká na úlohu pre manažéra."), except the task commands and the two explicit
  combined forms below.
- **Fact-only branch** (R04): `logFollowUpAs` while locked records the contact exactly as today (CALL / CLIENT_REPLIED /
  SMS_SENT, reply, phone-price `OFFER_SENT`) but writes **no** status, step or planning activity — the submit carries
  `keepLockedStep: true`, and the server rejects any step/status input in that mode. `recordOfferSentAs` while locked
  records the send with `followUp = false`, forced on the server.
- **Cancel + change** (D5): the same commands accept `cancelTask: { taskId, reason }`. Then, in one transaction: the
  task becomes CANCELLED (`TASK_CANCELLED`), the lock ends, and the chosen outcome / status / step is applied as
  today (snooze, "nemajú záujem", "zlé číslo", "Zmeniť krok"). The manager's status select, "Stratené" and owner
  changes use the same parameter. The `taskId` must be the deal's OPEN task, else `STALE`.
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

**Locked ⇒ not actionable, everywhere.** One TS predicate (`isStepLocked`) and one SQL fragment (`STEP_LOCKED_SQL` =
`EXISTS (open task)`) exported from one place and used by: the pipeline sections and `DEAL_RANK_SQL` (locked deals rank
with "Čaká"), the step-kind pills ("Poslať cenu" etc. exclude locked deals — they are in "Čakám na manažéra"), the row
urgency (shows "⏳ čaká na Michala (2 dni)" instead of a date), the dashboard due list and calendar
(`lib/queries/today/index.ts`), and the manager's per-rep overdue counts (`lib/queries/today/manager.ts`). The empty
locked date (§5.1) is the second safety net. Tests: one locked deal must appear in none of the actionable views and in
"Čakám na manažéra" / "Pre mňa".

A SNOOZED deal cannot keep a locked step: creating a task on a SNOOZED deal sets it ACTIVE in the same transaction
(the ask dialog says "Obchod sa zobudí").

### 5.4 Invariants (test each)

- I1 At most one OPEN task per deal.
- I2 While a task is OPEN, `Lead.nextAction*` and `Lead.status` change only through task commands or the explicit
  cancel + change form.
- I3 Every task event = exactly one Activity row with `taskId`; every task mutation = one transaction, one revision
  bump, one idempotency key with a canonical fingerprint (§5.5).
- I4 No task row is written by a call outcome, a send, a saved price or a design save (D9).
- I5 A DONE HELP task has a result for every ticked content (PRICE → amount; DESIGN → ≥ 1 non-deleted design with a
  URL; OTHER → answer text).
- I6 Task creation, assignment and messages never change the deal owner. HANDOVER acceptance, direct takeover, owner
  change, bulk transfer, first-call handoff and first-call revert do — and each actual owner change writes exactly one
  `DealOwnership` row in the same transaction. None of them goes through one function today (`calls.ts` handoff,
  `history.ts` revert, `pipeline.ts` raw bulk update, `deal.changeOwner`): add `recordOwnership` to each.
- I7 No OPEN task on a closed deal; no OPEN task whose assignee is the current owner.
- I8 A locked step has `nextActionAt = NULL`.

### 5.5 Freshness and retries (R10, R18)

- **Freshness — one simple rule:** every command that changes a deal's status, owner, step or task carries the
  `expectedRevision` the screen was rendered with; a mismatch returns `STALE` and the screen refreshes. This adds
  `expectedRevision` to `changeStatusAs`, `markLostAs`, `reopenDealAs`, the owner change, takeover and all task
  commands (today only some commands have it). No other stale handling is needed: an old tab simply cannot act.
- **Retries:** each command has one idempotency key on its one primary Activity row, and `meta.fp` = a canonical string
  of what the user **submitted** (never recomputed current values). Same key + same `fp` → success without a second
  write; same key + different `fp` → `IDEMPOTENCY_CONFLICT` (`activityReplay` with `fingerprint`/`want`).

| Command | Primary row | `fp` contains |
|---|---|---|
| ask | `TASK_CREATED` | type, sorted contents, assignee, text, locked step kind + note |
| message | `TASK_MESSAGE` | text |
| finish | `TASK_DONE` | price amount + note, sorted design ids + versions, answer |
| "Vybavil som to sám" (finish + send) | `TASK_DONE` (the `OFFER_SENT` row in the same transaction has no key) | the finish fields + send contents, `sentOn`, follow-up choice + date |
| decline / cancel | `TASK_DECLINED` / `TASK_CANCELLED` | reason (+ for cancel + change: the chosen outcome/status/step/date) |
| reassign | `TASK_REASSIGNED` | new assignee |
| handover accept | `TASK_DONE` | the manager's new step + date |

- Two existing gaps closed in the same wave, because the lock makes them reachable: `offerFingerprint` adds the price
  amount + note and the follow-up choice + date; the follow-up CALL replay (`idempotentReplay` for `source ≠ CALL_QUEUE`)
  adds note, reply and next-step choice.

### 5.6 Ordering (R16)

Everything that says "last" or "latest" orders by `(createdAt, id)`: task history, the 💬 badge, "the latest closed
task", História.

## 6. Flows

### 6.1 Asking (HELP)

On the SR's own deal, button **"Požiadať manažéra"** (prominent when the step is "Poslať návrh", because an SR can never
make a návrh; also offered after "Chcú cenu/návrh" replies; never created automatically):

```
Čo potrebuješ?   ☑ Cena   ☐ Návrh   ☐ Iné
Popis:           [e-shop, 200 produktov, SK+EN]           (pre-filled from the last call note, editable, required)
Pre:             Michal                                   (pre-selected when one resolver)
Keď Michal dodá: [Poslať cenu ▾]  poznámka [          ]   (default from contents, any step kind incl. Vlastný krok)
                 🔒 Krok bude zamknutý, kým úloha nie je vybavená.
```

Default follow-up step: PRICE only → `SEND_QUOTE`; DESIGN (with or without PRICE) → `SEND_DESIGN`; OTHER only →
`CALL`. No date field (§5.1). The send dialog completes a `SEND_DESIGN` step when a návrh is ticked and pre-ticks the
price from the task result (§6.4), so price + návrh needs no new step kind.

Transaction: guard (owner, ACTIVE/SNOOZED, no OPEN task, not own-deal resolver, `expectedRevision`) → write the chosen
step with an empty date (`NEXT_ACTION_*` planning row as today) → create `DealTask` + `TASK_CREATED` → wake a snoozed
deal → one bump.

Rows after asking:
- SR: `🔒 Poslať cenu · ⏳ čaká na Michala (0 dní)` — in "Čakám na manažéra".
- Manager, "Pre mňa": `Cena · Jana · Kvetinárstvo Lipa · od 18. 9. · „e-shop, 200 produktov…"`.

### 6.2 Messages while waiting — and "the client wants to talk to you" (R01)

- Either side: **"Napísať"** on the task → `TASK_MESSAGE` ("chce modrú", "koľko jazykov?").
- Badge derived from the last message on the OPEN task: from the owner → manager's row "💬 nové od Jany"; from the
  manager → SR's row "💬 Michal sa pýta". No read/unread state.
- The client calls the SR in between: she records the call (fact-only, §5.1) and adds the requirement with "Napísať".
- **The client wants to discuss details with the manager while a task is open**: no second task (D4). The SR writes
  it as a message (a quick chip "Klient chce riešiť detaily priamo s tebou"). The manager decides, as Michal described:
  - he calls the client, gets the details, finishes the task, and the SR continues (the call need not be recorded, or
    he notes it in the task);
  - or he takes the client over (§6.9: the task closes in the same transaction, he sets his own step, e.g. "Zavolať –
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

### 6.4 SR sends (R07)

"Čo sme poslali" with the step coming from a DONE task:
- **Pre-ticks exactly what the task returned**: Cena if `result.price`, and the designs in `result.designs` — not "all
  unsent designs".
- **Compares with the current state** and says so before saving:
  - the deal's price differs from the returned one → "Michal vrátil 1 285 €, aktuálna cena je 1 300 €" — the send uses
    the current price (the one place the price lives) only after the SR ticks "Posielam aktuálnu cenu";
  - a returned design was deleted or has no URL → it cannot be ticked; the dialog says why;
  - a returned design has a newer version → shown as information ("vrátená verzia 1, aktuálna 2"); the send snapshots
    the current version.
- `OFFER_SENT` remains the truth of what the client got. The send's follow-up ("Zavolať" in a few days, editable date)
  becomes the next step as today.

### 6.5 Manager does it himself

**"Vybavil som to sám"** on an OPEN HELP task = the "Čo sme poslali" dialog (with the result fields) as **one command**
(key on `TASK_DONE`, §5.5): the result is saved, the send is recorded as his, the task is DONE, the lock ends, and the
send's follow-up becomes the owner's step ("Zavolať · +N dní"). If any part fails, nothing is committed.

### 6.6 Manager declines (D16)

**"Zamietnuť"** with a required reason → DECLINED, `TASK_DECLINED`, unlock: the SR's step stays what it was ("Poslať
cenu" — it still has to happen), date = business today. Row: `Poslať cenu · ✗ Michal: „zavolaj im a zisti, čo
chcú" · dnes`. The SR changes the step if the reason calls for it. (Michal would rarely decline — he would call the
client and then fill the price; declining exists so nothing gets stuck.)

### 6.7 SR cancels

**"Zrušiť úlohu"** with a required reason, in the dialog that also offers the new step and date (default: the locked
step, today). One command (cancel + change, §5.1).

### 6.8 Handover request (HANDOVER, D8) and "Chcú objednať" (D15)

- SR: **"Odovzdať manažérovi"** on her deal when **no task is open** (with a HELP task open, see §6.2) → required note
  ("chce riešiť technické detaily", what they want to order) → HANDOVER task, her step stays and is locked.
- Manager **"Preberám"** → owner = manager, `DealOwnership(HANDOVER)` + `OWNER_CHANGED`, task DONE, and in the same
  dialog he sets **his own** step and date (default: the locked step, today). The SR loses access immediately; the deal
  appears in her História.
- Manager **"Nie, pokračuj ty"** with a reason → DECLINED, unlock, her step due today, row shows the reason.
- **"Chcú objednať" / "Idú do toho"** reply: recorded as the contact it is (outcome `WANTS_TO_ORDER`), **not
  terminal** — the SR picks a normal next step like for any other reply (the manager on his own deal likewise). After
  saving, the sheet offers "Odovzdať manažérovi" — a separate command with its own key. The intermediate state (deal
  with a step, no task) is valid, so a failure between the two needs no recovery. The automatic ORDER request and the
  `ORDER` step kind are removed; every writer of `ORDER` goes (`leadFlow.ts`, `clientReplies.ts`).

### 6.9 Direct takeover (no task needed)

Manager on any deal: **"Preberám klienta"** → note, his step and date (default: the current step, today) →
`DealOwnership(TAKEOVER)` + `OWNER_CHANGED`. With an OPEN task the dialog says "Úloha sa uzavrie: … (krok ostane:
Poslať cenu)" and the task closes in the same transaction: HELP → CANCELLED "klienta prevzal Michal", HANDOVER → DONE.
He can give the deal back later with a normal owner change (§6.10).

### 6.10 Owner change and bulk transfer (R09, D6)

The dialog decides per new owner, for single and bulk transfers alike:

| New owner | Open task on the deal |
|---|---|
| another SR (not a resolver) | stays OPEN, lock continues, requester stays; the dialog shows "Úlohy pôjdu: [Michal ▾]" — the assignee can be changed for all moved tasks at once |
| a manager / admin (resolver) | closes: CANCELLED "obchod prevzal X"; the locked step stays as his plain step, date today (Michal: *"instead of next step: poslať cenu, task: … it will be just Poslať cenu"*) |
| nobody (nepriradené) | the same as a manager — unassigned deals are the manager's to handle |

Every deal whose owner actually changes gets one `DealOwnership` row (reason `CHANGE` or `BULK`). Returned results
(DONE, not yet sent) follow the deal to the new owner.

### 6.11 Reopen — not a task (D13)

The manager reopens a closed deal with the existing "Znovu otvoriť" (`reopenDealAs`, now with `expectedRevision`). The
SR has no in-app way to ask in wave 3; a future *request* covers it (backlog BL-01).

### 6.12 Closing, deactivation, role change, revert

- Closing (WON / LOST / UNREACHABLE) with an OPEN task → the dialog names the task; cancel + close in one command
  ("obchod uzavretý"). Reopening never revives a task.
- **Deactivation and role change** (D14): `lib/commands/admin.ts` today releases only uncalled NEW contacts and merely
  *counts* deals. Wave 3 adds a refusal: the user owns open deals (ACTIVE/SNOOZED) → "Najprv presuň N obchodov";
  the user is the assignee of open tasks → "Najprv presuň N úloh" (reassign). The same for a role change that removes
  `deals.receive` or `requests.resolve`. Closed deals keep their owner (history, statistics).
- **First-call revert** cannot happen once a task exists: task creation bumps `Lead.revision`, and
  `revertCallResultAs` requires the CALL's `leadRevision == Lead.revision`. No task handling is added to revert.

### 6.13 What the SR sees after a task closes (R06)

- **Delivered PRICE / DESIGN**: the step line shows `Poslať cenu · ✓ od Michala: 1 285 €` (návrh: `✓ od Michala:
  Variant A` + copy-link button); the name is `closedById`, not a fixed "Michal". Visible **until** a non-reverted
  `OFFER_SENT` created after `closedAt` contains the returned content (PRICE: any price send; DESIGN: every returned
  design id), or the SR clicks "Skryť" (`resultDismissedAt`), or the deal closes, or a newer task on the deal closes.
  An unrelated call or SMS does not hide it.
- **Delivered OTHER** (an answer): shown on the task card; on the row until the SR changes the step or clicks "Skryť".
- **DECLINED**: the reason on the row until the SR changes the step or clicks "Skryť".
- The result itself stays readable forever on the task card (closed tasks listed under the open one, collapsed).

## 7. Lists, counters, dashboard, História (R11, R12, R16)

**One predicate per pill, shared by its list and its count.** Each pill is a function
`(viewer, scope, filters) → where/SQL`; the list query and the count query call the same function with the same
inputs, so they cannot disagree. `getDealCounts` receives the same inputs as the list (scope, owner, status, search,
handed-off-by) — today it takes only scope/owner/handed-off-by.

| Pill | Rows | Honours |
|---|---|---|
| Na dnes, Všetko, step-kind pills, "Dostali …" | deals | scope, owner, status, search, handed-off-by; step-kind pills exclude locked deals (§5.3) |
| **Čakám na manažéra (n)** | deals in my scope with an OPEN task | scope, owner, search; all open statuses |
| **Pre mňa (n)** | OPEN tasks where `assigneeId = me`, any owner, oldest first, age red after 2 business days; shows contents, owner, company, text, 💬 | search only; its link resets owner and status, because an inbox is not a slice of my deals |

Manager dashboard "Čaká na mňa" = the "Pre mňa" query (replaces `prisma.dealRequest` in
`lib/queries/today/manager.ts`). Tests compare every count with the full unpaginated list under search, every status
and every owner filter — not just the defaults.

**História (SR)** — `/dashboard/pipeline/historia`: deals that moved away from me. The query itself enforces
`DealOwnership.fromUserId = me` and current owner ≠ me; **one row per deal** (its latest move away from me, `(createdAt,
id)` order), showing company, date, who, note; no link to the live deal. Opening a handed-over deal would need a
**new** permission `deals.viewHandedOver` (no role holds it) — it does **not** exist in code today. Ownership history
starts at rollout; no invented backfill rows.

Deal detail: one **task card** (the open task with text, messages, actions; closed tasks with results, collapsed).

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
  reply, SMS, phone price) and a send succeed and leave the step unchanged; cancel + change (snooze, lost, bad number,
  replan, manager status select) = one transaction, one bump.
- finish: PRICE without amount / DESIGN without a valid URL-bearing design → error; DONE saves `Lead.price` and the
  result; step date = today; "Vybavil som sám" writes exactly one `OFFER_SENT` and closes the task atomically; retry
  with a changed amount / design / follow-up date → conflict.
- decline / cancel: reason required; unlock; decline keeps the step.
- handover: accept changes owner + one `DealOwnership` row + the former owner gets `NOT_FOUND`; decline unlocks;
  "Chcú objednať" is non-terminal and creates no task.
- takeover, owner change to SR / manager / nobody, bulk with assignee change, close: the §6.9–6.12 outcome, one
  transaction, one `DealOwnership` row per changed owner.
- deactivation / role change refused with open deals or assigned open tasks.
- freshness: every status / owner / step / task command with an old `expectedRevision` → `STALE`.
- visibility (§6.13): the ✓ line survives an unrelated call, disappears after the matching send or "Skryť".
- send dialog (§6.4): pre-ticks exactly the returned designs; price mismatch needs the explicit tick.
- sections & views: `clientSection` ↔ `TODAY_SQL` parity over {no task, OPEN HELP, OPEN HANDOVER, DONE, DECLINED,
  CANCELLED} × {ACTIVE, SNOOZED, closed}; a locked deal appears in no actionable view (§5.3); every pill count = its
  full list under all filters; an SR never sees a foreign task.
- `TASK_*` rows never change "Naposledy".
- HTTP role checks: SR, telesales, manager, admin, scout on the new actions and pages.

## 10. Order of implementation

1. **Schema on test.** Verify the endpoint is the test branch (`…nhww8x`) and not the commented production URL. Inventory
   `DealRequest` rows, `REQUEST_*` activities and leads with `nextActionKind = ORDER` (expected 0 / few after the
   2026-09-18 reseed; list them before anything is dropped). Review the generated SQL. **Test only (Michal,
   2026-09-19):** because test has the round-1 request data and production never had it, dropping it on test may make
   `prisma db push` ask for `--accept-data-loss`; this is allowed **on the test database only**, after the double check
   above. It is **never** allowed on production without Michal explicitly saying so. Generate, then record the verified
   delta.
2. Domain: `lib/domain/tasks.ts` (pure: types, contents → default step, result schema, `fp` builders, `isStepLocked`,
   `STEP_LOCKED_SQL`), `lib/domain/taskMutations.ts` (create / message / finish / finish+send / decline / cancel /
   reassign / accept handover, `assertStepUnlocked`), `recordOwnership` in every owner-changing path; remove the request
   machinery; the section rule + SQL twin + every actionable view (§5.3) with parity.
3. Commands + actions (`lib/commands/tasks.ts`), `expectedRevision` on the manager commands (§5.5), the fact-only and
   cancel + change branches (§5.1), the deactivation / role-change refusal (§6.12), the replay fingerprints.
4. Queries: task on rows/detail, lock state, the ✓/✗ line (§6.13), "Pre mňa", "Čakám", shared pill predicates and
   counts (§7), História, dashboard.
5. UI: ask dialog, task card, finish / decline / cancel / reassign dialogs, handover / takeover dialogs, owner-change
   and bulk-transfer dialogs with the task column, lock notices in the sheet and the send dialog, pills. Fix
   `DesignTrackingCard` on the way (R17): check every command result, show the error, keep the inputs open on failure,
   and tell the manager a návrh needs a URL before "Hotovo".
6. Docs (domain files describe what exists), progress tracker with honest check results, full check pass
   (`code-standards.md` §7), HTTP role checks, a two-account click-through (SR + manager) on desktop and phone.

**Production** (later, separate approved session): rehearse on a fresh production duplicate in order — round 1 →
wave 2 → wave-3a conversion / column removal → wave 3 schema and code — and reconcile before touching production.

## 11. Answered questions (Michal, 2026-09-19)

1. **Reopen** — not a task; later *request* concept (D13, BL-01).
2. **Iné** — stays (D17).
3. **Date after "Hotovo"** — none to pick; the step is due from the moment the task is finished and tracked normally.
4. **Reassigning a task to another manager** — yes (D17, `TASK_REASSIGNED`).

Still open: **F1** (§12) — whether the two-field sheet belongs in wave 3.

## 12. Known limits (accepted) and related findings

**Known limits.**
- A fixed client appointment cannot be planned while the step is locked, nor next to a "send" step in general (D11,
  BL-02). The SR writes it into a task message, visibly — it is not scheduled or alerted.
- One open task per deal: a second, unrelated ask waits until the first closes (or is added as a message).
- A combined PRICE + DESIGN task has one completion time; no separate time-to-price / time-to-návrh (BL-07).

**Finding F1 — the step note (verified in code, 2026-09-19; decision open).** The interaction sheet has a single note
field (`InteractionSheet.tsx`, `note`). `logFollowUpAs` writes it as the contact's note (history) **and**, through
`dealStateForFollowUp` (`lib/domain/leadFlow.ts`), as `Lead.nextActionNote` for `POSITIVE`, `NO_ANSWER`, `CALL_AGAIN`
and `SNOOZE`. For `WANTS_QUOTE` / `WANTS_DESIGN` / `WANTS_TO_ORDER` the step note is a fixed text ("Poslať cenu", …)
and the typed note goes only to the history. "Zmeniť krok" (contact NONE) writes it only to the step. So "what the
client said" and "what I will do" share one field, and whether the typed text reaches the step depends on the outcome.
Proposed fix: two fields — "Čo povedali" (history) and "Poznámka ku kroku" (pre-filled per kind, always saved to the
step). The ask dialog in §6.1 already has its own step note.

**Finding F2 — price and návrh together (verified).** One `OFFER_SENT` row already holds `contents` (e.g.
`[PRICE, DESIGN]`), the price snapshot and the design snapshots (`lib/domain/offers.ts`); "Čo sme poslali" can tick
both; a `SEND_DESIGN` step is completed when a návrh is ticked (`OfferSentDialog.tsx:82-83`). Missing: one `Lead.price`
per deal — **no price per návrh**; the "Cena & ponuky" card does not show which price went with which návrh. A core
offer-model change — **not in wave 3** (backlog BL-03). Michal's direction for it: pick what the client **wants** by
ticking contents, and what **I sent** by ticking contents.

---

## 13. External review (2026-09-19) — resolution log

Source-only review by ChatGPT; the full text with Michal's comments is in `backup/wave-3-task-proposal-final.md`.

### 13.1 Findings

| ID | Finding (short) | Michal | Resolution |
|---|---|---|---|
| W3-R01 | a HELP task blocks an urgent handover (one-task rule) | the manager closes the task and takes over / or calls, finishes, lets the SR continue / can give the deal back later | no second task: SR writes a message; manager uses takeover or finishes — §6.2, §6.9 |
| W3-R02 | deactivated owners are not reassigned; work can return to nobody | block deactivation until deals and tasks are moved; demotion = new account; later a "transferred" marker + filter | D14, §6.12; marker → BL-11 |
| W3-R03 | "Chcú objednať" → handover has no retry contract | order means nothing now; remake later | D15, §6.8: non-terminal reply + separate handover command; ORDER removed; BL-09 |
| W3-R04 | the lock cannot simply guard the current commands | why can't the SR snooze/close? | she can (D5): fact-only branch + explicit cancel + change — §5.1 |
| W3-R05 | a locked step still looks actionable elsewhere | fix | one lock predicate in every actionable view + empty locked date — §5.1, §5.3 |
| W3-R06 | "✓ od Michala" disappears after an unrelated call | valid, do it | consumption rules per content, `closedById`, "Skryť" — §6.13 |
| W3-R07 | send can silently use a different price/design than returned | fix | pre-tick returned items, compare and confirm — §6.4 |
| W3-R08 | decline/cancel activates an impossible step | the step should stay "Poslať cenu" — it still must happen | D16, §6.6 (kept; reason shown; SR replans if needed) |
| W3-R09 | transfer to another manager / nobody undefined | bulk: choose where tasks go; to a manager the task disappears, the step stays | D6, §6.10 |
| W3-R10 | cancel + change and manager selects are not stale-safe | fix simply, no slop | `expectedRevision` on every such command; one combined command — §5.1, §5.5 |
| W3-R11 | wrong claims (`deals.viewHandedOver`, deactivation, revert) | fix the docs | §6.12, §7 |
| W3-R12 | pill counts need exact predicates | do it | shared predicate per pill — §7 |
| W3-R13 | only wave 3 alone is additive; test drop may need data-loss acceptance | `--accept-data-loss` allowed on **test only**, never production without asking | §4.3, §10 step 1 |
| W3-R14 | I6 wording wrong | fix | I6 — §5.4 |
| W3-R15 | undated CALL conflicts with the picker | fix | locked steps have no date; date set on unlock — §5.1, I8 |
| W3-R16 | ordering, História duplicates, metrics | fix | `(createdAt, id)`; one História row per deal; index; BL-07 — §5.6, §7 |
| W3-R17 | design card discards failed input | do it | fix in wave 3 UI step — §10 step 5; URL revalidated at finish — §6.3 |
| W3-R18 | fingerprints need an exact payload | fix | table in §5.5 incl. the two existing replay gaps |

### 13.2 Writer inventory (checklist for §5.1 and I6)

| Current path | Writes | Wave 3 treatment |
|---|---|---|
| `lib/commands/calls.ts:93-147` | first-call `status`, `nextAction*`, `ownerId` | no task can exist in the call stage; add `DealOwnership(HANDOFF)`; remove the automatic DESIGN request |
| `lib/commands/dealWork.ts:140-219` + `lib/domain/leadFlow.ts:197-299` | every follow-up contact / status / step, snooze, close, phone price | fact-only branch and cancel + change (§5.1); remove request / ORDER writes; "Chcú objednať" non-terminal (§6.8) |
| `lib/domain/dealMutations.ts:191-209,240-268,282-333` | direct step, close / lost, reopen, status | guard + cancel + change; `expectedRevision` on status, lost, reopen |
| `lib/domain/offerMutations.ts:97-198` via `lib/commands/offers.ts:61-88` | send, optional follow-up step, current price | while locked `followUp = false`; finish + send is its own command (§6.5) |
| `lib/domain/dealMutations.ts:335-353`; `lib/commands/pipeline.ts:70-87,149-201` | single and raw bulk owner changes | recipient rules (§6.10), one `DealOwnership` row per changed owner, `expectedRevision` on single changes |
| `lib/commands/history.ts:63-120` | first-call revert resets status / owner / step | unreachable after a task (§6.12); writes `DealOwnership(REVERT)` |
| `lib/commands/admin.ts:16-47,62-120` | releases uncalled NEW contacts only | refuse deactivation / role change with open deals or assigned open tasks (D14) |
| `lib/commands/tracking.ts:38-117`; `lib/domain/dealMutations.ts:139-168`; `lib/domain/offerMutations.ts:203-220` | designs, current price, send corrections | no lock conflict; the returned result may become stale → reconciled at send (§6.4) |
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
