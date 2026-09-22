# Wave 5 specification review R01 — response

Date: 2026-09-20. Answers `R01.md` in this folder.

**Where the work landed:** `context/features/01-salesrep/wave-5-proposal.md` (draft v2). That file is the single
source of truth; this page is the reviewer-facing index of what changed. Nothing is implemented and no schema is
applied.

**Headline changes made because of this review**

1. **A request is an event, not a label.** New table `LeadRequest` (lead, content, state, `requestedAt`, who,
   source activity, resolution) replaces the proposed `Lead.askedFor` array. A receipt satisfies a request only if it
   happened after it, so "asked again in September" is real work (§6.2).
2. **`NOTHING_SPECIFIC` removed** (Michal agrees): two callers cannot tell it from "Info / ukážky".
3. **A normative mapping table** ask → satisfying send content → channel → internal step (§5).
4. **One outcome per call + one new value `INTERESTED`** (§6.5). The dominant-value mapping suggested in the draft is
   rejected as untruthful: cenník-only would be stored as "info emailom" and price + návrh would be counted once.
   Old `WANTS_*` values stay readable; new calls stop writing them. Demand statistics read the request rows.
5. **Migration without a legacy mode** (§11): the backfill writes explicit rows — `SENT` for converted receipts
   (Michal's rule "received = asked"), `OPEN` for an open deal whose send step has no receipt, nothing elsewhere.

| # | Finding | Response |
|---|---|---|
| 1 | Phone price vs. written price obligation | **Product rule (Michal):** a price heard on the phone is received. One projection; the SR may keep "Poslať cenu" by hand. §2, §5. |
| 2 | Lifetime array cannot express a later request | **Accepted** — request ledger, §6.2. `Lead.askedFor` dropped so there is one truth. |
| 3 | Mapping incomplete; `NOTHING_SPECIFIC` unfinishable | **Accepted** — §5 matrix; `NOTHING_SPECIFIC` removed. |
| 4 | First-call replay can lose a wish | **Accepted** — canonical `fp` including the sorted asks; tests §10.1. |
| 5 | A wave-3 task can overwrite the headline | **Accepted** — the stored kind is recomputed from open requests + task state, never the task content alone (§6.4); test §10.7. |
| 6 | Old open deals need a compatibility mode | **Solved differently:** explicit backfilled rows (§11), no permanent legacy mode in the code. |
| 7 | "No conversion" could cancel the old-send conversion | **Accepted** — §11 separates asks from receipts; the `db-changes.md` §3.3 conversion stays required before any column removal. |
| 8 | Stored headline vs. a deliberate CALL | **Accepted** — transition policy in §6.4: automatic recomputation only while the step is a system send step or a task lock; a manual plan is preserved, warnings remain; corrections reopen rows. |
| 9 | Revert / corrections must include the asks | **Accepted** — §6.4: first-call revert deletes that call's rows (refused if one is already satisfied); crossing out a send reopens its rows; crossing out a call does not silently remove asks. |
| 10 | `ASKED_CHANGED` had no contract | **Accepted** — S-18 `CLIENT_ASK_CHANGED`, keyed, `added` / `removed` / `reason` / `fp`, one bump, excluded from "Naposledy" (§6.3–§6.4). |
| 11 | Statistics must not read `CallOutcome` | **Accepted and strengthened** — new `INTERESTED` value (§6.5); statistics read the rows. |
| 12 | No general note for an unticked item | **Accepted** — "explain in the note" removed (§3.4). |
| 13 | `NOTHING_SPECIFIC` design choice | **Removed.** |

**Corrections to the review's assumptions about live data (Michal, 2026-09-20)**

- **There is no cenník in live production.** `PRICELIST` exists only on the test branch (wave 3a); the old system had
  no such content and no flag. The migration creates `PRICELIST` only for recipients Michal names by hand.
  `db-changes.md` §3.3 corrected.
- **A price plus "klient pozná cenu" means the exact calculated price, sent by email.** That is the bulk conversion
  rule; the clone inventory still has to classify the exceptions (flag without a price, price without the flag, undo
  sequences, several CPs).

**Still open** — `wave-5-proposal.md` §9: Q2 (does telesales need to see "Chceli" after the call), Q6 (rozbor webu in
every first email — a content decision), Q7 (warn at once or after some days). Q1, Q3, Q4, Q5 are decided in that table.

**Before implementation:** the wave-3 human click-through, then a re-review of the v2 draft, then the schema
(S-16 – S-19) on test, then the code. The production migration is a separate, explicitly authorised session on a clone
of production.
