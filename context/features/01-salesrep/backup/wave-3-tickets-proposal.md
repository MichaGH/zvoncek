# Wave 3 proposal: tickets, the ball, or a separate manager task — handover, história, counters

Status: **PROPOSAL for review, nothing implemented.** Temporary file: once decided, it is folded into
`round2-deal-workspace.md` (replacing §2b) and deleted. v1 (a separate ticket object with an inbox) is kept by Michal
as `wave-3-tickets-proposal-backup.md`. This file preserves v2's ball model and adds **option C** (§10): a small,
explicit manager task that does not replace the deal owner's next step. **No option is selected yet.** Sections 3–9
describe B only; they must not be read as decisions for C. **§13 is Claude's review of all three against the code and
Michal's workflow, with a recommended refinement of C ("C′ — the ball on the task").**

For a reviewer without the code: Zvonček is an internal CRM (Next.js 16 + Prisma + PostgreSQL) for a small web-design
company (one manager, a few sales reps and telesales). A positive first call turns a contact (`Lead`) into a deal,
owned by a sales rep (SR) or the manager, worked in `/dashboard/pipeline`. Every deal has **one next step**
(`nextActionKind` + date + note: "Zavolať · zajtra"); the list, the "Na dnes" view and the urgency all run on it.
Mutations lock the lead row, check an optimistic revision, bump it once, and accept an idempotency key. Scope is
server-side; out-of-scope = `NOT_FOUND`.

---

## 1. The problem, stated without any existing solution

Three real situations:

1. **Price.** The SR does not know how to price a client → asks the manager → the manager gives the price (or decides
   the deal is too complicated and takes it over) → the SR sends it.
2. **Návrh.** The client wants a design → only the manager can make it → the manager must see that it has to be done,
   the SR must see that the deal is waiting for the manager and for what → the manager finishes → the SR must see that
   it is done and take the next step (send it).
3. **Takeover.** At any point (usually after "áno, ideme do toho") the manager takes the client; the SR loses the deal
   but keeps a record that it was hers.

Plus two needs: the manager sees **everything waiting for him** in one place regardless of whose deals they are, and
the SR sees **what she is waiting for**.

What made the current "Požiadavky" bad (found in use): the request was a second object next to the deal, and the two
had to be kept in sync — the deal was "swallowed" by an open request, the pill counted the wrong thing, requests were
created and closed automatically behind the user's back. Every review of the v1 ticket design again found edge cases in
exactly that synchronisation (parking, un-parking, several open tickets, a ticket closed while the step says
otherwise).

## 2. Three models

### Model A — tickets (v1)

A separate `DealRequest` object with its own lifecycle (open → resolved), an inbox (Pre mňa / Od mňa / Vybavené), a
comment thread, editing, three resolution buttons; the deal is "parked" via a special next step `WAITING_FOR_MANAGER`
that must be kept in line with the ticket.

### Model B — **the ball** (the original v2 recommendation)

There is no separate object. The deal's **next step gets an owner**: *who has to do it*. Asking the manager = handing
him the ball; resolving = handing it back.

```
Ďalší krok:  Naceniť · rieši Michal · od 18. 9. (2 dni)      ← SR sees: waiting for the manager, and for what
             „majú e-shop, 200 produktov, chcú aj EN"
```

- The SR clicks **"Požiadať manažéra…"** → what: *Naceniť · Pripraviť návrh · Zavolať im (technické) · Prevziať
  klienta* (+ note). The deal's next step becomes that task, assigned to the manager.
- The manager's pill **"Pre mňa (n)"** lists every deal whose step is assigned to him — any owner, ignoring the owner
  filter. That is his inbox, and it is just a filter over deals.
- The manager does the work and clicks **"Hotovo – vrátiť Jane"**: for a price he types the price + breakdown right
  there; the step goes back to the SR, pre-filled ("Poslať cenu · dnes"). Or **"Vybavil som to sám"** (records the
  send, the SR gets "Zavolať, či prišlo"). Or **"Preberám klienta"** (owner change).
- The SR's deal reappears in her Na dnes with the returned step and a small "vrátené od Michala" marker; the history
  shows "Michal: nacenené 1 285 €".

### Model C — separate manager task, **no ticket–step parking** (new option)

`Lead.ownerId` remains the owner of the client relationship, `Lead.nextAction*` remains that owner's next action,
and a small assigned task records work another person must do. The UI can still say "Požiadať manažéra" and "Pre mňa";
users need not learn the word *ticket*. An open manager task is displayed alongside the deal, but does not itself
overwrite or suppress a real SR follow-up. A manager can return a price/design, do the client-facing work herself, or
explicitly take the whole deal over. Full flows, data and safety rules are in §10.

### Comparison

| | A — tickets | B — the ball | C — separate task, no parking |
|---|---|---|---|
| Concepts the user must learn | deal, next step, ticket, parking, inbox | deal, next step (with "rieši") | deal, own next step, "požiadal/a som manažéra" |
| "What is this deal waiting for?" | ticket + parked step | one assigned step | task badge and inbox; own step remains separately visible |
| Deal ↔ task synchronisation | open ticket must match parked step | no separate task, but only one action slot | no permanent parked-step invariant; a few explicit transitions on open/return |
| Manager's inbox | ticket inbox | "Pre mňa" filter over deals | "Pre mňa" list of assigned tasks |
| SR call while manager prepares a design | possible, but parking can hide the SR's due call | call can be logged; no second scheduled SR step | independent SR step and manager task can coexist |
| Two asks at once | two tickets | one compound step/note | two distinct tasks if genuinely needed |
| Conversation | ticket thread | one step note + deal history | short task-specific thread; general deal notes stay wave 4 |
| Future developer role | addressed ticket | needs new limited assignee scope on deals | addressed task with task-limited access, without deal-manager rights |
| Timing/statistics | ticket timestamps | structured assignment history would be needed | task created/assigned/resolved timestamps |
| Schema | reshape `DealRequest`, thread, `WAITING_FOR_MANAGER` | Lead assignee columns + step kinds; remove `DealRequest` | task + messages, ownership history; no Lead step-assignee columns |
| Complexity | highest because task and parked step must agree | smallest now, constrained by one step | between A and B; independent concurrent work |

**Decision pending.** B was the original v2 recommendation. C is added because the SR and manager may have valid work
on the same deal at the same time, a closed-deal reopen request is not naturally a next step, and a future developer
needs narrower access than a manager. C keeps the useful "whose move?" UI without representing all work in one Lead
step. Sections 3–9 below remain the unmodified B proposal; §10 is the alternative, not an instruction to combine
their schemas.

## 3. Model B in detail

### 3.1 Data

On `Lead` (the next step already lives there):

| Field | Meaning |
|---|---|
| **new** `nextActionAssigneeId String?` (FK User) | who must do the step; `NULL` = the deal owner (today's behaviour) |
| **new** `nextActionAssignedById String?` | who handed it over |
| **new** `nextActionAssignedAt DateTime?` | since when (drives the age "od 2 dní", red after 2 business days) |

New step kinds (manager-side tasks), labels in `lib/dictionaries.ts`:

| Kind | Label | Typical |
|---|---|---|
| `PREPARE_PRICE` | Naceniť | SR unsure of the price |
| `PREPARE_DESIGN` | Pripraviť návrh | client wants a návrh |
| `CALL` (existing) | Zavolať | assigned to the manager = "zavolaj im, sú tam technické detaily" |
| `TAKE_OVER` | Prevziať klienta? | "áno, ideme do toho" |
| `REOPEN_DEAL` | Znovu otvoriť? | the SR asks to reopen a closed deal |

`ORDER` is **removed** (production never had it; no test lead uses it). Existing kinds stay.

**`DealRequest` is dropped** together with its enums and the `REQUEST_*` activity types' writers. Production has never
had the table, so dropping it on test is still additive towards production (net-delta rule). The activity enum values
`REQUEST_CREATED` / `REQUEST_RESOLVED` stay in the enum (dropping enum values is pointless churn); nothing writes them.

`DealOwnership` (new table, as in v1): `leadId`, `fromUserId?`, `toUserId?`, `byUserId`, `reason` (`HANDOFF` · `CHANGE` ·
`BULK` · `TAKEOVER` · `REVERT`), `note?`, `createdAt` — written by every code path that changes `Lead.ownerId`.

### 3.2 Rules

- **Who may assign to whom.** The owner (SR) may hand the step to a resolver (`requests.resolve`: manager/admin); with
  one manager the choice is automatic, with several the owner's team leader (if a resolver) is pre-selected. The
  manager may hand it back to the owner. Nobody assigns to telesales. No step is ever assigned automatically.
- **No handing to yourself**: on the manager's own deal the choices above are simply his own next steps (e.g. "Pripraviť
  návrh" for himself), not an assignment.
- **The step is never replaced silently.** While the step is assigned to the manager, the SR may still record contact
  (a call, a reply…); the next-step section then defaults to **"Ponechať: Naceniť · Michal"**. Replacing it is an
  explicit choice, and it un-assigns (the SR takes the ball back — "už to netreba").
- **Na dnes / sections** (`clientSection` and the SQL twin): a step assigned to **someone other than the owner** puts
  the deal in "Čaká na manažéra" (not in the owner's Na dnes). The manager's work is the **"Pre mňa"** pill (assignee =
  me), independent of owner, status tab and dates. `clientSection` stays viewer-independent; the "open request" rule and
  the `NOT EXISTS (open request)` SQL clause are removed **in the same commit** (the parity test is the gate).
- **One transaction per hand-over**: assign / return / take over each lock Team → User (actor, owner, assignee) → Lead,
  bump the revision once, carry an idempotency key, and write one planning activity ("Pre Michala: Naceniť – …",
  "Vrátené Jane: Poslať cenu – cena 1 285 €").
- **Closing / reopening / reverting** a deal clears any assignment with the step (the existing rules already clear the
  step).

### 3.3 Flows

**Price.** SR: row → "Požiadať manažéra…" → *Naceniť*, note pre-filled from the last call note → the deal shows
"Naceniť · rieši Michal". Michal: "Pre mňa (1)" → opens the deal → **"Hotovo – vrátiť Jane"**: price + breakdown
fields (saved on the deal), the SR's step pre-filled "Poslať cenu · dnes" (editable) → saved. Jana: Na dnes shows
"Poslať cenu · vrátené od Michala" and the price is in "Cena & ponuky". Alternatives for Michal: "Vybavil som to sám"
(opens "Čo sme poslali" with the price ticked; saving records the send and returns "Zavolať, či prišlo" to Jana) or
"Preberám klienta".

**Návrh.** "Chcú návrh" (first call routed to the SR, or a follow-up reply) → the step is "Poslať návrh" with the note
"Požiadať manažéra o návrh", and the sheet/detail show a prominent **"Požiadať manažéra o návrh"** (one click →
*Pripraviť návrh* assigned to Michal). On Michal's own deal: the step is simply "Pripraviť návrh" for himself. Michal
makes the návrh (design card) → "Hotovo – vrátiť Jane" → Jana gets "Poslať návrh · dnes" and the copy link is ready.

**"Pozreli, chcú zmeny" / "Idú do toho".** For an SR these replies offer **"Odovzdať manažérovi"** (*Zavolať im* or
*Prevziať klienta?* assigned to Michal), because the rep handles introductions only; for the manager they are normal
steps.

**Takeover.** From "Pre mňa" or any deal: **"Preberám klienta"** (optional note, optional new step for himself) → owner =
Michal, assignment cleared, `DealOwnership(TAKEOVER)` + `OWNER_CHANGED`; the SR loses access immediately. "Nie,
pokračuj ty" on a *Prevziať klienta?* step = return it with a note.

**Reopen.** On a closed deal the SR can hand *Znovu otvoriť?* to the manager; he reopens (existing command, which sets
the owner's step) or returns it with a reason.

**História (SR).** A button next to "Obnoviť" → `/dashboard/pipeline/historia`: deals that moved away from me
(`DealOwnership.fromUserId = me`, current owner ≠ me): `#číslo firma · prevzaté 18. 9. · Michal · poznámka`. No link
(`deals.viewHandedOver`, nobody holds it).

**Counters on every pill.** One SQL query with `count(*) FILTER (…)` per view, same scope + owner + status filters as
the list. New pills: **"Pre mňa"** (assignee = me; for everyone, usually only the manager has any) and **"Čaká na
manažéra"** (my deals whose step is assigned to someone else) — replacing "Požiadavky".

**Manager dashboard** "Čaká na mňa" = the same query as "Pre mňa" (oldest first, red after 2 business days).

### 3.4 What disappears

`DealRequest` and everything around it: `ensureOpenRequest`, `resolveOpenRequests`, `closeRequestsForStatus`,
`createDealRequestAs`, `cancelOwnDealRequestAs`, `resolveDealRequestAs`, `openRequestsWhere`, `RequestsCard`, the
requests card and request step in the detail/sheet, the requests view and kind sub-filter, the automatic DESIGN/ORDER
requests from call outcomes, the auto-closing in `saveQuote` / `recordOffer` / WON / reopen / revert,
`caps.createRequests` / `resolveRequests` (replaced by "may hand over" / "is a resolver"), `REQUEST_KIND_LABEL`.

## 4. Code shape (B)

- `lib/domain/handover.ts` (pure): manager-side kinds, who may assign to whom, the default returned step per kind.
- `lib/domain/handoverMutations.ts`: `assignStep`, `returnStep`, `takeOver`, `recordOwnership` (called by every owner
  change: first-call handoff, owner select, bulk transfer, takeover, revert).
- `lib/commands/handover.ts` + actions; `logFollowUpAs` / `recordOfferSentAs` respect "keep the assigned step".
- `lib/queries/pipeline`: `assignee` in rows and detail, views `for_me` and `waiting_on_manager`, counters, História.
- UI: "Požiadať manažéra…" dialog, "Hotovo – vrátiť" dialog (with price fields for Naceniť), "Preberám klienta",
  assignee line on the next-step tile and list rows, pills, História page.

## 5. Permissions

`requests.resolve` stays as "resolver" (may receive steps, return them, take over — with `deals.manage`). Handing over:
`deals.work` on the deal (owner) and not a resolver. New unused `deals.viewHandedOver`. Out of scope → `NOT_FOUND`.

## 6. Schema (test first; for production everything is additive)

| id | Change |
|---|---|
| S-08 | `Lead.nextActionAssigneeId`, `Lead.nextActionAssignedById` (FK User, nullable), `Lead.nextActionAssignedAt`; index `(nextActionAssigneeId, status)` |
| S-09 | `NextActionKind += PREPARE_PRICE, PREPARE_DESIGN, TAKE_OVER, REOPEN_DEAL`; remove `ORDER` |
| S-10 | `DealOwnership` + `DealOwnershipReason` |
| S-11 | drop `DealRequest`, `DealRequestKind`, `DealRequestStatus` (test only; production never had them) |

`db-changes.md` then loses the round-1 `DealRequest` rows (§1.5) and the wave-2 `NextActionKind.ORDER` row — the
production delta gets smaller.

## 7. Tests

- assigning: SR → manager only; not to telesales, not to self; one bump; idempotent; the deal leaves the SR's Na dnes
  and appears in the manager's "Pre mňa" (any owner, ignoring the owner filter); counts match lists;
- the SR's contact recording keeps the assigned step by default; replacing it un-assigns;
- return / "vybavil som sám" / takeover: right owner, step, assignee, history, one bump; takeover writes `DealOwnership`
  and the SR immediately gets `NOT_FOUND`, while História lists the deal; every owner-changing command writes exactly
  one ownership row;
- a return racing the SR's own step change → one wins, the other gets `STALE`;
- `clientSection()` ↔ Na dnes SQL parity with the new rule; no business action creates or closes anything by itself.

## 8. Order of implementation

1. Schema (+ convert/clear the few test rows) → generate.
2. Domain + commands + ownership recording + removal of the request machinery + the Na dnes rule change with parity.
3. Queries: assignee in rows/detail, "Pre mňa", "Čaká na manažéra", counters, História.
4. UI.
5. Docs, full check pass, HTTP role checks, human click-through.

## 9. If model A (tickets) is chosen instead

Keep v1 (`wave-3-tickets-proposal-backup.md`) with these corrections found while rethinking: production has no
`DealRequest` table, so reshape it freely (remove `EMAIL` / `ORDER`, NOT NULL columns are fine); make every ticket
state change go through one function that also sets/clears the parked step; resolve "several open tickets" by never
parking twice.

## 10. Model C in detail — a task for the manager, a separate next step for the owner

This is a **third proposal**, not an approved schema or implementation instruction. It uses the useful part of B's
"ball" metaphor in the UI while keeping the two independent responsibilities from Michal's examples. The manager
task is a real object, but unlike A it never has to agree with a stored `WAITING_FOR_MANAGER` next-step kind.

### 10.1 The three sources of truth

| Data | One meaning | Not its meaning |
|---|---|---|
| `Lead.ownerId` | who owns the client relationship and may work the deal as an SR | who is currently making a design or price |
| `Lead.nextAction*` | the **owner's** next action or reminder (which can include preparing an artifact on the manager's own deal) | another person's task queue |
| an OPEN `DealTask` (working name) | a specific piece of internal work assigned to a named person | a transfer of deal ownership or a replacement for every SR action |

The app never infers ownership from the assignee. Asking for a price/design does not make the manager the deal owner;
only an explicit takeover/owner-transfer mutation does. Conversely a manager can take over without any prior task.
The current `DealRequest` behaviour where *any* OPEN request hides the owner's due call is removed. No business action
creates a task merely because it sees an outcome, and saving a price/design/send does not silently finish one.

### 10.2 Proposed data shape (to finalise before a schema command)

`DealTask` is the preferred **logical** and UI-neutral name; implementation may replace/convert the test-only
`DealRequest` table rather than physically create a parallel table. Never leave old `DealRequest` and new `DealTask`
write paths active together. Minimum persisted fields:

| Field | Meaning |
|---|---|
| `id`, `leadId` | stable task identity and deal; `leadId` FK |
| `kind` | `PRICE`, `DESIGN`, `CLIENT_CALL` (technical/details), `REOPEN`, `OTHER`; a pending takeover kind only if the acceptance policy in §11 chooses one |
| `status` | `OPEN`, `DONE`, `CANCELLED`; resolved rows remain for history |
| `requestedById`, `assigneeId` | historical requester and **actual named recipient** (`User` FKs); do not encode "all managers" as an implicit recipient |
| `requestText`, `createdAt`, `updatedAt` | instructions and age; editing/comments never reset `createdAt` |
| `resolution`, `resultText`, `resolvedById`, `resolvedAt` | `RETURNED`, `DONE_BY_ASSIGNEE`, `TAKEN_OVER`, `DECLINED`, `CANCELLED_BY_REQUESTER`, `CLOSED_WITH_DEAL`, `REOPENED` as applicable; exact enum can be narrowed at schema review |
| `suggestedReturnKind` | owner action proposed when the task is finished (`SEND_QUOTE`, `SEND_DESIGN`, `CALL`, etc.); not a second copy of the manager's task status |
| `acknowledgedAt?` | the current owner has seen/acted on the finished result; until then "Hotové od manažéra" remains conspicuous |

A PRICE result must retain the amount and breakdown **as delivered by the manager**; a DESIGN result must reference the
selected `Design` and version/link that were ready at resolution. These are immutable result snapshots/references,
not replacements for current `Lead.price` or the design version. Choose typed columns or a strictly validated result
object in the final schema; do not rely on parsing a free-text result later for history or statistics. A task-specific,
append-oriented `DealTaskMessage`/event table records each comment and request-text correction with author and time.
Both sides can add new details while the task is OPEN; a manager sees the latest update, and the original request is
not silently overwritten. General deal notes are still wave 4.

At most one OPEN task of the same kind per deal in wave 3, enforced under the `Lead` lock; a second attempt opens the
existing task to add information, not another invisible duplicate. Distinct kinds may be open together (e.g. PRICE
and DESIGN). A later new request of a completed kind is a new task. Index the assignee/status/age for "Pre mňa",
lead/status for badges, and requester/status for "Čakám". The final design must specify where unique idempotency
keys and complete payload fingerprints are stored for task creation, comments and resolution. (Correction, verified
in code: the Wave 3a gap is already fixed — `activityReplay` compares a content fingerprint since review fix R3-5. The
only replay without a full fingerprint is `idempotentReplay` for CALL, which compares source + outcome but not note
or next step; do not copy that one.)

`DealOwnership` from A/B remains a separate additive table: `leadId`, `fromUserId?`, `toUserId?`, `byUserId`, reason,
note and time. Every actual owner change writes one row in the same transaction, including positive first-call
routing, manual owner selection, bulk transfer, takeover and first-call revert. A task assignment is **not** an
ownership row. Do not invent historical HANDOFF rows from current `ownerId`/`handedOffById` if the original owner
cannot be proved; a clearly labelled baseline or history beginning at rollout is more honest.

No `Lead.nextActionAssigneeId`, `PREPARE_PRICE`, `PREPARE_DESIGN`, `TAKE_OVER`, `REOPEN_DEAL` or
`WAITING_FOR_MANAGER` step kinds are needed for C. The test-only `ORDER` step and old automatic `DealRequest`
machinery are retired; production never had `ORDER` or `DealRequest` according to the current ledger, subject to the
live-schema comparison before rollout.

### 10.3 Opening a task and the owner's queue

An initial `WANTS_QUOTE` or `WANTS_DESIGN` call creates the deal and its owner next step as it does now, **but no
automatic manager task**. An SR sees a prominent contextual "Požiadať o cenu/návrh" shortcut. Clicking it explicitly
selects the recipient (the sole eligible active manager can be pre-filled), supplies/edits the request text (pre-filled
from the relevant call), and creates the task. On the manager's **own** deal, making a price/design is the manager's
own next step, not a request to himself.

The existing `WANTS_TO_ORDER` outcome remains a truthful record of what the client said, but C removes the test-only
`ORDER` next-step kind and automatic ORDER request. On an SR-owned deal it offers an actionable, due-now owner step
"Odovzdať manažérovi / dohodnúť ďalší postup" (using an existing suitable step kind until a final kind is chosen),
not a silently created task or WON. The SR then explicitly hands over under the policy in §11. On a manager-owned
deal it is a manager follow-up, not a request to himself. The exact replacement kind/label is a final-design choice
and needs a test for both owner types.

Opening a task changes the owner's next step **only if that exact step is now blocked by the request**: e.g.
`SEND_QUOTE` without a price or `SEND_DESIGN` without a ready design can be cleared in the same transaction. The task
stores the suggested return action. An already scheduled SR call, a `WAITING_FOR_CLIENT` check, or another independent
step is left alone. This is a one-time, explicit transition, **not** the A-style permanent invariant "open task iff
waiting step". The task badge remains visible whatever next step the SR chooses later.

Section/list rule for open deals, shared by `clientSection()` and its SQL twin:

1. If the owner has a due/overdue next action, it stays in **Na dnes**, even with an OPEN manager task. The row also
   says "Čaká na Michala: návrh".
2. If an `ACTIVE` deal has **no owner next action** and has an OPEN manager task, it is shown as **Čaká na manažéra**,
   derived from that task; no waiting value is stored in `Lead.nextActionKind`.
3. If an `ACTIVE` deal has no step and no open task, it stays in Na dnes as "bez ďalšieho kroku". Closed status takes
   precedence. A `SNOOZED` deal keeps its existing sleep/wake rule; a task does not silently wake it or change its
   status, and the manager's task inbox remains visible independently of the deal status filter.

The SR may record a call, reply or SMS while a manager task is OPEN. That interaction does not cancel, replace or
resolve the task. Its own next-step selection is the SR's action only. Adding new client requirements to the task is
an explicit comment/update, visible in the manager's inbox; it cannot be hidden solely inside the mutable `Lead.note`.
If the SR cancels a task, she gives a reason; the task becomes CANCELLED. If the owner has no step and no other open
task, the deal returns to Na dnes as "bez ďalšieho kroku", so the SR must choose what to do next.

### 10.4 Completion, return, send and takeover

Completing a task is an **explicit** manager action; saving a quote, creating a design, recording `OFFER_SENT`, or
logging a call in another part of the app may show "work appears ready — finish task?" but never closes it behind the
user's back. There are three endings:

- **Hotovo – vrátiť obchodníkovi.** For PRICE, enter/confirm amount + breakdown; save `Lead.price` and an immutable
  task-result snapshot together. For DESIGN, select a non-deleted design with a usable email link/version; just
  creating an empty design is insufficient. The task is DONE. If the owner has no current step, set the suggested
  `SEND_QUOTE` / `SEND_DESIGN` step (business date) in that same transaction. If the owner scheduled a call or another
  step meanwhile, **preserve it** and surface an unacknowledged "Hotové od manažéra – poslať cenu/návrh" item until the
  SR explicitly changes/acknowledges it. Never silently replace her plan.
- **Vybavil/a som to sám/sama.** The manager actually sends or calls, records that event, and completes the task as
  **one logical transaction**. Sending a price/design uses the current `OFFER_SENT` snapshot rules; it does not send
  an email on its own. The SR gets an appropriate follow-up suggestion (e.g. "Zavolať, či prišlo") under the same
  non-overwrite rule. Do not record a send merely because the manager prepared a price/design.
- **Preberám klienta.** An explicit owner change to the manager; the task is resolved as TAKEN_OVER, other open tasks
  are explicitly resolved/reassigned as part of the same UI decision, `DealOwnership` and `OWNER_CHANGED` are
  written, and the former SR immediately loses deal-detail access. Her restricted História keeps who/when/why.

A manager may take over a deal **without** any task. A generic owner transfer while a task is open must preserve the
task's historical requester, name its *current* recipient, and return the work to the **current** deal owner, not
blindly to the old requester. Transfer to the task's assignee and deactivation/role loss of an assignee need an
explicit keep/reassign/close policy; never leave work assigned to an inactive account. Closing a deal cancels open
tasks with a visible `CLOSED_WITH_DEAL` reason in the same transaction; reopening does not resurrect them silently.

### 10.5 Walk-through of Michal's examples

| Flow | SR sees/does | Manager sees/does |
|---|---|---|
| A: initial call → wants a price → complex | Own deal with `SEND_QUOTE`; presses "Požiadať o cenu", describes requirements. It moves to "Čaká" only if she has no other action. | `Pre mňa: Naceniť`, enters price + breakdown, returns it; SR sees "Hotové" and sends the price through "Čo sme poslali". |
| B: initial call → wants a návrh | Explicit "Požiadať o návrh"; may still log a new client call, schedule one, and append "prosí modrú" to the open task. | Sees updated task, makes/selects the design and link, returns it. SR sends and records the send, then follows up. |
| B variant: manager sends the návrh | SR remains owner and sees the actual send plus a returned follow-up, without pretending she sent it. | Records the real `OFFER_SENT` and finishes the task atomically. |
| C: client has deep technical questions | Chooses an explicit complete handover (or requests acceptance, depending on §11). Once ownership changes, she sees only restricted História. | Takes the deal, handles technical discussion and future communication; not merely a "design task" still owned by the SR. |
| Reopen a closed SR deal | Creates a `REOPEN` task; the closed deal gets **no** fictitious next step. | Reopens and resolves it in one transaction, or declines with a reason. |

The direct-versus-accepted SR handover in C is **not decided**. My default for this option is an explicit, confirmed
direct transfer to an eligible manager (not general `deals.manage` for the SR): the manager's pipeline gains it
immediately. If Michal wants to accept/refuse first, model it as a distinct pending takeover task; ownership stays
with the SR until acceptance, and the UI must say that plainly.

### 10.6 UI, counts and visibility

- Manager: **Pre mňa (n)** counts OPEN tasks assigned to *me*, regardless of the deal's owner/status filters; oldest
  first, with overdue age, company, kind, requester and latest comment. The dashboard "Čaká na mňa" uses the same
  query. The deal detail has a concise task card, not a second full pipeline.
- SR: **Čakám na manažéra** shows her deals with OPEN tasks, even if she also has a due action; task badges say what
  and who. **Hotové od manažéra** (or one prominent returned-work count) shows DONE but unacknowledged results so a
  completed design cannot disappear behind a different scheduled SR step. The exact pill layout can be settled in the
  UI pass, but the result must remain visible until the SR acts/acknowledges it.
- Counts must match the actual clicked list: "Pre mňa" counts **tasks**, "Čakám" can count **deals** if its rows are
  deals (state that in the label), and the general pipeline pills retain their own scope/owner/status filters. Do not
  reuse today's `Požiadavky` count with its owner filter for the manager inbox.
- An SR sees only tasks on her currently owned deals and her own limited completed/handover history. A former owner
  does not regain deal detail through a task URL. `deals.viewHandedOver` remains an unused future capability; the
  História list exposes only the deliberately allowed summary.

### 10.7 Permission and future-developer boundary

Today the SR may request/cancel/comment on an **own** deal; only an active manager/admin may be the recipient and
complete manager work. The manager can inspect all tasks/deals and take over. Telesales do not request tasks and do
not obtain deal access through the first-call shortcut. Commands recheck the live DB user's role/permissions and
the deal/task relationship under the lock; UI capabilities and `taskId`/`leadId` in a URL are never authority.

When a developer role is added, give it a **task-assignee permission and a narrow task view**, not `deals.manage` or
all-deal scope. A manager can reassign a DESIGN task to the developer; its requester and task history stay intact.
The developer sees only the context and design controls required for the assigned work, not the SR's whole pipeline or
other reps' deals. That future permission/UI is out of this wave, but storing an actual `assigneeId` now avoids an
"every ticket is for all managers" migration later. Do not equate a team's leader with an eligible task resolver:
the leader may be an SR or scout leader.

### 10.8 Transaction and collision rules

Every task mutation affecting an existing deal uses `withLockTx`, an access guard, Team → User (actor, owner,
assignee/target in id order) → Lead → task row, `expectedRevision`, a full-payload idempotency key, and exactly one
`Lead.revision` bump for the business transaction. A comment also bumps once under the existing rule. Persist and
compare the actual semantic payload on retry (kind, assignee, text, completion choice, price/design, return-step
choice); a reused key with changed content is `IDEMPOTENCY_CONFLICT`, not a false "saved". A stale SR step edit racing
a manager return: one wins, the other refreshes; it must never overwrite both plans without a choice.

Task completion with price/design, an optional real `OFFER_SENT`, next-step proposal, ownership change if selected,
task status, activity/audit and revision is atomic. If any part fails, none of it commits. A retry of a completed
operation returns the prior logical result, not a second price/send/task or a second revision bump. No task/comment/
ownership activity counts as "Naposledy" client contact; only the actual call, reply, SMS or send does.

### 10.9 Test-branch transition and production delta

This option is a **proposal only**; do not add it to `context/domain/db-changes.md` yet. Today test has the old
`DealRequest` table, `ORDER` step and automatic request writers. Before changing test schema, inventory the rows and
their activity/history links, choose whether to convert/retain fixture information or deliberately discard known
fixtures, document the exact SQL and rollback/restore path, and review any destructive warning. Remove every old
automatic create/close writer in the same implementation wave as the query and UI switch. Do not let both task
models be writable. Run `clientSection()` ↔ SQL parity after removing the blanket open-request exclusion.

The current production ledger says production has **no** `DealRequest` and no `NextActionKind.ORDER`, so retiring them
on test should not become a production drop; the eventual net Wave 3 change can be new task/message/ownership
objects and enums only. This remains conditional on comparing the *actual* production schema before rollout—the
ledger's baseline is explicitly an assumption. Wave 3 is not a standalone deployment: the pending round-1, Wave 2
and Wave 3a schema/data steps have their own order. The chosen non-additive old-send conversion is a **separate**
reviewed migration and must not be disguised as an additive Wave 3 change. No live database is touched in this
proposal phase.

### 10.10 Required tests and implementation order if C is chosen

1. Decide §11 policy questions and record the final schema/data-safety plan in the active feature design; do not
   silently implement this optional section alongside B. Verify the test endpoint, inventory old test requests,
   review the generated SQL, apply on test, then record the **verified net** test–production delta.
2. Build one guarded task command path; remove automatic request creation/closing; implement task events, completion,
   owner-history writes in *every* owner-changing path, and the limited handover operation. Unit/concurrency cases:
   duplicate create; same key/same and changed payload; two kinds on one deal; create/comment/return versus SR call,
   scheduled step, close, transfer and deactivation; one revision bump and no partial PRICE/DESIGN/send result.
3. Change `clientSection()` and TODAY SQL together; assert parity over combinations of due SR action, no action,
   OPEN tasks, multiple tasks, SNOOZED and closed. Test inbox/count/list parity across owner/status filters and
   rep-versus-manager scopes. The manager must see assigned tasks on another owner's deal; an SR must never see a
   foreign task or regain a transferred deal via a task/history URL.
4. Build the contextual shortcuts, task detail/thread, return/send/takeover dialogs and conspicuous returned-work
   state; check the flows on phone and desktop with two accounts/tabs. Only then update current-state domain docs and
   the progress tracker, run the full code/database-backed check pass on test, and schedule a production-duplicate
   rehearsal separately.

## 11. Open questions before choosing a model

1. **A, B or C?** B is smallest now; C is the better fit if the SR and manager may have independent simultaneous
   actions, and if developer assignment should later have narrow access. Neither C nor its schema is approved yet.
2. Under C, does an SR's **"Odovzdať manažérovi" transfer ownership immediately**, or create a takeover request
   that the manager accepts? Until acceptance the SR remains owner; after immediate transfer she loses access.
3. Under C, is one open task **per kind per deal** sufficient? A PRICE and DESIGN task can coexist; later delegation
   changes a task's assignee, not its identity.
4. Under C, should a completed-but-unacknowledged result have its own "Hotové" pill, or a badge/count in Na dnes?
   Either way it must stay visible when an unrelated SR next step was preserved.
5. Under B, is one pending ask per deal enough in practice? (Two asks = one compound step/note.) Can a closed REOPEN
   request and a future developer's limited access fit without a separate task object?
6. Under B, is the step note plus deal history enough conversation until wave 4? How is assignment duration measured
   reliably after the current assignee fields are cleared?
7. For any model, should ownership history start at rollout rather than backfilling unprovable earlier owner changes?
   What should the SR's limited História show for transfers that happened before the new log existed?
8. The manager's **"Pre mňa"** — a distinct pill is recommended. Define its count from the same query as its list.

## 12. Not in this wave

General deal notes/conversations (wave 4; C's *task-specific* updates are part of its task if chosen), notifications,
the developer role and its UI, pipeline sorting by "naposledy upravené", team sanity warnings, and the separately
reviewed old-send migration.

---

## 13. Review of A, B and C against the code and Michal's workflow (Claude, 2026-09-18)

### 13.1 The workflow every option must serve (Michal's words, condensed)

INITIATE = telesales/SR calls from `/calls` and picks návrh / email / cena.

- **A (price):** SR picks "Cenová ponuka" → the project is complicated → asks the manager for the price → the manager
  gives it back → **the SR must see it** and sends the email.
- **B (návrh):** only the manager (later a developer) makes a návrh → the manager must see it has to be done → makes
  it, uploads the link → **the SR sees it is ready**, sends it, marks it sent → follows up → client wants it / wants
  deeper changes → the manager takes over and talks to the client from then on. Small wishes ("make it blue") → the SR
  keeps the client.
- **C (deep details):** after the first call the client has requirements or technical questions → the deal goes to
  the manager **completely**.
- Always: the manager can take over at any point; the SR sees what is waiting for the manager and what came back; the
  manager sees his list; the UX must be obvious.

So there are **two different things**, and the design must not mix them:
1. **Work for someone else on a deal that stays mine** (price, návrh, návrh changes) — it goes there and comes back.
2. **Handing the client over** (C, the end of B, a manager takeover) — it goes there and does not come back.

### 13.2 Facts checked in code that decide between the options

| Fact (verified) | Consequence |
|---|---|
| Only the manager can create/edit a návrh: `createDesignAs` etc. use `requireDealManage` (`lib/commands/tracking.ts`). | The návrh is always someone else's work for an SR → a frequent case, not an exception. |
| Closed deals are read-only for the owner; the only thing an SR may do on one is ask to reopen (`ClosedPolicy "reopenRequestOnly"`, `lib/access/leads.ts`); reopening is `requireDealManage` (`reopenDealAs`). | **B's `REOPEN_DEAL` step cannot work**: a closed deal has no next step and the SR may not write one. A reopen ask needs an object outside the step, i.e. a task. |
| Today any OPEN request moves the deal to "Čaká na nás" before the step is looked at (`lib/domain/clientSections.ts:68`), and the SQL twin has `NOT EXISTS (open request)` (`lib/queries/pipeline/index.ts:124`). | This is the bug Michal hit: a due SR call disappears. All options remove it; the replacement rule goes into both places with the parity test. |
| `activityReplay` already compares content fingerprints (R3-5); `Activity.idempotencyKey` is unique; `OFFER_SENT` meta is zod-validated. | Task events can be **Activity rows**: idempotency, immutable snapshots and the deal history come for free (13.4). |
| First calls create requests automatically (`lib/commands/calls.ts:142` DESIGN on WANTS_DESIGN; `lib/commands/dealWork.ts:218/274`); `WANTS_TO_ORDER` makes an ORDER request. | Michal decided: no automatic tickets. Every option removes these writers. |
| `NextActionMode.IN_PROGRESS` exists ("rozpracované, trvá X dní"). | Not needed by any option; noted so nobody reuses it as a "waiting for the manager" flag. |

### 13.3 Verdict per option

**A — tickets + parked step.** Correct, but carries the one invariant that broke every review: *open ticket ⇔ parked
step*; the parking can hide a due SR call. **Reject.**

**B — the ball on the step.** Beautifully small, but four real problems:
1. The deal has **one slot**. During flow B (the manager makes the návrh for days) the SR cannot keep her own reminder
   ("call Friday, tell them it's coming"), and a returned result replaces whatever she planned.
2. `REOPEN_DEAL` as a step is impossible (13.2).
3. After a return the assignee columns are cleared, so "how long did the manager take" and "what did he return" live
   only in planning-activity text. Statistics need structure.
4. A future developer needs access to the **deal** (the step lives on it), i.e. deal scope for developers — which C
   correctly avoids.
It also blurs the two things from 13.1: "Prevziať klienta?" is a step that means an ownership change.

**C — separate task, no parking.** The right split (owner + owner's step + a task for someone else), but as written
it grew heavy and has two mechanisms where one is enough:
1. **Returned work visibility** is solved three times: a conditional step rewrite on return ("set `SEND_QUOTE` if the
   owner has no step, otherwise keep it"), **plus** `acknowledgedAt`, **plus** a "Hotové" pill.
2. **Opening a task silently clears** `SEND_QUOTE`/`SEND_DESIGN` "if blocked" — an automatic rewrite of the SR's plan
   hidden in a rule, the opposite of "no silent changes".
3. **Two new storage shapes** (`DealTaskMessage` table + typed result snapshot) where the Activity table already gives
   append-only, authored, timestamped, idempotent, zod-validated rows shown in the deal history.
4. The `CLIENT_CALL` kind overlaps with flow C (which is a full handover, not a task) → unclear which to use.
5. `acknowledgedAt` answers "has the SR seen it"; what matters is "has the SR **done** something with it".

### 13.4 Recommendation: **C′ — the ball on the task** (C, simplified)

Keep C's three truths (owner, owner's next step, task). Take B's best idea — *whose move is it* — but put it **on the
task**, not on the step.

**Data.** Reshape the test-only `DealRequest` into `DealTask` (production never had it → additive):

| Field | Meaning |
|---|---|
| `id`, `leadId`, `kind` | `PRICE` (Naceniť) · `DESIGN` (Návrh / úprava návrhu) · `REOPEN` (Znovu otvoriť) · `OTHER` (Otázka / iné) |
| `status` | `OPEN` · `DONE` · `CANCELLED` |
| `requestedById` | who asked (history, never changes) |
| **`holderId?`** | **whose move it is now.** A user = that person must act. **`NULL` = the deal's current owner** ("came back to you"). |
| `text` | the ask; additions are Activity rows, the original is never silently overwritten |
| `createdAt`, `returnedAt?`, `closedAt?`, `closedById?`, `closeReason?` | age, "vrátené", closing |

Partial unique index: one OPEN task per `(leadId, kind)`. Index `(holderId, status)` for "Pre mňa".

The **events are Activity rows** with `meta.taskId` (types settled at schema review, e.g. `TASK_CREATED`, `TASK_NOTE`,
`TASK_RETURNED`, `TASK_CLOSED`; the test-only `REQUEST_*` values may be reused or renamed). A returned price stores
`{amount, breakdown}` in the `TASK_RETURNED` meta; a návrh stores `{designId, version}`. That one row is the immutable
snapshot, the idempotency record (unique key + fingerprint via `activityReplay`) and the history line "Michal:
nacenené 1 285 €". **No message table, no snapshot columns, no `acknowledgedAt`.** None of these rows counts as
"Naposledy" (not in `LAST_TOUCH_TYPES`).

**Why `holderId NULL = owner` matters.** A returned task automatically follows the deal: takeover or transfer needs no
task update, and a former SR never keeps work on a deal she can no longer see.

**One inbox for everybody — "Pre mňa (n)"** = OPEN tasks whose holder is me (`holderId = me`, or `NULL` on a deal I own).
- Manager: "Naceniť · Jana · Kvetinárstvo Lipa · od 2 dní".
- SR: "Cena od Michala: 1 285 € — poslať" / "Návrh je hotový — poslať".
- Later developer: the same pill and list, a narrow task view. Nothing new to learn for anyone.

**"Čakám (n)"** = deals I own with an OPEN task held by someone else ("Čaká na Michala: návrh · 2 dni").

**Sections** (`clientSection` + SQL twin, one commit, parity test):
1. closed → closed (their tasks were cancelled when the deal closed);
2. a task **held by the owner** (returned) → **Na dnes**, badge "Hotové od Michala" — returned work cannot hide behind a
   later step, and the step is never rewritten;
3. the owner's step is due → Na dnes (an open manager task is only a badge);
4. no step and a task held by someone else → **Čaká na manažéra**;
5. no step, no task → Na dnes "bez ďalšieho kroku"; otherwise planned/future as today. SNOOZED keeps its rule.

**Flows.**
- *Asking* (SR, own deal): "Požiadať manažéra…" → kind + text (pre-filled from the call note) → the dialog shows the
  current step with a **visible** choice *Ponechať* / *Zmeniť* / *Bez kroku – čakám*. The default is *Bez kroku* when
  the step is the blocked one (`SEND_QUOTE` for PRICE, `SEND_DESIGN` for DESIGN), otherwise *Ponechať*. The user sees
  it before saving → not silent. One transaction, one bump.
- *Adding info* ("chce modrú"): "Doplniť" on the task → a `TASK_NOTE` row; the manager's list shows the latest note.
- *Manager returns*: "Hotovo – vrátiť Jane". PRICE asks for amount + breakdown (saved to `Lead.price` and the
  snapshot); DESIGN requires picking an existing, non-deleted design with a link. `holderId → NULL`, `returnedAt` set.
  **The SR's step is not touched**; rule 2 puts the deal into her Na dnes.
- *SR sends*: the existing "Čo sme poslali" dialog shows **"✓ Uzavrieť: Cena od Michala"**, pre-ticked when the ticked
  contents cover the task (the price for PRICE, that design for DESIGN). Visible and un-tickable → explicit, unlike the
  old hidden auto-close. A plain "Uzavrieť / netreba" button on the task as well.
- *Manager does it himself*: "Vybavil som to sám" = the existing send dialog + closing the task in one transaction; the
  SR sees the send in history.
- *Small návrh changes after sending* (flow B): a new DESIGN task "úprava: modrá" (the previous one is closed, so the
  one-per-kind rule holds); the SR keeps the client.
- *Delegation later*: the manager changes the holder to the developer; the developer returns it to the manager or to the
  owner (`NULL`). The requester stays.
- *Reopen*: on a closed deal the SR creates a `REOPEN` task (allowed by `reopenRequestOnly`); the manager's reopen
  closes it in the same transaction, or he declines with a reason.

**Handover is not a task** (13.1, thing 2):
- **"Preberám klienta"** (manager, any deal, any time) and **"Odovzdať manažérovi"** (SR, own deal: flow C, "idú do
  toho", "chcú väčšie zmeny"). Both direct and immediate, with a required note and the new owner's first step. The
  dialog lists the open tasks and what happens to each (tasks held by the new owner are closed — he cannot ask himself;
  returned ones simply follow the deal). `DealOwnership` + `OWNER_CHANGED`; the SR loses access at once and keeps the
  História line. Direct beats "request + accept": one state fewer, and the manager finds the deal in his Na dnes with a
  step.
- `WANTS_TO_ORDER` / "Idú do toho" / "Pozreli, chcú zmeny" on an SR deal **offer** "Odovzdať manažérovi"; the `ORDER`
  step and the ORDER request disappear.

**Edge rules.**
- Closing (WON/LOST) cancels open tasks with reason "obchod uzavretý"; reopening does not revive them.
- Deactivating a user who holds tasks: the deactivation dialog reassigns them to another resolver (never work on an
  inactive account); `NULL`-held tasks are unaffected.
- No task to yourself (`holder ≠ actor` at creation): on the manager's own deal price/návrh are simply his next steps.
- Eligible holders = users with `requests.resolve` (not "the team leader" — a leader may be an SR or scout leader).
- Every mutation: `withLockTx`, Team → User (actor, owner, holder, in id order) → Lead → task, `expectedRevision`, one
  bump, idempotency key with a fingerprint.

### 13.5 How C′ answers each workflow step

| Step | Screen |
|---|---|
| A2–3 SR unsure of the price | "Požiadať manažéra → Naceniť"; her row: "Čaká na Michala: cena · 0 dní" |
| A4 manager gives the price | Pre mňa → "Hotovo – vrátiť Jane" with the amount |
| A4 SR sees it | Na dnes + Pre mňa: "Cena od Michala 1 285 € — poslať"; "Čo sme poslali" closes the task |
| B2 SR cannot make a návrh | "Požiadať o návrh" (prominent after "Chcú návrh") |
| B3 manager sees and makes it | Pre mňa: "Návrh · Jana · Kvetinárstvo"; design card; the return picks the design |
| B4 SR sees it is here | Na dnes: "Návrh je hotový — poslať" with the copy-link button |
| B5 SR follows up | her normal step "Zavolať, či videli" (chosen when sending) |
| B6 changes / yes | small → new DESIGN task; deep or "áno" → "Odovzdať manažérovi" |
| C complete transfer | "Odovzdať manažérovi" right after the first call |
| Manager overtakes anytime | "Preberám klienta" on any deal |
| SR: what waits / what came back | "Čakám (n)" / "Pre mňa (n)" + badges |
| Manager: my tasks | "Pre mňa (n)" + dashboard "Čaká na mňa" (same query) |

### 13.6 Answers to §11

1. **C′** (13.4). B is simpler on paper but fails reopen, parallel work and the developer; A keeps the parking invariant.
2. **Direct transfer**, confirmed in the dialog, with a note and the manager's first step. No pending-acceptance state.
3. **One OPEN task per kind per deal** — yes; PRICE and DESIGN may coexist; a revision is a new task after the old one
   closes.
4. **Neither a separate pill nor `acknowledgedAt`**: the returned task sits in the SR's "Pre mňa" and keeps the deal in
   Na dnes until she closes it (by the send or "netreba").
5.–6. B questions — moot under C′ (task rows carry durations; conversation = `TASK_NOTE` rows).
7. **Ownership history starts at rollout.** No invented rows; História shows only logged moves.
8. **"Pre mňa"** is its own pill for everybody, counted by the same query as its list; "Čakám" counts deals.

### 13.7 Schema sketch for C′ (for review only — not applied)

| id | Change |
|---|---|
| S-08 | `DealRequest` → `DealTask`: add `holderId?` (FK User), `text`, `returnedAt?`, `closedById?`, `closeReason?`; `createdById` → `requestedById`; kinds `PRICE · DESIGN · REOPEN · OTHER` (drop `EMAIL`, `ORDER`); partial unique `(leadId, kind) WHERE status = 'OPEN'`; index `(holderId, status)`. Test rows: expected 0 after the reseed — verify before the push. |
| S-09 | `ActivityType += TASK_*` (or reuse/rename the test-only `REQUEST_*`) + the task meta zod schema |
| S-10 | `DealOwnership` + reason enum |
| S-11 | `NextActionKind` − `ORDER` (verify no lead uses it) |

Production delta: new `DealTask`, `DealOwnership`, their enums, new activity values. No new `Lead` columns.

### 13.8 What C′ costs compared to B

One table and a few activity types more, and one more case in the section rule (rule 2). In exchange: parallel work,
reopen, the developer, statistics, and returned work that never hides — without any step rewriting or a second
acknowledgement mechanism.
