# Wave 4 (v1, 2026-09-19) — SUPERSEDED, kept as history

> **This file is a backup, not a plan.** It is the wave-4 draft as it stood **before** wave 5 was built, superseded on
> 2026-09-20 by the rewritten `wave-4-proposal.md`. Several of its rules contradict the shipped wave-5 contract (the
> step derived from task contents rather than from the outstanding set, "the step is recomputed only when a part
> leaves the play — never when a part is delivered", the `CANCEL_TASK` overlap choice, "returned items" as a concept
> separate from `prepared`). **Do not implement anything from this file.** It is kept so the decisions of
> 2026-09-19 (Q1, Q3, Q4, §2.1) and the review R03 answers stay traceable. Parts B, C and D were carried over to the
> new proposal essentially unchanged.

**Status:** **BLOCKED until this proposal is re-reviewed against the shipped wave 5** (implementation-order decision,
2026-09-19). Wave 5 is **built on the test branch** (2026-09-20), so the blocking condition is now the re-review, not
the build: Part A must consume the shipped projection — `clientRequestState(requests, managerWork)` in
`lib/domain/clientRequests.ts`, whose `making` / `prepared` lists wave 4 fills from `taskPartState` — and must not
invent a second definition of what is left to send. §§2.2–2.10 are not an implementation-ready contract until that
re-review is done. Parts B–D still wait for
answers (§7). Nothing implemented and no schema applied. The stable name/number is intentionally retained so historical
decisions, reviews and code comments remain traceable.

**Read first:** `AGENTS.md`, `context/code-standards.md`, `context/domain/database-map.md`,
`context/domain/operations.md`, `context/app-workflow.md` §5–§7, `wave-3-task-proposal-final.md` (D3, D4, D5, §5.1,
§6.1–§6.4, §6.13), and the shipped wave-5 operations (`context/domain/operations.md` — `clientRequests.ts`,
`requestMutations.ts`, `setClientAsksAs` — plus `context/app-workflow.md` §5b). Wave 3 is built on the test
branch; its open items are in `context/progress-tracker.md`. Do not begin wave-4 implementation from this draft.

**Sources**

- Round 2 plan (`round2-deal-workspace.md` §5): wave 4 = D-07 notes (S-02) + the order note (D-08 step 3) + B-09.
- Michal, 2026-09-19 (wave-3 click-through): price **and** návrh in one request → backlog BL-12, wave-3 D4 update.
- Michal, 2026-09-19 (after R03): changing / cancelling a combined task, a client with more wishes while a task is
  open, other services (SEO, marketing …) in the far future; then the decisions Q1, Q3, Q4 (§2.1).
- Implementation review R03 (`.ai/reviews/01-sales-rep/W3/implementations/R03.md`) findings 2–6 — design gaps for
  this wave, answered in §2.3–§2.9 and §8 (finding 1 was a wave-3 bug, fixed on test).
- Wave-3 leftovers (`progress-tracker.md`, "Wave 3 — not resolved").

---

## 1. Scope

| Part | What | Size |
|---|---|---|
| **A** | One task with several **parts** (Cena, Návrh, Iné — any combination, any order): partial delivery, the manager declines one part, the SR withdraws or adds a part | 3–4 days |
| **B** | **Notes** (`LeadNote`): who wrote it, for whom, pinned in front of whoever calls; the scout's note is no longer overwritten | ~2 days |
| **C** | **Order note for the build** (`FOR_BUILD`) kept on the deal after a handover | 0.5 day |
| **D** | Wave-3 leftovers (pick) | 0.5 day each |

**Wave 5 is implemented first.** It owns the selection of what the client asked for, what was actually sent, the
derived remaining-to-send checklist, its combined display label, partial sending and correction/revival. Wave 4 Part A
then adds multipart manager work on top of those shipped rules. A task remains an internal work order; it never becomes
the source of truth for client intent or client receipt. The wave numbers are stable identifiers, not chronological
renames.

Also not wave 4: order / WON process (BL-09), statistics (BL-10), requests on any lead (BL-01), "transferred" marker
(BL-11), developer projects (BL-04). Production rollout is separate as always.

---

## 2. Part A — one task, several parts

### 2.1 Michal's decisions (2026-09-19)

- **Cena, Návrh and Iné are combinable** in "Požiadať manažéra", in **no fixed order** — *"I will probably calculate
  the price immediately as I see the request for price, and make návrh eventually."* Iné too (Q1 = yes): e.g. "is this
  a good client?" + price + návrh — the manager answers Iné now, the rest later.
- **Partial delivery:** the task keeps its name ("Cena + Návrh"); what is done gets a **green check**.
- **The SR can withdraw one part or add one** while the task is open (Q3 = yes) — not "edit the task", and not only
  "cancel and ask again". A part that is already done cannot be withdrawn.
- **The manager can decline one part and keep making the other** (Q4 = yes). Michal's two real cases:
  - *"This is a difficult website — send them the price first, come back if they still want a návrh"* → the manager
    declines Návrh with that reason, delivers Cena.
  - *"The price is too difficult to calculate now, I will just make the návrh"* → the manager delivers Návrh, declines
    Cena ("zavolaj im – prepoj ich na mňa kvôli cene"); in the next contact the SR says the manager will call about the
    price, and either hands the client over or not.
- **Telesales choosing several things on the first call** (cena + návrh, cenník …) is **wave 5** (2026-09-19), not wave 4
  — see §2.8.
- **Must not over-complicate** the UI: everything happens in the task card and the dialogs that exist today.

### 2.2 How it works — the short version

1. The SR asks for any combination of **Cena / Návrh / Iné** in one task, for one manager.
2. Each of them is a **part** with its own state: *being made* → **✓ done** · **✗ declined** (manager) ·
   **– withdrawn** (SR).
3. The task stays **open while at least one part is being made**. While it is open the SR's step is **locked**
   (wave-3 rule, unchanged).
4. The step is always "what will have to be sent": a návrh in play → "Poslať návrh", only a price → "Poslať cenu", only
   Iné → the step the SR chose. It is recomputed only when a part **leaves the play** (declined, withdrawn) or **joins**
   (added) — never when a part is delivered.
5. A **delivered** part is immediately a returned item the SR can send, even while the task is still open. It stays
   waiting until it is sent or "Neposielam" — whatever happens to the task afterwards.
6. When the last part is resolved, the task closes and the step unlocks for today — as today.

### 2.3 What the users see

**Task card on the deal** (SR and manager — the same card as today, parts listed under the request):

```
Úloha pre manažéra                        ⏳ čaká na manažéra · Nikolas
  „e-shop, 200 produktov, chcú aj logo"   Jana → Nikolas · 19. 9.

  ✓ Cena 1 285 €     Nikolas · 19. 9. · poslané klientovi 20. 9.
  ○ Návrh            robí sa                               ⋯
  ✓ Iné              Nikolas: „dobrý klient, len pomaly platí"   (answer shown in full)

  Po vybavení: Poslať návrh
  [Hotovo…]  [Presunúť…]  [Zamietnuť…]            ← manager
  [+ Pridať]  [Zrušiť úlohu…]                     ← SR (owner)
```

- `⋯` on a part that is **being made**: SR → **"Už netreba…"**; manager → **"Toto nerobím…"**. Delivered, declined and
  withdrawn parts have no menu (nothing left to change there — "Neposielam" for a delivered part stays in the list of
  returned items, as today).
- **"+ Pridať"** (SR) offers only the kinds not yet in play; a message to the manager is required. It appears in the
  task thread ("Jana pridala: Návrh – klient volal, chce aj návrh").
- **"Zrušiť úlohu…"** stays (= withdraw everything still being made; see §2.5).
- Delivered **Iné** shows the answer text; the SR takes it on board with "Beriem na vedomie" as today.

**Manager's "Hotovo" dialog** — one dialog for all parts, no separate buttons per part:

```
Hotovo – Cena + Návrh + Iné
  Cena     [ 1 285 ] €   rozpis …              ← fill = deliver
  Návrh    [ Variant A (v2) ▾ ]
  Iné      [ odpoveď … ]
  ─────────
  [Odoslať hotové (2 z 3)]      Návrh ostáva otvorený – dokončíš ho neskôr.
```

Whatever the manager fills in is delivered; the rest stays open. Nothing filled = button disabled. "Poslal som to
klientovi sám" works the same way over the filled parts.

**"Požiadať manažéra"** — the three tiles become toggles (one or more). The summary line stays: "Keď Nikolas dodá, tvoj
krok bude **Poslať návrh + cenu**"; "Zmeniť" only when the task is Iné alone (as today).

**List row / dashboard label:** "Poslať návrh + cenu" while both are in play, then only what is left; ✓ marks in the
row's task summary ("Cena ✓ · Návrh robí sa").

### 2.4 Data (proposal — R03-4)

A new table, because tasks do not exist in production yet (ChatGPT's point, confirmed: whatever we do with the task
tables, the test → production delta stays additive):

```prisma
model DealTaskPart {
  id           String             @id @default(cuid())
  task         DealTask           @relation(fields: [taskId], references: [id], onDelete: Cascade)
  taskId       String
  kind         DealTaskContent    // PRICE | DESIGN | OTHER (later services, §2.10)
  status       DealTaskPartStatus @default(REQUESTED)
  result       Json?              // set once on DELIVERED: { price } | { designs } | { answer }
  addedBy      User               @relation("DealTaskPartAddedBy", fields: [addedById], references: [id])
  addedById    String             // who asked for this part (with the task or later via "Pridať")
  addedAt      DateTime           @default(now())
  resolvedBy   User?              @relation("DealTaskPartResolvedBy", fields: [resolvedById], references: [id])
  resolvedById String?            // who delivered / declined / withdrew (null = the system on close)
  resolvedAt   DateTime?
  reason       String?            // required for DECLINED / WITHDRAWN

  @@unique([taskId, kind])
  @@index([taskId, status])
}

enum DealTaskPartStatus { REQUESTED DELIVERED DECLINED WITHDRAWN }
```

- A part leaves `REQUESTED` **exactly once**; a delivered result is never overwritten (a new price = a new task).
  Exception: re-adding a **withdrawn** kind puts that part back to `REQUESTED` (the withdrawal stays in the history as
  its activity row). A declined or delivered kind cannot be re-added in the same task.
- **Task status** is still stored on `DealTask` (lists and the SQL lock read it) and written in the same transaction as
  the part change that closes it: any part DELIVERED → `DONE`; else any DECLINED → `DECLINED`; else `CANCELLED`.
  `DealTask.closedAt / closedBy` = when / who closed the whole task; per-part actor and time live on the part.
- `DealTask.contents` and `DealTask.result` move into the parts. On test: reviewed SQL converts the existing tasks
  (OPEN → REQUESTED, DONE → DELIVERED from `result` with `closedBy / closedAt`, DECLINED → DECLINED, CANCELLED →
  WITHDRAWN), then drops the two columns. Never `--accept-data-loss`; wipe + reseed of test data is the fallback.
  Production has neither column, so it only gains the new table.
- `@@unique([taskId, kind])` keeps the item address `(taskId, kind, designId)` — `OFFER_SENT.meta.fulfils` and
  dismissals do not change shape. A DECLINED item additionally names the declined part (`part: PRICE | DESIGN |
  OTHER`) so two declined parts of one task are two items; a whole HANDOVER decline stays one item.
- New `ActivityType` values: `TASK_PART_DONE`, `TASK_PART_DECLINED`, `TASK_PART_WITHDRAWN`, `TASK_PART_ADDED` (primary,
  keyed rows of the new commands; `taskId` set; `meta.parts`). When a command closes the task it also writes today's
  `TASK_DONE` / `TASK_DECLINED` / `TASK_CANCELLED` in the same transaction (secondary row, same bump).

**One canonical projection** `taskPartState(task, parts, fulfils, dismissals)` — pure, in `lib/domain/tasks.ts` —
returns for every part: requested (by, when) · being made · delivered (snapshot, by, when) · waiting to be sent · sent
(when) / not sent (dismissed) · declined / withdrawn (by, when, why). The task card, the list row, the step label, the
overlap check, the send dialog and the server validation all use it; nobody re-derives it (R03-4).

### 2.5 Commands (all: `withLockTx`, access guard, lock order Team → User → Lead, `expectedRevision`, idempotency key with a canonical fingerprint, exactly one revision bump)

| Command | Who | What |
|---|---|---|
| `askManagerAs` (changed) | owner-rep | `contents` = 1–3 distinct kinds → one part each. Step derived as today (`stepAfterTask`), Iné alone keeps / chooses the step. |
| `resolveTaskPartsAs` (new; replaces `finishTaskAs` / `declineTaskAs` for HELP) | resolver (as `finishTaskAs` today) | `parts: [{ kind, deliver: {…} } \| { kind, decline: reason }]` — any subset of the parts still being made. Only `REQUESTED` rows are written (`updateMany … where status = REQUESTED`; fewer rows than asked → `STALE`). Delivered price → also the deal's price (as today). Closes the task when nothing is left, with the step rules of §2.6. Whole-task "Zamietnuť" = decline every open part. Primary row `TASK_PART_DONE` (or `TASK_PART_DECLINED` if nothing was delivered). |
| `finishAndSendAs` (changed) | resolver | as today, over the parts filled in: deliver + `OFFER_SENT` with `fulfils` for them; the follow-up call only when the task closes and nothing else waits (as today, I10). |
| `withdrawTaskPartsAs` (new) | owner only (wave-3 D5) | `parts` still being made + `reason`; + `step` when §2.6 asks for one. Primary row `TASK_PART_WITHDRAWN`. |
| `addTaskPartsAs` (new) | owner only | `kinds` not in play + `message` (a `TASK_MESSAGE` in the same transaction). Task must be `OPEN`. Primary row `TASK_PART_ADDED`. |
| `cancelTask` paths (unchanged meaning) | owner; system on close / takeover / owner change | = withdraw every part still being made (reason required; system reason on close). Delivered parts stay waiting (§2.7). |
| `reassignTaskAs` | resolver | unchanged — parts move with the task; each delivered part keeps its own deliverer. |

### 2.6 The step — exact rules

"In play" = parts `REQUESTED` + delivered price / návrh not yet sent or dismissed.

- **Deliver:** step unchanged (the delivered part is still in play until sent).
- **Decline / withdraw / add** while the task stays open: recompute with today's `stepAfterTask` over the kinds in
  play (návrh → "Poslať návrh", else price → "Poslať cenu"); the note stays when the kind stays. If only Iné is left in
  play, the SR picks the step in the same dialog (withdraw / add); on a manager's decline the step keeps its kind.
- **The task closes** (last part resolved):
  - something delivered is waiting → step unlocks for today with what is left to send (I10 as today);
  - nothing waits (all declined / withdrawn, or the delivered parts were already sent) → step unlocks for today with
    its current kind, exactly like a declined task in wave 3 — the SR sees the reasons ("✗ Cena: zavolaj im…") and
    picks the next step in the next contact;
  - the SR withdrew the last open part and nothing was delivered → it is today's **"Zrušiť + zmeniť"**: the SR picks
    the next step in the same save (one transaction, one revision).

Michal's two cases then run like this:

| | Manager | Task | SR's step |
|---|---|---|---|
| "Send the price first" | delivers Cena, declines Návrh ("najprv cenu, potom uvidíme") | `DONE` | "Poslať cenu" today; ✗ Návrh with the reason to take on board |
| "Price too difficult" | delivers Návrh, declines Cena ("prepoj ich na mňa") | `DONE` | "Poslať návrh" today; ✗ Cena with the reason; after sending → "Zavolať, či prišlo", where the SR tells the client about the price call (handover or not) |

### 2.7 Edge cases (R03-2, R03-3)

- **A delivered part survives everything.** Returned items come from `DELIVERED` parts **whatever the task status**
  (OPEN / DONE / DECLINED / CANCELLED) until an `OFFER_SENT` fulfils or a `TASK_RESULT_DISMISSED` dismisses them.
  Deal close: open parts are withdrawn by the system ("obchod uzavretý"), then all waiting items are dismissed — the
  order no longer matters. Takeover, move to nobody, owner change, bulk transfer: task-level behaviour as in wave 3;
  delivered parts wait for whoever owns the deal next.
- **Only a part being made can be withdrawn or declined.** Done → "Neposielam" (dismiss) instead.
- **Overlap uses the parts being made.** Sending a delivered part is fulfilment — no question, the task stays open for
  the rest. Sending something the manager is **still making** (the SR got the price elsewhere) asks: "Úloha ostáva
  otvorená" or **"Už to netreba – zrušiť cenu"** = withdraw exactly those parts. The input `overlap: CANCEL_TASK`
  becomes `WITHDRAW` with the part list; on a one-part task it behaves exactly like today's "zrušiť úlohu". Sending the
  price can never close an open návrh.
- **Races** go through the Lead lock and `expectedRevision`: manager delivers the price while the SR withdraws it → one
  wins, the other gets "Obchod sa medzitým zmenil"; after a won delivery the withdrawal is refused ("už dodané – ak to
  neposielaš, daj Neposielam").
- **HANDOVER tasks** have no parts and do not change.

### 2.8 First call and remaining-to-send state — supplied by wave 5 (R03-5)

Wave 5 is implemented first. It records **several things the client asked for** (cenník, cena, návrh, info and the final
approved vocabulary), what the client actually received, and the derived checklist of what remains to be sent. Wave 4
builds no first-call outcome, client-intent list or competing send checklist.

**Dependency contract for the wave-4 re-review:**

- "Požiadať manažéra" may pre-select PRICE / DESIGN from wave 5's remaining client wishes, but the SR explicitly
  creates the task; nothing is automatic.
- `DealTaskPart.kind` is manager work (`PRICE | DESIGN | OTHER`), not the wave-5 client-request vocabulary. Cenník,
  info and other ready materials never become task parts just because the client asked for them.
- Delivering a part changes REQUESTED → DELIVERED and makes that result ready. It does not mark the content sent and
  does not remove it from wave 5's remaining-to-send projection.
- A valid `OFFER_SENT` for an exact subset is what removes client-facing contents. A correction can make them pending
  again. Wave 4 must call the wave-5 operation rather than duplicating those rules.
- While any task part remains REQUESTED, the step stays locked against arbitrary replanning, but wave 5's send dialog
  remains usable for every ready subset. The task and the checklist may therefore change independently.
- The task UI distinguishes **prepared by the manager** from **received by the client**. They must not share one
  ambiguous green check.

### 2.9 Tests (server, `check-concurrency.ts`)

- Ask with 1, 2, 3 kinds; duplicate kinds refused; step per combination (návrh wins, Iné alone keeps / chooses).
- Deliver price → task OPEN, step locked, price waiting; send it → consumed, task still open, step unchanged; deliver
  návrh → DONE, unlocked, návrh waiting; send → "Zavolať, či prišlo". Both orders; all at once; Iné answered first.
- Michal's two decline cases (§2.6 table). Decline all → `DECLINED` as in wave 3.
- Withdraw one part (step recomputed), withdraw the last with / without a delivered part, only Iné left → step chosen,
  add a part, re-add a withdrawn kind, add a declined / delivered kind refused, add on a closed task refused.
- Partial price, then: decline of the rest, owner cancel, close WON / LOST, move to nobody, takeover, owner change, bulk
  transfer, reassign → the price is still waiting each time.
- Withdraw vs. deliver race; replay (parallel + again) and changed payload of every new command; non-owner withdraw /
  add refused; non-resolver resolve refused.
- Overlap: sending a delivered price never asks and keeps the návrh open; `WITHDRAW` of the price leaves the návrh.
- Pure: `taskPartState` matrix, step recompute matrix, parity of the SQL lock with the part state.

### 2.10 Thinking ahead — more wishes, other services (not built in wave 4)

- **A client calls while a task is open and wants more:** use the shipped wave-5 operation to record the additional
  client wish, then use "+ Pridať" only if new manager work is actually required. A task stays an **internal work
  order**; the client's wishes are a separate list. Keeping the two apart is what lets "sent without being asked"
  (foot in the door) and "asked but not sent" both be counted.
- **Other services** (SEO, marketing …, *"tick box other services"*): a part kind is just a value — new
  `DealTaskContent` values or one kind `SERVICE` with a service field on the part, decided with wave 5 / the services
  feature. Nothing in wave 4 blocks it; the website steps ("Poslať cenu / návrh") stay website-specific.
- **The locked step** keeps its job throughout: while anything is being made the SR cannot plan something else. Its
  checklist/headline comes from the shipped wave-5 projection, including ready materials with no task part. When the
  last manager part resolves, the step unlocks with exactly what wave 5 says is left to send.

---

### 2.11 A call while waiting for the manager — accepted limitation (2026-09-19)

> **ACCEPTED LIMITATION — not a defect (Michal, 2026-09-19).** One locked step per deal means the SR cannot plan a
> separate call while a task is still open (e.g. price sent, návrh still being made). This is **extremely rare**
> (sending the price before the návrh when both were asked for is rare; wanting a call in between is rarer still). The
> SR can still record any call while the step is locked. **Decision: keep the limit (option a). Nothing is built.**
> Reviews should not report it as an error; option (c) below stays on record in case practice proves otherwise.

**The limit:** one deal has one next step. While a task is open that step is locked, so the SR cannot plan anything
else — e.g. "price sent today, call Thursday whether it arrived; the návrh comes next week".

| | How | Core change | Verdict |
|---|---|---|---|
| a | Keep the limit; the SR records the call when it happens (allowed while locked) | none | **chosen** |
| b | Give the locked step a date meaning "call meanwhile" | re-uses `nextActionAt`, breaks the wave-3 rule "a locked step has no date"; filters would show a "Poslať návrh" that is really a call | no |
| c | **"Medzitým zavolať" on the waiting task**: one optional date + note | two nullable columns on `DealTask`; one more condition in the due queries | on record, not planned |
| d | Several next steps per deal (a small calendar) | the core model of the app | no — backlog |

**(c) in detail (only if ever needed):**

- In the open task (owner only): "+ Medzitým zavolať" → date (+ optional note). The step stays locked. Stored as
  `DealTask.checkInAt DateTime?`, `DealTask.checkInNote String?` — additive; production has no task tables yet.
- On that day the deal appears in the rep's due lists as **"Zavolať (čaká sa na návrh)"**: a reminder inside the
  lock, not a second step.
- **Recording any contact** on or after that date clears it in the same transaction (one bump); the rep may set a new
  one. It disappears with the task — when the task closes, the step unlocks for today anyway.
- Keyed command `setTaskCheckInAs` (owner, `expectedRevision`, one bump, a row in the task thread so the manager sees
  it). The due query gets one `OR` (open task with `checkInAt <= today`); the SQL twin of the lock and its parity test
  are extended. About 4–6 hours.

## 3. Part B — notes (D-07, accepted 2026-09-17)

### 3.1 The problem today (verified in code)

| Where a note lives | Who writes it | Problem |
|---|---|---|
| `Lead.note` (Údaje, calls InfoDrawer) | the scout; then **the first call replaces it** (`logCallAs`); any contact edit overwrites it | **B-09** — the scout's observation disappears; nobody knows whose note it is (Michal saw this in the ask dialog) |
| `Activity.note` of each contact | whoever records it | buried in the history |
| `nextActionNote`, `callbackNote`, `priceNote` | step / callback / price | field annotations — they stay |
| `DealTask.text` + task messages | SR ↔ manager | belongs to one task, not to the client |
| handover note | SR handing over | what they ordered — hidden in a closed task |

### 3.2 The accepted design

`LeadNote` (S-02): author, the author's role at the time, stage, kind (who needs to read it), body, pin, soft delete.

```prisma
model LeadNote {
  id         String       @id @default(cuid())
  lead       Lead         @relation(fields: [leadId], references: [id], onDelete: Cascade)
  leadId     String
  author     User         @relation(fields: [authorId], references: [id])
  authorId   String
  authorRole Role         // rola v čase písania – „od scouta" platí aj po povýšení
  stage      NoteStage    // CALL_STAGE | DEAL_STAGE
  kind       LeadNoteKind @default(GENERAL)
  body       String
  pinnedAt   DateTime?    // pripnuté = v hlavičke akčného okna a hore v detaile
  deletedAt  DateTime?
  createdAt  DateTime     @default(now())
  updatedAt  DateTime     @updatedAt
  @@index([leadId, pinnedAt])
  @@index([leadId, createdAt])
}

enum NoteStage { CALL_STAGE  DEAL_STAGE }
enum LeadNoteKind {
  GENERAL   // o klientovi – typicky scout
  FOR_CALL  // pre toho, kto bude komunikovať – typicky telesales
  FOR_BUILD // pre vývoj – čo si objednali, doména, addony
  INTERNAL  // interné
}
```

Shown in: a **Poznámky** card on the detail (pinned + latest three, "Zobraziť všetky (n)" with filters), **pinned notes
in the action-sheet header** (calls and deals — in front of whoever is about to dial), and the calls InfoDrawer instead
of today's single `Lead.note`. No separate note board yet.

### 3.3 Details to confirm

| # | Proposal |
|---|---|
| 1 | The scout's note on adding a contact = first `LeadNote` (GENERAL, pinned) |
| 2 | The positive first call's note = a FOR_CALL note (the handover to whoever continues); other call notes stay history |
| 3 | On deals, "Čo povedali" stays history; a separate "+ Poznámka" adds a `LeadNote` |
| 4 | `Lead.note` becomes read-only "Poznámka pri pridaní kontaktu"; the card shows it next to the notes (no data copy) |
| 5 | Author edits own notes, manager edits / deletes any; delete is soft and stays in history |
| 6 | INTERNAL notes only for managers |
| 7 | Author and manager may pin; the sheet header shows at most 3 pinned, then "+n" |

---

## 4. Part C — order note for the build (D-08 step 3)

When the manager accepts a handover (or takes the client over), the SR's handover text becomes a **pinned FOR_BUILD
note** on the deal, authored by the SR — what they ordered stays visible after the task is closed. Handover chips stay;
proposed additions "dohodnutá cena" and "doména". It is a copy of what the SR wrote, not an automatic task (wave-3 D9
is about tasks). Later the WON step (BL-09) and the developer (BL-04) read these notes.

---

## 5. Part D — wave-3 leftovers

| # | Leftover | Proposal |
|---|---|---|
| D1 | In "Čo sme poslali", when returned items stay unsent, the kept "Poslať…" step's date and note cannot be edited there | show the kept step editable in the same dialog |
| D2 | Reopen always sets "Zavolať" today | offer the next-step choice in the reopen confirmation |
| D3 | A manager cannot cancel + replan a rep's task (only by closing) | keep, unless it annoys in practice |
| D4 | Pill counts run one query per pill (13 per load) | measure; optimise only if slow |

---

## 6. Data (proposal — review before applying on test)

| id | Change | Part | Toward production |
|---|---|---|---|
| S-02 | `LeadNote` + enums `NoteStage`, `LeadNoteKind` | B, C | additive (new table + enums) |
| S-13 | `DealTaskPart` + enum `DealTaskPartStatus`; test tasks converted, then `DealTask.contents` / `DealTask.result` dropped on test with reviewed SQL | A | additive (production has no task tables yet) |
| S-14 | `ActivityType += TASK_PART_DONE, TASK_PART_DECLINED, TASK_PART_WITHDRAWN, TASK_PART_ADDED` | A | additive (enum values) |

As always: proposal here → endpoint check → reviewed SQL → `db push` "already in sync" → verified delta in
`context/domain/db-changes.md`. Test branch only, never `--accept-data-loss`. **Schema before code (R03-6):** S-13 and
S-14 are applied and verified on test and Prisma regenerated **before** any Part A code that writes them; in
production the new table and enum values go in before the code that uses them.

---

## 7. Open questions

Decided 2026-09-19: **Q1** Iné combinable — yes · **Q3** withdraw / add a part — yes · **Q4** manager declines one
part — yes (§2.1). Q2 (first-call "chcú cenu aj návrh") is gone — moved to wave 5 (§2.8).

| # | Question | Proposed |
|---|---|---|
| Q5 | Notes details §3.3 (1–7) | as proposed |
| Q6 | Order note automatic when a handover is accepted? | yes |
| Q7 | Which leftovers (D1–D4)? | D1, D2 |
| Q8 | Order after the wave-5 prerequisite: re-review → A → B → C → D? | yes |

---

## 8. Order of implementation (only after wave 5 and the answers)

0. **Hard prerequisite:** finish wave 5, update the current domain documentation, and run its full automated and human
   checks. Then re-review this proposal against the actual wave-5 schema, pure projection and commands. Replace every
   provisional task-owned step/checklist rule in §§2.2–2.10 with calls to that shipped contract. Do not apply S-13 or
   begin Part A before this gate passes.
1. **Schema on test** (R03-6): S-13 (with the reviewed conversion of the test tasks), S-14, S-02;
   Prisma regenerated; ledger entry in `db-changes.md`.
2. **Part A domain:** `taskPartState`, returned items from parts, step recompute + label, overlap over parts; pure tests.
3. **Part A commands:** §2.5 (ask, resolve, finish-and-send, withdraw, add, cancel / close / takeover / transfer
   paths, overlap `WITHDRAW`); the §2.9 server tests.
4. **Part A UI:** toggles in "Požiadať manažéra", parts with ✓ / ✗ / – in the task card, `⋯` menu, "+ Pridať", one
   "Hotovo" dialog for all parts, labels in the list / dashboard.
5. **Part B:** `lib/domain/notes.ts`, commands (add / edit / delete / pin — keyed, one bump), queries (detail card,
   sheet header, InfoDrawer), UI, wiring into contact creation and the first call; tests (authorship, role at the time,
   soft delete, pin rules, scope).
6. **Part C:** handover → FOR_BUILD note in the same transaction as the acceptance; tests.
7. **Part D** items chosen in Q7.
8. Docs, full check pass, HTTP role checks, click-through.
