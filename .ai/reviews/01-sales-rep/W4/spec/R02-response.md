# Wave 4 specification review R02 — response

Date: 2026-09-20. Answers `R02.md` in this folder. Branch `feature/wave5-workflow-fix`.
**Specification only — no schema command, no application code, nothing committed, production not touched.** The only
files changed are `context/features/01-salesrep/wave-4-proposal.md` and this response.

**All ten findings are valid and all ten are resolved.** Three were blockers and each was a real hole, not a wording
problem: finding 1 made two different terminal statuses defensible for the same action, finding 2 would have let the
card claim a client received a návrh that was deliberately not sent, and finding 3 left an ordinary
`OTHER + PRICE` task with no locked step at all. Finding 6 turned out to be a defect in **shipped** code as well as a
spec gap, so it is now a prerequisite (P1) beside P0.

Two suggested fixes were adopted with a change; both are marked below and explained.

| # | Finding | Verdict | How it is resolved |
|---|---|---|---|
| 1 | Aggregate status contradicts whole-task cancellation | **Valid, blocker** | One terminal-transition table (§2.4a); the activity row follows the **resulting status**. `declineTaskAs` removed |
| 2 | `taskPartState` cannot represent partial consumption | **Valid, blocker** | Per-item `ItemDisposition`, enriched `Consumption` input, derived part mark (§2.3, §2.5) |
| 3 | Mixed `OTHER + PRICE/DESIGN` has no fallback step | **Valid, blocker** | `DealTask.fallbackKind` / `fallbackNote`; P6 = `derived ?? fallback`, no `isSystemStep` guard while locked (§2.6) |
| 4 | Field presence would deliver a prefilled stale price | **Valid** | Explicit per-part "Odovzdať teraz" toggles; server refuses values for an unnamed kind (§2.7, §2.9) |
| 5 | Correction specified both ways | **Valid** | One rule: re-derive while locked, never touch an unlocked step (§2.6 R02-5, §2.10) |
| 6 | "Nothing else pending" ≠ the wave-5 outstanding set | **Valid, and a shipped bug** | Server-enforced `outstandingOf` gate; promoted to prerequisite **P1** (§7) |
| 7 | Multi-day write gap before the code cutover | **Valid** | Parts are a pure derivation until cutover; re-run + zero-drift verify twice (§6.3, §9) |
| 8 | Notes permission / edit contract | **Valid** | §3.3 rewritten: INTERNAL is read-restricted in the query, bodies immutable, deletion attributed |
| 9 | `Lead.note` provenance | **Valid** | §3.4: "Staršia poznámka (autor a pôvod neznámy)", one canonical write, writer inventory |
| 10 | Destructive fallback as an automatic plan step | **Valid** | Abort and report; a reset only on Michal's explicit choice (§6.3) |

## 1. Terminal status vs. cancellation (blocker)

The reviewer is right that the three statements could not all be true. Adopted as suggested, and taken one step
further.

- **§2.4a is now the single terminal-transition table** — nine rows covering deliver-all, mixed deliver+decline,
  decline after a delivery, owner withdrawal with and without an earlier delivery, deal close, takeover, owner
  removal, bulk transfer and accepted HANDOVER. Each row names the resulting status, the primary keyed activity and
  the exact secondary rows. Nothing else may decide a status.
- The rule is stated as: **resolve the named parts, recompute the aggregate, and let the resulting status choose the
  activity row** — never the name of the action. So "Zrušiť úlohu" after a delivered price writes
  `TASK_PART_WITHDRAWN` + `TASK_DONE`, and the card reads *"Vybavené — cena odovzdaná, návrh zrušený"*.
- **Beyond the suggestion: `declineTaskAs` is removed**, folded into `resolveTaskPartsAs` as "decline every part still
  `REQUESTED`". The reviewer asked that declining-after-delivery must not claim the whole task was declined; keeping a
  command literally named *decline* that must sometimes emit `TASK_DONE` is how that bug comes back. One command per
  outcome is cheaper than a rule about when the command lies.
- Consequence the spec now states: `resolveTaskPartsAs` writes `TASK_PART_DONE` when anything was delivered and
  `TASK_PART_DECLINED` otherwise, so its `runKeyed` lookup passes **both** types; the `fp` still separates a replay
  from a conflict.
- `cancelOpenTask` keeps its name, its callers and its input shape — only its body changes.
- The contradicting `resolvedById` comment is gone (§2.4 now says it is always the acting user, matching B8).

## 2. Per-item consumption (blocker)

Accepted in full; the reviewer's type sketch is adopted almost verbatim.

- **`ItemDisposition` = `WAITING` | `SENT` | `DISMISSED`**, each carrying its own instant, actor, reason and
  `activityId`. `PartView.items` is a list of `PartItemView`; the impossible part-level `receivedAt` is gone.
- The pure function can now actually compute what it promises: the input is a `Consumption[]` carrying the offer
  instant and the dismissal metadata, not two bare `ItemRef[]` lists. `pendingByLead` already reads those rows and
  only needs `id`, `createdAt`, `userId` and the actor's first name added to its select — no new query.
- **Three marks, not two** (§2.3): `◆ pripravené`, `✓ poslané`, `⊘ neposlané`. A dismissed item is never rendered as a
  client receipt, which is the part that could have made the CRM lie.
- The part's compact mark is **derived**: all waiting → `◆`; mixed → `✓ 1 z 2 poslané`; all sent → `✓`; anything
  dismissed → said explicitly. A dismissed PRICE part is therefore distinguishable from a malformed one.
- `pendingItems` keeps its exact meaning (`WAITING` items only), so I10 and `prepared` are untouched.
- Tests `w4Items`: both waiting · one sent one waiting · one sent one dismissed with a reason · both sent in different
  emails · correction of one of those sends · a dismissed price.
- **One question for Michal (Q12)**, because it is a UI judgement and he has asked twice not to over-complicate the
  card: one row per part with a compact mark and the items expandable underneath (proposed), or two top-level rows for
  two návrhy?

## 3. The `OTHER` fallback (blocker)

The sharpest finding in the review. Both failure scenarios are real, and the second one — a deliberate "Zavolať
v piatok" that `isSystemStep` would freeze in place while a newly added price is being made — was not something the
old text could resolve at all.

Adopted as suggested: **persist the fallback.** `DealTask.fallbackKind` / `fallbackNote`, written **once at ask time**
from the step the deal had before `stepAfterTask` locked it, never rewritten. Then:

```
lockedStep = defaultStep(outstanding, lead, { locked: true })  ??  { kind: fallbackKind, note: fallbackNote }
```

- **`isSystemStep` no longer guards P6 while a task is open.** The lock already prevents free replanning and the
  fallback holds the user's own choice, so a deliberate CALL can be displaced by "Poslať cenu" and comes back when the
  price part is withdrawn, sent or answered.
- **Deliberately narrower than the reviewer's sketch: no date and no mode are stored.** Wave 3 already discards the
  date at lock time and makes the step due *today* at unlock (`unlockStep`), and a locked step is `SCHEDULED` by
  invariant (I8). Storing a schedule we would then have to throw away would be two truths for one fact.
- **A consequence the review did not name, and it matters:** `setClientAsksAs` must adopt the same rule. It re-derives
  a locked step today but only when `isSystemStep`. If wave 4 changes one and not the other, the pencil and the task
  commands compute two different locked steps for the same deal. Written into §2.6 as a required change to code
  shipped on 2026-09-20.
- Converted tasks have a `NULL` fallback (no record of the pre-lock step exists), which §2.6 treats as "keep what is
  stored".
- Tests `w4Fallback`: OTHER-only → add PRICE → withdraw PRICE → Friday's call restored; PRICE + OTHER → send the price
  → the locked step becomes the fallback instead of still saying "Poslať cenu"; close; correction of that send.

## 4. Selection vs. prefilled values

Valid and concrete — I verified it in the code rather than taking it on trust. `FinishTaskDialog.tsx:44–45` prefills
the amount from `Lead.price`, and `:73–83` includes the price whenever the task wants `PRICE`, so a manager returning
only a návrh really would have frozen a stale €700 into an immutable part result.

Adopted as suggested, on both sides: an explicit **"Odovzdať teraz"** toggle per requested part, values still
prefilled but submitted only for toggled parts, the button count and the "what stays open" line read from the toggles,
and the server refuses values for a kind that is not named in the operations list. "Poslal som to klientovi sám" uses
the same subset. Test `w4Selection` uses a deal that already has a price, which is the case that would have failed.

Worth noting: the **server** contract in the old draft was already an explicit operations list — it was the dialog
spec that said "whatever is filled in is delivered". The finding is still right, because that dialog is what would
have been built.

## 5. One correction rule

My own draft really did say both things, in §2.6 (B2) and §2.10. Resolved in the direction the reviewer recommends,
and for a reason the new §2.6 now makes explicit:

- on an **unlocked** deal the shipped rule is untouched — a correction never replans a user's step, because the user
  can fix it;
- while **locked** the user cannot fix it, so staleness has no repair path;
- and under P6 the locked step is a **function** of `(outstanding, fallback)`, not a decision anyone made. Letting a
  correction desynchronise a derived value would be arbitrary.

So while a task is `OPEN`, `correctRecord` calls the same `refreshLockedStep` helper as a partial send: kind and note
only, date `NULL`, mode `SCHEDULED`, status untouched, same planning row. §2.6, §2.10 and `w4StepLocked` now say this
once each and nothing else. If Michal prefers the "never touch it" rule even while locked, that is a one-line flip and
the tests say which.

## 6. The follow-up gate — and a shipped bug

Valid, and checking it turned up more than the review claimed. Confirmed in code: `finishAndSendAs` computes
`otherPending` from returned **task items** only (`lib/commands/tasks.ts:300–302`), and `recordOffer`'s follow-up
branch asserts only I10 (`offerMutations.ts:247–248`). Neither consults `LeadRequest`.

That means the bug exists **today**, not only in the wave-4 plan: a manager who finishes PRICE + DESIGN with "Poslal
som to sám" schedules "Zavolať, či prišlo" while the client is still owed INFO and PRICELIST. And the send dialog's
own rule ("no follow-up while anything is outstanding") is enforced **only in the client** — `recordOfferSentAs` takes
`followUp` from the request and never checks.

So it is written up twice: as the wave-4 contract (§2.7 R02-6) and as prerequisite **P1** (§7), beside P0, to be
fixed in wave 5's closeout. The server rule: after recording and reconciling, a `CALL` follow-up is allowed only when
`outstandingOf(tx, lead.id)` is empty — and for a task, only when the task is closing. `recordOfferSentAs` refuses a
hand-crafted `followUp: true` outright. Test `w4FollowUpGate` covers the reviewer's exact scenario plus the "all four
contents in the same email" case and an older waiting task item.

## 7. The cutover

Valid. Adopted, with the mechanism stated rather than only the schedule.

The key sentence is now in the spec: **until the code cutover, `DealTaskPart` is a pure derivation, not a source of
truth.** Nothing reads it, nothing but the conversion writes it — so the conversion deletes every part row and
re-inserts from the parents, and is exactly reproducible however long the implementation takes. After the cutover it
becomes the source of truth and is never re-derived.

Order (§6.3, §9): S-13a + first conversion → implement → **stop task writes, re-run in one transaction, verify zero
drift** → switch reads → full checks + click-through → **second zero-drift verification** → S-13b drops the columns.
The spec also states plainly that production never runs any of this: it has no task tables and receives the final
parent + parts schema directly.

## 8–9. Notes and `Lead.note`

Both valid and both adopted; §3.3 and §3.4 are rewritten, and Q5 now means "confirm those two sections" rather than
the old seven lines.

- **INTERNAL is manager-only to create *and* read**, with the visibility predicate in the **query** — every list,
  count, detail and sheet-header read. The review's point about the deal detail handing a rep every BUSINESS row in
  scope is exactly why a component-level filter would leak.
- **Bodies are immutable**: a correction is another note. If editing is ever added it needs `updatedById` plus an
  append-only edit history and an "upravil X" line — never silent re-attribution.
- **Soft delete records `deletedById` and a reason**; deleted notes are manager-visible only.
- **Old `Lead.note` is labelled "Staršia poznámka (autor a pôvod neznámy)"**, never an intake note. New scout input is
  written **once**, as a GENERAL `LeadNote`, in the contact-creation transaction; `Lead.note` is not written with it,
  so nothing renders twice. Every later writer of the field is inventoried and stopped
  (`lib/actions/contacts/index.ts`, `lib/commands/calls.ts`, `lib/domain/dealMutations.ts`).
- **Not adopted:** backfilling old values into `LeadNote` with a null author. It would need the schema to allow
  unknown authors for content that is already untrustworthy. The column stays frozen and clearly labelled instead —
  the review offered this as one of its two options.
- Access tests are per role (scout / telesales / rep / manager), including a role change after the note was written.

## 10. The destructive fallback

Valid. §6.3 step 7 now reads: **abort, report the exact rows, write nothing.** Wiping and reseeding happens only if
Michal explicitly chooses it for the verified test endpoint after seeing the report. This also matches his standing
rule about never reaching for the destructive option, and the test database currently holds the wave-3 and wave-5
click-through state that this very migration needs to be verified against.

## Questions for Michal

1. **Q12 (new).** A "Návrh" part can return two návrhy and the rep may send one and decline the other. One row per
   part with a compact mark (`✓ Návrh · 1 z 2`), expandable to the item lines — or two top-level rows? I propose the
   compact row; the card stays as short as today.
2. **Q9 still open** from the previous round: a declined part changes nothing about the client's request. My
   recommendation is unchanged — do nothing, no shortcut, no automation.
3. Q5 has changed meaning: it is now "confirm §3.3 and §3.4", which is a real contract rather than a sketch. Parts B–D
   still block nothing in Part A.

## State

| | |
|---|---|
| Schema commands run | **none** |
| Application code changed | **none** |
| Files changed | `context/features/01-salesrep/wave-4-proposal.md`, this response |
| Automated checks | **not run — and not applicable.** No code changed; a spec revision has nothing to compile or test |
| Gates before Part A | wave-5 F4 click-through · **P0** and **P1** fixed · Q9 and Q12 answered |

The reviewer's closing assessment holds after these changes: the architecture does not need another redesign, and
Part A can be built in small reviewable stages once the gates clear.
