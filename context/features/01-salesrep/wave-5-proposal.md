# Wave 5 — what the client asked for, what they got, which price they saw

**Status:** **NEXT TO DESIGN AND IMPLEMENT**, after the outstanding wave-3 human click-through is completed and
recorded. Draft v4 (2026-09-20) — v2 answered review R01 (request ledger §6.2, mapping §5, migration §11); v3 answers
review R02: one reconciliation under the lock (§6.7), the whole next step and not only its kind (§6.8), the grouped
projection (§6.9), close / reopen (§6.10), migration identity and provenance (§6.2, §11), complete relations (§6.2)
and the manager's edit rights (§6.4). Draft v4 answers review R03: the projection also takes the manager's prepared results (§6.9), one coverage rule for
the headline and warnings (§6.9a), the pencil's exact contract (§6.4) and two corrected tests. Resolutions: §12 (R01),
§13 (R02) and §14 (R03). Nothing implemented and no schema applied.
When §9 is answered and this file is re-reviewed it becomes `wave-5-proposal-final.md`. Backlog: BL-13.

**Implementation-order decision (Michal, 2026-09-19):** keep the stable identifiers, but implement **wave 5 before
wave 4**. Order: wave-3 closeout → wave 5 → re-review wave 4 against the shipped wave-5 operations → wave 4. Do not
renumber historical decisions, review folders, backlog IDs or code comments. Wave 4 Part A is blocked until this wave
is implemented and documented.

**Read first:** `AGENTS.md`, `context/code-standards.md`, `context/domain/database-map.md` (Lead offer columns,
`OFFER_SENT`), `context/domain/operations.md` (`recordOfferSentAs`, `logCallAs`, `logFollowUpAs`),
`context/app-workflow.md`, wave 3a in `round2-deal-workspace.md` §2c ("Čo sme poslali" / "Klient dostal"), and
`wave-4-proposal.md` only for the downstream integration boundary — wave 5 must work with the current wave-3
single-content tasks and must not depend on unbuilt wave-4 task parts.

---

## 1. Why

- Telesales can record only **one** wish on the first call ("Chcú konkrétnu cenu" / "Chcú návrh" / "Chcú info
  emailom"). Clients often ask for two things, so the rest ends up in a free-text note, and nobody checks the note later.
- The app records **what we sent** (wave 3a) but not **what the client asked for**. Michal: *we must send what they
  literally asked for, and we may send extra.* The app exists so that we don't miss anything.
- For the phone calls that follow, the rep must know **whether the client has seen a price, and which one**, and
  whether they have only seen the cenník. That decides what can still be said: *"I can't say a bigger number now"*,
  and *"if they only saw the cenník, maybe an add-on can be priced differently."*
- One new thing to send: a **website critique** of the client's current site. Clients do not ask for it, but it is
  the only part of the first email that is about *them*.

**Principle (Michal):** a useful tool, not form-filling software. One tick when the client asks, one tick when we send,
and the app compares the two. No statuses to maintain.

## 2. Decided so far

From the discussion (2026-09-19) and Michal's answers to review R01 (2026-09-20):

- Telesales **ticks several things** the client asked for. No combined options such as "cena + návrh".
- **"O nás" is renamed "Info / ukážky"** on screen. "Pošlite niečo o vás" means "are you legitimate, what have you
  built", not "send me your company history". Only the label changes; the stored send content stays `ABOUT_US`.
- **Cenník and price stay separate.** The cenník is general prices; the price is a price for *this* client.
- **A price is always an estimate** at this stage. There is **one** current price with its note, as today. No price
  levels (none / indicative / concrete).
- **Dropped:** "sent proactively" and "held back on purpose" as statuses; the asked ↔ got comparison shows both.
- **Dropped (R01-3/13):** "Nič konkrétne – len email". Two callers cannot tell it apart from "Info / ukážky", and it
  produces the same email. "Pošlite mi niečo" is recorded as **Info / ukážky**; the nuance goes in the call note.
- **A price the client heard on the phone counts as received** (R01-1). Seeing and hearing an exact amount are the
  same fact. If the SR wants to confirm it in writing she keeps "Poslať cenu" herself; the app does not force it.
- **A request is an event, not a permanent label** (R01-2): the client may ask for the same thing again later, and the
  app must show that as new work — see §6.
- **One outcome per call, contents in rows** (§6.5): new `CallOutcome.INTERESTED`; no dominant-value guessing.
- The **visible headline lists everything outstanding** ("Poslať návrh + cenu"); the stored step kind stays one
  internal category for filters and sorting (R01-5).

## 3. What people see

### 3.1 Telesales — first call

Today there are three buttons ("Chcú konkrétnu cenu", "Chcú návrh", "Chcú info emailom"). They become one positive
outcome with ticks:

```
Majú záujem – čo chceli?
  [ ] Info / ukážky
  [ ] Cenník
  [ ] Konkrétna cena
  [ ] Návrh
  [ ] Rozbor webu  (čo je zlé na ich webe – pýtajú sa na to zriedka)
  Poznámka …
```

At least one tick is required. The next step follows from the ticks (§5). "Pošlite mi niečo" → Info / ukážky.

### 3.2 Rep — deal detail, price card

```
Cenová ponuka                              1 400 €
  Web 550 · admin I 249 · jazyk 100 …
  Chceli:        Cenník 19. 9. ✓ · Konkrétna cena 22. 9. – ešte neposlané
  Klient dostal: ✓ Info 19. 9. · ✓ Cenník 19. 9. · ✓ Cena 1 285 € (telefonicky 22. 9.) · ✓ Rozbor webu 19. 9.
  ⚠ Klient videl 1 285 € – aktuálna cena 1 400 € ešte neodišla
```

- **Asked and not yet received** → the row stays open under "Chceli" on the detail. In the **deal list** there is no
  second warning while the step already says it: "Poslať cenu" is shown there with its own urgency ("dnes" amber,
  "2 dni po termíne" red — `lib/overdue.ts`, unchanged). The row warning "⚠ chceli cenu" appears **only when an open
  request is not covered by the current step** — e.g. the step is "Zavolať v pondelok" while a price is still owed
  (active deals only). This is the "we don't miss something" part.
- **Sent without being asked** needs no marker: it appears under "Klient dostal" and not under "Chceli".
- "Chceli" is edited with the pencil (§6.4): an ask can be **added** or **withdrawn** ("už nechcú návrh"), never
  silently rewritten. Withdrawing never cancels an open manager task; the dialog says the task is still open and links
  to the existing "Zrušiť úlohu" path (R01-8).

### 3.3 Price vs. the price the client saw

The current price and the price the client has seen are **two different things** and both already exist (wave 3a):
`Lead.price` is the current amount, and each valid `OFFER_SENT` with `PRICE` carries the **snapshot** of the amount
that actually reached the client, by email or phone.

Wave 5 only makes it visible where it matters:

- on the card as in §3.2, and in the **call sheet header**: "Klient videl 1 285 € (telefonicky 22. 9.) · aktuálna
  1 400 € ešte neodišla";
- "Klient cenu ešte nevidel" when no valid PRICE receipt exists; "Videl len cenník" when only PRICELIST was received.

Recording the same amount again is a normal new receipt: a new dated row, and it completes the current "Poslať cenu".

### 3.4 "Čo sme poslali" (rep)

- **New tick "Rozbor webu"** — what is wrong with their current site, with screenshots. Usually sent without being
  asked, but clients do ask for it ("a čo je na tom zlé?"), so it is a full content: it can be asked for and sent
  (Michal, 2026-09-20).
- Contents **asked for and not yet received are pre-ticked**; the rep can untick them or add extra contents. Unticking
  needs no explanation — the row simply stays outstanding (R01-12).
- A cenník that was asked for is pre-ticked even when the step is "Poslať cenu".

### 3.5 Later calls (rep)

The call sheet gets the same ticks as "Chcú aj …", for the client who asks for more later ("so what would the exact
price be?"). Each tick creates a **new request** (§6), even for a content received months ago; the step follows §5.
Today's follow-up outcomes "Chcú konkrétnu cenu" / "Chcú návrh" become these ticks.

### 3.6 "Požiadať manažéra"

Pre-selects Cena or Návrh from the **open** requests, and never creates a task automatically. In this wave the
existing wave-3 dialog still accepts one manager-work content; after wave 4 it may accept several parts. The
client-request vocabulary stays separate from the task vocabulary in both versions.

### 3.7 The combined step — a checklist, not a longer step

Situation: the client asked for Cena, Cenník, Návrh and Info. The SR asks the manager for the price and the návrh; the
step is locked. The manager delivers the price within an hour. Usually the SR waits and sends everything together.
Sometimes she has agreed with the client to send the price now and the návrh later.

**The step does not store its contents. The checklist is derived; the stored kind is only a category.**

```
Ďalší krok: Poslať návrh + cenník            🔒 čaká na Nikolasa
  ✓ Info            poslané 20. 9.
  ✓ Cena 1 285 €    poslané 20. 9.
  ○ Cenník          treba poslať
  ○ Návrh           robí Nikolas
```

- The **checklist** = open requests (§6) + the current wave-3 open task content and its pending returned result. Each
  row is: ✓ received by the client (date) · *pripravené* by the manager but not sent · *robí sa* · *treba poslať*. The
  UI never uses the same green ✓ for "prepared" and "received".
- The **visible headline** names every outstanding row: "Poslať návrh + cenu + cenník". After a partial send it
  immediately drops what went out. **`Lead.nextActionKind` stays one internal category** (návrh outstanding →
  `SEND_DESIGN`, else price → `SEND_QUOTE`, else `SEND_EMAIL`) for pills, filters, sorting and "Na dnes". There is no
  combinatorial enum value.
- **Sending part now** uses the shipped wave-3 fact-only path while the task is locked; the recorded subset gets ✓ and
  the rest stays outstanding.
- **When nothing is outstanding**, the send completes the step and "Zavolať, či prišlo" is pre-selected (`sendCompletesStep`
  from R03-1, extended from returned items to open requests).
- **Without a manager** (cenník today, price tomorrow): the same checklist without 🔒. After a partial send the step
  stays a send step by default; if the SR plans a call instead, the warning stays visible until the content is sent or
  the request is withdrawn. A warning, not a block.
- **Why not store the contents in the step:** it would duplicate the requests and the receipts, every send would have
  to rewrite it, and it would drift. Derived, it cannot be wrong, and a new content (Rozbor webu)
  appears without touching the step.
- **A manager's own deals never lock** (wave-3 D7): the same checklist, without 🔒.
- **Accepted limitation, not a defect (Michal, 2026-09-19):** while the návrh is still being made the step is locked,
  so the SR cannot schedule a separate call about the price she already sent. Extremely rare; she can still record any
  call. Kept as is — see wave-4 §2.11. Reviews should not report it.

## 4. What goes into the first "Info" email (content, not app logic)

Nobody replies to emails. The email's job is to make the next call feel natural and give the rep something to talk
about. Proposed skeleton:

1. **Who we are:** two sentences.
2. **What we noticed on their site:** 2–3 concrete problems (the rozbor webu) — the only part about them.
3. **Proof:** 2–3 references with links.
4. **Prices:** the cenník, if they asked.
5. **Next step:** "Zavolám vám vo štvrtok."

The app does not generate emails. This is for Michal and the reps to agree on.

## 5. The mapping — asked → received → step (normative, R01-3)

| Ask (`RequestContent`) | Shown as | Satisfied by a valid `OFFER_SENT` with | Channel | Internal step while open |
|---|---|---|---|---|
| `INFO` | Info / ukážky | `ABOUT_US` | EMAIL | `SEND_EMAIL` |
| `PRICELIST` | Cenník | `PRICELIST` | EMAIL | `SEND_EMAIL` |
| `PRICE` | Konkrétna cena | `PRICE` (with its amount snapshot) | EMAIL **or** PHONE (R01-1) | `SEND_QUOTE` |
| `DESIGN` | Návrh | `DESIGN` (any design of the deal) | EMAIL | `SEND_DESIGN` |
| `REVIEW` | Rozbor webu | `REVIEW` | EMAIL | `SEND_EMAIL` |

- **Satisfaction is by time, not by category** (R02-1): a receipt satisfies a request only if the receipt's instant is
  **not earlier** than the request's instant. An old June price does not satisfy a September request, and a send
  entered in October but dated back to July does not satisfy a September request either.
  - *request instant* = the instant of the source activity (the call), not a rounded business day; a migrated row uses
    its linked receipt's instant (§11);
  - *receipt instant* = today's `offerInstant(meta, createdAt)` — the historical business day for a backdated send,
    otherwise the recording time; only **valid** (not crossed-out) receipts count;
  - the phone price told in the same call resolves the requests created by that same call **by link**, never by
    comparing equal timestamps.
- One receipt satisfies **every** eligible open request of its contents (one email can close several rows), and the
  resolver stored on a row is the **earliest** eligible valid receipt.
- **Dominant internal kind** while several are open: `DESIGN` → `SEND_QUOTE` → `SEND_EMAIL`, in that order
  (`INFO`, `PRICELIST` and `REVIEW` all fall under `SEND_EMAIL`).
- `OTHER` (wave-3/4 manager work) never maps to a client request.

## 6. Data — the part that must not be sloppy

### 6.1 What already exists and does not change

| Fact | Where it lives today |
|---|---|
| Current price and breakdown | `Lead.price`, `Lead.priceNote` (editable, not a history) |
| What the client received, with the price **snapshot**, channel and date | `Activity(OFFER_SENT)` + `meta` (wave 3a), corrections via the existing cross-out |
| Fast summaries for lists | `Lead.offerAboutUsAt`, `offerPricelistAt`, `offerPriceAt`, `Design.sentAt` (recomputed from the canonical rows) |
| The next step | `Lead.nextActionKind`, `nextActionAt`, `nextActionNote` |
| Manager work | `DealTask` (wave 3), later `DealTaskPart` (wave 4) |

### 6.2 What is new: one small request ledger

A request is an **event with a time**, so it cannot be one array on the lead (R01-2: "asked again in September" must be
visible even though a price was sent in June).

```prisma
model LeadRequest {
  id            String         @id @default(cuid())
  lead          Lead           @relation(fields: [leadId], references: [id], onDelete: Cascade)
  leadId        String
  content       RequestContent // INFO | PRICELIST | PRICE | DESIGN | REVIEW
  state         RequestState   @default(OPEN) // OPEN | SENT | WITHDRAWN
  origin        RequestOrigin  @default(LIVE) // LIVE | MIGRATED_RECEIPT | MIGRATED_OPEN_STEP

  // kedy a od koho: „instant“ = čas zdrojovej aktivity, nie zaokrúhlený deň (§5)
  requestedAt      DateTime
  requestedBy      User?     @relation("LeadRequestRequestedBy", fields: [requestedById], references: [id])
  requestedById    String?   // NULL pri migrovanom riadku bez známeho aktéra
  source           Activity? @relation("LeadRequestSource", fields: [sourceActivityId], references: [id], onDelete: SetNull)
  sourceActivityId String?   // hovor, z ktorého vznikla; revert prvého hovoru riadky zmaže

  // vyriešenie – prepočítané, nie prepínané (§6.7)
  resolvedAt         DateTime? // instant prijatia / stiahnutia
  resolvedBy         User?     @relation("LeadRequestResolvedBy", fields: [resolvedById], references: [id])
  resolvedById       String?
  resolution         Activity? @relation("LeadRequestResolution", fields: [resolvedActivityId], references: [id], onDelete: SetNull)
  resolvedActivityId String?   // OFFER_SENT, ktoré ju splnilo
  reason             String?   // povinný pri ručnom stiahnutí

  // migrácia (§11)
  migrationKey String? @unique // deterministický kľúč zdroja – opakovaný beh nevytvorí duplikát
  provenance   Json?           // zdrojové stĺpce / aktivity, istota, schválená výnimka

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([leadId, state])
  @@index([leadId, content, state])
}

enum RequestContent { INFO PRICELIST PRICE DESIGN REVIEW }
enum RequestState   { OPEN SENT WITHDRAWN }
enum RequestOrigin  { LIVE MIGRATED_RECEIPT MIGRATED_OPEN_STEP }
```

`Lead`, `User` and `Activity` gain the matching back-relation collections — the model above is only the new side
(R02-7). A foreign key still cannot prove that a linked activity belongs to the **same lead**, so every command
asserts under the Lead lock that the activity's `leadId` matches, that its type is the expected one (`OFFER_SENT` for
a resolution, a call for a source) and that it is not crossed out.

- **"Chceli"** on the card = the rows of the deal, newest first. **Open work** = `state = OPEN`. The list warning is one
  `EXISTS (… state = 'OPEN')`, so no JSON parsing and no duplicated logic in SQL.
- **The state is stored, but it is always the result of one recomputation, never a local toggle** (R02-1): every
  operation that changes requests or receipts ends by running the reconciliation of §6.7 under the Lead lock. It
  replays that lead's requests and all valid receipts in instant order and writes state, resolver and instant. This is
  the pattern wave 3a already uses for the receipt summaries (`recomputeOffers`), so a backdated send, a second send or
  a crossed-out send can never leave a stale row.
- **Crossing out a send** re-runs the same reconciliation: a request reopens only when **no other valid receipt** still
  satisfies it; otherwise the resolution moves to that other receipt (R02-1).
- **Asking again** creates a **new row**; the old `SENT` row stays as history. Nothing is ever edited in place except
  its resolution.
- **No `Lead.askedFor` array.** One place only; a summary column would be a second truth to keep in sync.

### 6.3 Where each new fact is stored

| Fact | Column / field | Note |
|---|---|---|
| The ticks of one call | `Activity.meta.asked` (sorted, canonical) + one `LeadRequest` row each | the activity is the audit; the rows are the work |
| Open / done / withdrawn request | `LeadRequest.state` (+ `resolvedActivityId`) | written under the Lead lock |
| "Rozbor webu" received | `Lead.offerReviewAt` (like `offerAboutUsAt`) | recomputed from canonical rows |
| "Rozbor webu" in a send | `OFFER_SENT.meta.contents += "REVIEW"` | zod list, no DB enum |
| Ask edited by hand | `Activity(CLIENT_ASK_CHANGED)` with `meta.added`, `meta.removed`, `meta.reason`, `meta.fp` | history only; excluded from "Naposledy" |
| Call outcome | unchanged `CallOutcome` | routing only, see §6.5 |

### 6.4 Operations (all: access guard, `withLockTx`, lock order Team → User → Lead, `expectedRevision`, idempotency key with a canonical fingerprint, exactly one revision bump)

| Operation | Change |
|---|---|
| `logCallAs` (first call) | takes `asked: RequestContent[]` (non-empty, unique, server-normalised); writes the activity, the request rows, the handoff and the derived step. **The fingerprint gains the sorted asks** (R01-4), so a retry with a different selection conflicts instead of replaying. |
| `logFollowUpAs` | takes `asked` as "Chcú aj …"; adds rows; the phone price closes open PRICE rows. The existing `fp` gains the sorted asks. |
| `recordOfferSentAs` | writes the receipt, then reconciles; `sendCompletesStep` counts outstanding **contents** (grouped, §6.9), not only returned task items. |
| `setClientAsksAs` (new) | the pencil: `add: RequestContent[]`, `withdraw: string[]` (**request row ids**). Only `OPEN` rows of the same lead may be withdrawn — a `SENT` or already `WITHDRAWN` row returns `STALE`, so a resolved row never loses its receipt link (R03-5). "Už to nechcú" withdraws **every** open row of that content, by id. The **reason is required when `withdraw` is non-empty**, optional for an add-only correction. **The current owner may edit; a manager with `deals.manage` may edit any deal in scope, including another rep's; an ownerless deal is manager-only; out of scope → `NOT_FOUND`** (R02-8). It never touches an open task — the dialog says the task is still open and links to "Zrušiť úlohu". Primary row `CLIENT_ASK_CHANGED` with `meta.added` (contents), `meta.withdrawn` (row ids **and** their contents), `meta.reason`, and an `fp` over the sorted row ids, sorted added contents and the reason. |
| offer correction (existing) | re-runs the reconciliation (§6.7); a row reopens only if nothing else satisfies it. |
| first-call revert (existing) | deletes the rows whose `sourceActivityId` is that call; refuses (STALE) if one of them is already `SENT` (R01-9). |
| task create / finish / decline / cancel | the stored step is derived from **outstanding contents + task state**, never from the task content alone (R01-5). |
| close / reopen | §6.10. |

**Who owns the stored next step** (R02-2). There is **no background recomputation** of the `Lead.next*` fields, and
therefore no "was this step automatic or manual?" flag to store:

1. The step changes **only inside a user command** (call, send, task operation, replan, close, reopen) — as today.
2. Inside that command the projection supplies the **default** step (§6.8) and an **explicitly submitted step always
   wins**. In a contact transaction the asks and receipts are reconciled first and the submitted step is applied last.
3. Nothing else ever rewrites the step. A "Poslať cenu" deliberately kept after a phone price therefore survives every
   later reconciliation, and recording that email later completes it normally.
4. When nothing is outstanding, the headline is the stored step's own label — a planned extra or a resend, not a false
   "client never received it" warning.

### 6.5 One outcome per call, several requests — new value `INTERESTED` (decided 2026-09-20)

One call has **one** outcome, because the outcomes are mutually exclusive states of that call (nezdvihli · zlé číslo ·
nemajú záujem · majú záujem). What is multi-valued is *what the client asked for*, and that now has its own rows
(§6.2). So `Activity.outcome` is **not** turned into an array — an array would allow `NO_ANSWER` together with
`WANTS_DESIGN` and would force every existing query to handle lists.

The dominant-value mapping first proposed here (`WANTS_DESIGN` → `WANTS_QUOTE` → `WANTS_EMAIL`) is **rejected**:
it lies. A client who asks only for a cenník would be stored as "Chcú info emailom", and a client who asks for a price
and a návrh would be counted only once, under the návrh (Michal, 2026-09-20; R01-11).

**Decision:** add one additive value `CallOutcome.INTERESTED` = "dovolali sme sa, majú záujem"; the contents are the
request rows.

| | Today | Wave 5 |
|---|---|---|
| Call outcome | `WANTS_QUOTE` / `WANTS_DESIGN` / `WANTS_EMAIL` | `INTERESTED` |
| What they asked for | implied by the outcome (only one thing possible) | `LeadRequest` rows, any combination |
| Next step | `leadStateForOutcome` per `WANTS_*` value | derived from the open requests (§5) |
| "Koľko malo záujem" | sum of the three `WANTS_*` (+ `POSITIVE`) | `INTERESTED` + the old `WANTS_*` + `POSITIVE` |
| "Čo chceli" | not answerable | count of request rows — cenník alone is finally countable, and one call can count in two contents |
| A new content later | would need a new `WANTS_*` value | nothing — one more `RequestContent` |

- Old `WANTS_*` rows stay valid and keep rendering in História; new calls stop writing them. The values are **not**
  removed (that would be destructive and pointless).
- Code that must change with this (small, ~2–4 h): `isHandoffOutcome` and `leadStateForOutcome`
  (`lib/domain/leadFlow.ts`), the replay answer in `lib/domain/idempotency.ts`, the "záujem" bucket in
  `lib/queries/stats/index.ts`, the label in `lib/dictionaries.ts`, plus the deal-stage reply list
  (`lib/domain/clientReplies.ts`, which maps "Chcú konkrétnu cenu" / "Chcú návrh" to `WANTS_*` today), the seeds and
  the tests.
- **Demand statistics read the request rows only**, never the outcome (R01-11). Migrated old deals get request rows
  from their receipts (§11), so old demand is countable too, marked as migrated.

### 6.6 Schema ledger entries

| id | Change | Toward production |
|---|---|---|
| S-16 | table `LeadRequest` (incl. `origin`, `migrationKey`, `provenance`) + enums `RequestContent`, `RequestState`, `RequestOrigin` | additive |
| S-17 | `Lead.offerReviewAt DateTime?` | additive |
| S-18 | `ActivityType += CLIENT_ASK_CHANGED` | additive (enum value) |
| S-19 | `CallOutcome += INTERESTED` (§6.5) | additive (enum value) |
| — | `OFFER_CONTENTS += "REVIEW"` (zod list in `meta`) | no schema change |

Nothing is renamed or dropped by wave 5. Test branch only, reviewed SQL, schema before code, ledger entry in
`context/domain/db-changes.md`.

### 6.7 One reconciliation, run under the lock (R02-1)

```
reconcileRequests(tx, leadId)      // pure rule + one write, no local toggles
```

1. Load that lead's `LeadRequest` rows and its **valid** `OFFER_SENT` activities (crossed-out ones are ignored, exactly
   as the receipt summaries already ignore them).
2. Sort both by instant: requests by `requestedAt`, receipts by `offerInstant(meta, createdAt)`.
3. Per content, walk the receipts in order. A receipt resolves every still-open request of that content whose instant
   is **not later** than the receipt's instant, and only those. The first eligible receipt wins, so re-running the
   function always produces the same answer.
4. Rows the caller withdrew by hand keep `WITHDRAWN` and are never revived by a receipt.
5. Write the result (`state`, `resolvedAt`, `resolvedById`, `resolvedActivityId`) for the rows that changed. The call
   is part of the caller's transaction, under the same Lead lock, inside the caller's single revision bump.

Run it at the end of: the first call, a follow-up call (including the phone price), a send, a send correction, the
pencil edit, the first-call revert, a task operation that changes the step, and the migration backfill. Requests that a
**same-transaction** phone price must satisfy are passed by id, so nothing depends on two timestamps being equal.

### 6.8 The whole next step, not only its kind (R02-4)

A step is five fields (`nextActionKind`, `nextActionAt`, `nextActionHasTime`, `nextActionMode`, `nextActionNote`), and
the mode and date decide whether the deal shows up in **Na dnes**, **Rozpracované** or **Plánované**. The default the
projection hands a command is therefore the whole step:

| Situation | kind | mode | at | note |
|---|---|---|---|---|
| Outstanding contains Návrh | `SEND_DESIGN` | `IN_PROGRESS` | today | default of the kind |
| Outstanding contains Cena (no Návrh) | `SEND_QUOTE` | `SCHEDULED` | today | default of the kind |
| Outstanding only Info / Cenník / Rozbor | `SEND_EMAIL` | `SCHEDULED` | today | default of the kind |
| The dominant kind does **not** change (e.g. a second ask of the same content) | unchanged | unchanged | **unchanged** | unchanged |
| A manager task is open (step locked) | as above | as above | **null** (wave-3 rule) | kept, else default |
| The task closes | as above | as above | today | kept |
| Nothing outstanding | the command's own rule as today (send dialog: follow-up call or keep the step; call sheet: the user picks) |
| The user submitted a step | exactly what was submitted (§6.4) |

"Today" means the business day start (`businessTodayStart`), `hasTime` stays false. Because the fields only change when
the **kind** changes, a deal already in progress on a návrh does not restart its age when a cenník is added, and a
price that becomes dominant after the návrh was sent becomes due today instead of inheriting the old in-progress mode.
The existing `clientSections` / `TODAY_SQL` parity tests are extended to every row of this table.

### 6.9 One projection, two cardinalities (R02-6), three sources (R03-1)

```
clientRequestState(requests, receipts, managerWork)   // pure, lib/domain/clientRequests.ts
//   managerWork = { making: TaskContent[], prepared: PendingItem[] }
//   wave 3: making  = the OPEN task's PRICE / DESIGN contents
//           prepared = pendingItems() — results of DONE / DECLINED tasks not yet sent or dismissed
//   wave 4: the same two lists come from taskPartState; this signature does not change
```

**Outstanding work has three sources, not one** (R03-1). A manager result stays actionable **after its task is
closed**: in wave 3 a finished task is `DONE` and its result is carried by `pendingItems()` until an `OFFER_SENT`
fulfils it or it is dismissed. A rep may also ask the manager without the client ever asking, so there can be a price
waiting with no `LeadRequest` at all. The projection therefore takes the manager work as an input of its own:

| Source | Row state | Example |
|---|---|---|
| open client request (§6.2) | *treba poslať* | "Chceli cenu" |
| `making` — the open task's PRICE / DESIGN | *robí sa* | "Návrh robí Nikolas" |
| `prepared` — a returned PRICE / DESIGN not yet sent or dismissed | *pripravené* | "Cena 1 285 € od Nikolasa" |

- **Outstanding = the union of the three, grouped by content.** One "Cena" row even when the client asked twice and the
  manager has already prepared it. The checklist, the headline, the list warning, the send-dialog pre-ticks,
  "Požiadať manažéra", the step default (§6.8) and `sendCompletesStep` all consume that grouped union — which keeps the
  shipped wave-3 I10 rule ("a returned price / návrh holds the step until it is sent or explicitly dismissed") intact
  instead of regressing it.
- `OTHER` answers and `DECLINED` reasons are **acknowledgement items only**: they never become outstanding send
  contents, exactly as today.
- **History ("Chceli")** — every request event with its date, who recorded it and how it ended. Two price requests show
  as two lines.
- **Statistics** read the raw request events with `origin = LIVE` (migrated rows excluded), so two asks count twice
  while the work stays one.

### 6.9a What the current step covers (R03-2)

```
coveredContents(stepKind, outstanding)   // pure, same module
```

The step the user deliberately chose may be narrower than everything outstanding, so one rule decides what the
headline says and what still warns:

| Stored step | Covers |
|---|---|
| `SEND_EMAIL` | INFO, PRICELIST, REVIEW |
| `SEND_QUOTE` | PRICE |
| `SEND_DESIGN` | DESIGN **and** PRICE (a návrh email carries the price — the shipped I10 rule) |
| `CALL`, `WAITING_FOR_CLIENT`, `CUSTOM` | nothing |

- **The step covers the dominant outstanding content** (i.e. it is the default of §6.8) → the headline is the combined
  list of everything outstanding: "Poslať návrh + cenu + cenník".
- **The step is narrower than the dominant content** (the rep chose "Poslať cenu" although a návrh is also outstanding)
  → the headline is that step's own label, and everything it does not cover shows as a warning: "Poslať cenu" +
  "⚠ Chceli návrh – ešte nedostali". The deliberate plan stays visible and the unsent work is not hidden.
- **The step covers nothing** (a call, waiting) → every outstanding content warns.
- **Nothing outstanding** → the headline is the stored step's own label (§6.4).

The same function is what the deal list uses, so the row, the detail, the pills and the counts cannot describe
different work; the SQL twin is covered by the parity test (§10.10).

### 6.10 Closing and reopening a deal (R02-5)

- **Closing** (WON / LOST / UNREACHABLE) does not rewrite the history: open rows stay `OPEN` but dormant, because the
  checklist, warnings and counts only apply to active deals. The step is cleared as today.
- **Reopening** uses the same default as every other command (§6.8): if something is still outstanding, the step is
  that send step, due today — "Poslať návrh", not "Zavolať". Only when nothing is outstanding does it fall back to
  today's fixed "Zavolať" (wave-3 `REOPEN_STEP_NOTE`). This replaces the hard-coded reopen step, which always said
  "Zavolať" even when the obvious next move was to send the thing that was never sent (Michal, 2026-09-20; it also
  settles the wave-4 leftover D2 "reopen has no step choice" for the request case).
- No request is ever withdrawn automatically by a status change; the manager sends it or withdraws it with a reason.

## 7. Relation to wave 4

**Wave 5 is a prerequisite for wave 4 Part A.** They stay separate concepts but not independent in order:

- wave 5 owns what the client asked for, what the client received, the derived checklist and headline, partial sending
  and correction;
- the existing wave-3 task contributes at most one manager-work content and its returned item to that projection;
- wave 4 replaces that contribution with `DealTaskPart[]`; it must consume the shipped wave-5 projection and must not
  invent a second definition of what remains to be sent;
- a manager delivering PRICE or DESIGN means **prepared**, not received. Only a valid `OFFER_SENT` means received;
- `OTHER` stays internal manager work with no client request.

## 8. Rough plan (≈ 30–36 h, without the production migration)

| Step | Hours |
|---|---|
| Wave-3 human click-through closed and recorded | human gate |
| §9 answered, this file reviewed and frozen as `wave-5-proposal-final.md` | planning gate |
| Schema S-16 – S-19 on test, Prisma regenerated, ledger | ~1 |
| `INTERESTED` outcome: hand-off, replay, step derivation, stats bucket, labels, reply list, seeds (§6.5) | ~3 |
| `lib/domain/clientRequests.ts`: pure rules (mapping, satisfaction order, grouped projection over all three sources, coverage, whole-step defaults, headline) + pure tests | ~6 |
| `reconcileRequests` (§6.7) and its use in every touching command; reopen uses the normal step default (§6.10) | ~3 |
| `logCallAs` ticks, fingerprint, handoff, derived step | ~4 |
| `logFollowUpAs` "Chcú aj …", phone price closing PRICE rows | ~2 |
| `recordOfferSentAs` + correction: closing / reopening rows, `sendCompletesStep` | ~3 |
| `setClientAsksAs` (pencil) + revert integration | ~2 |
| UI: telesales ticks, card "Chceli", list warning, checklist + headline, call-sheet price line, "Rozbor webu" | ~6 |
| Concurrency + parity tests (the matrix in §10), docs, full check pass | ~7 |

## 9. Questions for Michal

| # | Question | Proposed |
|---|---|---|
| Q1 | Name of the new sendable item | **decided 2026-09-20:** "Rozbor webu" (can still be renamed before it ships — it is only a label) |
| Q2 | ~~Telesales view~~ | **decided 2026-09-20:** the call history line shows the selected contents ("Majú záujem: cenník + cena"); no extra column in the call lists |
| Q3 | ~~First-call outcome~~ | **decided 2026-09-20:** new `INTERESTED` value, contents in the request rows (§6.5) |
| Q4 | Withdrawing an ask: reason required? | **decided 2026-09-20:** required, one short line, shown in História |
| Q5 | May a manager edit "Chceli" on a rep's deal? | **decided 2026-09-20:** yes, same rule as other deal work (owner or manager; an ownerless deal = manager) |
| Q6 | ~~Rozbor webu~~ | **decided 2026-09-20:** it is a full content — telesales and reps can record it as an ask, and it can be sent unasked. Whether it belongs in every first email stays a content decision, not app logic |
| Q7 | ~~List warning timing~~ | **decided 2026-09-20 (Michal):** no timing rule and no second warning where the step already says it. The list already shows the step with its urgency ("dnes" amber, "2 dni po termíne" red). The row warning appears **only when an open request is not covered by the current step** (e.g. the step is "Zavolať" while a price is still owed). See §3.2. |

## 10. Tests before this ships

1. First call with each single ask and with combinations; reordered arrays = same payload; changed arrays under the
   same key = conflict; parallel double submit.
2. PRICE by phone closes a PRICE request; the SR may still keep "Poslať cenu" by hand.
3. Old PRICE received in June, new PRICE request in September → open work, warning, "Požiadať manažéra" pre-selects
   price. Same for a second návrh.
4. Partial sends in both orders; extra unasked contents; a send that closes several rows; two tabs sending overlapping
   subsets.
5. Crossing out a send re-runs the reconciliation: a row reopens only when no other valid receipt satisfies it.
   (There is no generic call cross-out in the app — the only call reversal is the first-call revert in test 6, and
   wave 5 does not add one; R03-4.)
6. First-call revert removes that call's rows; refused when one is already satisfied.
7. Wave-3 task: PRICE task while DESIGN is also open → the stored kind stays `SEND_DESIGN`; finish, decline, cancel,
   overlap, send while locked.
8. Pencil add / withdraw, withdraw with an open task (no silent cancellation), two-tab race.
9. Scope: another rep → NOT_FOUND, closed / reopened deal, deactivated owner, exactly one revision bump per operation.
10. Checklist, list warning, headline and counts agree with the SQL used by the lists (parity test).
11. **R02-1 ordering:** a backdated send between two requests; two sends then a correction of the first / of the
    second; same-call ask + phone price; a migrated request linked to its receipt.
12. **R02-2 step precedence:** phone price with "Poslať cenu" deliberately kept; an extra unasked "Poslať email";
    a later ask and a correction while each manual step is present.
13. **R02-4 step fields:** every row of the §6.8 table, checked against `clientSections` and the list SQL (Na dnes /
    Rozpracované / Plánované), not only the enum kind.
14. **R02-6 grouping:** two open requests of the same content and one send — one checklist row, one label, both rows
    closed, two events in the statistics.
15. **R02-3 migration identity:** a rerun and an interrupted rerun of the backfill create no duplicates; migrated rows
    are excluded from demand statistics; an inferred row with no actor is labelled, not attributed to the owner.
16. **R02-7 links:** an activity from another lead, a crossed-out receipt and a deactivated user are refused.
17. **R02-5 close / reopen:** closing leaves the rows untouched and withdraws nothing. Reopening with an outstanding
    DESIGN / PRICE gives the §6.8 dominant send step due today; reopening with nothing outstanding gives the fixed
    "Zavolať" today with `REOPEN_STEP_NOTE` (R03-3).
18. **R03-1 manager work without a client request:** no `LeadRequest` at all — finish a PRICE task → the task is
    `DONE`, the price is *pripravené* and still outstanding, the step stays "Poslať cenu", the send consumes it and
    only then offers the follow-up call; crossing out that send brings it back. The same for DESIGN, and for a
    withdrawn request while the manager result is still waiting.
19. **R03-2 coverage:** PRICE and DESIGN outstanding, the rep deliberately keeps "Poslať cenu" → the headline is
    "Poslať cenu", the návrh shows as a warning, and the list row, the detail and the pills agree.
20. Production-clone rehearsal (§11).

## 11. Production migration — what is true today and what is needed

**Everything applied to the test branch so far is additive** (`db-changes.md` §1: 0 drops). The only non-additive step
ever decided is the removal of the old send columns `Lead.quoteSentAt`, `Lead.aboutUsSentAt`, `Lead.priceDisclosed`
after their meaning is converted into canonical `OFFER_SENT` rows (`db-changes.md` §3.3). `Lead.price` and
`Lead.priceNote` are **not** touched by that. Wave 5 itself adds only new objects (§6.6).

**What the repository already knows about the old database:** the production baseline schema is the Prisma schema at
commit `7beb689`, and `db-changes.md` §1 is the verified net delta from it. §3.3 already holds the agreed meaning of
every old column. What nobody has measured is the **actual data**: which combinations really occur, undone sends,
missing amounts, designs without rows.

**Michal's migration rule (accepted as the business truth, to be verified):** for old records, everything the client
**received** is also treated as something they **asked for**. With the ledger this needs no special legacy mode
(it replaces R01-6):

| Old, after the §3.3 conversion | Wave-5 backfill |
|---|---|
| canonical `ABOUT_US` receipt | `LeadRequest(INFO, SENT)` dated with the send |
| canonical `PRICELIST` receipt | **There is no cenník in the live database** (Michal, 2026-09-20): the old system had no such content and no flag. Rows exist only for recipients Michal identifies by hand, if any. |
| canonical `PRICE` receipt with a verified amount | `LeadRequest(PRICE, SENT)` |

**Michal's rule for the old price (2026-09-20, to be verified on the clone):** in live production, a lead with a price
and the "client knows the price" flag means **the exact calculated price, sent by email**. So the conversion is
`priceDisclosed = true` + a price present → one `OFFER_SENT(EMAIL, [PRICE])` with that amount, dated from the old CP
date. The clone inventory must still count the exceptions — a flag with no price, a price with no flag, undone sends,
several CPs — and each exception gets an explicit decision, not a guess.

| canonical `DESIGN` receipt | `LeadRequest(DESIGN, SENT)` |
| `REVIEW` | nothing — the old system had no such content; rows only if Michal names recipients |
| **open** deal with `SEND_QUOTE` / `SEND_DESIGN` / `SEND_EMAIL` and no matching receipt | one `LeadRequest(PRICE / DESIGN / INFO, OPEN)` so the pending work survives |
| anything else | no rows, no warnings |

Every backfilled row carries its identity and provenance in the columns of §6.2 (R02-3): `origin`
(`MIGRATED_RECEIPT` for a converted receipt, `MIGRATED_OPEN_STEP` for an inferred obligation), a deterministic unique
`migrationKey` built from the approved source identity (so a rerun or an interrupted run cannot duplicate rows),
`provenance` with the source column / activity ids, the confidence and the approved exception decision, and
`requestedById = NULL` where the original actor is unknown — never the current owner. A migrated `SENT` row is linked
to the receipt that satisfies it and is valid even when both fall on the same historical day. Migrated rows are
excluded from demand statistics. The backfill is dry-run by default, repeatable and verified row by row, and it runs
**after** the canonical receipt conversion (`db-changes.md` §3.3), never before.

**What I need from Michal to do this safely:**

1. A **fresh duplicate of production** (a Neon branch of the live database, or a dump restored into a new branch) —
   never live production. Its connection string goes into `.env` under its **own name** (e.g. `CLONE_DATABASE_URL`),
   never as `DATABASE_URL`, and no script may take an endpoint from an argument alone.
2. The **exact commit currently deployed** to production (so the old writing code is known, not only the schema).
3. Permission for a **read-only inventory** on that duplicate: counts of every combination of `quoteSentAt`,
   `priceDisclosed`, price present / missing, about-us evidence, old `QUOTE_SENT` / `EMAIL_SENT` / `DESIGN_SENT` rows
   and undo patterns, designs with and without `sentAt`, leads still in the call stage with send evidence, deleted and
   closed leads. Output: a report plus an exception list, both committed under `context/domain/` or `prisma/backfill/`.
4. Michal's list of the **cenník recipients** (§3.3 says there is no old flag for it).
5. Then, and only then: the reviewed conversion script, a full rehearsal on the duplicate, reconciliation counts, and
   the contraction SQL — in a separate, explicitly authorised session, with every step written into `db-changes.md`.

## 12. Review R01 — how each finding is resolved

Review: `.ai/reviews/01-sales-rep/W5/R01.md` (2026-09-20).

| # | Finding | Resolution in this draft |
|---|---|---|
| 1 | Phone price vs. the written price obligation | **Product rule (Michal):** a price heard on the phone is received. §2, §5. One projection, no channel obligation; the SR may keep "Poslať cenu" by hand. |
| 2 | A lifetime array cannot express "asked again" | **Accepted, and solved with the ledger** (§6.2): each request is a row with `requestedAt`; a receipt satisfies only later. `Lead.askedFor` is dropped so there is one truth. |
| 3 | Mapping incomplete, `NOTHING_SPECIFIC` unfinishable | Normative matrix in §5; `NOTHING_SPECIFIC` removed entirely (R01-13). |
| 4 | First-call replay can lose a wish | The first call gets a canonical `fp` including the sorted asks (§6.4); tests in §10.1. |
| 5 | A wave-3 task can overwrite the headline | The stored kind is recomputed from **open requests + task state**, never from the task content alone (§6.4); test §10.7. |
| 6 | Old open deals need a compatibility mode | Not needed: the backfill writes explicit rows — `SENT` for converted receipts, `OPEN` for an open deal whose send step has no receipt (§11). |
| 7 | "No conversion" could cancel the old-send conversion | §11 says it plainly: **asks** are not inferred for history beyond the accepted rule; **receipts** still require the `db-changes.md` §3.3 conversion before any column is removed. |
| 8 | Stored headline vs. a deliberate CALL | Transition policy in §6.4: automatic recomputation only while the step is a system send step or a task lock; a manual plan is preserved and warnings remain; corrections reopen rows. |
| 9 | Revert and corrections must include the asks | §6.4: a first-call revert deletes that call's rows (refused if one is already satisfied); crossing out a send reopens its rows; crossing out a call does not silently remove asks. |
| 10 | `ASKED_CHANGED` had no contract | S-18 `CLIENT_ASK_CHANGED` with `added` / `removed` / `reason` / `fp`, keyed, one bump, excluded from "Naposledy" (§6.3, §6.4). |
| 11 | Statistics must not read `CallOutcome` | §6.5: new `INTERESTED` outcome (one per call) + request rows; the dominant-value mapping is rejected because cenník-only and price+návrh would be counted wrongly. Demand statistics read the rows. |
| 12 | No general note for an unticked item | "explain in the note" removed (§3.4). |
| 13 | `NOTHING_SPECIFIC` design choice | Removed. |

## 13. Review R02 — how each finding is resolved

Review: `.ai/reviews/01-sales-rep/W5/spec/R02.md` (2026-09-20). Response page: `R02-response.md` beside it.

| # | Finding | Resolution in this draft |
|---|---|---|
| 1 | Close / reopen of matching rows cannot express chronology | **Accepted.** One `reconcileRequests` under the Lead lock replays requests and valid receipts by instant and rewrites the result (§6.7); the instants are defined in §5 (source-activity instant vs. `offerInstant`), and a same-call phone price resolves by link, not by equal timestamps. |
| 2 | An automatic step could erase a deliberately chosen send step | **Accepted, solved without a new column.** The step changes only inside a user command; the projection gives the default and an explicitly submitted step wins; nothing recomputes it in the background (§6.4). A "Poslať cenu" kept after a phone price therefore survives, and the headline falls back to the stored step when nothing is outstanding. |
| 3 | Migrated rows need identity and provenance | **Accepted.** `origin`, unique `migrationKey`, `provenance`, nullable `requestedById` (§6.2); dry-run, repeatable backfill run after the receipt conversion; migrated rows excluded from demand statistics (§11). |
| 4 | Only the kind was derived, not the whole step | **Accepted.** §6.8 gives the full transition table (kind, mode, date, note), including "the kind did not change → nothing moves", the task lock and the manual step; the `clientSections` / list-SQL parity tests cover every row. |
| 5 | Close / reopen lifecycle undefined | **Accepted, with one correction to the reviewer's policy:** closing leaves the rows dormant and withdraws nothing, but reopening does **not** keep the hard-coded "Zavolať" — it uses the normal default (§6.8), so a deal with an unsent návrh reopens on "Poslať návrh" today and only falls back to "Zavolať" when nothing is outstanding (§6.10). |
| 6 | Events vs. actionable contents need different cardinality | **Accepted.** `clientRequestState` returns the history as events and the outstanding work grouped by content; every screen and `sendCompletesStep` consume the grouped set, statistics the raw LIVE events (§6.9). |
| 7 | The Prisma sketch lacked relations | **Accepted.** Real relations for source, resolution and both users, back-relations on `Lead` / `User` / `Activity`, plus a same-lead / expected-type / not-crossed-out assertion under the lock (§6.2). |
| 8 | Manager's edit rights were ambiguous | **Accepted.** Written out in §6.4: owner may edit; a manager with `deals.manage` may edit any deal in scope, including another rep's; an ownerless deal is manager-only; out of scope → `NOT_FOUND`. |

## 14. Review R03 — how each finding is resolved

Review: `.ai/reviews/01-sales-rep/W5/spec/R03.md` (2026-09-20). Response page: `R03-response.md` beside it.

| # | Finding | Resolution in this draft |
|---|---|---|
| 1 | The projection omitted a returned task result after the task closes | **Accepted — it was a real regression of a shipped wave-3 invariant.** The projection now takes the manager work as its own input (`making` + `prepared`) and the outstanding set is the union of open requests, work being made and prepared-but-unsent results, grouped by content (§6.9). A price returned for a task the rep asked for without any client request stays outstanding, holds the step and is consumed by the send — exactly as wave 3 does today. Wave 4 later fills the same two lists from `taskPartState` without changing the signature. |
| 2 | "Covered by the current step" and the headline were undefined | **Accepted.** One pure `coveredContents(stepKind, outstanding)` with an explicit table (§6.9a), used by the detail, the list, the pills and the warning. A deliberately narrower step shows its own label and everything it does not cover warns — so "Poslať cenu" + "⚠ Chceli návrh" is the specified answer, not one of three possible readings. |
| 3 | Test 17 contradicted the reopen rule | **Accepted.** Split into the two cases of §6.10. |
| 4 | "Crossing out a call" is not an operation | **Accepted.** Removed from test 5, with a note that wave 5 adds no generic call correction; the only call reversal stays the first-call revert (test 6). |
| 5 | The pencil did not say which rows may be withdrawn | **Accepted.** Only `OPEN` rows of the same lead, by id (`SENT` / `WITHDRAWN` → `STALE`); "už to nechcú" withdraws every open row of that content; the reason is required only when something is withdrawn; the audit row and its fingerprint carry the exact row ids (§6.4). |
