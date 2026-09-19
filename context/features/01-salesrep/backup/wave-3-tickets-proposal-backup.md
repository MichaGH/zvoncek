# Wave 3 proposal (v1): tickets, handover, história, counters

Status: **PROPOSAL for review, nothing implemented.** Temporary file: once decided, it is folded into
`round2-deal-workspace.md` (replacing §2b, which it refines) and deleted.

For a reviewer without the code: Zvonček is an internal CRM (Next.js 16 + Prisma + PostgreSQL) for a small web-design
company. Telesales make first calls; a positive call makes the contact (`Lead`) a deal, owned by a sales rep (SR) or the
manager and worked in `/dashboard/pipeline`. Every mutation locks the lead row (lock order Team → User → Lead), checks an
optimistic `Lead.revision`, bumps it once, and accepts an idempotency key. Scope is server-side: a rep sees only own
deals; out-of-scope = `NOT_FOUND`.

Question for any reviewer: **is this a model the team can use unchanged when a developer role and more reps arrive?**

---

## 1. Why (what is wrong today, found in use)

Today a "request" (`DealRequest`) does three jobs at once — a **ticket** ("make me a price"), a **state marker** (the deal
leaves the rep's normal list) and an implied **handover** — and that produces:

1. **The "Požiadavky" pill counts the wrong thing.** For a rep it means "my deals with an open request" — their own
   outbox shown as a to-do ("Požiadavky (4)" after four first calls). For the manager it is empty by default, because
   the tickets sit on other people's deals and the default owner filter is "ja".
2. **A ticket swallows the deal.** The Na dnes rule and `clientSection()` send any deal with an open request to "Čaká na
   nás", whatever else happens on it.
3. **Tickets appear from nowhere.** "Chcú návrh" (first call or follow-up) and "Chcú objednať" create tickets
   automatically — even raised in the name of a *telesales* person — so the SR finds tickets they never raised.
4. **Tickets close themselves.** Saving a price, recording a send, marking WON or reopening silently close tickets, so
   the manager cannot "give the price back to the rep" versus "send it himself".
5. **No conversation.** One note field that a second create appends to; no edit, no reply.
6. **No explicit handover.** The manager cannot "take the client" as a recorded act, and the rep has no record of deals
   that were taken over.

## 2. Decisions already made (Michal, 2026-09-17/18) — this proposal must respect them

| # | Decision | Source |
|---|---|---|
| D1 | `Požiadavky` becomes an **inbox of tickets** with tabs **Pre mňa / Od mňa / Vybavené**; it ignores the owner filter | §2b D-16, §2c 9a.4 |
| D2 | **Where a deal sits is decided by its next step**, not by a ticket: new step `WAITING_FOR_MANAGER` ("Čaká na manažéra · cena") | D-16 |
| D3 | Kinds: `PRICE`, `DESIGN`, `CALL_CLIENT`, `HANDOVER`, `OTHER` (+ `REOPEN` on closed deals). No `ORDER`, no `EMAIL` (the rep sends emails) | D-17, §2c answers |
| D4 | `PRICE`, `DESIGN`, `CALL_CLIENT`, `HANDOVER` park the deal; `OTHER` does not | §2c answers |
| D5 | **No automatic tickets.** Only the deal owner raises one; telesales never do. The owner who cannot make designs sees "Požiadať manažéra o návrh" | §2c 9a.1, D-17 |
| D6 | **No tickets to yourself**: on the manager's own deal nothing is raised, it is simply his to-do | §2c answers |
| D7 | Note required only for `OTHER`; pre-filled with the last call note; one create function for every path | D-17 |
| D8 | Tickets are **editable by the author while open** (every edit logged, new `ActivityType.REQUEST_UPDATED`) and **both sides comment** | D-18, §2c answers |
| D9 | Age is set at creation; editing does not reset it | D-18 |
| D10 | **Cancelling un-parks the deal**: step cleared → Na dnes "bez ďalšieho kroku" | D-18 |
| D11 | **Tickets close only manually**; no business action closes one silently. If the manager does the work outside the ticket, the ticket shows a hint "Cena doplnená – uzavrieť tiket?" | §2c 6 |
| D12 | Resolution = **three buttons**: "Vrátiť obchodníkovi" · "Vybavil som to sám" · "Preberám klienta" (the two D-19 switches, simplified) | §2c 6, D-19 |
| D13 | For `PRICE`, the manager types price + breakdown **in the ticket**; it is saved on the deal and posted into the thread automatically | §2c 6 |
| D14 | "Vybavil som to sám" records the send and closes the ticket **in one save** | §2c 6 |
| D15 | **Takeover at any time**, with or without a ticket; the rep **loses access**; one question "Zavrieť otvorené tikety? (n)", default yes | D-20 |
| D16 | Ownership history (`DealOwnership`) powers the rep's **História** ("prevzaté 18. 9. · Michal", names and dates only), statistics and future rep → rep transfers; detail access behind an unused flag `deals.viewHandedOver` | D-21 |
| D17 | **Counters on every pill**, same scope + owner filter as the list; the inbox pill counts tickets for me | D-22 |
| D18 | No manager → rep tickets in this wave; work handed back arrives as the rep's next step | D-19 |

## 3. Facts that make this easier

- **Production has no `DealRequest` table at all** (round 1 is not rolled out). Everything about tickets is a new table
  for production, so reshaping it on test — even removing enum values or adding NOT NULL columns — is still **additive
  towards production** (`context/domain/db-changes.md`, net-delta rule).
- Production never had `NextActionKind.ORDER` or `DealRequestKind.ORDER` / `EMAIL`, so they can be **removed** instead of
  kept as legacy.
- Test data today: 20 fixture tickets (PRICE 2, DESIGN 16, ORDER 2 — all ORDER already cancelled), no lead on the
  `ORDER` step.

## 4. Model

### 4.1 Ticket (`DealRequest`, reshaped)

| Field | Change | Meaning |
|---|---|---|
| `kind` | enum `PRICE`, `DESIGN`, `CALL_CLIENT`, `HANDOVER`, `OTHER`, `REOPEN` (remove `EMAIL`, `ORDER`) | what is asked |
| `status` | unchanged `OPEN` / `DONE` / `CANCELLED` | |
| `resolution` **new** `DealRequestResolution?` | `RETURNED` (vrátené obchodníkovi) · `DONE_BY_MANAGER` (vybavil sám) · `TAKEN_OVER` · `DECLINED` (zamietnuté) · `CANCELLED_BY_AUTHOR` · `CLOSED_WITH_DEAL` (deal closed / reverted) · `REOPENED` | how it ended — for the rep's "Vybavené" tab and statistics |
| `note` | unchanged | the ticket text (editable by the author while open) |
| `editedAt` **new** `DateTime?` | set on every text edit | shows "upravené"; `createdAt` stays the age (D9) |
| `resolvedById`, `resolvedAt`, `resolutionNote` | unchanged | |
| `toUserId` | **not added now** (see open question Q1) | today every ticket goes to "the managers" = holders of `requests.resolve` |

Rule kept: **at most one OPEN ticket per (deal, kind)**, enforced under the lead lock. A second create of the same open
kind becomes a **comment** on the open ticket (today it appends to the note).

### 4.2 Thread (`DealRequestComment`, new table)

`id`, `requestId` (cascade), `authorId`, `body`, `system Boolean` (automatic lines such as "Cena: 1 285 € – Web 550 · …"),
`createdAt`. Comments only while the ticket is open. Visible to both sides.

### 4.3 Next step `WAITING_FOR_MANAGER`

- `NextActionKind += WAITING_FOR_MANAGER`; **remove `ORDER`** (test data has none).
- Raising a parking ticket (D4) sets the step: `WAITING_FOR_MANAGER`, no date, note = the reason ("Čaká na manažéra ·
  cena").
- `clientSection()`: `WAITING_FOR_MANAGER` → section "Čaká na nás", **never** "Na dnes" — for the rep it is parked. The
  rule "open request ⇒ Čaká na nás" is **removed**; the Na dnes SQL loses its `NOT EXISTS (open request)` clause and
  gains the `WAITING_FOR_MANAGER` exclusion **in the same commit** (the TS ↔ SQL parity test is the gate).
- Several parking tickets: resolving or cancelling one leaves the deal parked while another parking ticket is still open
  (reason of the oldest remaining) — **except** when the resolution explicitly sets the rep's next step (§5.4).
- The rep may still change the step while parked (they call the client meanwhile); the ticket stays open and the row
  shows a badge "čaká na manažéra: cena". A later resolution sets the step again.

### 4.4 Ownership history (`DealOwnership`, new table)

`id`, `leadId` (cascade), `fromUserId?`, `toUserId?`, `byUserId`, `reason` enum `HANDOFF` (positive first call) ·
`CHANGE` (owner select) · `BULK` (bulk transfer) · `TAKEOVER` · `REVERT` (first call reverted), `note?`, `createdAt`.
Written by **every** code path that changes `Lead.ownerId`, in the same transaction.

### 4.5 Activity log

- New `ActivityType.REQUEST_UPDATED` (edit, AUDIT, `meta.previousNote`) and `REQUEST_COMMENTED` (BUSINESS? — see Q4).
- Existing `REQUEST_CREATED` / `REQUEST_RESOLVED` stay; `meta.resolution` added.
- Takeover writes the existing `OWNER_CHANGED` (AUDIT) plus the `DealOwnership` row.
- None of these count as "Naposledy" (only real client contact does — already the rule).

## 5. Flows (user's view)

### 5.1 Raising a ticket (SR)

Entry points: the action sheet ("Požiadať manažéra…"), the detail's ticket card, and **contextual shortcuts**:
- "Chcú návrh" (first call already routed to the SR, or a follow-up reply) → the deal gets "Poslať návrh" with note
  "Požiadať manažéra o návrh", and the sheet/detail shows a prominent **"Požiadať manažéra o návrh"** (one click, text
  pre-filled from the call note). On the manager's own deal: no button, the step is his to-do (D6).
- "Chcú konkrétnu cenu" → step "Poslať cenu" with the hint "ak ju nevieš, požiadaj manažéra"; **"Požiadať o cenu"**
  one click.
- "Pozreli, chcú zmeny" (a design was sent) → for an SR: offers **"Prevziať klienta / zavolať im"** (`CALL_CLIENT` or
  `HANDOVER`) because the rep handles introductions only (§2d note); for the manager: a normal next step.
- "Idú do toho" (today "Chcú objednať") → for an SR: offers a **`HANDOVER`** ticket; for the manager: normal step.

Creating a parking ticket sets `WAITING_FOR_MANAGER` in the same transaction (one revision bump).

### 5.2 The inbox — `/dashboard/pipeline?view=requests`

- **Pre mňa**: open tickets I should act on. Resolver (`requests.resolve`) → all open tickets in scope; others → none
  today (D18). **Od mňa**: open tickets I raised, on deals still in my scope. **Vybavené**: tickets I raised or resolved,
  closed in the last 30 days, newest first.
- Default tab: Pre mňa for resolvers, Od mňa for others.
- Ignores the owner filter and the status tab (D1); a kind sub-filter stays.
- Row: kind badge · `#číslo firma` · who asked · age (red after 2 business days) · text (first line) · last comment ·
  "upravené" if edited. Row click opens the **ticket sheet**; the deal name is a link to the deal.
- The pill counts **Pre mňa** for resolvers and **Od mňa** for others (see Q2).
- The manager's dashboard block "Čaká na mňa" is the same query (one definition, `ticketsForViewer`).

### 5.3 The ticket sheet (both sides)

Header: kind, deal, author, age. Body: text (author: "Upraviť" while open), the thread, a comment box. Footer:
- author: "Zrušiť tiket" (optional reason) → `CANCELLED_BY_AUTHOR`, un-park (D10);
- resolver: the three resolution buttons + "Zamietnuť" (reason required, visible to the rep → `DECLINED`, un-park).

### 5.4 Resolving (manager) — three buttons

| Button | PRICE | DESIGN | CALL_CLIENT | HANDOVER | OTHER |
|---|---|---|---|---|---|
| **Vrátiť obchodníkovi** (`RETURNED`) | price + breakdown required in the sheet → saved on the deal, system comment in the thread; rep step "Poslať cenu" today | rep step "Poslať návrh" today (design must exist) | note what was agreed required; rep step chosen in the sheet (default "Zavolať" next working day) | = "not now": reason required; rep step chosen | rep step optional (default: keep) |
| **Vybavil som to sám** (`DONE_BY_MANAGER`) | opens "Čo sme poslali" with the price ticked; saving records the send **and** closes the ticket; rep step = the dialog's follow-up | same with the design ticked | the manager records his call via the action sheet; saving it closes the ticket; rep step from the sheet | — (not offered) | closes with an optional note; rep step optional |
| **Preberám klienta** (`TAKEN_OVER`) | takeover (§5.5) | takeover | takeover | takeover | takeover |

The rep's new step is always shown **editable** in the sheet before saving (kind + date), pre-filled as above. All of it
is one transaction: lock order Team → User (actor, owner) → Lead, one revision bump, idempotency key.

### 5.5 Takeover

From a ticket or from the deal detail ("Preberám si klienta", manager, deal not his): owner → the manager,
`DealOwnership(TAKEOVER)` + `OWNER_CHANGED`, optional note shown to the rep in *Vybavené*. One question "Zavrieť otvorené
tikety? (n)" — default yes (`TAKEN_OVER`), "nechať otvorené" allowed. If the step is `WAITING_FOR_MANAGER` it is cleared
(the deal lands in the manager's Na dnes as "bez ďalšieho kroku"), unless he sets one in the same dialog. **The rep loses
access immediately** (existing scope rule).

### 5.6 História (rep)

A button next to "Obnoviť" → `/dashboard/pipeline/historia`: deals whose ownership moved **away from me** (latest
`DealOwnership` with `fromUserId = me` and current owner ≠ me): `#číslo firma · prevzaté 18. 9. · Michal` and the note.
No link to the deal (`deals.viewHandedOver`, nobody holds it). The manager sees his own list too (rare).

### 5.7 Counters on every pill (D17)

One SQL query per page load with `count(*) FILTER (WHERE …)` per view, same scope + owner + status filters as the list
(`Na dnes` keeps its SQL rule). The inbox pill uses `ticketsForViewer`.

### 5.8 Where the automatic behaviour goes

| Today | After wave 3 |
|---|---|
| first-call "Chcú návrh" → DESIGN ticket (by the caller) | step "Poslať návrh" + note; no ticket |
| follow-up `WANTS_DESIGN` → DESIGN ticket | same; the sheet offers the one-click ticket |
| follow-up `WANTS_TO_ORDER` → ORDER step + ORDER ticket | outcome kept, relabelled "Idú do toho"; SR: offered HANDOVER ticket; manager: normal step |
| `saveQuote` closes PRICE | no; hint on the open ticket |
| `recordOffer` closes PRICE / EMAIL / DESIGN | no; hint; "Vybavil som to sám" closes it explicitly |
| WON closes ORDER as DONE | closing a deal closes all open tickets as `CLOSED_WITH_DEAL` (kept rule, new resolution) |
| reopening closes REOPEN as DONE | kept (`REOPENED`) — the reopen *is* the resolution of that ticket kind |
| reverting a first call cancels all tickets | kept (`CLOSED_WITH_DEAL`) |

## 6. Code shape

- `lib/domain/tickets.ts` (pure): kinds, which park, reason labels, default rep step per kind + resolution, validation.
- `lib/domain/ticketMutations.ts` (tx bodies): `openTicket` (the **only** create path: parks, dedupes into a comment,
  REQUEST_CREATED), `editTicket`, `commentTicket`, `resolveTicket`, `cancelTicket`, `unparkIfFree`, `takeOver`,
  `recordOwnership` (called by every owner change).
- `lib/commands/tickets.ts`: guarded commands; `lib/actions/pipeline` exposes them.
- `lib/queries/pipeline/tickets.ts`: `ticketsForViewer(viewer, scope, tab, filters)` — replaces `openRequestsWhere` and
  the three ad-hoc filters (pill count, requests view, manager dashboard).
- Replaced/removed: `lib/domain/dealRequests.ts` (`ensureOpenRequest`, auto-closing `resolveOpenRequests`,
  `closeRequestsForStatus` → one "close all with the deal" helper), `resolveDealRequestAs`, `createDealRequestAs`,
  `cancelOwnDealRequestAs`, `RequestsCard.tsx`, the request step in `InteractionSheet`, the requests card in
  `DealDetail`, `openRequestsWhere`; auto-close calls in `saveQuote` / `recordOffer`.
- UI: `components/pipeline/TicketInbox.tsx`, `TicketSheet.tsx`, `TicketBadge`, `components/pipeline/History` page.

## 7. Permissions

- `requests.resolve` (MANAGER, ADMIN) = resolver; unchanged.
- Raising: `deals.work` on the deal (owner) and **not** a resolver (D6); telesales have no `deals.work` → never.
- Editing/cancelling: the author. Commenting: the author, the deal owner, resolvers. Resolving/declining/takeover:
  resolvers with `deals.manage`.
- New unused permission `deals.viewHandedOver`.
- Out of scope → `NOT_FOUND`, as everywhere.

## 8. Schema proposal (test first; for production it is part of the new table — additive)

| id | Change | Note |
|---|---|---|
| S-08 | `DealRequestKind`: add `CALL_CLIENT`, `HANDOVER`; remove `EMAIL`, `ORDER` | test rows converted first: ORDER → HANDOVER (all cancelled anyway), no EMAIL rows exist |
| S-09 | `DealRequest.resolution DealRequestResolution?`, `DealRequest.editedAt DateTime?` | nullable; old test rows get `resolution` backfilled from status |
| S-10 | `DealRequestComment` table | new |
| S-11 | `NextActionKind`: add `WAITING_FOR_MANAGER`; remove `ORDER` | no lead uses ORDER on test; production never had it |
| S-12 | `DealOwnership` table + `DealOwnershipReason` enum | new; optional backfill of `HANDOFF` rows from `handedOffById` / `pipelineEnteredAt` for statistics (Q5) |
| S-13 | `ActivityType += REQUEST_UPDATED, REQUEST_COMMENTED` | additive |

Removing enum values in PostgreSQL = recreating the type (Prisma does it in `db push` / `migrate diff`); the reviewed
SQL must be read before applying, and it must run only after the conversion of the test rows. `ALTER TYPE … ADD VALUE`
values must exist before the code that writes them.

## 9. Tests (added to `prisma/backfill/check-concurrency.ts`)

- a rep's inbox never shows another rep's tickets; "Pre mňa" for a resolver ignores the owner filter; counts match lists;
- raising a parking ticket sets `WAITING_FOR_MANAGER` once (one bump, idempotent); a second same-kind create becomes a
  comment; OTHER does not park; telesales / manager-on-own-deal cannot raise;
- each resolution × each kind produces the right status, resolution, owner and rep step; "Vybavil som to sám" records
  the send and closes in one transaction; a resolution racing a cancel → exactly one wins;
- cancelling / declining un-parks only when no other parking ticket is open;
- takeover closes tickets (or not, when asked), writes `DealOwnership`, and the rep immediately gets `NOT_FOUND` on the
  deal while their História lists it; every owner-changing command writes exactly one `DealOwnership` row;
- `clientSection()` ↔ Na dnes SQL parity after the rule change; `check-client-sections.ts` expectations updated;
- no business action closes a ticket any more (saveQuote, recordOffer).

## 10. Order of implementation (each step ends green before the next)

1. Schema step (after converting the test rows) + generate.
2. Domain + commands (`openTicket`, resolve, cancel, edit, comment, takeover, ownership) + tests; remove auto-creation and
   auto-closing; the Na dnes rule change with its parity test.
3. Queries: `ticketsForViewer`, counters on every pill, História.
4. UI: inbox, ticket sheet, shortcuts in the action sheet / detail, badges, História page, takeover button.
5. Docs + full check pass + HTTP role checks + human click-through.

## 11. Open questions

1. **Addressing (`toUserId`)**: add now (unused, every ticket "for the managers") or when the developer role arrives? The
   table is new for production either way, so adding later is still additive. **Recommendation: later.**
2. **The SR's pill**: "Pre mňa" is always 0 for an SR today. Count "Od mňa" (open tickets I am waiting on) instead, or
   show no number? **Recommendation: Od mňa, in a muted style.**
3. **Revision bump on a comment**: a comment does not change the deal, but it is a mutation under the lead lock.
   Bumping keeps the rule simple ("every business transaction bumps") but makes the other side's open sheet stale.
   **Recommendation: bump** (consistency; staleness only refreshes).
4. **Should a comment count as history?** Log `REQUEST_COMMENTED` as BUSINESS (visible in the deal history) or keep
   comments only inside the ticket? **Recommendation: only inside the ticket** (no activity row), to keep the history
   about the client.
5. **Backfill `DealOwnership` HANDOFF rows** for existing deals (from `handedOffById` + `pipelineEnteredAt`), so the
   statistics start complete? Test only now; production decision at rollout.
6. **Vybavené window**: 30 days, or everything with paging?
7. **"Vrátiť" for HANDOVER** ("not now, you continue") — is it needed, or is "Zamietnuť" with a reason enough?
8. **Reminder when a ticket waits too long**: only the red age after 2 business days (today), or also something on the
   manager's dashboard? (Notifications are out of scope.)

## 12. Explicitly not in this wave

- Manager → rep tickets and a developer inbox (the model allows adding `toUserId` later).
- Notifications (email/push).
- Pipeline sorting by "naposledy upravené" (§2d note).
- Team sanity warnings (§2c 10).
- Anything about the old-send migration (`db-changes.md` §3.3).
