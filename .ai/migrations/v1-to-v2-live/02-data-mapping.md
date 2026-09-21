# 02 — Data mapping specification

Working mapping, revision 2 (2026-09-21). Supersedes revision 1 (the generic draft matrix). Human-readable companion:
`CHANGES-OVERVIEW.md`. Rules marked **[Qn]** depend on an open question in `DECISIONS.md` D-003; the default written
here is the recommended answer and must not be implemented before Michal confirms it. Final approved rules must be
synchronized to `context/` (db-changes.md §3.3, app-workflow.md §5a/§5b) before implementation.

Sources: V1 code = `origin/main` (`8e8b183`). V2 code = the frozen target (not yet frozen). Live data = not measured.

## 1. V1 facts the mapping relies on (verified in V1 code, not yet in data)

| V1 writer | Writes |
|---|---|
| `logSent(lead, "EMAIL_SENT", sentAt?)` (button "Označiť ako poslané" by "Email o nás"; disabled once set) | `Lead.aboutUsSentAt = at`, `Activity(EMAIL_SENT, BUSINESS, PIPELINE, createdAt = at)`, next step `CALL +7d` + planning row. No undo. `sentAt` param exists but the UI never passes it. |
| `setQuoteSent(lead, true)` | `quoteSentAt = now`, **`priceDisclosed = true`**, `Activity(QUOTE_SENT, note "Cenová ponuka odoslaná: <p> €" or "Cenová ponuka odoslaná")`, next step `CALL +7d` |
| `setQuoteSent(lead, false)` | `quoteSentAt = NULL` (priceDisclosed **unchanged**), `Activity(CONTACT_UPDATED, AUDIT, note "Odoslanie cenovej ponuky zrušené")` |
| `setPriceDisclosed(lead, b)` | `priceDisclosed = b`, `Activity(CONTACT_UPDATED, AUDIT, note "Klient oboznámený s cenou" / "Oboznámenie s cenou zrušené")` |
| `saveQuote(lead, {price, priceNote})` | `price`, `priceNote`; if price changed `Activity(CONTACT_UPDATED, AUDIT, note "Cena: <old|—> → <new|—>")` → **price history is reconstructible** |
| `setDesignSent(design, true)` | `Design.sentAt = now`, `Lead.designSentAt = now`, `Activity(DESIGN_SENT)` **without design id**, next step `CALL +7d` |
| `setDesignSent(design, false)` | `Design.sentAt = NULL`, `Lead.designSentAt = latest other sent non-deleted design`, `Activity(TRACKER_UPDATED, AUDIT, note "Návrh označený ako neposlaný")` |
| `removeDesign` | `Design.deletedAt = now`; **does not recompute `Lead.designSentAt`** |
| `resetLeadToCalls` | status `NEW`, clears callback/next step/lostReason; **keeps CALL rows** (even positive ones); `STATUS_CHANGED` "Vrátené do volaní (reset na nový)" |
| `correctOutcome` | rewrites `Activity.outcome` in place, re-applies lead flow, writes `OUTCOME_CORRECTED` |
| all pipeline writers | require `pipeline.manage` → every V1 send was made by MANAGER/ADMIN; `source = PIPELINE` |

Consequences: a CP send and the "knows price" tick are not independent (every CP send sets the tick); `DESIGN_SENT`
rows must be matched to designs by timestamp (same transaction as `Design.sentAt`, equal to the millisecond is not
guaranteed — `new Date()` is called twice; match within the same second and same lead); the only way
`Lead.designSentAt` exists without a live sent Design is design deletion, un-send mismatch, or seed data.

## 2. Target concepts (V2)

- Receipt = `Activity(type OFFER_SENT)`; `meta` per `lib/domain/offers.ts` `offerMetaSchema`:
  `{ channel, contents[], price?: {amount: "1285.00"-style string, note}, designs?: [{id,label,url,version}] | untrackedDesign?: true, sentOn: "YYYY-MM-DD" (Europe/Bratislava), historical: true, migrated: true, migration: {...provenance} }`.
  No `fp`, no `idempotencyKey`, no `fulfils`, no `callActivityId`.
- `createdAt` = the **original V1 timestamp** of the earliest source row (changed 2026-09-21 so the converted send sits
  at its real place in the history; `offerInstant` is then that exact moment). The migration time is in
  `meta.migration.migratedAt`. `sentOn` = the Europe/Bratislava business day of that timestamp.
- `ABOUT_US` = "Info" in the UI and satisfies request content `INFO`.
- `PRICE` requires `price.amount`. A `PRICE` receipt means "client knows this exact amount"; there is no other flag.
- Summaries (`offerAboutUsAt`, `offerPricelistAt`, `offerPriceAt`, `offerReviewAt`, `Lead.designSentAt`,
  `Design.sentAt`) are produced **only** by `recomputeOffers` after the events are written.
- `Lead.price`, `Lead.priceNote`, `nextAction*`, `status`, `ownerId` are never written by the send conversion.

## 3. Old send events (step A — extraction)

Per lead, build the list of **old send events**. Each has: `kind ∈ {ABOUT, CP, DESIGN}`, `at` (timestamp),
`actorId | null`, source ids.

| Kind | Primary source | Fallback | Excluded |
|---|---|---|---|
| ABOUT | each `EMAIL_SENT` activity (`at = createdAt`, actor = `userId`) | `aboutUsSentAt` with no `EMAIL_SENT` row → field-only event, actor unknown | — |
| CP | each `QUOTE_SENT` activity (`at = createdAt`) | `quoteSentAt` with no `QUOTE_SENT` row → field-only | a `QUOTE_SENT` followed (before any later `QUOTE_SENT`) by an audit "Odoslanie cenovej ponuky zrušené" = **undone** → excluded (Q4 APPROVED) |
| DESIGN | each non-deleted `Design` with `sentAt` (`at = sentAt`, designs meta from the Design row + `currentVersion`), matched to a `DESIGN_SENT` row for actor | `DESIGN_SENT` rows that match no currently-sent Design: if followed by "Návrh označený ako neposlaný" → undone, excluded (Q4 APPROVED); `Lead.designSentAt` with no sent non-deleted Design → one event with `untrackedDesign: true` (Q7 APPROVED); a **deleted** Design with `sentAt` → `untrackedDesign: true` (Q7 APPROVED) | undone sends |

`EMAIL_SENT` in V1 was written **only** by the "Email o nás" button (verified: `logSent` has one caller). So every
`EMAIL_SENT` is an about-us email; the old "generic email" exception class is dropped unless the inventory finds
`EMAIL_SENT` rows with a non-null note or a `sentAt` backdate pattern that V1 UI could not produce.

**Grouping (Q5 APPROVED):** old events of the same lead on the same Europe/Bratislava business day are merged into **one**
converted send (union of their contents; earliest `at`; actor of the earliest; all sources listed). Different days =
different sends.

## 4. Contents rule (step B) — Michal 2026-09-21, answers round 2

```
contents(event) =
    {ABOUT_US}                                   -- every old send: "Info"
  ∪ {DESIGN}  if event includes kind DESIGN
  ∪ {PRICE}   if event includes kind CP and amount(event) != null
  ∪ {PRICE}   if Q1 approves it for this lead (ABOUT-only or DESIGN event without a CP, price filled)   [Q1 OPEN]
```

Never `PRICELIST` (D-004). Never `REVIEW`.

**Price is known only if it was explicitly sent (Q2, APPROVED).** A filled `Lead.price` with no CP send, and the
"klient pozná cenu" tick with no CP send, produce **no** receipt. Report them as `I_PRICE_ONLY` /
`I_DISCLOSED_NO_PRICE`; they are approved no-ops. There is no PHONE price conversion.

**Open "Poslať cenu" (Q3, APPROVED):** such a deal with no CP send gets no PRICE and keeps an open `PRICE` request (§6).

**Amount (Q1 context):** current `Lead.price` (Michal: very likely what the client received). Cross-check: when a CP's
`QUOTE_SENT` note carries an amount that differs from current `Lead.price`, report `E_PRICE_DIFFERS` with both
amounts for Michal to choose. CP with no amount anywhere → Info only + `E_AMOUNT_MISSING` (blocking until decided).
`price.note` = current `priceNote` when the chosen amount equals current `Lead.price`, else `null`.

**Q1 inventory groups** (report counts and an anonymous per-lead list: number, event dates, amount; decide per group or
per lead): `Q1A` about-us sent, price filled, no CP ever; `Q1B` návrh sent, price filled, no CP ever. Until decided,
these leads get no PRICE.

## 5. Provenance on every converted `OFFER_SENT` (step C)

`meta.migration = { key, rule, sources: [<old Activity ids>], designIds?: [<Design ids>], originalAt: ISO, amountSource?: "QUOTE_NOTE" | "CURRENT_PRICE" | "DECISION", migratedAt: ISO }`
— exactly the typed shape in `lib/domain/offers.ts` `offerMetaSchema.migration` (no extra keys: a correction rewrites meta
from the parsed shape). The V2 history hides every Activity id listed in `sources` of a migrated send
(`migratedSourceIds`, implemented 2026-09-21), so each old send shows once, with no label (Michal 2026-09-21: no visible old/new distinction).

- Deterministic key: `v2mig:offer:<leadId>:<sentOn>` (one send per lead-day after grouping). Uniqueness enforced by
  the writer under the Lead lock (a partial unique index on `meta->'migration'->>'key'` is optional and would be a new
  schema object — if added, it goes through the normal proposal path).
  the writer under the Lead lock (a partial unique index on `meta->'migration'->>'key'` is optional and would be a new
  schema object — if added, it goes through the normal proposal path).
- `userId` = actor of the earliest source activity; field-only → the migration operator account (Michal's user) with
  `actorKnown: false`. `Activity.userId` is NOT NULL, so "unknown" cannot be stored as NULL.
- `source` = `PIPELINE` (all V1 sends were manager actions), `category = BUSINESS`,
  `note = offerNote(meta)`.
- The raw `QUOTE_SENT`/`EMAIL_SENT`/`DESIGN_SENT` rows are untouched (they still count for "Naposledy"); the history
  hides those listed in `meta.migration.sources` (done). Undone CP rows are not a source of anything and stay visible
  as old records.

## 6. "Chceli" backfill (step D, `2026-09-wave5-requests.ts`) — required change

Receipt rows: unchanged (first receipt per content → `LeadRequest(SENT, MIGRATED_RECEIPT)`).

Open-step rows, **changed**: for each non-deleted deal (`pipelineEnteredAt IS NOT NULL`) with status `ACTIVE` or
`SNOOZED` and `nextActionKind ∈ {SEND_QUOTE→PRICE, SEND_DESIGN→DESIGN, SEND_EMAIL→INFO}`:

- `stepSetAt` = `createdAt` of the latest `NEXT_ACTION_SET`/`NEXT_ACTION_CHANGED` planning row whose resulting kind is
  the current kind, else the positive first call that pre-filled it (`WANTS_*` outcome), else `pipelineEnteredAt`.
  (V1 planning rows carry only `describeNextAction` text in `note` — the inventory must confirm the text reliably
  identifies the kind; otherwise fall back to "latest planning row at or before `nextActionAt`" and report.)
- Create `LeadRequest(content, OPEN, MIGRATED_OPEN_STEP, requestedAt = stepSetAt, migrationKey w5:step:<leadId>:<content>)`
  **unless a valid receipt of that content has `offerInstant ≥ stepSetAt`**. An older receipt no longer suppresses it.
- Then run `reconcileRequests` per lead (V2 logic) and verify it leaves every row in the state the backfill chose.
- `SEND_DESIGN` creates only `DESIGN` (the step covers the price, rule I10). `SEND_EMAIL` creates only `INFO`.

The current script's `--apply` abort ("old send evidence without a single canonical OFFER_SENT") must accept an
explicit no-op list (`I_PRICE_ONLY`, `I_DISCLOSED_NO_PRICE`, undone-only leads) instead of aborting.

## 7. Round 1 backfill exceptions to resolve before any rehearsal

| Case (V1 origin) | Current script | Decision (Q6 = a, APPROVED; no legacy leftovers) |
|---|---|---|
| any `OUTCOME_CORRECTED` row exists | global abort | allow; the corrected outcome is already in `Activity.outcome`; report count |
| `NEW` + positive queue call (V1 `resetLeadToCalls` after a deal) | `CONFLICT` → abort | keep in pool: stays `NEW`, unassigned; mark every earlier CALL row `revertedAt = reset time`, `revertedById = resetter`; audit `CALL_REVERTED` with `meta.migrated` |
| `NEW` + non-positive queue calls (reset, or other) | `NEW_WITH_HISTORY` → `CALLING RETRY` for last caller | same as above if a reset audit row follows the last call; otherwise current behaviour |
| deal with `pos > 1` or `pos = 0` | `CONFLICT` | inventory first; decide per case |
| deal without owner | owner := Michal | **APPROVED (Q8)** |
| soft-deleted lead | excluded (`deletedAt IS NULL` in every query) | **include (Q9 APPROVED)**: classify and fill like a live lead, keep `deletedAt`; `revision` bump as usual |

## 8. Exception / report codes

Blocking until decided: `E_AMOUNT_MISSING` (CP or DESIGN without any amount), `E_UNDO_SEQUENCE` (undo pattern the
rules above do not classify; a plain undo is an approved no-op per Q4), `E_DESIGN_IDENTITY` (DESIGN_SENT that matches no Design and no undo),
`E_PRE_DEAL` (send evidence on a lead with `pipelineEnteredAt IS NULL` after Round 1), `E_EXISTING_CANONICAL`
(any `OFFER_SENT` already in live — expected 0), `E_ROUND1_CONFLICT`, `E_OTHER`.

Informational (approved no-op or approved default, still counted): `I_PRICE_ONLY`, `I_DISCLOSED_NO_PRICE`,
`I_ABOUT_NO_AMOUNT`, `I_FIELD_ONLY_ACTOR`, `I_SAME_DAY_MERGED`, `I_DELETED_DESIGN_UNTRACKED`, `I_DELETED_LEAD`, `Q1A`, `Q1B`.
Also blocking: `E_PRICE_DIFFERS` (CP note amount ≠ current price).

Soft-deleted leads (`deletedAt IS NOT NULL`) are **converted like any other lead** (Q9 APPROVED) and stay soft-deleted.
The same applies to the Round 1 backfill and the "Chceli" backfill; both scripts currently filter them out and must
be changed. Report them separately as `I_DELETED_LEAD` (count only).

## 9. Scope after inventory 1 (2026-09-21) — implement only what the data contains

Measured in `INVENTORY-2026-09-21.md`. The converter implements **only** these patterns: EMAIL_SENT → ABOUT;
QUOTE_SENT with an amount in its note (undo rule of §3) → CP; sent non-deleted Design matched to its DESIGN_SENT →
DESIGN; same-day merge; the three per-lead decisions for #628, #98 and #404 as an explicit, reviewed override list.
Everything else is **not built**. It becomes an abort gate: the converter's dry-run refuses to plan, and the final-clone
inventory must report 0 for each.

| Gate (must be 0) | Measured on clone 1 |
|---|---|
| field-only send (`aboutUsSentAt` / `quoteSentAt` / `Lead.designSentAt` without its activity/Design) | 0 |
| QUOTE_SENT kept (not undone) without an amount | 0 |
| DESIGN_SENT not matched to a sent Design, un-send rows, sent+deleted Design | 0 |
| send evidence on a lead with no positive first call (non-deal) | 0 |
| send evidence on a soft-deleted lead | 0 |
| open `SEND_*` deal whose content was already received earlier (D-007 case) | 0 |
| open `SEND_QUOTE` deal with a price but no CP (Q3 case) | 0 (no open SEND_QUOTE at all) |
| Round 1 CONFLICT / NEW_WITH_HISTORY / STRAY / `OUTCOME_CORRECTED` | 0 (the existing script already aborts on these) |
| a new about-us/návrh + price without CP, or a CP amount ≠ current price, other than #628 / #98 / #404 | 0 |
| `POSITIVE` or several positive first calls on one lead | 0 |

If the final clone shows a non-zero gate, stop, show Michal the lead numbers and decide. Do not add a generic rule
in advance. The existing Round 1 and Wave 5 scripts need **no change** for this data: no deleted-lead handling, no
reset handling, no D-007 dating. §6 and §7 above stay as the reasoning record only.
