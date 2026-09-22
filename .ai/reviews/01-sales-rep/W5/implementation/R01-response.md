# Wave 5 implementation review R01 — response

Date: 2026-09-20. Answers `R01.md` in this folder. Branch `feature/wave5-workflow-fix`, test database only. **No schema
change, nothing committed, nothing pushed, production not touched.**

Findings 1–5 are accepted. Finding 6 (status files) is accepted as a process rule, with nothing closed yet. The
"lower the tile saturation" remark in the UI paragraph is **not** taken (see the end). Three of the fixes differ from
the reviewer's suggestion; each says why.

| # | Finding | Response |
|---|---|---|
| 1 | Cenník backfill turns recipients into open work | **Accepted, different fix.** Removed the manual mode instead of repairing it (below) |
| 2 | Same-call phone price, sheet still forces "Poslať cenu" | **Accepted**, fixed on the server as suggested, plus one case the reviewer did not name |
| 3 | Close / snooze contradicts the newer workflow | **Accepted.** Michal's P7 rule (`wave-5-workflow.md` §6) is now the implemented one; one question left (Q2) |
| 4 | "Čo sme poslali" preselects unasked content | **Accepted** as written; no "first email" preset (Q3) |
| 5 | An untracked / PDF návrh cannot be recorded | **Accepted**, stricter than suggested |
| 6 | Status files say "open / unverified" | **Accepted as a rule**; nothing closed without Michal (Q4) |

## 1. BLOCKER — cenník recipients became `OPEN` rows

The reviewer's reading is right: `--pricelist-leads` inserted `PRICELIST` as `OPEN` / `MIGRATED_RECEIPT` with no receipt,
so a recipient looked like someone still owed a cenník.

**The suggested fix was to identify `leadId + activityId`, add `PRICELIST` to that send in the offer migration, and if
the Wave 5 script keeps a manual mode, make it verify a real receipt.** The first two steps are what
`db-changes.md` §3.3 already says. Once they are done, the normal receipt path produces the right `SENT` row by
itself, so a second manual mode in the Wave 5 script has nothing left to do but be wrong. I therefore **removed it**:

- `PRICELIST` is now a normal receipt source in the backfill (`INFO` / `PRICELIST` / `PRICE` / `DESIGN`). A canonical
  send that contains `PRICELIST` gets one `LeadRequest(PRICELIST, SENT)` linked to that send
  (`resolvedActivityId`, `resolvedAt`, `resolvedById`).
- No file, no flag, no `w5:pricelist:` key. Production had no cenník, so with no named recipient nothing is created.
- The SQL moved to `prisma/backfill/wave5-requests-sql.ts`, imported by the script **and** by a new test. The
  reviewer's point that the old test never ran the real branch is fixed by running the real statements, not a copy.
- `w5MigrationPricelist`: a lead with a canonical `PRICELIST` send and no request → the migration SQL run twice in a
  transaction that is rolled back → exactly one `SENT`, linked row, the second run adds nothing, and no migrated
  `PRICELIST` row is `OPEN` anywhere. (The rollback matters: the statement is database-wide, and the test must not
  leave migrated rows on other test leads.)
- Docs: `db-changes.md` §3.3 / §5 and `operations.md` now say recipients are named at the send conversion.
  A read-only dry-run of the rewritten script on test still works.

The send conversion script (`2026-09-offer-migrate.ts`) is still the unfixed prototype; adding a
`leadId + activityId` input there is part of its own rewrite, not this review.

## 2. Same-call phone price vs. the derived step

The reviewer's diagnosis is right: the sheet sent a step computed **before** saving, so the server never got to
derive it after the phone price resolved the price request.

Fix: `logFollowUpAs` accepts `stepFromRequests` (valid only with `asked`, outcome `POSITIVE`, no `nextKind`, no
`schedule`, not while the step is locked). The server writes the asks and the phone receipt, then derives the step from
what is **still** outstanding and stores it. The sheet no longer sends a step after "Chcú niečo poslať".
The flag is part of the canonical fingerprint only when set, so old fingerprints do not change.

One case the reviewer did not name: **PRICE alone** (the phone price covered everything they asked for). There is
nothing left to send, and the reviewer noted the old behaviour leaves "Poslať cenu" with no request behind it. Here the
server cannot derive a step, so it refuses with `STALE`; the sheet checks this **before** saving and goes to the
"Kedy ďalej?" screen (Zavolať · Čakáme na klienta · Vlastný krok), which is what `wave-5-workflow.md` §2 says for an
answer that does not decide the step by itself. A returned manager price that the rep did **not** use still counts as
outstanding, so that case does not fall into the "nothing left" screen.

The reviewer also raised keeping written confirmation after a phone quote. It is not offered, matching workflow §1
("a send step is never chosen"); if Michal wants it, it is a separate deliberate act later.

Test `w5StepFromRequests`: phone PRICE + asked PRICE on a deal that still needs INFO → **Poslať info** (the old client
computation gave "Poslať cenu"); PRICE + DESIGN → **Poslať návrh**, in progress; same key replays; changed payload
conflicts; nothing left → `STALE`, no rows written; the flag with an explicit step, without asks or on another
outcome is refused.

## 3. Close / snooze vs. the workflow contract

Two documents disagreed, and the test agreed with the older one. The newer one is Michal's own decision (P7:
"snoozing … asks nothing. It must."), so it wins. `wave-5-proposal.md` §6.10 now carries a short "partly
superseded" note pointing at it (I edited that protected file only for that note; nothing else in it).

What is implemented:

- The sheet knows the **exact open request ids** (new `openRequests` on the list row and the detail). On "Ozvať sa o
  pár mesiacov" and on "Nemajú záujem" it lists what the client asked for, says it will not be sent, and requires a
  reason. "Zlé číslo" uses the typed reason or "zlé číslo".
- The server takes `withdraw {ids, reason}`, allowed only for `SNOOZE`, `NOT_INTERESTED`, `BAD_NUMBER`. If the deal has
  open requests it is **required**; the ids must equal exactly the open rows **now**, otherwise `STALE` and a refresh
  (another tab changed them); a blank reason is refused. The rows are withdrawn under the same Lead lock as the
  snooze/close, with a `CLIENT_ASK_CHANGED` audit row, one revision bump. There is no "withdraw all" flag anywhere.
- Reopen: a withdrawn row is never revived; a deal with nothing outstanding reopens on the fixed "Zavolať".
- Not a client-side rule only: a client that sends no `withdraw` for a deal with open requests is refused by the server.

Test `w5CloseWithdraw`: missing / blank / partial / foreign-id → refused and nothing written; success = one bump,
all rows `WITHDRAWN` with the reason and actor, one audit row; same key replays without a second audit row; changed
reason conflicts; a request added in another tab → `STALE`, nothing withdrawn; LOST and UNREACHABLE withdraw; closing
without `withdraw` is refused; `withdraw` on a normal call is refused; reopen keeps them withdrawn and gives "Zavolať";
a deal with nothing open still snoozes as before. The old `w5CloseReopen` still passes: it covers the **manager's**
status change in the detail, which this fix deliberately does not touch (**Q2**).

## 4. "Čo sme poslali" preselects unasked content

Accepted as written. Only what the client asked for and has not received (plus the returned manager results and the
current step's content, both already so) is ticked. The rule is one pure function, `offerDefaults(asked)`, used by the
dialog and by the test `w5DialogDefaults` (a návrh-only request ticks no e-mail content). The dialog subtitle and
`app-workflow.md` §5a were reconciled — the context contradiction the reviewer found is gone. Not done: an "info +
cenník" preset (**Q3**).

## 5. Untracked / PDF návrh

Accepted, with two differences from the suggestion. The reviewer proposed "DESIGN with `untrackedDesign: true` and no
ids". That is the shape used (`meta.untrackedDesign`, never together with `designs`). Additionally:

- The server allows it **only when the deal has no non-deleted `Design`** (otherwise `STALE`: pick the design). The
  reviewer said the dialog should show the box only when there is nothing to pick; the server now enforces the same,
  so the flag cannot be used to bypass design tracking. It is also refused with design ids or with a returned-návrh
  `fulfils`.
- `Lead.designSentAt`. A deal without any `Design` used to keep its old value forever, so a new untracked receipt
  would have left "klient dostal návrh" showing **no**. Rule now: while a deal has no `Design`, the column keeps its
  legacy value **until** an untracked send is recorded for it; from then on it is recomputed from those sends (latest
  valid one, cleared if all are crossed out). This is the "historical design with no Design row" rule that
  `db-changes.md` §3.3 already requires after cutover. Known small edge: a deal with an old legacy date **and** an
  untracked send that is later crossed out ends with an empty date, because the old value cannot be recovered; the
  converted receipt from the migration will cover such a deal.
- `Design.sentAt` is not touched. The dialog shows one plain "Návrh — bez záznamu v systéme" box, ticked when a návrh
  was asked for and the deal has no design.

Test `w5UntrackedDesign`: refused without the flag / with ids / on other contents; recorded with the flag; request
`SENT` linked to the send; no `Design` row created; retry with the same key = one send; crossing it out reopens the
request and clears the date; a deal that has a `Design` cannot use it; an old `designSentAt` survives an unrelated send.

## 6. Status files

Agreed and done as a rule, not as a closure: `wave-5-followups.md` F4 stays **open**. Visual acceptance ("I like the
design") is recorded here only as Michal's words; behaviour acceptance waits for a click-through of findings 2–5
(phone and desktop). F1 and F2 stay open as the reviewer said. `progress-tracker.md` has a new block for this review
and its cenník wording is corrected. I did **not** edit `wave-5-followups.md` (protected).

## UI assessment

- **"Lower the tile saturation."** Not taken. Michal explicitly asked for the whole tile to be the contrasting colour
  with a white icon after finding the pale tint washed out (`wave-5-workflow.md` §10). It is his taste call and he made it.
- Everything else in that paragraph needed no action. I looked at the snooze screen with unsent asks in the dev
  preview on desktop: the warning box names the asks, the reason field is required, and the month buttons stay disabled
  until a reason is typed. The phone width and the full click-through are still Michal's.

## Michal's answers and the follow-up round (same day)

**Q1 — answered; it is the narrow rule, no code change.** Michal's clarification: the *old live app* let a user create a
**Cenová ponuka** (CP), tick that it was sent, and tick separately whether the client **saw** it; there was also an
"email o nás odoslaný" tick. Target: CP sent → **exact price sent**; "saw" ticked → **client saw the price**;
"email o nás" → info sent. That is what `db-changes.md` §3.3 already described for `QUOTE_SENT` / `priceDisclosed`; my
earlier reading ("every lead with a price written is a send") was a misreading of his message, and the note I had
added as "pending" is replaced by this clarified mapping. Two consequences are written down there:
(a) in the new model a `PRICE` receipt *is* "client saw the price", so a CP marked sent **without** the "saw" tick has
no faithful representation and goes to the exception list on the duplicate instead of being converted silently;
(b) the remark that every old "o nás" email also carried the exact price is **not** applied unless Michal confirms it
separately (it is unclear where the amount would come from).

**Q2 — yes.** A manager closing in the detail now behaves like the sheet: **LOST / UNREACHABLE** ("Nemajú záujem",
the status select) require a reason and withdraw the open requests by exact id (shared helper
`withdrawOpenOnLeave`, one revision bump, audit row, `STALE` if another tab changed them). **WON** leaves them and
refuses a withdraw. Test `w5ManagerClose`.

**Q3 — no preset.** Nothing added; the boxes stay separate and only the asked ones are ticked.

**Q4 — "one small detail" turned into three points plus the SMS follow-up**, all done:

1. **"Pozreli, chcú zmeny" and "Cena je vysoká" now lead to the manager.**
   *Before:* "chcú zmeny" saved at once, recorded a návrh request and set "Poslať návrh" — the manager was never asked;
   "Cena je vysoká" only offered a call or waiting, so the manager path was a hole, as Michal saw.
   *Now:* both open the "Kedy ďalej?" screen with **"Požiadať manažéra"** as the pre-selected step — a custom step
   **due today** with that note. Saving it opens the ask dialog immediately (cancel the dialog and the deal keeps a
   visible "Požiadať manažéra" step for today). "Zavolať" and "Čakáme na klienta" remain one tap away. "Chcú zmeny" also
   still records the `DESIGN` request (they did ask for a reworked návrh). The card only appears for the deal's owner and
   while the step is not locked by a manager task. It is a UI step on the existing custom step: **no new step kind, no
   schema change** — if you later want a real "Požiadať manažéra" filter/pill, that is a separate change.
   *Answer to "does Pozreli, chcú zmeny change the next step?":* yes, it always replaced the step; it now proposes the
   manager instead of "Poslať návrh".
2. **"Poslali sme SMS" can say the price was given.** The same price screen as for a call. A price in the SMS is recorded
   as an offer of channel `PHONE` with `via: "SMS"`, linked to the SMS row: it satisfies open price requests, is stored
   as the deal's price, shows as "Klient videl 990 € (SMS)" and never plans "Zavolať, či prišlo". I kept channel `PHONE`
   (meaning "not an email") so the existing queries that treat phone prices specially keep working; no enum or column.
   Test `w5SmsPrice`.
3. **"Poslali sme SMS" → keep the current step (your last message).** Agreed; "Chcú niečo poslať" from an SMS would
   overlap the call path, so it is not added. The next-step screen after an SMS now starts with **"Ponechať aktuálny
   krok"** (shows the current step's note), **pre-selected when the deal has a step** — one tap to save, no date needed.
   Picking anything else works as before. Server side it is `keepStep` (SMS only): writes the SMS and a price in it,
   changes nothing else, one revision bump. If you would rather have it *not* pre-selected, it is one line.
   Test `w5SmsKeepStep`.
4. **"Nezdvihli".** Your message broke off after "When I click for example nezdvihli, we have one problem" and went on to
   the three points above. I read those three as the problem list and changed nothing on "Nezdvihli" — **if there was a
   separate issue there, tell me what you saw.**

### Files added to this round
`lib/domain/clientReplies.ts`, `lib/domain/requestMutations.ts` (`withdrawOpenOnLeave`), `lib/domain/clientRequests.ts`
(`withdrawInputSchema`), `lib/domain/dealMutations.ts`, `lib/commands/pipeline.ts`, `lib/commands/dealWork.ts`,
`lib/domain/offers.ts`, `lib/domain/offerMutations.ts`, `lib/queries/pipeline/index.ts`,
`components/pipeline/InteractionSheet.tsx`, `DealDetail.tsx`, `CenovaPonukaCard.tsx`, the concurrency suite, and the
docs (`app-workflow.md`, `operations.md`, `database-map.md`, `db-changes.md`).

## Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| ESLint on every file I changed (components, commands, domain, queries, backfill, tests) | passed |
| `npx next build` | passed |
| `npx tsx prisma/backfill/check-business-time.ts` | passed |
| `npx tsx prisma/backfill/check-client-sections.ts` | passed (4,200 combinations) |
| New groups `w5MigrationPricelist`, `w5StepFromRequests`, `w5CloseWithdraw`, `w5DialogDefaults`, `w5UntrackedDesign` + `w5PhonePrice`, `w5CloseReopen` | **10 / 10** on the verified test endpoint (`…nhww8x`) |
| Full `check-concurrency.ts` (default iterations), after the follow-up round | **171 / 171** (final run, after the SMS keep-step) |
| Read-only dry-run of `2026-09-wave5-requests.ts` on test | ran, reports its counts; no write |
| `git diff --check` | clean (only the usual LF→CRLF notices) |
| Full `npx eslint .` | not re-run; the one known unrelated `MobileNav.tsx:17` error is unchanged |
| Browser | snooze screen with unsent asks checked in the dev preview (desktop). **Phone width and the real click-through were not done** |

## Files

Code: `lib/commands/dealWork.ts`, `lib/commands/offers.ts`, `lib/domain/offers.ts`, `lib/domain/offerMutations.ts`,
`lib/domain/clientRequests.ts`, `lib/queries/pipeline/index.ts`, `components/pipeline/InteractionSheet.tsx`,
`OfferSentDialog.tsx`, `DealDetail.tsx`, `app/dev/proposal/InteractionPreview.tsx`,
`prisma/backfill/2026-09-wave5-requests.ts`, new `prisma/backfill/wave5-requests-sql.ts`,
`prisma/backfill/check-concurrency.ts`.
Context: `app-workflow.md`, `domain/operations.md`, `domain/database-map.md`, `domain/db-changes.md`,
`progress-tracker.md`, and the one-note supersession in `features/01-salesrep/wave-5-proposal.md` §6.10.

Must wait for the production rollout: unchanged — the send conversion, the duplicate rehearsal, Q1's mapping and the
named cenník recipients.
