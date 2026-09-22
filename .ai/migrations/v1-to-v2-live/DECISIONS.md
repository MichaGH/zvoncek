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

## D-003 — historical send conversion rule (revision 2)

- Status: **PROPOSED by Michal on 2026-09-21; **all questions answered 2026-09-21**; promote to context when the converter is built.** Revision 1 (about-us always implies exact price) is **SUPERSEDED** by this revision.
- Scope: existing V1 records only. New V2 actions are unaffected.
- Rule (exact spec: `02-data-mapping.md` §3–§5; readable: `CHANGES-OVERVIEW.md` §3), after Michal's answers of
  2026-09-21 (round 2):
  - V1 "Email o nás" → one send with `ABOUT_US` ("Info").
  - V1 "CP odoslaná" (not undone) → one send with `ABOUT_US` + `PRICE`.
  - V1 návrh marked sent → one send with `ABOUT_US` + `DESIGN` (+ `PRICE` only per Q1b). Info confirmed by Michal
    2026-09-21.
  - **`PRICE` only when a price was explicitly sent** and an amount exists. A filled `Lead.price` alone, or the
    "klient pozná cenu" tick alone, is **not** a receipt (Q2).
  - No `PRICELIST`, no `REVIEW`.
  - All converted sends: channel `EMAIL`, `historical: false` (D-009), `migrated: true`, dated with the old click's business day,
    provenance per `02-data-mapping.md` §5.
- Answers (Michal 2026-09-21):
  - **Q2 — APPROVED:** a price counts as known only if it was explicitly sent. No receipt from a filled price or the
    tick alone; the price stays on the deal as its current price.
  - **Q3 — APPROVED:** open "Poslať cenu" + price filled, no CP sent → not sent; "Chceli: cena" stays open.
  - **Q4 — APPROVED:** an undone CP / návrh is not a send. Raw rows stay as history.
  - **Q5 — APPROVED:** old sends of one lead on the same business day become one email with all their contents.
  - **Q7 — APPROVED:** návrh sent whose Design was later deleted (or matches no Design) → návrh receipt recorded as
    "návrh mimo systému" (`untrackedDesign`).
  - **Q8 — APPROVED:** old deals without an owner get Michal (ADMIN) as owner.
  - **Q6 — APPROVED (a), 2026-09-21:** `OUTCOME_CORRECTED` rows are accepted (corrected outcome used). A `NEW` lead
    with call history left by V1 "Vrátiť do volaní" stays `NEW`, unassigned, in the shared pool; its earlier CALL rows
    get the normal V2 `revertedAt` / `revertedById` plus one `CALL_REVERTED` audit row with `meta.migrated`. Expected to
    be a handful of leads or none. **No legacy column, flag, code path or UI** may be added for this case — it is a
    one-time data fix inside the Round 1 backfill using only existing V2 fields.
  - **Q9 — APPROVED (changed from the recommendation):** soft-deleted leads are converted too — Round 1 classification,
    send conversion and "Chceli" — so they are consistent V2 data if ever restored. They stay soft-deleted.
- Still open:
  - **Q1 — APPROVED per lead (Michal 2026-09-21):**
    - #628 → one send on 12.7: Info + Cena 499 € (the price went out with the about-us email).
    - #98 → no price receipt ("the price is just filled out there"); sends stay Info 17.6 and Info + Návrh ×2 9.7.
    - #404 → CP receipt with 689 € (what the CP said); current price 639 € stays on the deal.
  - Q6, Q7, Q9 and Q3 have **0 cases** in the data; their rules are not implemented, only gated (`02-data-mapping.md` §9).
- Superseded parts: revision 1 (about-us always implies price); the "price filled = client knows it" reading of
  2026-09-21 round 1 (replaced by Q2).

## D-004 — no cennik inference

- Status: **APPROVED** (Michal 2026-09-21: "There were no cenniks sent in the old version.")
- Decision: no converted send contains `PRICELIST`; no `LeadRequest(PRICELIST)` is created by the migration. The
  earlier "roughly the last 20 recipients" note in `context/domain/db-changes.md` §3.3 is void.

## D-005 — preserve old evidence

- Status: **SUPERSEDED by D-009** (old send rows and audits are removed after conversion; the restore point keeps V1)
- Decision: conversion adds canonical events; it does not delete `QUOTE_SENT`, `EMAIL_SENT`, `DESIGN_SENT` or audit
  rows. The UI must avoid displaying source and canonical event as two client sends. Every canonical migrated event
  records source identity and rule/confidence in provenance.

## D-006 — contraction timing

- Status: **SUPERSEDED by D-009** (columns dropped in the window)
- Recommendation: deploy V2 after canonical conversion while P-01..P-03 remain read-only, observe the stabilized
  production system, then drop them in a separate window. This maximizes repairability. Before approval, confirm the
  final V2 commit does not read those columns and define what application rollback means after V2 starts accepting
  writes.

## D-007 — "Chceli" open-step rows are dated by the step, not by the first receipt

- Status: **SUPERSEDED by D-009** (asks come from the first call); earlier: NOT NEEDED (2026-09-21, inventory 1) — 0 open SEND_* deals with an earlier receipt; the current script
  is correct for the data. Kept as a gate (`02-data-mapping.md` §9).
- Problem: `2026-09-wave5-requests.ts` creates an `OPEN` row for an open `SEND_*` step only if the lead never received
  that content. An old deal that received návrh v1 and now waits for návrh v2 would lose the open návrh in "Chceli".
- Decision: `requestedAt` = when that step was set; create the row unless a receipt exists at or after that instant.
  Spec: `02-data-mapping.md` §6. Requires a script change and a test in the concurrency suite.

## D-008 — Round 1 backfill must classify V1 reset and outcome-correction data

- Status: **NOT NEEDED (2026-09-21, inventory 1)** — 0 reset leads with remaining history, 0 `OUTCOME_CORRECTED`. The
  existing script already aborts on both, which is the gate. Nothing is built.
- Problem: V1 `resetLeadToCalls` and `correctOutcome` produce data the Round 1 backfill aborts on (CONFLICT / global
  `OUTCOME_CORRECTED` check). Spec of the recommended handling: `02-data-mapping.md` §7.

## D-009 — the migrated data must look as if it was always V2 (supersedes D-002 timing, D-006, D-007, part of D-005)

- Status: **APPROVED by Michal 2026-09-22** (after the ChatGPT review found 13 closed deals with an unsent "Poslať…").
- Decision (all in tonight's window, script `prisma/backfill/2026-09-v2-normalize.ts` + `sql/03-drop-v1-columns.sql`):
  1. **Closed deals as V2 closes them:** no step on WON / LOST / UNREACHABLE; on LOST / UNREACHABLE whatever the client
     asked for and never got is `WITHDRAWN` "obchod uzavretý" at the closing date.
  2. **First calls in V2 shape:** `WANTS_QUOTE` / `WANTS_DESIGN` / `WANTS_EMAIL` → `INTERESTED` + `meta.asked`
     [`PRICE` / `DESIGN` / `INFO`]; the "Chceli" row is created **from that call** (its time, its caller, `origin LIVE`)
     and reconciled against the sends. This **replaces** the "received implies asked" backfill (`2026-09-wave5-requests.ts`
     is not run).
  3. **Ownership history** as V2 writes it: one `DealOwnership HANDOFF` per deal (from nobody → owner, by the caller).
  4. **Call-stage leads carry no step** (V2 uses only the callback there).
  5. **Old records removed:** the 97 old `EMAIL_SENT` / `QUOTE_SENT` / `DESIGN_SENT` rows (replaced by the converted
     sends), the 7 old send audits; the 22 "Cena: X → Y" notes become V2 `PRICE_CHANGED` rows.
  6. **Converted sends are ordinary sends** (`historical: false`, original time; no label). `meta.migrated` /
     `meta.migration` stay only as invisible provenance.
  7. **Dead columns dropped tonight:** `Lead.quoteSentAt`, `aboutUsSentAt`, `priceDisclosed`, `designUrl`,
     `lockedById`, `lockedAt`. Rollback = Neon restore point.
  8. **Statistics:** no old/new distinction; all "Chceli" rows are `LIVE`.
- Kept on purpose: enum values of old activity types / outcomes (no rows use them after the window; removing a
  Postgres enum value means recreating the type — not worth it).
