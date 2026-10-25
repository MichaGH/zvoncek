# Feature 02 — Recycling contacts ("Recyklácia")

**Status: v1 DECIDED and built on the development copy (2026-10-25); reviewed in R01 and R02, both resolved.** All
questions in §13 are decided (Michal, 2026-10-25: Q1–Q3 and Q6 chosen, the rest by accepting the recommended
defaults). Changes made after R02 are in §16. Not in production; steps in `production-rollout.md`.

Read first: `AGENTS.md`, `context/project-overview.md` (§1 stage rule, §5 concurrency), `context/domain/database-map.md`.

---

## 1. Problem and goal

We can no longer afford scouts adding new contacts. The pool is empty — **10 contacts** in the shared pool on the
database copy of 2026-10-24 — and the only telesales caller needs new work **within ~12 hours**.

Thousands of contacts have already been called and ended somewhere: not interested, wrong number, never picked up,
snoozed, deals that were lost or simply forgotten. Many of them are worth calling again: enough time has passed, and
the best ones once said "yes, send us something". Some of those were never followed up (Michal: months without
follow-up, návrhy promised and never sent).

**Goal:** the admin can pick ended or stuck contacts in bulk from a data panel and **recycle** them: the contact
becomes a fresh `NEW` contact in the shared pool, exactly as if it had just been added, and everything that happened
before is **archived, not deleted**, so a later feature can show previous rounds.

**Non-goals for v1** (§12): viewing the archived rounds, undo in the UI, automatic recycling rules, statistics per round.

## 2. How contacts end today — measured, with corrections

Numbers: read-only census of the database copy `ep-divine-waterfall-asbkuort` (production as of 2026-10-24),
run 2026-10-25. The oldest activity in the data is from **2026-06-15**, so "enough time has passed" means at most
~4 months right now.

### 2.1 Telesales phase (call stage, `pipelineEnteredAt IS NULL`)

| Michal's case | What the app really stores | Count | Correction |
|---|---|---|---|
| 1. "they never pick up" | **not an end state.** "Nezdvihli" = `CALLING` + `callbackKind RETRY`, and the contact **stays in the caller's queue forever** — nothing closes it automatically | 1 432: **timea 1 379**, jurcovam 52, michal 1. 1 271 were called exactly **once** | Not dead — an untouched retry backlog. Verified (§2.3): the attempts are real `CALL` rows, not a migration artefact. The caller called each new contact once and then took the next batch instead of retrying |
| 2. "wrong number or unavailable" | `UNREACHABLE`, last call `BAD_NUMBER` | 420 | Recycling gives the caller the same wrong number again unless someone fixed it. Allowed, but the panel warns |
| 3. "they pick up and say no" | `LOST`, last call `NOT_INTERESTED` | 2 061 | — |
| (not in your list) "call me in X months" | call-stage `SNOOZED` (wakes on its date by itself, stays with the caller) | 16 | Recycling is possible but usually unnecessary — they come back on their own |
| (not in your list) agreed callback | `CALLING` + `SCHEDULED` | 71 | Live work with a date. Recyclable only deliberately |

### 2.2 Manager phase (deal, `pipelineEnteredAt` set)

| Michal's case | What the app really stores | Count | Correction |
|---|---|---|---|
| 1. "got a návrh but didn't want it" | deal `LOST` (+ `designSentAt` set) | 61 lost deals, of which 4 got a návrh | Cases 1 and 2 are the **same status** (`LOST`). The only difference is *what they received* (`offer*At`, `designSentAt`) and the free-text `lostReason`. The panel shows "dostali: info / cena / návrh" so you can tell them apart |
| 2. "got info but never got interested" | deal `LOST` (37 of the 61 got info) — **or still `ACTIVE`** with a step nobody did | see right | The forgotten ones are mostly **not closed**: 111 deals are `ACTIVE`, **28 have a step more than 30 days overdue**, 12 have an open "Chceli" (6 of them a návrh that was never sent) |
| 3. "lost contact" | deal `UNREACHABLE` | 7 | Or `ACTIVE` with many "nezdvihli" |
| (not in your list) parked deal | deal `SNOOZED` | 4 | — |
| won | `WON` | 1 | **Never recyclable** |

Deal owners today: `michal` (ADMIN) 53 active + 60 lost + 7 unreachable, `jurcovam` (SALES_REP) 58 active.
Recycling an active deal removes it from its owner's pipeline — the panel must show the owner.

Open manager tasks: 2 (5 tasks in total). A deal with an open task is **not** recyclable (§5.3).

**Michal (2026-10-25):** he will review and close the forgotten active deals himself later; once closed they are
ordinary `deal_lost` / `deal_unreachable` candidates. `deal_active` stays recyclable but is not the v1 focus.

### 2.3 Timea has left — her call work is the first thing to recycle

Michal, 2026-10-25: timea no longer works for the company, and her contacts must be recyclable. Her account is still
active in the copy. She holds **1 453 call-stage contacts** and no deals or tasks:

| Her work | Count | What it is |
|---|---|---|
| `CALLING` + `RETRY` ("Nezdvihli") | 1 379 | last call 2026-06: 43 · 07: 173 · 08: 404 · 09: 580 · 10: ~180. Almost all called once |
| `CALLING` + `SCHEDULED` (agreed callback) | 59 | the client gave a time — promised work |
| call-stage `SNOOZED` | 15 | "ozvať sa o X mesiacov" |
| `NEW` in her batch | 0 | |

Her first-call record (June–October): about 1 640 no-answers, 1 820 "nemajú záujem", 350 wrong numbers, 120
interested. That is why the `call_lost` bucket is the second big source (2 061 contacts).

What the app can already do **today, without this feature** (`/dashboard/calls/assignments`, `transferCallWorkAs`):

- move her `RETRY` / `SCHEDULED` / `SNOOZED` work, in any amount, to **another active caller** — they stay retries
  with their history ("1. pokus") and land in that caller's "Opakovať" list;
- it **cannot** return retries to the shared pool ("Do fronty sa vracajú len nové kontakty") — that is exactly what
  recycling adds;
- deactivating her (`deactivateUserAs`) is allowed now (she holds no deals or tasks); it only releases `NEW`
  contacts, so her retries, callbacks and snoozes stay assigned to the deactivated account until they are moved or
  recycled.

Consequences for this feature: the panel's *Kto to mal* filter lists **deactivated** users too (marked
"deaktivovaný"), and the command recycles contacts held by a deactivated caller (it locks that user row like any
other and never requires the holder to be active). Q12 decides what happens to her 59 callbacks and 15 snoozes.

## 3. What "recycle" means (definition)

Recycling one contact, in one transaction:

1. **Archive** — the complete current state of the contact (every `Lead` column) and **everything attached to it**
   (call history, deal history, what they asked for, what we sent, tasks, owner history, návrhy with their tracking)
   is kept, untouched, in an **archive record** of that contact (§4).
2. **Reset** — the live contact keeps its identity and contact data (id, `#number`, firma, telefón, web, email, and
   who originally added it and when) and everything else returns to the state of a freshly added contact: `NEW`,
   nobody assigned, no owner, no step, no price, no history (§4.3).
3. **Count the round** — the live contact's `round` goes 1 → 2 → 3… ("2. kolo").
4. **Back to the pool** — it enters the shared pool and is claimed with "Vziať ďalších 10" like any new contact.

Nothing is ever deleted. A recycled contact is, for every existing screen, query and rule, indistinguishable from a
new contact except for its round number.

## 4. Data design

### 4.1 Options considered

| Option | How | Why not / why |
|---|---|---|
| A. Round column on every child | `round` on `Lead`, `Activity`, `LeadRequest`, `DealTask`, `DealOwnership`, `Design`; every query filters "current round" | **Rejected.** Dozens of queries read children by `leadId` (pool `NOT EXISTS CALL`, attempts, history, revert, `reconcileRequests`, `recomputeOffers`, tasks, last touch, stats…). Missing one filter = a silent bug in live data. Too invasive for 4–8 hours |
| B. New live row | create a new `Lead` with the contact data, hide the old one | **Rejected.** The contact gets a new id and a new `#number` (Michal wants both kept); scout statistics would double-count or lose attribution |
| C. Delete the history | — | **Never.** |
| **D. Archive row (chosen)** | the live row keeps id + number and is reset; a **new hidden `Lead` row** receives a copy of the old columns, and all child rows are re-pointed (`UPDATE … SET "leadId" = <archive id>`) | Every existing query keeps reading children by the live `leadId` and finds nothing → behaves exactly like a new contact, **with zero changes to existing queries**. The archive row is a complete, internally consistent old contact (all foreign keys, activities, requests, tasks, sends still match each other), hidden by the existing soft delete. A later "previous rounds" view can render it with the existing detail components |

### 4.2 Schema proposal (S-R1, additive only)

```prisma
model Lead {
  // … existing fields unchanged …

  // Recyklácia (feature 02): koľké kolo je to (1 = pridaný, 2 = raz recyklovaný…).
  round          Int       @default(1)
  roundStartedAt DateTime? // kedy kontakt vstúpil do súčasného kola (recyklácia); NULL = kolo 1 = createdAt
  // Archívny riadok: celý stav jedného skončeného kola. Živý kontakt ho má v `archives`.
  archiveOf      Lead?     @relation("LeadArchive", fields: [archiveOfId], references: [id], onDelete: Restrict)
  archiveOfId    String?
  archives       Lead[]    @relation("LeadArchive")
  archivedBy     User?     @relation("LeadArchivedBy", fields: [archivedById], references: [id])
  archivedById   String?   // kto kolo uzavrel recykláciou; čas = deletedAt archívneho riadku

  @@index([archiveOfId])
}
// User: + archivedLeads Lead[] @relation("LeadArchivedBy")
```

Expected SQL (to be regenerated with `migrate diff` and reviewed before applying — `production-rollout.md`):

```sql
ALTER TABLE "Lead" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1,
                   ADD COLUMN "roundStartedAt" TIMESTAMP(3),
                   ADD COLUMN "archiveOfId" TEXT,
                   ADD COLUMN "archivedById" TEXT;
CREATE INDEX "Lead_archiveOfId_idx" ON "Lead"("archiveOfId");
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_archiveOfId_fkey" FOREIGN KEY ("archiveOfId")
      REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_archivedById_fkey" FOREIGN KEY ("archivedById")
      REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Data safety: no `DROP`, no retype, no new enum value. `round` is the only `NOT NULL` column and has a constant default
(PostgreSQL fast default, no table rewrite); every existing contact becomes round 1, which is true. `Lead` is 2.8 MB /
4 212 rows, so the index and the brief `ACCESS EXCLUSIVE` lock are instant. Old code keeps working against the new
schema (it never selects the new columns), so **schema first, code second** is safe and rollback of the code alone is
safe.

No new `ActivityType`: the archive row's columns (`archiveOfId`, `archivedById`, `deletedAt`, `round`) are the audit
record. This avoids the "enum value before code" ordering trap entirely.

### 4.3 Every `Lead` column: archive copy and live reset

The archive row gets **every** column copied from the live row as it was just before recycling, except the ones
marked below. The live row is then reset.

| Column | Archive row | Live row after recycling |
|---|---|---|
| `id` | new cuid | **kept** |
| `number` | new autoincrement value (hidden, never shown as the contact's number). Consequence (R02-09, accepted): every recycled round consumes one number, so the next contact a scout adds jumps by the number of contacts recycled | **kept** |
| `companyName`, `phone`, `website`, `email` | copy | **kept** |
| `note` | copy | **kept** as is (Q2, decided) |
| `origin` | copy | **kept** |
| `createdById`, `createdAt` | copy | **kept** (scout attribution and "contacts added" statistics must not change) |
| `status` | copy | `NEW` |
| `projectType` | copy | `NULL` |
| `ownerId` | copy | `NULL` |
| `nextActionKind`, `nextActionAt`, `nextActionNote` | copy | `NULL` |
| `nextActionHasTime`, `nextActionMode` | copy | `false`, `SCHEDULED` |
| `callbackKind`, `callbackAt`, `callbackNote` | copy | `NULL` |
| `callbackHasTime` | copy | `false` |
| `price`, `priceNote`, `lostReason` | copy | `NULL` |
| `designSentAt`, `offerAboutUsAt`, `offerPricelistAt`, `offerPriceAt`, `offerReviewAt` | copy | `NULL` (nothing left to recompute from — all sends moved) |
| `assignedCallerId`, `assignedCallerAt` | copy | `NULL` (shared pool — Q4) |
| `pipelineEnteredAt`, `handedOffById`, `closedAt` | copy | `NULL` |
| `revision` | copy (old value) | old value **+ 1** (exactly one bump; every open tab goes `STALE`) |
| `deletedAt` | **now** (hides it everywhere) | `NULL` (only non-deleted contacts are recyclable) |
| `round` | copy (the round that ended, e.g. 1) | old value **+ 1** |
| `roundStartedAt` | copy | **now** |
| `archiveOfId` | **live id** | `NULL` |
| `archivedById` | **the admin** | `NULL` |
| `createdAt` / `updatedAt` | copy / Prisma | kept / Prisma |

The copy is written with **named fields** (`code-standards.md` §4), not a spread. A test enumerates
`Prisma.LeadScalarFieldEnum` and fails if any column is neither copied nor listed as an exception — a future `Lead`
column cannot be silently lost from the archive.

### 4.4 Child rows that move to the archive row

All rows with `leadId = <live id>` in: `Activity`, `LeadRequest`, `DealTask`, `DealOwnership`, `Design`.
Rows hanging below them move implicitly (`DealTaskPart` → task, `DesignVersion` / `Tracker` / `TrackerEvent` →
design). After the move the live contact has **zero** child rows; the archive row has all of them and is internally
consistent (`Activity.taskId`, `LeadRequest.sourceActivityId` / `resolvedActivityId`, `OFFER_SENT.meta.fulfils`,
`Activity.leadRevision` vs the copied `revision` all still match).

Consequences, all intended:

- `status NEW ⇒ no CALL activity` holds on the live row → it qualifies for the pool (`POOL_WHERE`, claim SQL).
- A client who opens an old návrh link still works: the tracker moved with the design and ingest never bumps a
  revision; the events land on the archive.
- Global uniques are unaffected (`Activity.idempotencyKey`, `LeadRequest.migrationKey`, `Tracker.token` move with
  their rows). A replay of an old idempotency key against the live contact finds the activity on another lead and is
  refused, which is correct.

### 4.5 Why the archive row is invisible everywhere (verified in code, 2026-10-25)

Every reader of `Lead` already excludes `deletedAt IS NOT NULL`: the pool (`POOL_WHERE`, claim SQL), the caller board
(`callWorkWhere`), pipeline (`DEAL_WHERE`), "Pre mňa" / "Čaká na mňa" (`lead.deletedAt: null`), História
(`getHandedOverHistory`), deactivation and role-change guards (`heldDealWork`, `getRemainingWork`), contacts lists and
the duplicate-phone check, pool and "contacts added" statistics, and every mutation guard (`requireCallLead`,
`requireDealWork`, `requireDealManage`, `revertCallResultAs`, contact edit/delete). The implementation must re-verify
this list with a test (§10) rather than trust this paragraph.

Two places read `Activity` without looking at the lead, and both are fine:

- call statistics count `CALL` activities by user and date → round-1 calls stay counted (they really happened), and
  round-2 calls count as new calls;
- call history (`/dashboard/calls/history`) lists the caller's last 200 calls → archived calls still appear, with
  revert/edit already disabled for a deleted lead. **Display fix (small, in scope):** for an archived lead show the
  live contact's `#number` and a "1. kolo" label instead of the archive row's hidden number.

## 5. Which contacts can be recycled

### 5.1 Buckets (one predicate each, shared by list and count)

| Bucket key | UI label | Predicate (all also `deletedAt IS NULL`, `archiveOfId IS NULL`) | Default selected in the panel |
|---|---|---|---|
| `call_retry` | Volania – nezdvihli | call stage, `CALLING` + `RETRY` | **yes** (timea's backlog, §2.3) |
| `call_scheduled` | Volania – dohodnuté volanie | call stage, `CALLING` + `SCHEDULED` | no |
| `call_snoozed` | Volania – odložené | call stage, `SNOOZED` | no |
| `call_lost` | Volania – nemajú záujem | call stage, `LOST` | **yes** |
| `call_unreachable` | Volania – zlé číslo | call stage, `UNREACHABLE` | no (warns) |
| `deal_active` | Obchody – aktívne | deal, `ACTIVE` | no |
| `deal_snoozed` | Obchody – spiace | deal, `SNOOZED` | no |
| `deal_lost` | Obchody – stratené | deal, `LOST` | yes |
| `deal_unreachable` | Obchody – nedostupné | deal, `UNREACHABLE` | yes |

Never recyclable: `NEW` (nothing to recycle), `WON`, a deal with an `OPEN` `DealTask`, a deleted contact, an archive
row. The predicates live once in `lib/domain/recycling.ts` (pure, client-safe) with their Prisma `where` twins in
`lib/queries/recycling`, following "one predicate per pill" (`ui-context.md` §5).

### 5.2 Filters on top of a bucket

- **Kto to mal** — for deals the owner (`ownerId`); for call-stage contacts the assigned caller, or — because
  "Nemajú záujem" / "Zlé číslo" clear `assignedCallerId` — the author of the last call; plus "nikto". Deactivated users are listed too, marked "deaktivovaný" (§2.3).
- **Posledný kontakt staršie ako** — 7 / 30 / 60 / 90 days / any. *Last contact* = the newest non-reverted `CALL`,
  `CLIENT_REPLIED`, `SMS_SENT` or `OFFER_SENT` activity; a contact with none uses `createdAt`.
- **Pokusy (nezdvihli)** — at least N non-reverted `NO_ANSWER` calls (useful for `call_retry`).
- **Dostali / chceli** (deals) — got info / price / návrh; has an open "Chceli" návrh / price / info.
- **Kolo** — 1 / 2+.
- **Hľadať** — firma, web, telefón, email, poznámka, dôvod straty, `#číslo`.
- **Nevolať** (§16) — contacts whose note or loss reason contains a do-not-call word are hidden by default; the panel
  says how many and can show them.

Sort: last contact oldest first (default) / newest first, added oldest / newest, `#number`.

### 5.3 Rules checked again under the lock

The panel is only a view. The command re-checks every contact under its row lock (§6) and **skips** it, with a
reason, when: it was deleted or already recycled, its `revision` differs from what the admin saw ("zmenil sa
medzitým"), it is no longer in a recyclable bucket, or a deal got an open task.

## 6. The operation — `recycleLeadsAs`

`lib/commands/recycling.ts`, exposed through a thin action in `lib/actions/recycling`. Pure parts in
`lib/domain/recycling.ts` (buckets, eligibility, the reset field block, the archive copy field list).

**Input** (strict zod): `{ items: { leadId: string, expectedRevision: number }[] }`, 1–500 items, unique ids.
The client sends exactly the rows the admin selected, with the revision each row had on screen. The server never
recycles "everything matching a filter" it computed itself — what you saw is what gets recycled.

**Permission:** `contacts.recycle` (new permission, matrix edit only — §9) checked on the DB user before and under
the lock.

**Per batch** (≤ 100 leads, ascending id, one `withLockTx` each with `timeout: 30s`, `lockTimeout: 10s`):

1. Read `assignedCallerId` / `ownerId` of the batch without a lock.
2. Lock the actor + those users `FOR SHARE`, ascending id (lock order `Team → User → Lead`; no team is touched).
   Serializes with deactivation / role change, which take the user row `FOR UPDATE`. Only the **actor** must be
   active; a holder may be deactivated (timea, §2.3) — that is not a reason to skip.
3. Lock the leads `FOR UPDATE`, ascending id. **No `SKIP LOCKED`** (`project-overview.md` §5 rule 4): a lead busy in
   a caller's save waits up to the lock timeout; a timeout makes the batch `RETRYABLE`.
4. Re-validate each lead (§5.3), including that `assignedCallerId` / `ownerId` did not change since step 1.
5. For each valid lead: insert the archive row (§4.3), re-point the children (§4.4) with five
   `UPDATE … SET "leadId" = $archive WHERE "leadId" = $live`, reset the live row with exactly one revision bump.
6. Return per lead `RECYCLED` or `SKIPPED` + reason.

**Double submit / retry:** a repeated request carries the old `expectedRevision`, so every already-recycled lead is
seen as changed. To report it as success instead of a scary skip, the command recognises "an archive row of this lead
with `revision = expectedRevision` exists" as `ALREADY_RECYCLED`. No operation id or idempotency table is needed, and
a contact can never be recycled twice by one click.

**Result:** `{ recycled: number, skipped: { leadId, number, reason }[] }`. Reasons: `CHANGED`, `NOT_ELIGIBLE`,
`OPEN_TASK`, `NOT_FOUND`, `ALREADY_RECYCLED` (counted as recycled).

**Revision rule:** the live lead is bumped exactly once (`bump` in the reset + `markLeadBumped`); the archive row keeps
the old revision; the children are not bumped. Since §16 the write is set-based per chunk (`archiveRounds`). A test case goes into `prisma/backfill/check-concurrency.ts` (§10).

## 7. Effects on the rest of the app

| Area | Change needed | Note |
|---|---|---|
| Pool and claim order | **yes, small** — order by `COALESCE("roundStartedAt", "createdAt"), id` in the claim SQL (the board's own NEW list is a batch of ≤ 10 and keeps its `createdAt` order) | FIFO by the time a contact entered the pool (Q3, decided). Otherwise recycled contacts (old `createdAt`) would always jump ahead of newly scouted ones |
| Call board / call sheet | **yes, small** — a "2. kolo" badge when `round > 1`; nothing about the previous round (Q6, decided) | `round` is added to the board's `SELECT` / `map`; no query of the archive |
| Contacts page (scouts) | **yes** — "untouched" (`NEW`, unclaimed, 0 calls) must also require `round = 1` | Otherwise a scout could edit or **delete** a recycled contact. Same rule for the scout leader's team check |
| Call history | small display fix (§4.5) | |
| Pipeline, tasks, História, dashboard | none | the contact leaves them because its children and stage moved |
| Statistics | none | calls stay counted; contacts-added unchanged; pool counts the recycled contact as new |
| Deactivation / role change | none | the archive row is deleted → not counted |
| Design tracking | none | events keep landing on the archived design |
| Revert of a first call | none | the archived call's lead is deleted → refused, button hidden |

## 8. The admin page — `/dashboard/admin/recycle` ("Recyklácia kontaktov")

Desktop-first data panel (admin lists are not phone-first, `ui-context.md` §1). Card on `/dashboard/admin` linking to
it, with the current pool size.

**Header:** "V spoločnej fronte: 10 · v dávkach volajúcich: 10" — so you see how much work exists before adding more.

**Bucket pills** (two rows: *Volania* / *Obchody*), each with a count computed by the same predicate as the list.
Several buckets can be combined.

**Filters** (§5.2) and **sort**, all in the URL (like `dealFilters.ts`), changing a filter resets paging and selection.

**Table**, 100 rows per page:
`☐ | # | Firma / web | Telefón | Stav | Kto to mal | Posledný výsledok | Posledný kontakt | Pokusy | Dostali / chceli | Kolo`

- *Posledný výsledok* = last call outcome or deal status + `lostReason` (e.g. "Nemajú záujem", "Stratené – drahé").
- *Dostali / chceli* = small icons as in the pipeline row (info, cena, návrh) and open asks ("chceli návrh").
- Rows of `call_unreachable` show a warning icon "zlé číslo".
- The number links to the live detail only for deals (`/dashboard/pipeline/[id]`), nowhere for call-stage contacts.

**Selection:** checkbox per row, header checkbox = this page, plus **"Vybrať prvých [N]"** (N ≤ 500) which asks the
server for the first N ids + revisions of the current filter and sort. A sticky bar shows "Vybrané: 120" with a
breakdown by bucket and "Zrušiť výber".

**Confirm dialog** (`ResponsiveSheet`): "Recyklovať 120 kontaktov?" — breakdown per bucket; warnings
("12 zlých čísel", "5 aktívnych obchodov – zmiznú z pipeline vlastníka jurcovam", "3 obchody s otvorenou požiadavkou
návrhu"); what happens ("Stanú sa novými kontaktmi (2. kolo) v spoločnej fronte. Doterajšia história sa archivuje.");
primary button "Recyklovať 120". The button label stays stable; it is disabled while saving.

**Result:** toast "Recyklované 118 · preskočené 2" and, if anything was skipped, a short list (`#412 – zmenil sa
medzitým`). `RETRYABLE` offers "Skúsiť znova" with the same items. The page refreshes.

## 9. Permissions and routes

- New permission `contacts.recycle` — ADMIN only by default (Q7). Matrix edit in `lib/permissions.ts`; no schema.
- Route `/dashboard/admin/recycle`: the proxy already requires `admin.access` for `/dashboard/admin/*`; the page and
  the command check `contacts.recycle` themselves (like the teams page checks `teams.manage`).
- Docs: route table in `project-overview.md` §4, permission in §3.

## 10. Tests and checks

New cases in `prisma/backfill/check-concurrency.ts` (they create and remove their own fixtures):

| Case | Asserts |
|---|---|
| `rc1Snapshot` | every `Lead` scalar column is copied or explicitly excepted (enumerates `Prisma.LeadScalarFieldEnum`) |
| `rc2Reset` | after recycling a deal with sends, requests, a closed task, ownership rows and a `Design`: live row equals the fresh-contact shape; it has 0 children; the archive has all of them with unchanged ids; `recomputeOffers` on the archive is a no-op |
| `rc3Pool` | the recycled contact is in `POOL_WHERE`, is claimable by `claimBatchAs`, ordered by `roundStartedAt` |
| `rc4Invisible` | the archive row appears in none of: pool, caller board, pipeline list, contacts list, deactivation counts, the recycle panel. ("Pre mňa", História, pipeline counts and contacts-added statistics are covered in `check-recycling-second-pass.ts` / `check-recycling-review.ts`.) |
| `rc5Stale` | wrong `expectedRevision` → `CHANGED`; open task → `OPEN_TASK`; `WON` / `NEW` → `NOT_ELIGIBLE`; repeat of the same request → `ALREADY_RECYCLED`, round still 2 |
| `rc6Race` | recycle vs `logCallAs` on the same lead, both orders: exactly one wins, the other gets `STALE` / `CHANGED`; recycle vs `deactivateUserAs` of the caller; recycling contacts of an **already deactivated** caller succeeds |
| `rc7Scout` | a scout cannot edit or delete a recycled contact |
| `rc8Revision` | exactly one bump on the live row; archive keeps the old revision (asserted inside `rc2Reset` as "RC-8") |

Then the full `code-standards.md` §7 pass, with `--expect-endpoint ep-divine-waterfall-asbkuort` for the database
checks. Browser click-through of the page and of claiming a recycled contact as `timea`'s role is a human check.

## 11. Delivery plan — 3 agents, 4–8 hours

The core is the command; the page is a view on it. Contract between agents = §5.1 bucket keys, §6 input/result types.

| Phase | Agent A (data + command) | Agent B (page) | Agent C (review + edges) |
|---|---|---|---|
| 0 (0.5 h) | — Michal answers §13, spec frozen — | | |
| 1 (≈1 h) | schema S-R1 on the dev copy (reviewed SQL), `db-changes.md` row; `lib/domain/recycling.ts` | `lib/queries/recycling` (list, counts, first-N ids) against the bucket contract | re-verify §4.5 invisibility list in code; contacts `round = 1` guard; claim order |
| 2 (≈2 h) | `recycleLeadsAs` + action; tests rc1–rc8 | page, filters, table, selection, confirm dialog | review A's command (locks, revision, copy list); call-history display fix; round badge |
| 3 (≈1 h) | fix review findings | fix review findings | full §7 check pass; docs (`database-map`, `operations`, `app-workflow`, `project-overview`, tracker) |
| 4 (≈0.5 h) | — Michal clicks through on localhost against the dev copy — | | |
| 5 (≈1 h) | — production rollout (`production-rollout.md`), first batch recycled — | | |

**Fallback if the page is late:** the first batch can be recycled from the same page with only the table and
selection (no filters), or — last resort, separately approved — by a dry-run-first script that calls the same command.
Same-day option that needs **no deploy at all**: if the new caller already has an account, "Priradenia" can move
timea's retries to them today (§2.3); they would then be retries instead of round-2 contacts.

## 12. Out of scope (later)

- **Viewing previous rounds** in the contact / deal detail ("1. kolo: nemali záujem, 7/2026"), built on
  `Lead.archives`. The data is complete from day one. This also covers showing the caller the previous ending in the
  call queue (Q6 chose the badge only for v1) and a caller note typed for a whole recycled batch.
- **Undo** in the UI. The design is reversible (move children back, restore columns, delete the archive row) as long
  as the live row is untouched since (`revision = archive revision + 1`); not built in v1.
- Automatic recycling rules ("every LOST after 90 days").
- Statistics per round; round-aware conversion rates.
- Rewording `db-changes.md` / environments for the new dev database (housekeeping, Q11).

## 13. Open questions — with recommended defaults

| # | Question | Recommended default |
|---|---|---|
| Q1 | Approach: live contact keeps id + `#number`, old history moves to a hidden archive row (§4) | **DECIDED 2026-10-25: archive row** |
| Q2 | `Lead.note` on the recycled contact: keep / clear / keep with a "[1. kolo]" prefix? The note is often the scout's observation, but a first call may have overwritten it with the caller's note | **DECIDED 2026-10-25: keep as is** (the archive has the same text) |
| Q3 | Pool order: recycled contacts by the time they were recycled (FIFO with new contacts), always first, or always after new ones? | **DECIDED 2026-10-25: by recycle time (FIFO)** |
| Q4 | Destination: shared pool only, or also "assign to a caller" in the dialog? Direct assignment would break the "max 10 unworked NEW per caller" rule | DECIDED 2026-10-25 (default accepted): **Pool only** |
| Q5 | Which buckets are allowed at all? (§5.1) — especially `call_retry` (mostly 1 attempt), `call_scheduled`, `deal_active` | DECIDED 2026-10-25 (default accepted): **All of §5.1**, pre-selected as in §5.1 (call retries, call `LOST`, lost / unreachable deals) |
| Q6 | What does the caller see? Nothing / "2. kolo" badge / badge + one line of the previous ending ("Predtým: obchod stratený · chceli návrh · 7/2026") / + a note you type for the whole batch ("ospravedlniť sa za neposlaný návrh") | **DECIDED 2026-10-25: badge only** ("2. kolo"). The previous ending and a batch note are later (§12) |
| Q7 | Who may recycle: ADMIN only, or MANAGER too (nicolas)? | DECIDED 2026-10-25 (default accepted): **ADMIN only** |
| Q8 | Scouts still see their recycled contacts in "Kontakty" (as NEW again) but can no longer edit/delete them. OK? | DECIDED 2026-10-25 (default accepted): **Yes** |
| Q9 | Hard guard against recycling recently touched contacts (e.g. activity in the last 7 days)? | DECIDED 2026-10-25 (default accepted): **No hard rule**; default filter "staršie ako 30 dní", warning in the dialog |
| Q10 | Undo in v1? | DECIDED 2026-10-25 (default accepted): **No** (§12) |
| Q11 | Housekeeping before we start: `db-changes.md` still lists the pre-rollout delta of 2026-09-22 and the old test endpoint | DECIDED 2026-10-25 (default accepted): **Clear the ledger to "nothing owed"** and point docs at the new dev copy. (`.env.migration` with the production URL: **deleted by Michal 2026-10-25**; it is recreated only in the rollout window) |
| Q12 | timea's 59 agreed callbacks and 15 snoozes (§2.3): recycle them with the retries, or move them to the new caller with "Priradenia" so the promised times are kept? | DECIDED 2026-10-25 (default accepted): **Move them to the new caller**; recycle only the 1 379 retries |

## 14. Risks

| Risk | Mitigation |
|---|---|
| A query somewhere does not filter `deletedAt` and shows the archive row | `rc4Invisible` + code re-verification in phase 1 |
| A future `Lead` column is not copied to the archive | `rc1Snapshot` enumerates the Prisma field list |
| Recycling a contact a caller is saving right now | row lock + `expectedRevision`; the caller gets `STALE` and a refresh |
| Recycling 2 000 contacts at once buries newly scouted ones | FIFO by `roundStartedAt` (Q3); the header shows the pool size |
| Bad numbers come back | warning icon + dialog warning; not pre-selected |
| An active deal disappears from a rep's pipeline unexpectedly | owner column, owner filter, explicit dialog warning |
| Production write mistake | additive schema only; restore branch before; no data migration at rollout; recycling happens through the reviewed command, contact by contact |

---

## 15. Addition after review R01 and its resolution — Kontakty shows what is available to call

**Added 2026-10-25, after implementation review R01 (`.ai/reviews/02-recycling/implementation/R01.md`) and its
resolution (`R01-resolution.md`, all six findings resolved).** Michal found this while clicking through the resolved
build. Decisions K1–K5 below were left to Claude by Michal ("you decide"); the recommended defaults were taken.

### 15.1 The problem

After recycling on the dev copy, Michal opened **Kontakty** and could not find the recycled contacts. Measured on
`ep-divine-waterfall-asbkuort` the same day:

- They **are** in Kontakty: 200 contacts in round 2, all `NEW`, all in the shared pool.
- Kontakty has one order only — when the contact was first added, newest first, 50 per page. Recycling deliberately
  keeps `createdAt` (§4.3: scout attribution and "contacts added" statistics), so the 200 sit at **positions
  3 274–4 204 of 4 207**, about 65 clicks on "Načítať ďalších 50".
- Even when found they show only "Nový", exactly like a contact added today.
- The header already counts them ("N voľných na volanie" uses `POOL_WHERE`), but there is no list behind the number.

Michal needs today's view kept (scouts use it to see what they added) **and** a view of everything available to call
right now, new and recycled together, with recycled ones marked.

### 15.2 Decided design

**View switch** at the top of Kontakty (`view` in the URL):

| View | Label | Shows | Order |
|---|---|---|---|
| `added` (default) | **Pridané** | every contact in scope — today's list, unchanged | added, newest first |
| `pool` | **Na volanie** | what a caller gets with "Vziať ďalších 10" now: `POOL_WHERE` (NEW, nobody holds it, never called in this round), new **and** recycled | **queue order** — the same `COALESCE(roundStartedAt, createdAt), id` as `claimBatchAs`, so row 1 is what the next caller gets |

**Kolo filter** (`round` in the URL), combinable with both views and with the existing filters:
Všetky kolá · Len nové (1. kolo) · Len recyklované (2. kolo a ďalšie).

| Question | How |
|---|---|
| What did scouts add? | Pridané |
| What can be called right now? | Na volanie |
| Only recycled / only fresh waiting to be called? | Na volanie + Kolo |
| What did I recycle and what happened to it since? | Pridané + Len recyklované |

**Marking** (desktop table and phone cards): status badge unchanged plus a small **"2. kolo"** badge when
`round > 1` (same wording as the call board); under the date "recykl. 25. 10." (`roundStartedAt`); in Na volanie the
first column is the **position in the queue** — the rank in the *whole* pool, also when a filter, the round or a scout
scope narrows the list (§16, R02-03).

**Counts:** each view on the switch shows a count computed with the same scope, filters and predicate as its list
(`ui-context.md` §5). The header's "N voľných na volanie" links to Na volanie.

**Scope is unchanged** and server-side: admin / manager see all (existing filters), a scout leader their team, a
scout their own. Na volanie inside a scope = the part of the pool that belongs to it. A scout's own recycled
contacts show "2. kolo" and stay locked for edit / delete (§7).

| # | Decision |
|---|---|
| K1 | Two views + the Kolo filter (no separate "Recyklované" tab) |
| K2 | Na volanie = shared pool only; a caller's claimed batch stays under the existing "Volá" filter |
| K3 | Badge text "2. kolo" |
| K4 | Scouts and scout leaders may use Na volanie within their own scope |
| K5 | The header number links to Na volanie |

### 15.3 Implementation notes

- No schema change.
- The queue order exists in two places (claim SQL and the Kontakty pool list) → **one shared SQL fragment**
  `POOL_ORDER_SQL` next to `POOL_WHERE`, plus a test that the first 10 rows of Na volanie are exactly what
  `claimBatchAs` claims next (`code-standards.md` §5).
- `ContactsFilterBar` rebuilds the query string from scratch; it must carry `view` and `round`, or any filter change
  jumps back to Pridané.
- Not changed: recycling itself, the call queue, the claim's behaviour, today's default list.

### 15.4 Alternatives rejected

Sorting Kontakty by "entered the pool" (breaks the scouts' view) · resetting `createdAt` on recycle (corrupts scout
statistics) · a new status "Recyklovaný" (`NEW` is a business state the whole app relies on) · only a link from the
recycle page (Michal looks for contacts in Kontakty).

---

## 16. Changes after review R02 (2026-10-25)

Review: `.ai/reviews/02-recycling/implementation/R02.md`; resolution record `R02-resolution.md` next to it. Michal's
inputs: the Vercel function region was switched to Frankfurt (`fra1`), the same AWS region as Neon (`eu-central-1`);
everything else was left to the resolver ("resolve all the problems").

| Finding | Decision / change |
|---|---|
| R02-01 latency | The write is **set-based per chunk** (`archiveRounds`): one insert for all archive rows, one FK-only update per child table, one reset, one start-time update — ~8 statements per 100 contacts instead of ~700. Measured 0.5 s instead of 14.9 s at a 20 ms round trip. Chunk size and the 30 s transaction timeout unchanged (the timeout is a lock-time safety brake, not a duration target) |
| R02-08 order | The queue order of a recycled batch is **the admin's selection order** (`roundStartedAt = start of the request + position in the selection, in ms`), across all chunks |
| R02-03 rank | Kontakty → Na volanie shows each contact's rank in the **whole** queue (SQL `row_number()` over `POOL_SQL`, the SQL twin of `POOL_WHERE`), not its row number in the filtered list |
| R02-06 header link | "N voľných na volanie" links to Na volanie with only the scope its number counts (`createdBy` / `team`), so the click shows the same number |
| R02-02 edit | The Kontakty lock depends on the viewer, as on the server: managers and admins (`contacts.deleteAny`) can edit an unclaimed NEW contact again, including a recycled one (e.g. fix a wrong number); a scout only their own untouched round-1 contact |
| R02-07 label | A recycled contact in the pool is locked as **"recyklovaný"** (tooltip: only a manager / admin may edit it), not "obvolaný" |
| R02-04 do-not-call | Panel search covers the note and the loss reason; a **Poznámka** column shows the note; contacts whose note or loss reason matches `DO_NOT_CALL_PATTERN` (nevolať, nevolajte, nekontaktovať, neotravovať / neotravujte, „do p…", GDPR) are **hidden by default** with a visible count and a "zobraziť aj tieto" link; if shown and selected, the dialog warns. Limit (measured 2026-10-25): only 39 of 2 481 closed call-stage contacts have any note — the first call records a refusal only as "Nemajú záujem". A real "nevolať" call outcome is a later feature (backlog) and Michal's decision |
| R02-05 callers | The dialog warns per **active** caller whose retries / callbacks / snoozes would leave their queue; a deactivated caller (timea) and closed contacts do not warn |
| R02-09 numbers | Accepted and documented (§4.3) |
| R02-12 hosting | Runbook A7a: confirm `fra1` and Fluid compute on the new deployment |
| R02-14 UI | "Vybrať prvých N" is disabled at 0 and says it replaces the selection; pagination arrows are real disabled buttons at the edges |
