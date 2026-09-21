# 03 — Read-only inventory plan

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

