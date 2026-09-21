# 03 — Read-only inventory plan

> **SUPERSEDED (2026-09-22).** The current, executable route is `RECIPE.md` + `tools/run-migration.sh` (D-009). This file is kept as the planning record; where it disagrees with RECIPE.md, RECIPE.md wins.


Goal: measure the real V1 schema and classify every possible migration source before writing anything.

## Stage A — database identity and schema

1. Parse and display only sanitized identity: endpoint suffix, database name, branch ID/name and pooled/direct status.
2. Prove it is the intended fresh clone and not the known production or development endpoint.
3. Export schema only—no rows, owners, grants or secrets.
4. Compare actual clone schema with:
   - the exact deployed V1 commit;
   - local `origin/main`;
   - the recorded `7beb689` baseline;
   - the frozen V2 target.
5. Inventory tables, columns/defaults/nullability, enum values, indexes, foreign keys, extensions and approximate table
   sizes. Every unexpected difference is a blocker until explained.

## Stage B — legacy source census

Count leads by every combination of:

- `price IS NULL` / non-null;
- `priceDisclosed`;
- `quoteSentAt`;
- `aboutUsSentAt`;
- `designSentAt`;
- old `QUOTE_SENT`, `EMAIL_SENT`, `DESIGN_SENT` activities;
- Design rows, sent Design rows, deleted Design rows and tracker events;
- deal/call stage, open/closed status and soft deletion;
- existing canonical `OFFER_SENT`, if any.

Also count duplicate dates, multiple old activities per lead, conflicting field/activity dates, undo/audit rows and
evidence outside `pipelineEnteredAt IS NOT NULL`.

Added 2026-09-21 for mapping revision 2 (`02-data-mapping.md`):

- `EMAIL_SENT` rows per lead (expected ≤ 1) and any with a non-null note; `aboutUsSentAt` without an `EMAIL_SENT` row.
- `QUOTE_SENT` rows with / without an amount in the note; audit rows "Odoslanie cenovej ponuky zrušené",
  "Klient oboznámený s cenou", "Oboznámenie s cenou zrušené"; `quoteSentAt` vs last `QUOTE_SENT` date.
- Price history: leads with "Cena: X → Y" rows; leads whose current `price` differs from the amount in their last
  `QUOTE_SENT` note; leads with price set only after their first send.
- Every combination of {price null/non-null} × {ABOUT, CP, DESIGN event present} × {current `nextActionKind`} for
  open deals — especially `SEND_QUOTE` + price filled (Q3) and `SEND_*` steps on leads that already received that
  content (D-007).
- `DESIGN_SENT` rows matched / unmatched to a sent Design within 1 s; "Návrh označený ako neposlaný" rows; deleted
  Designs with `sentAt`; `Lead.designSentAt` without a sent non-deleted Design.
- Same-business-day groups of old sends per lead (Q5).
- Round 1 blockers: `OUTCOME_CORRECTED` count; "Vrátené do volaní (reset na nový)" rows; `NEW` leads with CALL rows
  (positive / non-positive); deals with 0 or >1 positive queue calls; deals without owner (Q6, Q8).
- For each planning row type (`NEXT_ACTION_SET/CHANGED`), whether its `note` identifies the step kind reliably
  (needed for D-007 `stepSetAt`).
- Any existing `OFFER_SENT`, `LeadRequest`, `DealTask` rows (expected 0 — the live schema should not even have them).

## Stage C — planned-event manifest

Produce one local sensitive manifest with one row per proposed canonical event:

- anonymous lead identity;
- deterministic event key;
- source field/activity/design IDs;
- selected date, channel, actor and source;
- contents;
- price amount and amount source;
- design snapshot/identity;
- direct vs inferred facts;
- exception codes and decision status.

Produce a separate sanitized summary suitable for repository evidence: aggregate counts by rule/exception only, plus
the sensitive manifest's hash and external path.

## Stage D — coverage report

The report must answer both directions:

1. **Source coverage:** every old field/activity/design send signal maps to exactly one planned canonical event or one
   explicit approved no-op.
2. **Target justification:** every planned event is justified by named source evidence and one approved rule.

Apply gate:

- zero unclassified sources;
- zero unresolved exceptions;
- zero unexplained planned targets;
- grouping/amount/date decisions approved;
- the same input produces byte-for-byte equivalent normalized manifest output on a second dry run.

## Inventory is not application testing

Do not start V2 against the clone merely to inspect it. Its schema is V1 and the current V2 code expects additional
objects. Inventory tooling is purpose-built and read-only; application testing begins only after the rehearsed schema
and data steps have completed.

## Expected drift between clone 1 and the final copy (Michal, 2026-09-21)

Live V1 keeps running until the final copy. Michal expects new data **only from the first stages**:

- **Scouts:** newly added contacts, i.e. new `NEW` leads (+ their `CONTACT_UPDATED` audit rows).
- **Telesales:** first calls from the call queue with ordinary outcomes only: no answer (`NO_ANSWER` → CALLING RETRY),
  call later (`CALL_AGAIN` → CALLING SCHEDULED, with V1's call-stage `nextAction`), wants návrh (`WANTS_DESIGN` → new
  ACTIVE deal, step SEND_DESIGN in progress) or wants price (`WANTS_QUOTE` → new ACTIVE deal, step SEND_QUOTE). Also
  plausible: `NOT_INTERESTED` / `BAD_NUMBER` / `WANTS_EMAIL`. "No special situations."

**Double-check on the final copy. Do not assume.** Re-run `inventory/` and compare with `INVENTORY-2026-09-21.md`:

1. Schema identical to clone 1 (any difference = stop).
2. Every lead/activity that is new or changed since clone 1 fits the list above. Expected results: Round 1 classes grow
   only in POOL / CALLWORK_TO_MIGRATE / DEAL_TO_MIGRATE / TERMINAL_OK; new deals are ownerless → Michal; new
   `SEND_DESIGN` / `SEND_QUOTE` / `SEND_EMAIL` deals have no sends → they become OPEN "Chceli" rows (new: OPEN PRICE rows
   for `WANTS_QUOTE` deals, 0 on clone 1).
3. Anything else is **unexpected and listed for Michal before any write**: a new EMAIL_SENT / QUOTE_SENT / DESIGN_SENT,
   price edit, design, status change, owner change, reset ("Vrátené do volaní"), outcome correction, NOTE, a changed
   send on one of the 86 known send leads, or a changed decision lead (#628, #98, #404).
4. Every §9 gate in `02-data-mapping.md` is still 0.
