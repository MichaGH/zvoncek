# Wave 4 — one manager task with several parts, notes, order note, wave-3 leftovers

**Status:** **design, nothing built, no schema applied.** Rewritten from zero on 2026-09-20 against the **shipped**
wave 5 and Michal's workflow description of the same day. The 2026-09-19 draft is kept unchanged as
`wave-4-proposal-v1-2026-09-19.md` — history only, do not implement from it.

The blocking condition of the v1 draft ("re-review against the shipped wave 5") is what produced this file. Part A is
now an implementation-ready contract. Parts B–D still wait for Michal's answers (§8).

**Read first, in this order:** `AGENTS.md` · `context/ai-workflow-rules.md` · `context/code-standards.md` (§5 and §6
are the ones that get forgotten) · `context/domain/database-map.md` (`Lead`, `DealTask`, `LeadRequest`) ·
`context/domain/operations.md` (everything under `clientRequests.ts`, `requestMutations.ts`, `tasks.ts`,
`taskMutations.ts`) · `context/app-workflow.md` §5a, §5b, §6 · `wave-5-proposal.md` §6.8, §6.9, §6.9a ·
`wave-3-task-proposal-final.md` D3, D4, D5, D19, §5.1, §5.4 (invariants I1–I10), §6.13.

**The code is the source of truth, not this file.** Where this file describes existing behaviour and the code
disagrees, the code wins and this file is wrong — say so instead of changing the code to match (`ai-workflow-rules`
§3.6).

**`[WAVE 4]` comments in the code still cite the v1 section numbers** (`tasks.ts`, `taskMutations.ts`,
`AskManagerDialog.tsx`, `FinishTaskDialog.tsx`, `OfferSentDialog.tsx`). They describe the right behaviour; only the
§ references moved. They are corrected in implementation step 2 (§9), not before — nothing else depends on them.

**Sources**

- Michal, 2026-09-20 (the workflow this wave must serve) — quoted and expanded in §2.1. This supersedes the
  2026-09-19 sketch wherever they differ.
- Michal, 2026-09-19 (after wave-3 click-through and review R03): Q1 "Iné" combinable = yes, Q3 withdraw / add a part
  = yes, Q4 the manager may decline one part = yes. Still valid, carried over.
- Round 2 plan (`round2-deal-workspace.md` §5): wave 4 = D-07 notes (S-02) + the order note (D-08 step 3) + B-09.
- Wave-3 leftovers (`progress-tracker.md`, "Wave 3 — not resolved").

---

## 0. What changed from the v1 draft, and why

Read this before §2 if you knew the old draft. Everything else in §2 is written so that you do not need the old one.

| v1 said | Now | Why |
|---|---|---|
| The step follows the **task contents**; it is recomputed when a part joins or leaves the play, "**never** when a part is delivered" | The step follows the **wave-5 outstanding set** (`defaultStep` / `stepAfterTask`), and it is **also** re-derived when a send consumes something **while the task is open** | Wave 5 shipped a single definition of "what is left to send" (§6.9). Michal 2026-09-20: after the rep sends the ready price, the locked step must drop it |
| "Returned items" were a wave-4 concept to redefine | They are wave 5's `prepared` list; wave 4 only changes where it comes from | `ManagerWork = { making, prepared }` is a shipped signature (`clientRequests.ts`). Wave 4 fills it from parts |
| A locked step never changes | A locked step still follows the outstanding set; it is never **freely replanned** | Not a new exception: `setClientAsksAs` already re-derives a locked step when the client asks for more (wave 5). Wave 4 makes the symmetric case work |
| Overlap choice `CANCEL_TASK` "becomes `WITHDRAW` with a part list" | Two separate inputs: `overlap: WITHDRAW_PARTS` + `withdrawParts` (part-scoped, send dialog), and the unchanged `cancelTask` (whole task: snooze, close, replan) | Two different intents. Reusing one field for both is how the wrong one gets cancelled |
| S-13 = add the table and drop `DealTask.contents` / `result` in one step | **S-13a** (add) before the code, **S-13b** (drop) after the code is switched over and verified | A drop must not land while code still reads the column; "schema before code" (R03-6) applies to the *add* |
| A declined task returns one `DECLINED` item | A declined **part** returns one item per part (`ItemRef.part`) | Two declined parts of one task must be two acknowledgements |
| Michal's "price too difficult, I'll call them" case ends cleanly | It leaves the **client's** `PRICE` request open, and that is **correct** — see §8 Q9 | Manager work and client intent are separate ledgers (wave 5 §7). A declined part says the manager will not do the work; it never says the client stopped wanting it |

**Revision 3 (2026-09-20) — what review R02 changed.** Answers: `.ai/reviews/01-sales-rep/W4/spec/R02-response.md`.

| R02 | What it found | Now |
|---|---|---|
| 1 | The aggregate task status contradicted "a cancellation writes `TASK_CANCELLED`" — one delivered part makes `CANCELLED` unreachable | §2.4a is the one terminal-transition table; the activity row follows the **resulting status**. `declineTaskAs` folded into `resolveTaskPartsAs` |
| 2 | `PartView` could not represent two návrhy, and merged *sent* with *deliberately not sent* | Consumption is **per item**, with a real `ItemDisposition` (`WAITING` / `SENT` / `DISMISSED`); the part's mark is derived (§2.3, §2.5) |
| 3 | A mixed `OTHER + PRICE/DESIGN` task had no locked step once the sendable work was gone | `DealTask.fallbackKind` / `fallbackNote`, written once at ask time; P6 becomes `derived ?? fallback` and drops the `isSystemStep` guard while locked (§2.6) |
| 4 | "Whatever is filled in is delivered" would have returned a **stale prefilled price** | Explicit "Odovzdať teraz" toggles; the server refuses values for a kind it was not asked to deliver (§2.7, §2.9) |
| 5 | Corrections were specified twice, both ways | One rule: **re-derive while locked**, never touch an unlocked step (§2.6, §2.10) |
| 6 | "Nothing else pending" meant task items only, not the client's outstanding work | Server-enforced gate on `outstandingOf`; also a real gap in shipped code → **P1** (§7) |
| 7 | The conversion had a multi-day write gap before the code cutover | Parts are a pure derivation until cutover; re-run + **zero-drift verify** before the read switch and again before the drop (§6.3) |
| 8, 9 | The notes sketch could leak INTERNAL notes and misattribute manager edits; old `Lead.note` would be given invented provenance | §3.3 and §3.4 rewritten — Q5 now means "confirm those two sections" |
| 10 | Wipe-and-reseed was an automatic fallback in a plan | Abort and report; a reset happens only if Michal chooses it (§6.3) |

**Two shipped defects must be fixed before Part A — §7, P0 and P1.** Both belong to wave 5's closeout, not to wave 4.

---

## 1. Scope

| Part | What | Size |
|---|---|---|
| **A** | One task carrying several **parts** (Cena · Návrh · Iné, any combination, any order): partial delivery, partial decline, partial withdrawal, adding a part, and sending a ready part while the rest is still being made | 4–5 days |
| **B** | **Notes** (`LeadNote`): who wrote it, for whom, pinned in front of whoever calls; the scout's note is no longer overwritten (B-09) | ~2 days |
| **C** | **Order note for the build** (`FOR_BUILD`) kept on the deal after a handover | 0.5 day |
| **D** | Wave-3 leftovers (pick) | 0.5 day each |

**Not wave 4:** correcting an already delivered part (a second price = a second task, §2.4) · manager work for contents
other than price / návrh / iné (§2.2) · order / WON process (BL-09) · statistics (BL-10) · requests on any lead (BL-01) ·
"transferred" marker (BL-11) · developer projects (BL-04) · other services as part kinds (§2.11). Production rollout is
separate as always.

---

## 2. Part A — one task, several parts

### 2.1 Michal's workflow (2026-09-20)

The scenario this wave exists for, in his order:

1. The client asks for **cenník, cena, návrh, info**. The rep ticks all of it. *(Shipped — wave 5. Four `LeadRequest`
   rows, one checklist, one derived headline "Poslať návrh + cenu + cenník + info".)*
2. The rep can send the cenník and info herself, but she needs the manager for the **exact price** and for the
   **návrh**. She opens "Požiadať manažéra" and ticks **both**. *(New: today that is two tasks, one after the other.)*
3. The manager **sends the price back** — he fulfils that part. The task is now "needs návrh", and the card shows that
   the price part is already done.
4. **Usually** the price and the návrh go to the client together: the manager finishes part by part, and then the rep
   sends one email with the návrh and the price.
5. **Sometimes** the client says *"send me the price now, you can work on the návrh"*. Then: the price part is
   delivered, the návrh part is still being made, and the rep must be able to **go through the locked step** and record
   that the price was sent. The step must show that some parts are done.
6. Delivering part by part is not a nicety — the manager **cannot** save a price and a návrh in the same moment
   anyway; one is always saved first.
7. Therefore wave 4 **breaks the rule about the locked step, in the sense of partially fulfilling it**. Michal:
   *"I wouldn't make any restrictions, that the price has to be resolved before he can change the step. I would just
   keep it after a dialog 'are you sure'."*
8. The lock keeps its job: *"when the next step is locked, we still can change the last step — in case the customer
   called etc., that's not a problem. We just cannot change the next step, so when the manager finishes, it's obvious
   she has to send it."*
9. Wave 4 also covers **partial cancelling** (the client no longer wants the návrh) and **partial expanding** (the task
   is "návrh", then they realise they also need the price).

**Manager work is not client intent.** A manager task part is `PRICE | DESIGN | OTHER` and nothing else — Michal:
*"there won't ever be a manager task 'info email' or so. It's assistance from the manager, so the sales rep can fulfil
the customer request."* Cenník, info and rozbor webu are never task parts. `OTHER` never maps to a client content.

> Michal's point 3 says "cenník was already finished that part of the task". Read as **cena** — cenník is never
> manager work. If that reading is wrong, everything in §2 that assumes it must be revisited.

### 2.2 The one thing to understand before writing code

Wave 5 already owns *what is left to send*. It is one grouped set with three sources
(`clientRequestState`, `wave-5-proposal.md` §6.9):

```
outstanding = open client requests  ∪  managerWork.making  ∪  managerWork.prepared     (grouped by content)
```

Today `managerWorkOf` (`lib/domain/requestMutations.ts`) fills those two lists from the one open task:

```ts
making   = open && open.type === "HELP" ? open.contents : []      // the whole task's contents
prepared = loadPending(leadId).filter(PRICE | DESIGN)             // DONE / DECLINED tasks only
```

**Wave 4 changes only these two lines and what feeds them.** Everything downstream is already built and must not be
re-derived, re-implemented or second-guessed:

| Consumer | Already shipped |
|---|---|
| the checklist and its per-row label | `clientRequestState`, `outstandingLabel` |
| the headline "Poslať návrh + cenu" | `stepView(stepKind, outstanding)` |
| the ⚠ warning when the step is narrower | `coveredContents`, `warningText` |
| the stored step kind, mode, date and note | `defaultStep(outstanding, current, { locked })` |
| the step at ask time | `stepAfterTask(contents, current, pending, defaultNote, outstanding)` |
| whether a send completes the step | `sendCompletesStep` |
| the send dialog's pre-ticks | `offerDefaults` + `prepared` |
| "Požiadať manažéra" pre-selection | `target.outstanding` |
| the list row, the pills, the counts, `TODAY_SQL` | one projection, one SQL twin |

After wave 4:

```ts
making   = REQUESTED parts of the OPEN task            (PRICE / DESIGN; OTHER maps to no content)
prepared = items of DELIVERED parts of ANY task of the lead, not yet sent or dismissed
```

If a wave-4 change ever needs a second answer to "what is still to send", the change is wrong.

### 2.3 States and vocabulary

A **part** is one kind of manager work inside one task. The **part** has a lifecycle; each **item** it returned has its
own **disposition** (R02-2 — these are two different things and the card must not merge them):

| Part state | Means |
|---|---|
| `REQUESTED` | the manager has it; its kind is in `making` |
| `DELIVERED` | the manager finished it; it returned one or more items |
| `DECLINED` | the manager will not do this part; reason required |
| `WITHDRAWN` | the rep took it back; reason required |

| Item disposition | Mark | Means |
|---|---|---|
| `WAITING` | `◆` pripravené, ešte neposlané | nothing consumed it; it is in `prepared` and holds the step (I10) |
| `SENT` | `✓` poslané klientovi 20. 9. | a valid `OFFER_SENT` named it in `meta.fulfils`; the date is that send's `offerInstant` |
| `DISMISSED` | `⊘` neposlané: „…" | a `TASK_RESULT_DISMISSED` named it; carries who, when and the reason |

**Three marks, not two.** `◆` and `✓` are different because wave 5 §3.7 forbids one green check meaning both
*prepared by the manager* and *received by the client*. `⊘` is different from both because a dismissed item was
**deliberately not sent** — showing it as `✓` would make the CRM claim the client saw material that never left
(R02-2).

**A part's compact mark is derived from its items, never stored:**

| Items | Part mark |
|---|---|
| all `WAITING` | `◆ pripravené` |
| some `SENT`, some `WAITING` | `✓ 1 z 2 poslané` |
| all `SENT` | `✓ poslané klientovi <date of the latest>` |
| any `DISMISSED` | the dismissal is named explicitly: `✓ 1 z 2 poslané · ⊘ 1 neposlaný` |
| none (a `DECLINED` / `WITHDRAWN` part) | `✗` / `–` with its reason |

"In play" = parts that are `REQUESTED`, or `DELIVERED` with at least one `WAITING` item. A part's kind may be asked
for again only when the part is not in play (§2.7, `addTaskPartsAs`).

### 2.4 Data — S-13

Tasks do not exist in production at all, so the whole `DealTask` family is additive toward production whatever we do
with it on test.

```prisma
model DealTaskPart {
  id           String             @id @default(cuid())
  task         DealTask           @relation(fields: [taskId], references: [id], onDelete: Cascade)
  taskId       String
  kind         DealTaskContent    // PRICE | DESIGN | OTHER
  status       DealTaskPartStatus @default(REQUESTED)
  result       Json?              // set once on DELIVERED: { price } | { designs } | { answer }
  addedBy      User               @relation("DealTaskPartAddedBy", fields: [addedById], references: [id])
  addedById    String             // who asked for this part (with the task, or later via „+ Pridať")
  addedAt      DateTime           @default(now())
  resolvedBy   User?              @relation("DealTaskPartResolvedBy", fields: [resolvedById], references: [id])
  resolvedById String?            // kto ju dodal / zamietol / stiahol – vždy vyplnené, kým je časť vyriešená
  resolvedAt   DateTime?
  reason       String?            // required for DECLINED and WITHDRAWN

  @@unique([taskId, kind])
  @@index([taskId, status])
}

enum DealTaskPartStatus { REQUESTED DELIVERED DECLINED WITHDRAWN }
```

and two columns on the existing task (**R02-3**, the fallback step — §2.6):

```prisma
// DealTask
fallbackKind NextActionKind? // krok, ktorý mal obchod PRED zamknutím – kam sa vráti, keď nie je čo poslať
fallbackNote String?
```

Rules (in code, under the `Lead` row lock — not constraints):

- **`@@unique([taskId, kind])` is load-bearing.** It keeps the item address `(taskId, kind, designId)` unchanged, so
  `OFFER_SENT.meta.fulfils`, `TASK_RESULT_DISMISSED.meta.items`, `itemKey` and `validateFulfils` keep their shape.
- **A part's `result` is written once and never rewritten.** A corrected price is a **new task** (Q11). The deal's
  current price may change afterwards; the snapshot does not — same rule as `DealTask.result` today.
- **`resolvedById` is always the acting user** once the part is resolved — the owner, the manager, or the manager
  performing the close / takeover / transfer. There is no "system" actor: every path has one. The column is nullable
  only because a `REQUESTED` part has no resolver (R02-1, and B8 in §2.7 already said this).
- **A part leaves `REQUESTED` exactly once per requested period.** The only way back is `addTaskPartsAs` re-adding a
  `WITHDRAWN` kind: the row returns to `REQUESTED`, `resolvedBy` / `resolvedAt` / `reason` are cleared, `addedAt` /
  `addedById` are set to the re-adder. `DELIVERED` and `DECLINED` kinds can never be re-added in the same task.
- **Task status is derived from the parts**, order-independently, and written in the same transaction — so the lock,
  `STEP_LOCKED_SQL` and every existing query keep working untouched:

  | Parts | `DealTask.status` |
  |---|---|
  | any `REQUESTED` | `OPEN` |
  | else any `DELIVERED` | `DONE` |
  | else any `DECLINED` | `DECLINED` |
  | else | `CANCELLED` |

  **This aggregate is the only rule, and the task-level activity row follows it** (R02-1). An earlier draft also said
  that a whole-task cancellation always writes `TASK_CANCELLED`, and that a delivered part can survive a `CANCELLED`
  task. Both were wrong: one delivered part makes `CANCELLED` unreachable. The exact transitions and the activity rows
  they write are **§2.4a** — there is no second source for them.

  `closedAt` / `closedById` = when and by whom the **task** ended; per-part actor, time and reason live on the part.
  `closeReason` keeps its wave-3 meaning only for an ending that really has one task-wide reason (deal closed,
  takeover, owner removed, bulk transfer); a mixed ending leaves it `NULL` and the reasons stay on the parts.
- **`DealTask.contents` and `DealTask.result` move into the parts and are dropped on test** (S-13b, §6). Production
  never had them.
- **A `DECLINED` part returns one acknowledgement item per part.** `ItemRef` gains an optional `part: DealTaskContent`,
  used **only** when `kind === "DECLINED"`:

  ```ts
  itemKey = `${taskId}:${kind}:${kind === "DESIGN" ? (designId ?? "") : kind === "DECLINED" ? (part ?? "") : ""}`
  ```

  Old rows (a whole-task decline, no `part`) keep the key `taskId:DECLINED:`; the conversion handles them (§6.3).
- **New `ActivityType` values** (S-14): `TASK_PART_ADDED`, `TASK_PART_DONE`, `TASK_PART_DECLINED`,
  `TASK_PART_WITHDRAWN` — the **primary keyed row** of the part commands, with `taskId` set and
  `meta = { fp, parts: [...] }`. The task-level row (`TASK_DONE` / `TASK_DECLINED` / `TASK_CANCELLED`) is written as a
  **secondary row without a key** whenever the task reaches a terminal status, so the history card, `pendingSummary`
  and every existing reader keep working. `TASK_DONE.meta.result` stays the merged result of all `DELIVERED` parts.
- `Activity` gets **no** `partId` column. The kinds are in `meta.parts`; `taskId` is enough to place the row.

### 2.4a Terminal transitions — the one table (R02-1)

Every ending is the same two steps: **resolve the named parts, then recompute the aggregate status of §2.4.** Nothing
else decides the status, and the task-level activity row is chosen by the **resulting status**, never by the name of
the action that caused it.

| Action | Parts touched | Resulting status | Primary keyed row | Secondary rows |
|---|---|---|---|---|
| deliver every remaining part | those → `DELIVERED` | `DONE` | `TASK_PART_DONE` | `TASK_DONE` |
| deliver some and decline the rest, one command | as named | `DONE` | `TASK_PART_DONE` | `TASK_DONE` |
| decline every remaining part, nothing ever delivered | those → `DECLINED` | `DECLINED` | `TASK_PART_DECLINED` | `TASK_DECLINED` |
| decline the rest **after** an earlier delivery | those → `DECLINED` | **`DONE`** | `TASK_PART_DECLINED` | **`TASK_DONE`**, not `TASK_DECLINED` |
| owner withdraws the last part, nothing ever delivered | those → `WITHDRAWN` | `CANCELLED` | `TASK_PART_WITHDRAWN` | `TASK_CANCELLED` |
| owner withdraws the last part **after** an earlier delivery | those → `WITHDRAWN` | **`DONE`** | `TASK_PART_WITHDRAWN` | **`TASK_DONE`** |
| deal closed / takeover / owner removed / bulk transfer, nothing delivered | every `REQUESTED` → `WITHDRAWN` with the system reason | `CANCELLED` | the caller's own row (`STATUS_CHANGED`, `OWNER_CHANGED`, the interaction row …) | `TASK_PART_WITHDRAWN` + `TASK_CANCELLED` |
| the same, **after** an earlier delivery | as above | **`DONE`** | the caller's own row | `TASK_PART_WITHDRAWN` + `TASK_DONE` |
| accepted `HANDOVER` | no parts | `DONE` | `OWNER_CHANGED` | `TASK_DONE` (unchanged from wave 3) |

- **`DONE` means "something came back", not "everything was done".** Q10 accepted exactly that, and the card never
  hides the rest — it prints the per-part marks: *"Vybavené — cena odovzdaná, návrh zrušený"*. A badge saying "Zrušené"
  while a delivered price is still waiting to be sent would be the real lie.
- **`declineTaskAs` is removed** and folded into `resolveTaskPartsAs` (§2.7). "Zamietnuť…" becomes "decline every part
  still `REQUESTED`, one reason". This removes the impossible case of a command named *decline* being forced to emit
  `TASK_DONE`, and leaves one command per outcome.
- The primary keyed row of `resolveTaskPartsAs` is `TASK_PART_DONE` when anything was delivered, otherwise
  `TASK_PART_DECLINED`, so its `runKeyed` lookup passes **both** types; the `fp` still decides whether a repeat is a
  replay or an `IDEMPOTENCY_CONFLICT`.
- **`cancelOpenTask` keeps its name and its callers** (`logFollowUpAs`, `recordOfferSentAs`, `changeStatusAs`,
  `markLostAs`, `ownerTransition`) and its input shape. Only its body changes: withdraw every `REQUESTED` part with the
  given reason, recompute, and emit the row the table names.

### 2.5 The pure projection — `taskPartState`

One canonical pure function in `lib/domain/tasks.ts`. The task card, the list row, the manager's inbox, the send
dialog, the step derivation and every server validation read it; nothing re-derives part state from raw rows.

**Consumption is per returned item, not per part (R02-2).** A `DESIGN` part can return several návrhy, and each one is
sent or dismissed on its own. Collapsing them into one part-level flag would let the card claim the client received a
návrh that was deliberately **not** sent — the exact failure wave 5 exists to prevent.

```ts
export type Person = { id: string; firstName: string };

export type ItemDisposition =
  | { state: "WAITING" }
  | { state: "SENT"; at: string; activityId: string }                                    // offerInstant of the valid OFFER_SENT
  | { state: "DISMISSED"; at: string; by: Person | null; reason: string | null; activityId: string };

export type PartItemView = PendingItem & { disposition: ItemDisposition };

export type PartMark = "MAKING" | "PREPARED" | "PARTLY_SENT" | "SENT" | "DECLINED" | "WITHDRAWN";

export type PartView = {
  kind: DealTaskContent;
  status: DealTaskPartStatus;
  addedBy: Person | null;
  addedAt: string;
  resolvedBy: Person | null;
  resolvedAt: string | null;
  reason: string | null;              // DECLINED / WITHDRAWN
  items: PartItemView[];              // PRICE: one · DESIGN: one per návrh · OTHER / DECLINED: one
  mark: PartMark;                     // the compact mark of §2.3, derived from items — never stored
  dismissedCount: number;             // so the card can say „⊘ 1 neposlaný" without walking items
};

export function taskPartState(
  task: { id: string; type: DealTaskType; status: DealTaskStatus },
  parts: readonly PartRow[],
  consumption: readonly Consumption[],
): { parts: PartView[]; making: DealTaskContent[]; openKinds: DealTaskContent[]; nextStatus: DealTaskStatus };
```

**The input has to carry the facts, not just the references** (R02-2: the old signature took two bare `ItemRef[]`
lists, so the pure function could not produce the date it promised):

```ts
export type Consumption = {
  ref: ItemRef;
  state: "SENT" | "DISMISSED";
  at: Date;                  // SENT: offerInstant(meta, createdAt) · DISMISSED: the row's createdAt
  by: Person | null;
  reason: string | null;     // DISMISSED only
  activityId: string;
};
```

`pendingByLead` already reads exactly the rows this needs (`OFFER_SENT` with `meta.fulfils`, `TASK_RESULT_DISMISSED`
with `meta.items`); it currently selects only `leadId, type, taskId, meta` and must also select `id`, `createdAt`,
`userId` and the actor's `firstName`. No new query, no new table.

- `returnedItems` keeps its name and meaning but takes **parts**, not `(status === DONE | DECLINED)` tasks — so a
  partially delivered **open** task returns items. `pendingItems` stays what it is: the items with
  `disposition.state === "WAITING"`. That is what `prepared` means, so I10 is untouched.
- `pendingByLead` / `loadPending` select parts for every task of the lead, not only closed ones. Their `[WAVE 4]`
  comments come out with the change.
- `managerWorkOf` becomes: `making` = the open task's `REQUESTED` part kinds; `prepared` = lead-wide `WAITING` items.
  **`prepared` must span all tasks**, exactly as `loadPending` does today — an item from an older task does not stop
  waiting because a newer task exists.
- `overlapsTask(open, sent)` becomes `overlappingKinds(parts, sent, fulfils)` → the `REQUESTED` kinds the send covers
  that no named `fulfils` already accounts for (§2.8).
- **`PendingItem.by` / `.closedAt` now come from the part** (`resolvedBy` / `resolvedAt`), not from
  `DealTask.closedBy` / `closedAt`, and `returnedItems` sorts by the part's `resolvedAt`. Keep the field names so the
  card, `pendingSummary` and the list row are untouched; only the source moves. An `OPEN` task now contributes items
  and its `closedAt` is `NULL`, which is exactly why the sort key has to move with them.

### 2.6 The next step — exact rules

Shipped principles, unchanged:

| | Rule | Where |
|---|---|---|
| P1 | The step never stores a list of contents. `Lead.nextActionKind` is one category; the headline is derived | wave 5 §3.7 |
| P2 | `outstanding` is the grouped union of the three sources (§2.2) | `clientRequestState` |
| P3 | On an **unlocked** deal, only a step the app chose itself is re-derived (`isSystemStep`). A call, "Čakáme na klienta" and a custom step are the user's decision | wave 5 §6.4 |
| P4 | An explicitly submitted step always wins | wave 5 §6.4 |
| P5 | A locked step has `nextActionAt = NULL` and `nextActionMode = SCHEDULED` | wave 3 I8, §5.1 |

**Wave 4 adds one rule, and it needs one new stored value.**

> **P6 — while a task is OPEN the step is a pure function, not a stored decision:**
>
> ```
> lockedStep = defaultStep(outstanding, lead, { locked: true })  ??  { kind: task.fallbackKind, note: task.fallbackNote }
> ```
>
> It is recomputed on every event that changes `outstanding` (§2.6 table). The date stays `NULL` and the mode stays
> `SCHEDULED` (P5). The step is never **freely replanned** while locked, no status change rides along, and the deal
> stays in "Čakám na manažéra".

**Why a fallback had to be stored (R02-3).** `OTHER` maps to no client-facing content, so `defaultStep` returns `null`
whenever the only thing left is an "Iné" question — and then P6 had nothing to write. Two ordinary combinations broke:

1. **PRICE + OTHER; the manager returns the price, the rep sends it, OTHER is still being answered.** Outstanding is
   now empty, the task is still `OPEN`, so the step must stay locked — but the stored kind is still "Poslať cenu",
   which is now false. The rep cannot fix it, because the step is locked.
2. **An OTHER-only task on a deal whose step is "Zavolať v piatok"; the owner later adds PRICE.** `CALL` is not a
   system step, so P3 would forbid the re-derivation and the locked card would keep saying "Zavolať" while a price is
   being made. If the implementation overrode P3 anyway, withdrawing PRICE later could not restore Friday's call —
   nothing had stored it.

`DealTask.fallbackKind` / `fallbackNote` (§2.4) fix both. They are written **once, at ask time**, from the step the
deal had **before** `stepAfterTask` locked it, and they are never rewritten. Then:

- **`isSystemStep` does not guard P6.** While a task is `OPEN` the lock already prevents free replanning, and the
  fallback holds the user's own choice, so a deliberate CALL can safely be displaced by "Poslať cenu" and comes back
  when the send-bearing part is withdrawn, sent or answered. P3 keeps its full meaning on **unlocked** deals.
- **`setClientAsksAs` must adopt the same rule** (`lib/commands/requests.ts:103–118`). Today it re-derives a locked
  step only when `isSystemStep`; from wave 4 the locked branch drops that guard and falls back the same way. This is a
  deliberate change to code shipped on 2026-09-20 — without it the pencil and the task commands would compute two
  different locked steps for the same deal.
- **No date and no mode are stored in the fallback.** Wave 3 already throws the date away at lock time and sets the
  step due **today** at unlock (`unlockStep`), and a restored fallback is `SCHEDULED` for the same reason as every
  other locked step (P5, B3).

**The event table.** "re-derive" always means the P6 formula, applied only when the resulting **kind** differs from
the stored one, and always writing the planning row `… · 🔒 čaká na úlohu`:

| Event | `outstanding` | stored step | lock |
|---|---|---|---|
| ask, with 1–3 parts | + the part kinds | `stepAfterTask(...)`; the previous step is copied into `fallbackKind` / `fallbackNote` | locks, date `NULL` |
| a part is `DELIVERED` | unchanged — the content moves `making` → `prepared` | **unchanged** | stays |
| a part is `DECLINED` or `WITHDRAWN`, task stays open | − that content **unless the client also asked for it** | re-derive (P6) | stays |
| a part is added | + that content | re-derive (P6) | stays |
| a valid `OFFER_SENT` while the task is open | − what the client now received | re-derive (P6) | stays |
| an `OFFER_SENT` is crossed out while the task is open | + what reopened | re-derive (P6) — see R02-5 below | stays |
| a price told on a call / in an SMS while the task is open | − PRICE, if it satisfied the ask | re-derive (P6) | stays |
| the last `REQUESTED` part resolves → the task closes | as it stands | see below | unlocks |

**R02-5 — corrections: one rule, and it is not the one an earlier draft gave twice.** That draft said both "a
correction never touches the step" (B2) and "while the task is open the locked step is re-derived" (§2.10). Only one
can be implemented. **Decision: while a task is `OPEN`, `correctRecord` re-derives the locked step through the same
command-owned helper as a partial send.** The reasoning:

- on an **unlocked** deal the shipped rule stands untouched — a correction never replans a user's step, because the
  user can simply fix it (`app-workflow.md` §5a, `offerMutations.ts:267–287`);
- while **locked** the user *cannot* fix it, so leaving it stale has no repair path;
- and under P6 the locked step is a **function** of `(outstanding, fallback)`, not a decision anyone made. Letting a
  correction desynchronise a derived value would be arbitrary.

It changes only the kind and the note, keeps the date `NULL`, the mode `SCHEDULED` and the status untouched, and
writes the same planning row as every other P6 event. §2.10 and `w4StepLocked` say the same thing and nothing else.

**When the task closes — B3: keep using `unlockStep`, not `defaultStep`:**

- Today `markTaskDone` / `declineTask` call `unlockStep`, which sets **only** `nextActionAt = today` and leaves the
  kind, note and **mode** alone. Calling `defaultStep(outstanding, lead)` instead would also set
  `nextActionMode = IN_PROGRESS` for `SEND_DESIGN`, moving the deal out of "Na dnes" into "Rozpracované" the moment a
  task closes. That is a silent behaviour change and it collides with F2 in `wave-5-followups.md`, which is Michal's
  open decision. Wave 4 must not decide it by accident.
- So on close: the step is the P6 formula one last time (outstanding, else the fallback), then **`unlockStep`** — due
  today, mode as it was.
- something is `prepared` and unsent → the send step, due today. I10 (`requiredStepKinds`) gives the same answer, so
  the two never fight.
- nothing outstanding and nothing prepared → the **fallback**, due today. For a declined task that is the wave-3 D16
  behaviour ("the step it always was"), now stored explicitly instead of relying on the field not having moved.
- the rep withdrew the last part and nothing was ever delivered → today's **"Zrušiť + zmeniť"**: the rep may pick the
  next step in the same transaction, which wins over the fallback (P4).

**Why `defaultStep` can never contradict I10 here.** I10 requires `SEND_DESIGN` while a návrh item waits, and
`SEND_QUOTE` or `SEND_DESIGN` while a price item waits. A waiting item is in `prepared`, so its content is in
`outstanding`, so the derived dominant kind already satisfies I10 — and the fallback branch is only reached when
**nothing** is outstanding, i.e. when `requiredStepKinds` is `null`. The derivation is still followed by
`assertStepAllowed` at every existing call site, and a test asserts the property directly (`w4StepLocked`).

**B1 — the re-derivation must not live inside `recordOffer`'s `factOnly` branch.** `factOnly` today means *"do not
touch the step"* and it is passed from **four call sites with two different intentions**:

| Caller | `factOnly: true` because | What P6 must do |
|---|---|---|
| `recordOfferSentAs` while a task is open | the step is locked | **re-derive, locked** |
| `logFollowUpAs` with `keepLockedStep` (phone price, task open) | the step is locked | **re-derive, locked** |
| `logFollowUpAs` with `keepStep` (SMS price, **no task**) | the user chose to keep the step | **nothing** |
| `logFollowUpAs`, ordinary call with a phone price | the command itself sets the step a few lines later | **nothing** |

If P6 were implemented as "`factOnly` now re-derives the locked step", the SMS `keepStep` path would call the P6
formula on an **unlocked** deal and set `nextActionAt = NULL` — destroying the step's date on a deal with no task at
all, and breaking the `keepStep` rule shipped in the wave-5 R02 round. The plain call path would move the step before
the command computes it.

**Therefore:** the re-derivation is owned by the **command**, through one shared helper
`refreshLockedStep(tx, actor, lead, source)` that every locked writer calls — `recordOfferSentAs`, `logFollowUpAs`
(`keepLockedStep` only), `correctRecordAs`, `resolveTaskPartsAs`, `addTaskPartsAs`, `withdrawTaskPartsAs`,
`setClientAsksAs`. `factOnly` keeps its current meaning untouched. This is also what wave 5 §6.4 says: *the step
changes only inside a user command.*

**What the lock still forbids while a task is open** (Michal's point 8 — unchanged from wave 3 §5.1):

- no user-chosen step, no date, no mode change, no status change, no snooze, no close — unless the same save
  explicitly cancels the task (`cancelTask`) or withdraws the overlapping parts (`withdrawParts`);
- every contact is still recorded as a **fact**: "Naposledy" moves, the step does not.

### 2.7 Commands

All of them: access guard → `withLockTx` → lock order `Team → User → Lead` → `expectedRevision` → `runKeyed` with a
canonical `fp` → **exactly one revision bump** → exactly one keyed primary `Activity`; secondary rows in the same
transaction carry no key. Every terminal status and its task-level row come from **§2.4a**, never from the command's
name.

| Command | Who | Contract |
|---|---|---|
| `askManagerAs` **(changed)** | owner-rep (`deals.work` without `requests.resolve`), deal ACTIVE / SNOOZED, no open task | `contents`: **1–3 distinct** kinds → one `REQUESTED` part each (today: exactly one). Step from `stepAfterTask(contents, …, outstanding)` as today, and the deal's **previous** kind + note are copied into `fallbackKind` / `fallbackNote` (§2.6). `step` accepted only when `!fixed` (Iné-only) or equal to the derived kind. Primary row `TASK_CREATED`, `meta.contents` = the sorted kinds — **unchanged type** |
| `resolveTaskPartsAs` **(new; replaces `finishTaskAs` for HELP and absorbs `declineTaskAs`)** | the assignee, or any `requests.resolve` + `deals.manage` | `parts: [{ kind, deliver: {…} } \| { kind, decline: reason }]`, 1–3, **distinct kinds, explicitly named** — see R02-4 below. Each row is written conditionally (`updateMany where { taskId, kind, status: 'REQUESTED' }`); a count ≠ 1 is `STALE`. A delivered `PRICE` is also saved on the deal (`saveQuote`, unchanged rules); a delivered `DESIGN` revalidates the version under the lock (`checkDesignVersions`); a delivered `OTHER` needs an answer. Then recompute the status (§2.4a); if the task stays open, `refreshLockedStep`. Primary row `TASK_PART_DONE` when anything was delivered, else `TASK_PART_DECLINED`; `runKeyed` looks up **both** types |
| `finishAndSendAs` **(changed)** | resolver | As today, over the parts named in this call: deliver + `OFFER_SENT` with `fulfils` for exactly those items. **The follow-up call is planned only when this call closes the task *and* `outstandingOf(tx, lead.id)` is empty after the reconcile** — see R02-6. Otherwise the command derives the remaining send step, and while any part is still `REQUESTED` that step stays locked (`refreshLockedStep`) |
| `withdrawTaskPartsAs` **(new)** | **owner only** (wave-3 D5) | `{ taskId, kinds[], reason (required), step? }`. Only `REQUESTED` kinds; a `DELIVERED` part is **not** withdrawable — "Neposielam" (dismiss) is that path. `step` is accepted **only** when this withdrawal closes the task **and** nothing is outstanding afterwards (the "Zrušiť + zmeniť" case), where it wins over the fallback. Primary row `TASK_PART_WITHDRAWN` |
| `addTaskPartsAs` **(new)** | **owner only** | `{ taskId, kinds[], message (required) }`. Task must be `OPEN` and `type === "HELP"`. A kind that is `REQUESTED`, `DELIVERED` or `DECLINED` is refused; a `WITHDRAWN` kind returns to `REQUESTED` (§2.4). The message is the row's `note`, so the manager sees why — no separate `TASK_MESSAGE` row. Then `refreshLockedStep`. Primary row `TASK_PART_ADDED` |
| `cancelOpenTask` paths **(same callers, same input)** | owner; the manager on close / takeover / owner change / no owner | = withdraw every part still `REQUESTED` with that reason, then §2.4a decides the status and the row. `DELIVERED` items keep waiting (§2.10). Callers (`logFollowUpAs`, `recordOfferSentAs`, `changeStatusAs`, `markLostAs`, `ownerTransition`) **do not change shape** |
| `reassignTaskAs` | resolver | Unchanged. Parts move with the task; each delivered part keeps its own deliverer |
| `dismissResultsAs` | owner (manager on an ownerless deal) | Unchanged shape; `ItemRef` may carry `part` for a `DECLINED` item (§2.4), and the dismissal is now what makes an item `DISMISSED` in the projection (§2.5) |

**R02-4 — the manager must *select* what he is returning; a filled field is not a decision.** The dialog pre-fills the
price from `Lead.price` / `Lead.priceNote` (`FinishTaskDialog.tsx:44–45`) and today submits it whenever the task wants
`PRICE` (`:73–83`). Under an earlier "whatever is filled in is delivered" rule, a manager who opens a PRICE + DESIGN
task, picks Variant A and saves would silently **deliver a stale €700 price**, freeze it as an immutable part result
(Q11) and possibly close the whole task. The rep would then be told that price came back from the manager, and may
send it.

So selection and values are separate, on both sides:

- each `REQUESTED` part gets an explicit **"Odovzdať teraz"** toggle; values stay pre-filled and are only submitted
  for toggled parts;
- the button count ("Odoslať hotové (2 z 3)") and the "what stays open" line read the **toggles**, never field
  emptiness;
- the server takes the explicit operations list above and **refuses values for a kind that is not named**
  (`FORBIDDEN`, "Neplatné údaje.") — the same posture as `buildTaskResult` today, which already refuses a price for a
  task that did not ask for one;
- "Poslal som to klientovi sám" uses the same selected subset.

**R02-6 — "nothing else pending" means the whole wave-5 outstanding set, not just task items.** Today
`finishAndSendAs` computes `otherPending` from returned **task items** only (`lib/commands/tasks.ts:300–302`), and
`recordOffer`'s follow-up branch asserts only I10 (`offerMutations.ts:247–248`). Neither looks at `LeadRequest`. So a
manager who finishes PRICE + DESIGN and sends them himself schedules "Zavolať, či prišlo" even when the client is
still owed INFO and PRICELIST — the drift wave 5 was built to remove. Wave 4 states the invariant and enforces it on
the **server**, not in the dialog: *after recording the offer and reconciling the requests, a `CALL` follow-up is
allowed only when the task will be closed **and** `outstandingOf(tx, lead.id)` is empty.* This is a real gap in
shipped code, so it is also listed as prerequisite **P1** (§7).

Details that are easy to get wrong, found in the 2026-09-20 reviews:

- **B6 — `HANDOVER` tasks have no parts**, so `addTaskPartsAs`, `withdrawTaskPartsAs` and `resolveTaskPartsAs` must
  refuse `type !== "HELP"` explicitly, the way `finishTaskAs` already refuses it ("Odovzdanie sa prijíma cez
  „Preberám""). Do not rely on "it has no parts anyway".
- **B7 — the fingerprint must canonicalise money as a string.** `finishFp` already does `moneyToString(amount)`;
  without it a replay of `1285` vs `1285.00` produces two different `fp` values and a double click becomes an
  `IDEMPOTENCY_CONFLICT`. Sort the parts by `kind`, trim every note and reason, and put the whole thing through
  `canonical()` — the same shape as today's `finishFp`.
- **B8 — `resolvedById` is always the acting user** (also stated in §2.4, where the contradicting schema comment has
  been removed).
- **B5 — the overlap check must not trust `fulfils` blindly.** `overlappingKinds` runs **before** `validateFulfils`,
  so a client could name a nonexistent item to dodge the question. Count a `fulfils` entry only when it names an
  actually `DELIVERED`, still-`WAITING` part **of this task**; anything else is ignored for the overlap decision and
  then fails in `validateFulfils` anyway (`STALE`, whole transaction rolled back).

### 2.8 Sending while the task is open — the case wave 4 exists for

This is Michal's point 5, and the only place where the server asks a question.

| What the send contains | Server |
|---|---|
| only contents no `REQUESTED` part covers — including a `DELIVERED` part's item named in `fulfils` | **no question.** The send is recorded, no follow-up call is planned (`factOnly`), and the **command** re-derives the locked step (P6 / B1 — never `recordOffer` itself). The *dialog* confirms (below) |
| a content whose part is still `REQUESTED`, not covered by a named `fulfils` | `TASK_OVERLAP` unless `overlap` is given |
| `overlap: "KEEP_OPEN"` | the send is recorded, the part stays `REQUESTED`, the task stays open |
| `overlap: "WITHDRAW_PARTS"` + `withdrawParts: { taskId, kinds[], reason }` | exactly those `REQUESTED` kinds are withdrawn (owner only); the task closes if nothing is left, and then the send is no longer `factOnly` |

- `OVERLAP_CHOICES` becomes `["KEEP_OPEN", "WITHDRAW_PARTS"]`. `CANCEL_TASK` disappears **from the overlap choice
  only**; the separate `cancelTask` input (snooze / close / replan) is untouched. On a one-part task
  `WITHDRAW_PARTS` behaves exactly like today's "Už to netreba – zrušiť úlohu".
- The phone-price overlap check in `logFollowUpAs` (`open.contents.includes("PRICE")`) becomes "a `REQUESTED` `PRICE`
  part exists".
- **Sending the price can never close an open návrh part**, and vice versa.

**The "are you sure" dialog** (Michal's point 7) lives in "Čo sme poslali" and appears whenever the task stays open
after the save. It is a confirmation, not a server flag — the server already has the exact `contents` and `fulfils`:

```
Úloha pre Nikolasa ostáva otvorená
  Posielaš teraz:      ◆ Cena 1 285 €
  Nikolas ešte robí:   Návrh
  Tvoj krok ostane zamknutý:  Poslať návrh
  [ Áno, poslať len cenu ]   [ Späť ]
```

No follow-up call is offered while a task is open (the step is locked) — unchanged from wave 3.

### 2.9 What the users see

**Task card on the deal** (same card as today, parts listed under the request; both roles see the same states):

```
Úloha pre manažéra                              ⏳ čaká na manažéra · Nikolas
  „e-shop, 200 produktov, chcú aj logo"         Jana → Nikolas · 19. 9.

  ✓ Cena 1 285 €        Nikolas · 19. 9.   · poslané klientovi 20. 9.
  ✓ Návrh · 1 z 2       Nikolas · 20. 9.   · Variant A poslaný 20. 9. · ⊘ Variant B neposlaný
  ○ Iné                 robí sa                                                          ⋯

  Po vybavení: Poslať návrh
  [Hotovo…]  [Presunúť…]  [Zamietnuť…]                 ← manager
  [+ Pridať]  [Zrušiť úlohu…]                          ← owner-rep
```

- **One row per part, with its compact mark (§2.3); the items are shown under it when the part has more than one, or
  when anything was dismissed** (R02-2). A `DESIGN` part that returned Variant A and Variant B is one row saying
  `✓ 1 z 2`, expandable to the two item lines with their own dispositions. Never `✓ Návrh poslaný` when only one of
  them left, and never `◆ pripravené` when one is already at the client. **Q12** asks Michal to confirm this
  compact-row-plus-detail shape rather than two top-level rows per návrh.
- `⋯` on a part that is **being made**: owner → **"Už netreba…"** (reason), manager → **"Toto nerobím…"** (reason).
  Declined and withdrawn parts have no `⋯`. A `WAITING` item keeps today's "Poslať klientovi…" / "Neposielam…" /
  "Beriem na vedomie"; a `SENT` or `DISMISSED` item has no actions, only its date and reason.
- **"+ Pridať"** (owner) offers only the kinds not in play, and requires a message. It shows in the thread:
  *"Jana pridala: Návrh — klient volal, chce aj návrh."*
- **"Zrušiť úlohu…"** (owner) = withdraw every part still being made, one reason. If something was already delivered
  the badge afterwards is **"Vybavené"** with the per-part marks, not "Zrušené" (§2.4a).
- **Manager's "Hotovo" dialog — every part has its own "Odovzdať teraz" toggle** (R02-4). Pre-filled values are a
  convenience, never a decision:

  ```
  Hotovo — Cena + Návrh + Iné
    ☐ Cena      [ 1 285 ] €   rozpis …        ← prefilled from the deal; NOT returned unless ticked
    ☑ Návrh     [ Variant A (v2) ▾ ]
    ☐ Iné       [ odpoveď … ]
    ─────────
    [Odovzdať vybrané (1 z 3)]   Cena a Iné ostávajú otvorené — dokončíš ich neskôr.
  ```

  The button count and the "what stays open" line come from the **toggles**. Nothing ticked → the button is disabled.
  "Poslal som to klientovi sám" uses the same ticked subset.
- **"Požiadať manažéra"**: the three content tiles become **toggles** (one or more) instead of a radio group. The
  summary line is unchanged and already correct — it reads the shipped `stepAfterTask` over the whole outstanding set:
  *"Keď Nikolas dodá, tvoj krok bude **Poslať návrh + cenu**"*. "Zmeniť" stays available only for an Iné-only task,
  and what the rep picks there is also what lands in `fallbackKind` / `fallbackNote`.
- **While only "Iné" is left**, the locked card says *"Čaká sa na Nikolasa (Iné)"* and shows the fallback underneath as
  *"Po vybavení: Zavolať v piatok"* — it never keeps advertising send work that is already done (R02-3).
- **List row / manager inbox**: the task summary shows progress, e.g. `Cena ✓ · Návrh robí sa` and `1 z 2`. The
  manager's "Pre mňa" row names the kinds still `REQUESTED` — what is left for **him**.
- **The step headline and the ⚠ warning are unchanged code.** They already say "Poslať návrh + cenu" and drop what
  went out. Michal's *"the step also needs to show that some parts were fulfilled"* is satisfied by the shipped
  checklist (`outstandingLabel`: *pripravené — cena 1 285 €* / *robí Nikolas* / *treba poslať*). **Wave 4 adds no new
  checklist concept.**

### 2.10 Edge cases and races

- **A delivered part survives everything.** Its item waits whatever the task's status until an `OFFER_SENT` fulfils it
  or a `TASK_RESULT_DISMISSED` dismisses it. In practice that status is `OPEN` or `DONE`: §2.4a makes `CANCELLED` and
  `DECLINED` unreachable once any part was delivered, which is why an earlier draft's "a delivered part survives a
  `CANCELLED` task" was removed (R02-1). Deal close: the open parts are withdrawn ("obchod uzavretý"), then
  `dismissAllPending` dismisses everything waiting — so the order no longer matters. Takeover, move to nobody, owner
  change, bulk transfer: task-level behaviour as wave 3 (`ownerTransition`) with §2.4a deciding the final status;
  delivered parts wait for whoever owns the deal next.
- **A manager never ends up holding a task for himself** (Michal asked, 2026-09-20 — it cannot happen and needs no new
  rule). `assertEligibleAssignee` refuses an assignee who is the deal's owner; `ownerTransition` ends the task in the
  same transaction when the new owner is a resolver (`HELP` → withdraw the requested parts, "klienta prevzal X";
  `HANDOVER` → `DONE` = accepted); I7 forbids an open task whose assignee is the current owner; D7 says a manager on
  his own deal simply has the step. **Wave 4 adds only this:** that cancel withdraws every part still `REQUESTED`
  with the same system reason and lets §2.4a name the final status,
  and parts he had already **delivered** keep waiting — so a manager who finished the návrh before taking the client
  over can still send it himself. Covered by `w4Survives`.
- **Only a `REQUESTED` part can be withdrawn or declined.** A delivered one is "Neposielam" (dismiss with a reason).
- **Crossing out the send that consumed a part** makes the item `WAITING` again (wave 3 §6.13, unchanged) and reopens
  the client's request if nothing else satisfies it (wave 5 §6.7). While the task is open, the locked step is
  re-derived by the same `refreshLockedStep` helper as a partial send — the single correction rule decided in §2.6
  (R02-5). On an unlocked deal a correction still never touches the step.
- **Manager delivers a part while the owner withdraws it** — both are under the `Lead` lock; the conditional
  `updateMany` makes one win. The loser gets `STALE`; after a won delivery the withdrawal says *"už dodané — ak to
  neposielaš, daj Neposielam"*.
- **Two managers resolve two different parts at the same time.** Both writes are legal on different rows, but each
  bumps the revision, so the second one's `expectedRevision` is stale → `STALE`, refresh, save again. Correct and
  accepted; a test asserts that nothing is half-written.
- **Adding a part while the manager closes the last one** → the task is no longer `OPEN` → `STALE`.
- **Re-adding a `WITHDRAWN` kind racing a whole-task cancel** → `STALE`.
- **HANDOVER tasks have no parts** and do not change.
- **A closed deal never has an open task** (I7), so no part is ever `REQUESTED` on a closed deal.
- **B4 — one content can be *pripravené* and *robí sa* at the same time, and the label hides it.** `prepared` spans
  every task of the lead, `making` is the open task's parts. So: task 1 delivered a price, nobody sent it, the rep
  opens task 2 asking for a price again → `PRICE` is in both lists. `outstandingLabel` returns the first match and
  shows only *"pripravené — cena 1 285 €"*, hiding that a new price is being made. **This is reachable today**
  (nothing stops asking again while an item waits), wave 4 only makes it more likely. Smallest honest fix:
  `outstandingLabel` says *"pripravené — cena 1 285 € · nová sa robí"* when both are set. One pure function, one
  test; no data change. Not a blocker for Part A, but do it in the same wave rather than leaving a label that lies.

### 2.11 What wave 4 does not change

Say this back to any reviewer who reports it:

- `Lead.nextActionKind` stays one category; there is still no combined enum value.
- `isStepLocked` / `STEP_LOCKED_SQL` are untouched, and there is no new TypeScript↔SQL twin.
- `clientRequestState`'s signature, `ManagerWork`, `stepView`, `coveredContents`, `sendCompletesStep`,
  `reconcileRequests` — untouched. A task operation creates no receipt, so it never calls `reconcileRequests`; only
  `finishAndSendAs`'s `recordOffer` does, as today.

**Three shipped things wave 4 *does* change, deliberately** (so a reviewer does not report them as regressions):
`defaultStep`'s locked branch is fixed to force `SCHEDULED` (P0); `setClientAsksAs` drops its `isSystemStep` guard on
a **locked** deal so the pencil and the task commands agree on the locked step (§2.6); and `recordOffer` /
`finishAndSendAs` gain the outstanding-based follow-up gate (P1).
- `OFFER_SENT.meta.fulfils`, `TASK_RESULT_DISMISSED.meta.items` and `itemKey` keep their shape (the `DECLINED`-only
  `part` field is additive).
- The client-request vocabulary (`RequestContent`) and the manager-work vocabulary (`DealTaskContent`) stay separate.
  A part is never created because the client asked for something; the rep always creates the task.
- Delivering a part means **prepared**, never **received**. Only a valid `OFFER_SENT` means received.
- One open task per deal; the manager never has a task on his own deal; telesales never create tasks.

### 2.12 Accepted limitation — a separate call while waiting (Michal, 2026-09-19)

> **Not a defect. Reviews must not report it.** One deal has one next step. While a task is open that step is locked,
> so the rep cannot *plan* a separate call in the meantime (e.g. price sent today, call on Thursday whether it
> arrived, návrh next week). She can still **record** any call. Michal chose to keep the limit; nothing is built.

Wave 4 makes it milder rather than worse: the ready part can now be sent while the task runs, so the deal is not stuck
on work that is already finished. Option (c) of the v1 draft ("Medzitým zavolať" — `DealTask.checkInAt` /
`checkInNote`, one optional date inside the lock, ~4–6 h) stays on record, unplanned.

### 2.13 Tests

Pure (`lib/domain/tasks.ts`), run from the existing check scripts:

- `taskPartState` matrix: every part status × every item disposition; `nextStatus` for every combination, asserted to
  be **order-independent** (the same set of parts always yields the same status, whichever command resolved last);
  `making` / `prepared` outputs; the compact `mark` for each row of the §2.3 table.
- `itemKey` for `DECLINED` with and without `part`; `sortedItems` stability.
- The P6 property: for every outstanding set, the locked-step formula returns `nextActionAt === null` **and**
  `nextActionMode === "SCHEDULED"`, its kind satisfies `requiredStepKinds`, and it falls back to
  `fallbackKind` exactly when `defaultStep` returns `null`.

Server (`prisma/backfill/check-concurrency.ts`), new groups:

| Group | Cases |
|---|---|
| `w4Ask` | ask with 1, 2, 3 kinds; duplicates refused; the derived step per combination (návrh wins, Iné-only keeps or chooses); a client ask for a návrh makes a price-only task lock on "Poslať návrh"; the deal's previous kind + note land in `fallbackKind` / `fallbackNote` |
| `w4Partial` | deliver the price → task `OPEN`, step locked and **unchanged**, price *pripravené*; send it → `SENT`, task still open, step still locked and still "Poslať návrh"; deliver the návrh → task `DONE`, unlocked today, návrh waiting; send → "Zavolať, či prišlo". **Both orders**, and all at once. Iné answered first |
| `w4Selection` (R02-4) | a PRICE + DESIGN task with a **pre-existing deal price**: delivering only DESIGN leaves PRICE `REQUESTED` and writes **no** price result and no `saveQuote`; a `deliver` payload for a kind that was not named is `FORBIDDEN`; the same for "Poslal som to sám" |
| `w4StepLocked` | the locked kind follows `outstanding` through deliver / decline / withdraw / add / send / correction, with `nextActionAt === null` and mode `SCHEDULED` after **every** one; no status change; the deal stays in "Čakám na manažéra". **B1:** an SMS with a price on a deal with **no task** (`keepStep`) leaves kind, date and mode untouched, and an ordinary call with a phone price still gets its step from the command. **R02-5:** crossing out a send while locked **does** re-derive; the same correction on an unlocked deal changes nothing. **B3:** closing the task leaves `nextActionMode` as it was (a `SEND_DESIGN` step does **not** silently become `IN_PROGRESS`) |
| `w4Fallback` (R02-3) | OTHER-only task on a deliberate "Zavolať v piatok" → the card shows the fallback; add PRICE → locked step becomes "Poslať cenu" although CALL is not a system step; withdraw PRICE → Friday's call is restored; PRICE + OTHER, send the price → outstanding empty, the locked step becomes the fallback and never keeps saying "Poslať cenu"; close the task → the fallback is due today; a correction of that price send puts "Poslať cenu" back |
| `w4Terminal` (R02-1) | every row of §2.4a: deliver-all, deliver+decline in one command, decline after a delivery (**status `DONE`, secondary row `TASK_DONE`, not `TASK_DECLINED`**), withdraw-last with and without an earlier delivery, deal close, takeover, owner removed, bulk transfer, accepted HANDOVER — asserting status, primary keyed type and the exact secondary rows |
| `w4Items` (R02-2) | a DESIGN part returning two návrhy: both waiting · one sent, one waiting · one sent, one dismissed with a reason · both sent in different emails · a correction of one of those sends · a dismissed PRICE part. Each case asserts the item dispositions, the part's compact mark, and that a dismissed item is **never** rendered as a client receipt |
| `w4Decline` | Michal's two cases (§2.1 point 5 and the "price too difficult" variant); decline all with nothing delivered → `DECLINED`; two declined parts = two acknowledgement items, dismissing one leaves the other |
| `w4Withdraw` | withdraw one part (step re-derived) — and **not** re-derived when the client also asked for that content; withdraw the last part with and without a delivered part; `step` accepted only in the closing case; a delivered part cannot be withdrawn; non-owner refused |
| `w4Add` | add a part; re-add a `WITHDRAWN` kind; add a `DELIVERED` / `DECLINED` / `REQUESTED` kind refused; add on a closed task or a `HANDOVER` refused (B6); the message is required; non-owner refused |
| `w4SendWhileOpen` | sending a delivered part asks nothing and keeps the rest open; sending a content whose part is still `REQUESTED` without `overlap` → `TASK_OVERLAP`; `KEEP_OPEN`; `WITHDRAW_PARTS` withdraws exactly those kinds and leaves the others; a `fulfils` entry naming a non-delivered item does not dodge the overlap question (B5); no follow-up call is ever planned while the task is open |
| `w4FollowUpGate` (R02-6 / P1) | client asked INFO + PRICELIST + PRICE + DESIGN; the manager finishes PRICE + DESIGN with "Poslal som to sám" → the task closes but **no** "Zavolať, či prišlo" is planned, the step becomes "Poslať info + cenník"; the same send including INFO + PRICELIST **does** plan the call; an older delivered task item still waiting also blocks it; a hand-crafted `followUp: true` with outstanding work is refused server-side |
| `w4Survives` | partial price, then each of: decline of the rest, owner cancel, close WON / LOST, move to nobody, takeover, owner change, bulk transfer, reassign → the price is still waiting each time and the step still says "Poslať…" |
| `w4Race` | withdraw vs. deliver; two parts resolved in parallel; replay (parallel and repeated) and changed-payload conflict for **every** new command, including the two-type `runKeyed` lookup of `resolveTaskPartsAs`; non-resolver resolve refused |
| `w4Conversion` | the S-13a conversion over a fixture of one task per (type × status × contents) shape: part counts, result slices, `DECLINED` dismissal rewrite, duplicate `contents` aborts (B9), rerun is a no-op, and the **zero-drift verification** of §6.3 catches a task changed after an earlier conversion |
| `w4PriceHistory` (D5) | every `saveQuote` path writes exactly one `PRICE_CHANGED` with the right `via`; a **breakdown-only** edit writes one too; an unchanged save writes none; the row never appears in "Naposledy" (`LAST_TOUCH_TYPES`) and is refused by `correctRecordAs`; the rep (non-manager) sees it in the detail; one revision bump per save, unchanged |

Existing groups that must be re-run and are expected to change: every `w3*` task group, `w5ManagerWork`, `w5Pencil`,
`w5CloseReopen`, `w1TodayParity`, and the `STEP_LOCKED_SQL` parity test (expected **unchanged** — that is the
assertion).

## 3. Part B — notes (D-07, accepted 2026-09-17)

### 3.1 The problem today (verified in code)

| Where a note lives | Who writes it | Problem |
|---|---|---|
| `Lead.note` (Údaje, calls InfoDrawer) | the scout; then **the first call replaces it** (`logCallAs`); any contact edit overwrites it | **B-09** — the scout's observation disappears; nobody knows whose note it is |
| `Activity.note` of each contact | whoever records it | buried in the history |
| `nextActionNote`, `callbackNote`, `priceNote` | step / callback / price | field annotations — they stay |
| `DealTask.text` + task messages | rep ↔ manager | belongs to one task, not to the client |
| handover note | rep handing over | what they ordered — hidden in a closed task |

### 3.2 The accepted design

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
in the action-sheet header** (calls and deals), and the calls InfoDrawer instead of today's single `Lead.note`. No
separate note board yet.

### 3.3 The notes contract (Q5) — rewritten after review R02 (findings 8 and 9)

The seven-line sketch this section used to hold was not a contract: it said "INTERNAL notes only for managers" without
saying whether that restricts **writing or reading**, and it let a manager edit anyone's note while the model stores
only the original `authorId` / `authorRole` — so a manager could rewrite a scout's sentence and the card would still
attribute it to the scout. That is the exact failure `LeadNote` exists to end. The contract below replaces it.

| # | Rule |
|---|---|
| 1 | **INTERNAL means manager-only to create *and* read.** The visibility predicate lives in the **query** — every list, count, detail and action-sheet-header read applies it before returning rows. UI hiding is not access control (`code-standards` §4), and the deal detail already hands a rep every BUSINESS row in scope, so a note filtered only in a component would leak |
| 2 | **Bodies are immutable.** The author corrects a note by adding another one; nobody rewrites what someone else wrote. If editing is ever required, it needs `updatedById` **plus** an append-only edit history (previous body, actor, time) and the card must render "upravil X" — never silent re-attribution |
| 3 | **Soft delete records who and why:** `deletedById` and an optional reason (or an audit activity). "Stays in history" is meaningless without them. Deleted notes are visible to managers only |
| 4 | The scout's note on adding a contact = the first `LeadNote` (GENERAL, pinned), written **once** in the contact-creation transaction — see §3.4 |
| 5 | The positive first call's note = a FOR_CALL note (the handover to whoever continues); other call notes stay history |
| 6 | On deals, "Čo povedali" stays history; a separate "+ Poznámka" adds a `LeadNote` |
| 7 | Author and manager may pin; the sheet header shows at most 3 pinned, then "+n" |
| 8 | Tests exercise SCOUT / TELESALES / SALES_REP / MANAGER access **directly** — list, counts, detail, pinned header — including a role change made after the note was written |

### 3.4 `Lead.note` — what old rows may honestly be called (R02-9)

The old plan displayed every surviving `Lead.note` as read-only **"Poznámka pri pridaní kontaktu"**. That label is
knowingly false: §3.1 of this file documents that the field is overwritten by the first call and by every later
contact edit (`lib/commands/calls.ts`, `lib/domain/dealMutations.ts`, `lib/actions/contacts`). A scout's
"web občas nejde" may long since have become "majiteľ chce modrú stránku". Inventing provenance is worse than showing
none.

- **Existing non-empty values are shown as "Staršia poznámka (autor a pôvod neznámy)"**, never as an intake note.
- **From the cutover, new scout input is written once, canonically, as a GENERAL `LeadNote`** in the same contact
  creation transaction. `Lead.note` is not written with it — otherwise the same sentence renders twice.
- **Every later writer of `Lead.note` stops.** Inventory and change them together: contact create / edit
  (`lib/actions/contacts/index.ts`), the first call's note (`lib/commands/calls.ts`), and the deal contact update
  (`lib/domain/dealMutations.ts`). Making the field read-only without that inventory would leave a silent writer.
- **The column itself is left frozen for legacy display.** Backfilling it into `LeadNote` would need an author, and
  there is none — the schema would have to allow `authorId = null` plus an explicit legacy origin. Not worth it for a
  field whose content is already untrustworthy; it stays visible and clearly labelled instead.

This does not block Part A. It **does** block Part B: Q5 is now "confirm §3.3 and §3.4", not the old seven lines.

## 4. Part C — order note for the build (D-08 step 3)

When the manager accepts a handover (or takes the client over), the rep's handover text becomes a **pinned FOR_BUILD
note** on the deal, authored by the rep — what they ordered stays visible after the task is closed. Handover chips stay;
proposed additions "dohodnutá cena" and "doména". It is a copy of what the rep wrote, not an automatic task (wave-3 D9).
Later the WON step (BL-09) and the developer (BL-04) read these notes.

---

## 5. Part D — wave-3 leftovers

| # | Leftover | Proposal |
|---|---|---|
| D1 | In "Čo sme poslali", when returned items stay unsent, the kept "Poslať…" step's date and note cannot be edited there | show the kept step editable in the same dialog |
| D2 | Reopen always sets "Zavolať" today | **partly solved by wave 5** (reopen uses the outstanding send step). What is left is the free choice in the reopen confirmation |
| D3 | A manager cannot cancel + replan a rep's task (only by closing) | keep, unless it annoys in practice |
| D4 | Pill counts run one query per pill (13 per load) | measure; optimise only if slow |
| **D5** | **The rep cannot see that the price changed** (Michal, 2026-09-20 — new, see §5.1) | a `PRICE_CHANGED` business row + an optional reason + a short history on the price card |

### 5.1 D5 — price history the rep can see (**accepted, Michal 2026-09-20**)

**What is wrong today** (verified in code, not designed away):

- `saveQuote` (`lib/domain/dealMutations.ts:185`) logs a price change as `category: AUDIT`, type `CONTACT_UPDATED`.
  `getDealDetail` gives non-managers **business rows only**, so the **deal's own rep never sees it**. She opens the
  deal, it says 1 385 €, and nothing tells her it was 1 285 € yesterday or who changed it.
- The row is written **only when the amount changes**. A breakdown-only edit (`priceNote`) is lost silently.
- There is no reason, so the line reads "Cena: 1285 € → 1385 €" with no story.

The **client-facing** half is already correct and is not in scope: each valid `OFFER_SENT` snapshots the amount the
client received, the card warns "Aktuálna cena sa líši od poslanej", and the sheet header says which price they saw.
D5 is the **internal** half only.

**Proposal.** No new table — `Activity` is already the append-oriented history and `Lead.price` is genuinely one
current value (`database-map.md`). A price ledger would be a second truth to keep in sync.

- **S-15** `ActivityType += PRICE_CHANGED` (additive enum value). `category: BUSINESS` so the rep sees it.
  `meta = { from: { amount, note }, to: { amount, note }, reason? }` — the breakdown is included, so a breakdown-only
  edit is recorded too. It replaces today's `CONTACT_UPDATED` price line; old rows stay readable as history.
- **`PRICE_CHANGED` is not a client contact**: it never moves "Naposledy" (it is not in `LAST_TOUCH_TYPES`) and it is
  not correctable (`CORRECTABLE_TYPES` unchanged) — it is a log of an internal edit, not a claim about the client.
- **An optional short reason** on the price popup ("pridali sme EN jazyk", "klient chce menej podstránok"). Optional,
  because a typo fix does not deserve a form.
- **Every writer gets it for free.** All four paths already go through `saveQuote`: the rep's price popup, the
  manager's price popup (`saveQuoteAs`), a delivered `PRICE` part, and a send whose price differs from the deal's.
  The last two carry an automatic reason ("z úlohy pre manažéra", "pri odoslaní klientovi"), so the list reads as a
  story rather than a diff log.
- **On the "Cena & ponuky" card**: the last few changes under the current price, interleaved with the send snapshots —
  *žiadaná 1 285 → poslaná klientovi 19. 9. → zmenená na 1 385 (pridali EN) → ešte neodišla*.

**Why this also settles Q11.** Editing the live price today silently loses the old number, which is exactly why an
"Opraviť, čo som odovzdal" button on a delivered part feels tempting. With D5 nothing is lost, so the delivered
result can stay immutable without costing anyone anything.

Size: ~0.5 day. It does not depend on Part A and Part A does not depend on it.

**Review notes (2026-09-20) — things that must be right or D5 becomes noise:**

- **The same user action must not produce two rows that say the same thing.** `saveQuote` is called from inside
  `recordOffer` (a send carrying a different price) and from a delivered `PRICE` part. Without care the history reads
  *"Cena: 1 285 € → 1 385 €"* immediately followed by *"Poslali sme: cena 1 385 €"*, or by *"Vybavené: cena 1 385 €"*.
  **Fix:** `meta.via = "EDIT" | "TASK" | "SEND"`. `EDIT` (the price popup) renders as its own history line; `TASK` and
  `SEND` are written but **collapsed into the row that already tells the story** and shown only in the price card's
  own list. One row per fact, one line per user action.
- **The write condition has to widen.** `saveQuote` writes its audit line only `if (oldPrice !== input.price)`, so a
  breakdown-only edit is invisible — which is half of what D5 is fixing. It becomes
  `oldPrice !== price || (lead.priceNote ?? null) !== priceNote`.
- **`PRICE_CHANGED` is not a client contact and not correctable.** It must stay out of `LAST_TOUCH_TYPES` (so it never
  moves "Naposledy") and out of `CORRECTABLE_TYPES` (crossing out an internal edit means nothing — the fix is another
  edit). Both are whitelists, so a new value is excluded by default; assert it in a test rather than trusting that.
- **`reason` is trimmed, optional, max 500** (`TASK_REASON_MAX`), and it is **never required** — a typo fix does not
  deserve a form. It is only offered on the price popup (`via: "EDIT"`); the `TASK` and `SEND` rows carry a fixed
  automatic text.
- **Old rows stay as they are.** Price changes recorded before D5 are `CONTACT_UPDATED` audit rows with the text
  "Cena: … → …". They are not migrated and not re-parsed; the card simply starts at the first `PRICE_CHANGED`. Say so
  in `database-map.md`, or someone will later read the gap as data loss.
- **Making it `BUSINESS` is the whole point and the only risk.** It is what lets the rep see it
  (`getDealDetail` gives non-managers business rows only) — and it is also what puts it in her History card forever.
  Keep the line short and factual, and do not let the `TASK` / `SEND` variants double up (first bullet).

---

## 6. Schema and the test-data conversion

### 6.1 Ledger entries

| id | Change | Part | When | Toward production |
|---|---|---|---|---|
| S-13a | `DealTaskPart` + enum `DealTaskPartStatus` + `DealTask.fallbackKind` / `fallbackNote` (R02-3) | A | **before** any Part A code | additive (production has no task tables) |
| S-14 | `ActivityType += TASK_PART_ADDED, TASK_PART_DONE, TASK_PART_DECLINED, TASK_PART_WITHDRAWN` | A | **before** any Part A code | additive (enum values) |
| S-13b | drop `DealTask.contents`, `DealTask.result` on test | A | **after** the Part A code is switched over and verified | additive toward production (it never had them) |
| S-02 | `LeadNote` + enums `NoteStage`, `LeadNoteKind` | B, C | before Part B | additive |
| S-15 | `ActivityType += PRICE_CHANGED` (§5.1) | D5 | before the D5 code | additive (enum value) |

Procedure for each, without exception (`code-standards` §6): proposal here → confirm the `DATABASE_URL` endpoint is the
test branch → review the generated SQL → apply → `npx prisma db push` reports **"already in sync"** →
`npx prisma generate` → record the **actual verified** delta in `context/domain/db-changes.md`. **Never
`--accept-data-loss`, never `migrate dev`, never `--force-reset`** — not even on test (Michal's standing rule).

### 6.2 Why the drop is a separate, later step

"Schema before code" (R03-6) is about **adding**. A `DROP COLUMN` must land **after** the last reader is gone, or the
running code breaks. So: S-13a and S-14 first, then all of Part A, then the full check pass, and only then S-13b — with
its own reviewed SQL through `prisma migrate diff` + `prisma db execute`, not through a `db push` that offers to drop
data.

### 6.3 Converting the test tasks, and the cutover (R02-7)

**The danger is not the conversion, it is the gap after it.** S-13a lands days before the new readers do, and the
running app keeps writing only `DealTask.contents` / `result`. A task Michal creates or the manager finishes in that
window has no part rows, so at cutover the new reader sees no delivered part — and S-13b then drops the only
structured copy of it. Real test evidence would disappear while the fixtures still look perfect.

**Until the code cutover, `DealTaskPart` is a pure derivation, not a source of truth.** Nothing reads it and nothing
but the conversion writes it. That is what makes the fix simple: the conversion **deletes every part row and
re-inserts from the parents**, so it is exactly reproducible and can be re-run as often as needed with no drift. After
the cutover it becomes the source of truth and is never re-derived again.

**The cutover, in order:**

1. **S-13a** adds `DealTaskPart`, `DealTaskPartStatus` and the two `DealTask` fallback columns. Run the conversion once
   so the fixtures and the `w4Conversion` group have data.
2. Implement the domain, the reads and the commands (§9 steps 2–6). The old writers stay live; part rows may go stale
   and that is expected.
3. **Immediately before switching the reads:** stop task writes (tell Michal; there is one user), re-run the
   conversion in **one transaction**, then verify **zero drift** — every `HELP` task has exactly the expected parts,
   every `DELIVERED` part's result equals the parent's slice, and no part disagrees with its parent. Abort on any
   difference.
4. Switch the code, run the full check pass (`code-standards` §7) and the human click-through.
5. **A second zero-drift verification**, now read-only — the new writers must produce exactly what the derivation
   would have.
6. Only then **S-13b** drops `DealTask.contents` and `DealTask.result`.

**Production never runs any of this.** It has no task tables at all, so it receives the final parent + parts schema
directly, in one additive step, and the test-data conversion is not part of the rollout.

The conversion itself, reviewed SQL, dry-run first, aborting on ambiguity:

1. For every `DealTask` with `type = 'HELP'`, `unnest(contents)` → one `DealTaskPart` per kind.
   `addedById` = `requestedById`, `addedAt` = `createdAt`.
2. Status and result per source task:

   | task | part | `result` | `resolvedBy` / `resolvedAt` |
   |---|---|---|---|
   | `OPEN` | `REQUESTED` | — | — |
   | `DONE` | `DELIVERED` | the slice of `result` for that kind | `closedById` / `closedAt` |
   | `DECLINED` | `DECLINED`, `reason` = `closeReason` | — | `closedById` / `closedAt` |
   | `CANCELLED` | `WITHDRAWN`, `reason` = `closeReason` | — | `closedById` / `closedAt` |

3. `HANDOVER` tasks get no parts. `fallbackKind` / `fallbackNote` stay `NULL` on converted tasks — there is no record
   of the pre-lock step, so an open converted task falls back to its current locked step (§2.6 treats a `NULL`
   fallback as "keep what is stored").
4. **Abort conditions** (report, do not guess): a `DONE` task whose `result` has no slice for a ticked kind (I5 should
   make this impossible), a `result` key with no matching kind, a `HELP` task with an empty `contents`, and — **B9** —
   a `contents` array containing the same kind twice. `DealTaskContent[]` is a plain Postgres array with no uniqueness
   guarantee, and `@@unique([taskId, kind])` would make the insert fail halfway. Count duplicates in the dry run and
   decide explicitly; do not silently `DISTINCT` them away.
5. **Verify:** `count(parts) = Σ array_length(contents)` over `HELP` tasks; every `DELIVERED` part has a non-empty
   result; every `DECLINED` / `WITHDRAWN` part has a reason where the task had one.
6. **`TASK_RESULT_DISMISSED.meta.items` with `kind = "DECLINED"`:** count them. Each such row belongs to a task that
   had exactly one content (today's UI sends one), so the reviewed SQL rewrites each entry to carry
   `part = <that kind>`. If the count is 0 — the likely case — nothing to do. If a row cannot be matched to exactly one
   content, **abort**: leaving it unmatched would make an acknowledged decline reappear as waiting.
7. **On ambiguity: abort, report the exact rows, write nothing** (R02-10). The test database currently holds the
   wave-3 and wave-5 click-through state, which is the very data this migration needs to be verified against — it is
   recoverable, but destroying it must never be an automatic step in a plan. Wiping and reseeding
   (`prisma/dummySeeds/seedTestWorld.ts --minimal`, triple endpoint guard + `--confirm`) happens **only if Michal
   explicitly chooses it** for the verified test endpoint after seeing the report.

## 7. Prerequisite findings — fix before Part A

**P0 — `defaultStep(..., { locked: true })` can produce a locked step with `nextActionMode = "IN_PROGRESS"`.**

`lib/domain/clientRequests.ts`, the *changed kind* branch of `defaultStep`:

```ts
return {
    nextActionKind: kind,
    nextActionAt: opts.locked ? null : businessTodayStart(opts.now ?? new Date()),
    nextActionHasTime: false,
    nextActionMode: kind === "SEND_DESIGN" ? "IN_PROGRESS" : "SCHEDULED",   // ← locked is ignored here
    nextActionNote: defaultStepNote(kind),
};
```

`opts.locked` clears the date but not the mode. The *same kind* branch does force `SCHEDULED`, so the gap is only on a
kind change. The one shipped caller that passes `locked` is `setClientAsksAs`
(`lib/commands/requests.ts:105`): a deal with an open task whose locked step is `SEND_QUOTE`, where someone adds a
`DESIGN` ask with the pencil, ends up with `SEND_DESIGN` + `IN_PROGRESS` + `nextActionAt = NULL` — which contradicts
the invariant stated in `database-map.md` ("an `OPEN` task ⇒ `nextActionAt IS NULL` and mode `SCHEDULED`") and wave 3
§5.1 / I8.

**Found by reading, not reproduced in a test**, and the visible damage today looks small (`isStepLocked` wins over the
mode in `clientSection`, and after the task closes the deal lands where it would have anyway). It matters for wave 4
because **P6 makes this branch run constantly**.

**Fix:** force `nextActionMode: opts.locked ? "SCHEDULED" : (kind === "SEND_DESIGN" ? "IN_PROGRESS" : "SCHEDULED")`,
and add the pure assertion from §2.13 plus a server case that asserts the invariant after a pencil edit on a locked
deal. It is a two-line change and belongs to wave 5's closeout, not to wave 4 — but Part A must not start until it is
in.

**P1 — the follow-up call is not gated on the client's outstanding work (found while answering review R02-6).**

`finishAndSendAs` decides whether to plan "Zavolať, či prišlo" from `otherPending`, which reads **returned task items
only** (`lib/commands/tasks.ts:300–302`). `recordOffer`'s follow-up branch then asserts only I10
(`offerMutations.ts:247–248`), which is again task items. Neither consults `LeadRequest`.

**Failure:** the client asked for INFO + PRICELIST + PRICE + DESIGN. The manager finishes PRICE + DESIGN with
"Poslal som to klientovi sám" and sends those two. The task closes, no task item is left — so the step becomes
"Zavolať, či prišlo" even though two promised contents were never sent. The deal now tells the rep to phone about an
email, and the owed info and cenník survive only as a ⚠ warning. That is exactly the drift wave 5 was built to remove.

The send dialog already enforces the right rule on the client side (wave 5: the follow-up is blocked while anything is
outstanding), but **the server does not** — `recordOfferSentAs` takes `followUp` from the client and never checks
`outstandingOf`.

**Fix (server-side, both paths):** after the offer is recorded and the requests reconciled, a `CALL` follow-up is
allowed only when `outstandingOf(tx, lead.id)` is empty — and, for a task, only when the task is being closed.
`finishAndSendAs` computes it itself; `recordOfferSentAs` **refuses** `followUp: true` with outstanding work
(`FORBIDDEN`, "Ešte neodišlo všetko, čo klient chce"), because its own dialog never offers it in that state, so such a
request is stale or hand-crafted. Tests: `w4FollowUpGate`.

Like P0, this is a defect in shipped code rather than a wave-4 design choice, and it belongs to wave 5's closeout.
Part A must not start until both are in.

---

## 8. Open questions for Michal

Decided 2026-09-19 and unchanged: **Q1** Iné combinable — yes · **Q3** withdraw / add a part — yes · **Q4** the manager
declines one part — yes. Q2 moved to wave 5 and is shipped.

**Q10 — decided 2026-09-20 (Michal).** A task where the price was delivered and the návrh was then withdrawn or
declined ends as **`DONE` / "Vybavené"**, with the per-part marks showing the truth. No fifth display state. Michal's
reason, which is the better one: *"Čiastočne vybavené seems like a state where we are waiting for the rest, which in
this case isn't really true — the task is closed, part of it was declined."* If they need that part again, it is a
**new task**.

**D5 — accepted 2026-09-20 (Michal): "let's make the activity price, with optional note."** Price changes become a
`PRICE_CHANGED` business row the rep can see, with an optional short reason (S-15, §5.1). It stays in **Part D**, it
does not touch Part A, and Q7's answer now reads "D1, D2, D5".

**Q11 — decided 2026-09-20 (Michal).** *"After sending the task, it should not be editable — it's written in."*
A delivered part's `result` is a history line ("Michal odovzdal 1 285 € · 19. 9.") and is **never rewritten**, from
the moment the manager submits "Hotovo" — not from the moment the client gets it. There is no
"Opraviť, čo som odovzdal". A manager who wants a different number before the rep sends it **edits the deal's price**
in "Cena & ponuky"; the rep is then warned in the send dialog (*"Michal vrátil 1 285 €, aktuálna cena je 1 385 €"*,
wave 3 §6.4), and a návrh's newer version is snapshotted at send time. What made this decision cheap is **D5**
(§5.1): with a visible price history, editing the live price loses nothing.

**Q9 — proposal corrected 2026-09-20; still needs a yes.** The original proposal here (a one-tap
*"manažér to rieši sám — stiahnuť požiadavku"* on a declined part) is **withdrawn**. It mixed the two ledgers that
wave 5 exists to keep apart: a declined **part** means the manager will not do that piece of work; it does **not**
mean the client stopped wanting the content.

Take Michal's own case — the manager declines the price part with *"prepoj ich na mňa, zavolám im kvôli cene"*:

- the client's `PRICE` request stays `OPEN`, so the checklist keeps saying "⚠ Chceli cenu – ešte nedostali". That is
  **true** (they have not got a price) and it is a useful nag if the call never happens;
- when the manager actually tells them the price, he records it (phone price → `OFFER_SENT`), which closes the
  request by itself. Nothing special is needed;
- once the task closes, the rep's step is unlocked and she plans it freely (e.g. "Zavolať"); the warning stays
  visible until the price reaches the client, which is exactly the shipped wave-5 behaviour for a step that is
  narrower than what is outstanding (§6.9a);
- if the client genuinely should not get it at all, that is the **pencil** at "Chceli", with a reason — one extra tap
  for a real decision, never automatic (wave 5 Q4).

| # | Question | Proposed |
|---|---|---|
| **Q9** | Confirm: a declined part changes **nothing** about the client's request — no shortcut, no automation. The card shows the manager's reason, the request closes when the content actually reaches the client, and the pencil is the way to withdraw it deliberately | **yes — do nothing** (replaces the withdrawn proposal above) |
| **Q12** | **Part A, UI (new, from review R02-2).** A čásť „Návrh“ can return two návrhy, and the rep may send one and say „Neposielam“ to the other. Is **one row per part with a compact mark** (`✓ Návrh · 1 z 2`), expandable to the two item lines, the right shape — or do you want **two top-level rows**, one per návrh? | one row per part, expandable — it keeps the card as short as today |
| Q5 | **Part B, notes.** Today a lead has one note field and it is overwritten (scout → first call → every contact edit), so the scout's observation is lost and nobody knows who wrote it. **Rewritten after review R02** — Q5 is now “confirm §3.3 and §3.4”: INTERNAL is manager-only to read as well as write, bodies are immutable, deletion records who and why, and an old `Lead.note` is labelled „Staršia poznámka (autor a pôvod neznámy)“ | as written in §3.3 + §3.4 |
| Q6 | **Part C, order note.** The rep's handover text ("eshop + EN jazyk, doména X") lives inside the task and is buried once the task closes. Should it be copied onto the deal as a pinned `FOR_BUILD` note automatically when the handover is accepted? | yes |
| Q7 | **Part D, wave-3 leftovers.** D1 = when something stays unsent, the kept "Poslať…" step's date and note cannot be edited in that same dialog · D2 = the reopen step choice (wave 5 already fixed most of it) · D3 = a manager cannot cancel + replan a rep's task · D4 = 13 count queries per page load · **D5 = accepted** | D1, D2, **D5** |
| Q8 | Order: P0 → A → B → C → D? | yes |

Q5–Q8 block nothing in Part A and can be answered when Part A is built.

---

## 9. Order of implementation

0. **Gates:** wave 5's human click-through accepted (F4 in `wave-5-followups.md`), **P0 and P1 fixed** (§7), and
   Q9 + Q12 answered. Nothing below starts before that.
1. **Schema on test:** S-13a (table + enum + the two `DealTask` fallback columns, with the §6.3 conversion:
   dry-run → verify → apply → verify), S-14; `prisma generate`; ledger entry in `db-changes.md`.
   `DealTask.contents` / `result` still present and still read — part rows are a **pure derivation** until step 7.
2. **Part A domain (pure first):** `DealTaskPart` types, `taskPartState`, `returnedItems` / `pendingItems` over parts,
   `ItemRef.part`, `overlappingKinds`, the task-status derivation; the pure tests of §2.13.
3. **Part A reads:** `managerWorkOf`, `pendingByLead` / `loadPending`, `getDealList` (`RowTask`), `getDealDetail`
   (`openTask`, `tasks`), `getManagerToday`. Assert that the headline, the warning and the pills are **byte-identical**
   to before for a single-part task — the regression net for §2.2.
4. **Part A commands:** `askManagerAs` (multi), `resolveTaskPartsAs`, `declineTaskAs` on top of it, `finishAndSendAs`,
   `withdrawTaskPartsAs`, `addTaskPartsAs`, the `cancelTask` paths, the overlap inputs; then the `w4*` server groups.
5. **Part A step rules (P6):** the locked re-derivation at every event of §2.6, copied from the `setClientAsksAs` call
   site; `w4StepLocked`.
6. **Part A UI:** toggles in "Požiadať manažéra", parts with `○ ◆ ✓ ✗ –` on the task card, the `⋯` menu, "+ Pridať",
   one "Hotovo" dialog for all parts, the partial-send confirmation, list and inbox labels.
7. **Cutover (R02-7):** stop task writes, re-run the conversion in one transaction, **verify zero drift**, switch the
   reads to parts, then run the full check pass (`code-standards` §7) and the human click-through of the multi-part
   flow on phone and desktop.
8. **Second zero-drift verification** (read-only), then **S-13b:** drop `DealTask.contents` and `DealTask.result` with
   reviewed SQL; `db push` "already in sync"; ledger.
9. **Part B** (`lib/domain/notes.ts`, commands, queries, UI, wiring into contact creation and the first call; tests for
   authorship, role at the time, soft delete, pin rules, scope).
10. **Part C:** handover → FOR_BUILD note in the same transaction as the acceptance; tests.
11. **Part D:** D5 (S-15 first, then `saveQuote` + the price card + `w4PriceHistory`), then the rest chosen in Q7.
    D5 is independent of Part A and can be pulled forward whenever the test branch is free.
12. Docs (`app-workflow.md` §6, `database-map.md`, `operations.md`, `progress-tracker.md`), HTTP role checks, final
    full check pass.
