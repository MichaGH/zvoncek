# Wave 5 specification review R03 — response

Date: 2026-09-20. Answers `R03.md` in this folder.

**Where the work landed:** `context/features/01-salesrep/wave-5-proposal.md` (draft v4). That file is the single
source of truth; this page is the reviewer-facing index. Nothing is implemented, no schema is applied, nothing is
committed.

All five findings are accepted as written. None of them needed a different solution, and none changes the model.

| # | Finding | Response |
|---|---|---|
| 1 | The projection omitted a returned task result once the task closes | **Accepted — a real regression of a shipped wave-3 invariant, and the reviewer's reading of the code is right:** a finished task is `DONE`, and its result lives on in `pendingItems()` until a send fulfils it or someone dismisses it, so `openTask` alone can never see it. The projection now takes the manager work as its own input — `managerWork = { making, prepared }` — and the outstanding set is the **union of three sources**: open client requests (*treba poslať*), the open task's PRICE / DESIGN (*robí sa*) and a returned PRICE / DESIGN that is not yet sent or dismissed (*pripravené*), grouped by content (§6.9). The case with **no** `LeadRequest` at all (the rep asked the manager on their own) therefore behaves exactly as wave 3 does today: the price holds the step, the send consumes it, and only then is the follow-up call offered. `OTHER` and `DECLINED` stay acknowledgement items and never become send contents. Wave 4 fills the same two lists from `taskPartState` without changing the signature. |
| 2 | "Covered by the current step" and the headline were undefined | **Accepted**, with the reviewer's policy written as one pure `coveredContents(stepKind, outstanding)` and an explicit table (§6.9a): `SEND_EMAIL` covers INFO / PRICELIST / REVIEW, `SEND_QUOTE` covers PRICE, `SEND_DESIGN` covers DESIGN **and** PRICE (the shipped I10 rule — a návrh email carries the price), and `CALL` / `WAITING_FOR_CLIENT` / `CUSTOM` cover nothing. If the stored step covers the dominant outstanding content, the headline is the combined list; if the rep deliberately chose a narrower step, the headline is that step's own label and everything uncovered warns — "Poslať cenu" + "⚠ Chceli návrh". The same function feeds the list row, the detail, the pills and the counts, and the SQL twin is covered by the parity test. |
| 3 | Test 17 asserted the opposite of the reopen rule | **Accepted.** Split into the two cases: outstanding content → the §6.8 dominant send step due today; nothing outstanding → the fixed "Zavolať" today with `REOPEN_STEP_NOTE`. |
| 4 | "Crossing out a call" is not an operation in this app | **Accepted.** Removed from test 5, and the test list now says explicitly that wave 5 adds no generic call correction; the only call reversal remains the first-call revert (test 6). The correction contract for `OFFER_SENT` is unchanged. |
| 5 | The pencil did not say which rows may be withdrawn | **Accepted.** `setClientAsksAs` takes `add: RequestContent[]` and `withdraw: string[]` of **request row ids**; only `OPEN` rows of the same lead may be withdrawn (`SENT` / `WITHDRAWN` → `STALE`), so a resolved row never loses its receipt link; "už to nechcú" withdraws every open row of that content by id; the reason is required only when something is withdrawn; the audit row carries `added`, `withdrawn` (ids **and** contents) and `reason`, and its fingerprint is over the sorted row ids, the sorted added contents and the reason (§6.4). |

**Also done in this pass**

- **Q2 marked decided** as the reviewer suggested: the selected contents appear in the call history line; no extra
  column in the call lists.
- New tests: **18** (manager work with no client request — finish a PRICE task, the price stays outstanding, the send
  consumes it, a correction brings it back; same for DESIGN and for a withdrawn request with a result still waiting)
  and **19** (coverage — PRICE and DESIGN outstanding with "Poslať cenu" deliberately kept; list row, detail headline
  and pills agree).
- Estimate unchanged at ≈ 30–36 h; the projection line grew by an hour.

**Open before freezing**

1. The outstanding wave-3 phone/desktop human click-through (unchanged gate).
2. The short verification this review asked for: that the projection takes the prepared results and that tests 5 and 17
   were corrected.
3. Then freeze as `wave-5-proposal-final.md` and apply S-16 – S-19 on the test branch.

No open questions for Michal from this round.
