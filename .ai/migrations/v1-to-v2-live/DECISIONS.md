# Migration decisions

Draft decisions live here while the rollout is designed. Once approved and needed to build or operate the system, copy
the final wording into the appropriate `context/` source of truth and link it here.

Statuses: `PROPOSED`, `APPROVED`, `SUPERSEDED`, `REJECTED`.

## D-001 — production duplicate is a rehearsal environment

- Status: **APPROVED**
- Decision: use a fresh Neon branch of production for inventory and full rehearsal. Do not promote a rehearsal branch
  after live V1 has continued accepting writes. The final migration runs against the current frozen production state,
  or against a new branch created only after the write freeze under a separately approved switch plan.
- Reason: Neon/PostgreSQL branches do not merge later V1 writes into the rehearsal copy.

## D-002 — obsolete columns use expand/migrate/verify/contract

- Status: **APPROVED in principle; exact timing pending**
- Decision: do not retain dead legacy columns permanently. Preserve them through conversion and initial verification;
  remove `Lead.quoteSentAt`, `Lead.aboutUsSentAt` and `Lead.priceDisclosed` only in a separately reviewed contraction.
  Backups are restore points, source activities, provenance and reconciliation artifacts—not stale columns.
- Always keep: `Lead.price`, `Lead.priceNote`, `Lead.designSentAt`, `Design.sentAt`, design/tracker history and raw old
  activity rows.

## D-003 — broad historical exact-price inference

- Status: **PROPOSED by Michal on 2026-09-21; needs exception decisions and context promotion**
- Scope: existing V1 records only. It does not change how new V2 actions work.
- Proposed rule:
  - any old price evidence—price stored, known flag, or sent marker—becomes a canonical exact `PRICE` receipt;
  - an old about-us email becomes one canonical send containing `ABOUT_US` and exact `PRICE`;
  - an old sent proposal becomes a canonical send containing `DESIGN` and exact `PRICE`;
  - when contents were part of the same real email, create one `OFFER_SENT` with all contents; do not merge distinct
    sends merely because they share a day;
  - canonical `PRICE` already means the client received/knew the price; do not create another knowledge flag;
  - label the inference in migrated provenance so it is distinguishable from a normal V2 fact.
- Decisions still required:
  1. What amount is used when the source implies exact price but `Lead.price` is null?
  2. What historical business date is used when only `Lead.price` exists and no reliable send/audit date exists?
  3. If several historical sends exist but only one current `Lead.price` survives, do all events receive that amount,
     or is exactly one canonical receipt created?
  4. How is a sent proposal represented when no surviving `Design` row can identify it?
  5. Does an undone old send still produce a receipt, or only audit provenance plus an explicit no-op decision?

## D-004 — no cennik inference

- Status: **APPROVED unless Michal supplies exact recipients**
- Decision: old live production had no cennik field. Create `PRICELIST` only for an explicitly identified send/event;
  never infer it from a date cutoff or “last N” leads.

## D-005 — preserve old evidence

- Status: **APPROVED**
- Decision: conversion adds canonical events; it does not delete `QUOTE_SENT`, `EMAIL_SENT`, `DESIGN_SENT` or audit
  rows. The UI must avoid displaying source and canonical event as two client sends. Every canonical migrated event
  records source identity and rule/confidence in provenance.

## D-006 — contraction timing

- Status: **PROPOSED**
- Recommendation: deploy V2 after canonical conversion while P-01..P-03 remain read-only, observe the stabilized
  production system, then drop them in a separate window. This maximizes repairability. Before approval, confirm the
  final V2 commit does not read those columns and define what application rollback means after V2 starts accepting
  writes.

