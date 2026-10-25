# Feature 02 — implementation review R02 resolution

Date: 2026-10-25. Fixer: Claude (Opus 5.5). Checkout `backup/recycling-2026-10-25`, starting HEAD `3502689` with
`R02.md` untracked. Database: development copy `ep-divine-waterfall-asbkuort` / `neondb` only. Production untouched.
No schema change.

**Result: all fourteen R02 findings addressed. Twelve are fixed in code or documentation and verified on the
development copy. Two need the owner and are recorded here as open owner actions: R02-13 (production admin
password) and confirming the Frankfurt region and Fluid compute on the next deployment. The do-not-call part of
R02-04 is also limited by the data itself; see below.**

`R02.md` is unchanged (`.ai/reviews/README.md`: review files are immutable). `.ai/reviews/review-format.md` does
not exist and `.ai/review-format.md` is empty, so this record follows the structure of the existing
`R01-resolution.md`: a resolution matrix with finding IDs, supporting decisions, verification, and the limits that
remain. Decisions taken while resolving are recorded in the spec (`recycling-spec.md` §16), so the spec stays the
source of truth.

Owner input used: Michal switched the Vercel function region to Frankfurt (`fra1`). Neon runs in `eu-central-1`,
also Frankfurt. Everything else was left to the fixer ("resolve all the problems").

## Resolution matrix

| Finding | Status | Change and verification |
|---|---|---|
| **R02-01** latency-bound recycle (P1) | **Resolved** | `lib/domain/recycleMutations.ts` `archiveRounds` writes a whole chunk set-based: one `createManyAndReturn` for the archive rows; one FK-only `UPDATE … FROM unnest(live, archive)` per child table (raw SQL, so R01-01's timestamp preservation holds); one `updateMany` reset with `round + 1` and one bump each; one `UPDATE` for `roundStartedAt`. `recycleLeadsAs` validates each contact exactly as before. The "already recycled" check is one query per chunk instead of one per contact. **Measured** with the R02 probe: 100 contacts in **460 ms** (was 14 873 ms) and 10 contacts in 370 ms, at a 20 ms round trip. New `rc10Budget`: 100 contacts must finish within 60 round trips + 2.5 s; measured 526 ms against a 3.7 s budget. Chunk size and the 30 s transaction timeout are unchanged: the timeout is a lock-time safety brake, not a duration target (spec §16). Michal moved the functions to `fra1` |
| **R02-13** production admin password (P1, outside the feature) | **Owner action — open** | Cannot be verified or fixed from a development session (production is never touched). Michal must check whether the live `michal` account uses `password123` and change it if it does. Listed in the progress tracker's owner actions |
| **R02-02** admins locked out of recycled contacts (P2) | **Resolved** | `app/dashboard/contacts/page.tsx`: the lock depends on the viewer, mirroring `lockContactForManage`. With `contacts.deleteAny`, an unclaimed NEW contact is editable, including a recycled one; everyone else needs `editable` (round 1). This is the pre-feature behaviour for managers. Verified by `check-recycling-http.ts`: the admin sees "Upraviť kontakt" on a recycled pool contact; the scout who added it does not |
| **R02-03** queue position relative to the filtered list (P2) | **Resolved** | `lib/queries/contacts` pool view computes `row_number() OVER (ORDER BY POOL_ORDER_SQL)` over the whole pool (`POOL_SQL`, the new SQL twin of `POOL_WHERE`), then narrows to scope and filters. Rows carry `queueRank`, which the page shows in both layouts. The claim also uses `POOL_SQL`, so the pool predicate exists once in SQL and once in Prisma. Tests: `kvQueueRank` (round filter, scout scope, and no filter all match the true rank) and `kvPoolParity` (`POOL_SQL` = `POOL_WHERE` over 458 pool contacts). HTTP: a searched row shows "214. v poradí", its real rank |
| **R02-04** no do-not-call protection (P2, workflow) | **Resolved within the available data** | Panel search covers `note` and `lostReason`, and a **Poznámka** column shows the note. `DO_NOT_CALL_PATTERN` (nevolať, nevolajte, nekontaktovať, neotravovať / neotravujte, „do p…", GDPR) has a TypeScript twin (`isDoNotCall`) and an SQL twin (`DO_NOT_CALL_SQL`), and hides matching candidates **by default** (`dnc=hide`). The panel shows "Skryté – v poznámke „nevolať“: N" with a "zobraziť aj tieto" link. If they are shown and selected, the dialog warns in red. Tests: `rc12DoNotCall` (word list, including no false hit on "nevolali"; TS = SQL over all 4 420 leads; hidden, counted, shown, found by note, counted in the summary) and the HTTP check. **Limit (measured):** only 39 of 2 481 closed call-stage contacts have any note, because the first call stores a refusal only as "Nemajú záujem". On today's data the filter hides one contact: a deal whose loss reason matches „do p…". A reliable exclusion needs a real "nevolať" call outcome, recorded as backlog **BL-15** (owner decision) |
| **R02-05** no warning when an active caller loses queue work (P3) | **Resolved** | Rows and selections carry `holderActive`. `summarizeRecycleSelection` returns `callers` (retry / scheduled / snoozed held by an active caller); the dialog warns "Miriam Jurčová: 2 z fronty volaní … zmiznú volajúcemu". Test `rc13Callers` covers an active caller, a deactivated holder and closed contacts. Seen in the browser (the dialog was cancelled) |
| **R02-06** header number ≠ the count its link shows (P3) | **Resolved** | The header link carries only the scope its number counts (`view=pool` + `createdBy` / `team`). HTTP check: opened with `round=2` and a search, the link is exactly `/dashboard/contacts?view=pool`, and the header shows 214 while the switch it opens shows 214 |
| **R02-07** "obvolaný" label on recycled contacts (P3) | **Resolved** | `ContactRowActions` takes `lockReason`. A recycled contact in the pool shows "recyklovaný", with a tooltip saying only a manager or admin may edit it. Verified by the HTTP check as the scout |
| **R02-08** batch order ignores the admin's sort (P3) | **Resolved** | `roundStartedAt` = request start + position in the admin's selection (ms), from one time base across all chunks. The selection order is the client's order: first-N rows in sort order, a whole page in display order, single ticks in click order. Test `rc11Order`: 120 contacts selected in random order (two chunks) are queued exactly in that order |
| **R02-09** archive rows consume `#number` (P3) | **Accepted, documented** | Spec §4.3 and `database-map.md` state that each recycled round takes one number. No schema change |
| **R02-10** tests outside the standard checks (P3) | **Resolved** | `code-standards.md` §7 lists the three feature 02 scripts and the new `check-recycling-http.ts`, run sequentially. `operations.md` (Scripts) describes them. The HTTP render checks moved from the git-ignored `.claude/` into the tracked `prisma/backfill/check-recycling-http.ts` (own users and fixtures, signed local sessions only for those users, cleanup) |
| **R02-11** spec drift (P3) | **Resolved** | `recycling-spec.md`: status line, §6 revision rule, §10 `rc4Invisible` / `rc8Revision` coverage, §5.2 search and do-not-call, §15.2 rank, and new §16 |
| **R02-12** `maxDuration = 300` needs Fluid compute (P3) | **Resolved in the runbook; owner check open** | `production-rollout.md` A7a: confirm region `fra1` (switched by Michal, applies to deployments made after the change) and Fluid compute ON on the new deployment. Neon is `eu-central-1` |
| **R02-14** UI nits (P3) | **Resolved** | "Vybrať prvých N" is disabled at 0, says it replaces the selection (tooltip and toast "predchádzajúci výber nahradený"). Pagination arrows at the edges are real disabled buttons, not links. HTTP check: no pagination link on a single page |

## Supporting changes

- **No regression in R01's fixes.** R01-01 (child timestamps) still holds: the set-based moves remain raw FK-only
  SQL, and `check-recycling-review.ts` passes. The R01-02 metadata grew by `holderActive` / `doNotCall`; both list
  rows and first-N rows carry them, so `check-recycling-resolution.ts` parity still passes (20/20).
- `archiveCopy` returns `Prisma.LeadCreateManyInput`; `rc1Snapshot` still proves every column is copied or excepted.
- New panel URL parameter `dnc` (`hide` by default, `show`) goes through `parseRecycleParams` / `recycleHref`, so
  list, counts, holders, first-N and the hidden count share one predicate.
- Two UI strings first used a straight `"` after „ and failed lint (`ui-context.md` §4). They now use the
  typographic “.

## Tests added

`check-concurrency.ts`: `rc10Budget`, `rc11Order`, `rc12DoNotCall`, `rc13Callers`, `rc14DeleteRecycled` (a
deleted recycled contact keeps its archive; both hidden), `rc15PoolStats` (total unchanged, LOST −1, NEW +1),
`kvQueueRank`, `kvPoolParity`. New `prisma/backfill/check-recycling-http.ts` (8 checks: R02-02, -03, -04 ×2, -06,
-07, -14, setup). Together they cover all six "tests to add" listed in R02.

## Verification (all actually run, 2026-10-25, development copy)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint .` | 1 error — the known `components/layout/MobileNav.tsx` |
| `npx next build` | OK (`/dashboard/admin/recycle`, `/dashboard/contacts`) |
| `check-business-time.ts` (local and `TZ=UTC`), `check-client-sections.ts` | passed |
| `prisma migrate diff` dev DB ↔ schema | empty (no schema change) |
| `check-concurrency.ts --expect-endpoint ep-divine-waterfall-asbkuort --iterations 100` | **274/274** |
| `check-recycling-review.ts` | 0 failures |
| `check-recycling-second-pass.ts` | **55/55** |
| `check-recycling-resolution.ts` | **20/20** |
| `check-recycling-http.ts --base http://localhost:3100` | **8/8** |
| R02 performance probe | 10 → 370 ms, 100 → **460 ms** (was 1.7 s / 14.9 s) |
| Fixture leftovers | none (pool still 213 = the 210 + 3 recycled during the R02 review) |

Browser (logged in as `michal` on localhost): the panel shows the do-not-call line and the Poznámka column. Selecting
two of jurcovam's retries opens the dialog with "Miriam Jurčová: 2 z fronty volaní … zmiznú volajúcemu"; the dialog
was cancelled and nothing was recycled.

## Remaining limits and owner actions

1. **R02-13:** check the production admin password and change it if it matches.
2. **Deployment:** confirm on the next deployment that functions run in `fra1` and Fluid compute is on (A7a), and
   run the A7a rehearsal against the development copy. Not verifiable from here.
3. **BL-15:** decide whether "nevolať" becomes a real call outcome. Until then the protection only covers what
   people wrote into notes or loss reasons.
4. Not done in this round: a deployed run of the feature, and a click-through on a phone of the new dialog warnings.
   Both are human checks.
