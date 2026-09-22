# Wave 5 specification review R02 — response

Date: 2026-09-20. Answers `R02.md` in this folder.

**Where the work landed:** `context/features/01-salesrep/wave-5-proposal.md` (draft v3). That file is the single
source of truth; this page is the reviewer-facing index. Nothing is implemented, no schema is applied, nothing is
committed.

All eight findings are accepted. Two are solved differently from the suggestion: finding 2 (no stored manual/automatic
flag) and finding 5 (reopen takes the normal step default instead of the hard-coded „Zavolať“).

| # | Finding | Response |
|---|---|---|
| 1 | Chronological satisfaction cannot be a close / reopen toggle | **Accepted.** New §6.7: one `reconcileRequests(tx, leadId)` runs under the Lead lock at the end of every operation that touches requests or receipts. It replays that lead's requests and all **valid** receipts by instant and writes the result, so it is order-independent and repeatable — the same pattern wave 3a already uses for the receipt summaries. §5 defines the instants: a request uses its source activity's instant (not a rounded business day), a receipt uses `offerInstant(meta, createdAt)`, and a same-call phone price resolves that call's requests **by link**, never by comparing equal timestamps. A crossed-out send reopens a row only when no other valid receipt still satisfies it; otherwise the resolution moves to that receipt. |
| 2 | An automatic step could erase a deliberately chosen SEND step | **Accepted, solved without the suggested origin flag.** §6.4 now says the stored step changes **only inside a user command**; the projection supplies the default and an explicitly submitted step wins, applied after reconciliation. Nothing recomputes the step in the background, so there is no "was this automatic?" question to answer and no new column to migrate. A "Poslať cenu" kept after a phone price survives every later reconciliation, and recording that email completes it normally. When nothing is outstanding the headline is the stored step's own label. **Why not the flag:** it would add a persisted field whose only job is to remember something the command already knows, and a wrong default at rollout would either freeze old steps or erase user plans. |
| 3 | Migrated rows need provenance and a repeatable identity | **Accepted.** `LeadRequest` gains `origin` (`LIVE` / `MIGRATED_RECEIPT` / `MIGRATED_OPEN_STEP`), a unique `migrationKey` built from the approved source identity, `provenance` (source ids, confidence, approved exception) and a **nullable** `requestedById` so an unknown historical actor is never silently attributed to the current owner (§6.2). The backfill is dry-run by default, repeatable, verified per source identity, and runs after the canonical receipt conversion (§11). |
| 4 | Only `nextActionKind` was derived | **Accepted.** §6.8 is a full transition table over all five step fields, including: the kind did not change → date, mode and note stay untouched (so an in-progress návrh does not restart its age); a price that becomes dominant becomes `SCHEDULED` today instead of inheriting `IN_PROGRESS`; the locked-task case keeps the wave-3 "no date" rule; nothing outstanding keeps today's command rules. The `clientSections` / `TODAY_SQL` parity tests are extended to every row (§10.13). |
| 5 | Close / reopen lifecycle undefined | **Accepted, with one correction.** Closing leaves open rows as they are (they stop showing because checklists and warnings only apply to active deals) and withdraws nothing. Reopening, however, does **not** keep the hard-coded "Zavolať": it takes the normal step default (§6.8), so a deal whose návrh was never sent reopens on "Poslať návrh" today, and "Zavolať" remains only for the case where nothing is outstanding (§6.10). The old fixed step was a wave-3 simplification, not a decision. |
| 6 | Raw events vs. actionable contents | **Accepted.** §6.9: one pure `clientRequestState` returns the history as events and the outstanding work **grouped by content**. Checklist, headline, list warning, send-dialog pre-ticks, "Požiadať manažéra" and `sendCompletesStep` all use the grouped set; statistics use the raw `LIVE` events. Two price asks = one row to act on, two events to count. |
| 7 | The Prisma sketch lacked relations | **Accepted.** Real optional relations for the source activity, the resolving activity and both users, plus the back-relation collections on `Lead`, `User` and `Activity`; and because a foreign key cannot prove the activity belongs to the same lead, every command asserts same-`leadId`, expected type and not-crossed-out under the Lead lock (§6.2). |
| 8 | Manager edit rights ambiguous | **Accepted.** §6.4 now reads: the current owner may edit; a manager with `deals.manage` may edit any deal in scope, including another rep's; an ownerless deal is manager-only; out of scope → `NOT_FOUND`. |

**Consequences recorded in the draft**

- Estimate raised from ≈ 25–30 h to **≈ 30–36 h** (reconciliation, grouped projection, full step table, migration
  identity, the extra tests).
- The test list grew with the R02 cases: backdated send between two requests, two sends and a correction of either,
  same-call ask + phone price, manual step precedence, every row of the step table against the list SQL, two open
  requests of one content, backfill rerun / interrupted rerun, cross-lead and crossed-out activity links, close /
  reopen, and a reopen whose step comes from the outstanding rows.
- Schema stays additive: S-16 (`LeadRequest` with `origin` / `migrationKey` / `provenance`, plus the three enums),
  S-17, S-18, S-19.

**Open**

- **Q2**: the reviewer agrees with the draft — the call-history line only, no extra `/calls` column.
- **Q7**: answered by Michal after R02 was written — there is **no timing rule and no second warning** where the step
  already says it. The deal list already shows the step with its own urgency ("dnes" amber, "2 dni po termíne" red,
  `lib/overdue.ts`). The row warning appears only when an open request is **not covered by the current step**, e.g.
  the step is "Zavolať" while a price is still owed (§3.2).
- Then: the wave-3 human click-through, a short re-review of v3, and only then the schema on the test branch.
