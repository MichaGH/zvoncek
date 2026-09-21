# V1 live → V2: what changes (readable overview for Michal)

Written 2026-09-21 from the code only: V1 = `origin/main` (`8e8b183`, same Prisma schema as `7beb689`), V2 = the current
working tree. **The live database has not been inspected yet.** Everything below is "what the code says the data
looks like". The clone inventory (`03-inventory-plan.md`) must confirm it.

Legend: **ADD** = new thing, nothing old is touched · **FILL** = new thing whose value is computed from old data ·
**TRANSFORM** = the meaning moves from an old place to a new one · **KEEP** = unchanged · **DROP LATER** = removed only
in a separate step after V2 is stable.

---

## 1. Tables and columns, side by side

### 1.1 Unchanged tables (KEEP)

`User` (only the `Role` enum gains `SALES_REP`), `Team`, `Invite`, `DesignVersion`, `Tracker`, `TrackerEvent`.
No row in these tables is rewritten. Tracker tokens, versions and view events stay exactly as they are.

### 1.2 `Lead` — columns that stay with the same meaning (KEEP)

`id`, `number`, company/contact data, `note`, `status`, `origin`, `projectType`, `ownerId`\*, `createdById`,
**`nextActionKind`, `nextActionAt`, `nextActionHasTime`, `nextActionMode`, `nextActionNote`**,
`callbackKind`, `callbackAt`, `callbackHasTime`, `callbackNote`, **`price`, `priceNote`**, `lostReason`, `deletedAt`,
`designUrl` (dead), `lockedById`/`lockedAt` (dead), `createdAt`, `updatedAt`.

The next step is never touched by the send conversion. A deal that is "Poslať návrh, rozpracované od 3. 9." in V1 is
exactly that in V2. `NextActionKind` has the same six values in both versions.

\* `ownerId` is filled with Michal **only** for old deals that have no owner — see §2.1.

### 1.3 `Lead` — new columns

| New column | Kind | Where the value comes from |
|---|---|---|
| `pipelineEnteredAt` | FILL | V1 had no "is this a deal" marker, only `status`. Filled with the time of the lead's positive first call from the call queue. `NULL` = call stage, set = deal. |
| `handedOffById` | FILL | who made that positive call |
| `closedAt` | FILL | deals that are WON/LOST/UNREACHABLE: time of the last status change (fallback `updatedAt`) |
| `assignedCallerId`, `assignedCallerAt` | FILL | V1 had no personal queue. Call-stage leads that are still being called (CALLING / SNOOZED with queue calls) get their **last caller**. NEW untouched leads stay in the shared pool. |
| `revision` | ADD (0) | +1 on every lead a backfill touches |
| `offerAboutUsAt`, `offerPricelistAt`, `offerPriceAt`, `offerReviewAt` | FILL | recomputed from the new `OFFER_SENT` rows (§3). Never written by hand. |
| `hadLegacySends`, `legacySendsReviewedAt` | **not added** | test-only "?" layer; must be removed from the V2 code/schema before release |

### 1.4 `Lead` — old columns whose meaning moves (TRANSFORM, then DROP LATER)

| Old column (V1) | What it meant in V1 (from the code) | Where it goes in V2 |
|---|---|---|
| `aboutUsSentAt` | date "Email o nás" was marked sent. Button disabled afterwards, no undo → at most one per lead. | `OFFER_SENT` with `ABOUT_US` (§3) → `offerAboutUsAt`. Column dropped later (P-02). |
| `quoteSentAt` | date "CP odoslaná" was marked sent. Undo clears it (but keeps the `QUOTE_SENT` row and `priceDisclosed`). A re-send overwrites the date. | `OFFER_SENT` with `ABOUT_US` + `PRICE` (§3) → `offerPriceAt`. Dropped later (P-01). |
| `priceDisclosed` | "klient pozná cenu" tick. **Automatically set to true when a CP is marked sent**, and stays true after undoing the CP. Also a separate manual toggle. | Not converted: only an explicitly sent CP counts (Q2). Dropped later (P-03). |
| `designSentAt` | latest "návrh sent" date across the lead's designs. **Not recomputed when a design is deleted** in V1. | Stays as a column, but becomes a summary recomputed from `OFFER_SENT` návrh sends. |

### 1.5 `Design`

| Column | V1 | V2 |
|---|---|---|
| `sentAt` | last time this návrh was toggled "sent" (toggle off → `NULL`) | first time it was sent, recomputed from `OFFER_SENT` |
| `legacySentAt` | — | **not added** (test-only) |

Everything else in `Design` is KEEP.

### 1.6 `Activity`

| | V1 | V2 |
|---|---|---|
| New columns | — | `idempotencyKey` (unique), `leadRevision`, `revertedAt`, `revertedById`, `taskId` — all ADD, empty for old rows, except `leadRevision` on each lead's latest first call (FILL, so a call can still be reverted) |
| Old rows `QUOTE_SENT`, `EMAIL_SENT`, `DESIGN_SENT` | the send records | KEEP as raw history. Each gets a canonical `OFFER_SENT` next to it; the old row becomes the "source". |
| New types | — | `OFFER_SENT`, `CLIENT_REPLIED`, `TASK_*`, `CALLER_*`, `CALL_REVERTED`, `DEAL_REOPENED`, `CLIENT_ASK_CHANGED`, `PRICE_CHANGED` (enum ADD) |
| New outcomes | — | `WANTS_TO_ORDER`, `INTERESTED` (enum ADD). Old `WANTS_QUOTE/DESIGN/EMAIL` rows stay readable. |
| New source | — | `CLIENTS` (enum ADD) |

### 1.7 New tables (ADD)

| Table | After migration |
|---|---|
| `DealTask`, `DealTaskPart` | empty — V1 had no manager tasks |
| `DealOwnership` | empty — older owner changes stay visible only as old `OWNER_CHANGED` activities |
| `LeadRequest` ("Chceli") | FILL from converted sends and open send steps (§4) |

---

## 2. Transformations that are not about sends

### 2.1 Call stage vs deal (Round 1 backfill, `prisma/backfill/2026-09-assignments.ts`)

| V1 lead | V2 result | Same place? |
|---|---|---|
| ACTIVE/SNOOZED/WON/LOST/UNREACHABLE with exactly one positive first call | deal: `pipelineEnteredAt` = that call, owner kept (**Michal if it had none**), closed ones get `closedAt` | yes (pipeline) |
| CALLING / SNOOZED call-stage lead | `assignedCallerId` = last caller | yes, now in that caller's personal queue instead of a shared view |
| NEW, never called | pool | yes |
| LOST/UNREACHABLE closed in the call stage | unchanged | yes |
| **NEW with call history** (e.g. calls happened, then V1 "Vrátiť do volaní") | stays NEW in the shared pool; its old calls are marked reverted (Q6 = a) | yes |
| soft-deleted lead | classified and filled like the others, stays deleted (Q9) | yes |
| **V1 "Vrátiť do volaní" after a positive call** (NEW + positive call still in history) | same: stays NEW in the pool, old calls marked reverted (Q6 = a) | yes |
| any `OUTCOME_CORRECTED` activity in the DB (V1 "opraviť výsledok") | accepted, the corrected result is used (Q6 = a) | yes |

### 2.2 Routing team

A team "Obchod" with leader Michal is created so telesales positive calls land with Michal (ADD).

---

## 3. Sends: old ticks → "Klient dostal" (your rule, 2026-09-21)

V1 had three separate buttons: **Email o nás**, **CP odoslaná** (+ "klient pozná cenu" tick), and **per návrh
"odoslané"**. Each click recorded one thing. A lead can have several (e.g. email in June, CP in July).

V2 records one `OFFER_SENT` per email with any combination of **Info · Cenník · Cena · Návrh · Rozbor webu**.

**Your mapping (answers of 2026-09-21, round 2):**

| V1 click | V2 "Klient dostal" for that send |
|---|---|
| Email o nás | **Info** |
| CP odoslaná (not undone) | **Info + Cena** |
| Návrh odoslaný | **Info + Návrh** |
| Price only filled in, or only the "klient pozná cenu" tick | **nothing** — the price stays on the deal as its current price, but the client is not marked as knowing it |
| Undone CP / undone návrh | **nothing** (the old rows stay in history) |
| (nothing) | nothing; no cenník, no rozbor webu for anyone |

- **Cena = only when a price was explicitly sent (a CP).** The amount is today's `Lead.price`. If the CP activity
  wrote a different amount at send time, the lead is listed for you to choose.
- **Still open (Q1):** about-us email or návrh sent **with a filled price but no CP** — did the price go with it? We
  decide after the clone shows how many such leads there are (possibly lead by lead). Until then: no Cena.
- Several old clicks on the **same day** = one email with all their contents.
- Návrh sent whose Design was later deleted → still "návrh sent" ("návrh mimo systému").
- Deleted contacts are converted too; they stay deleted.
- Channel = EMAIL, date = the day of the old click, marked `migrated` + `historical` so statistics can exclude them.
- Author = whoever clicked in V1 (always a manager). With only a date field and no activity row, the author is
  "unknown, migration".

**Examples**

| V1 lead | V2 "Klient dostal" | V2 "Chceli" | Step (list shows) |
|---|---|---|---|
| Email o nás 1. 9., step "Zavolať 8. 9." | Info 1. 9. | Info ✓ | Zavolať 8. 9. |
| CP odoslaná 5. 9., price 900 € | Info + Cena 900 €, 5. 9. | Info ✓ Cena ✓ | unchanged |
| Email o nás 1. 9. + CP 1. 9. (same day) | one email 1. 9.: Info + Cena | Info ✓ Cena ✓ | unchanged |
| Návrh smrek1 odoslaný 10. 9., price 1 200 €, no CP | Info + Návrh, 10. 9. (Cena → Q1) | Info ✓ Návrh ✓ | unchanged |
| Price 900 € filled, nothing sent, step "Poslať cenu" | nothing | **Cena — treba poslať** | Poslať cenu |
| Nothing sent, step "Poslať návrh — rozpracované od 3. 9." | nothing | **Návrh — treba poslať** | Poslať návrh, trvá X dní |
| Návrh v1 sent 1. 8., step "Poslať návrh" again from 20. 8. | Info + Návrh 1. 8. | Návrh ✓ (1. 8.) **and** Návrh — treba poslať (20. 8.) | Poslať návrh |

---

## 3a. Steps: what changed between V1 and V2

**Storage did not change.** Both versions store exactly one step per deal in the same columns: `nextActionKind` (one
of `CALL`, `SEND_QUOTE`, `SEND_DESIGN`, `SEND_EMAIL`, `WAITING_FOR_CLIENT`, `CUSTOM`), `nextActionAt`, `nextActionMode`
(termín / rozpracované), `nextActionHasTime`, `nextActionNote`. The migration copies nothing and changes nothing there.

**What is new is how V2 *shows* a send step.** The combination ("Poslať návrh + cenu + info") is **not stored in the
step**. It is computed on screen from the open "Chceli" rows (`LeadRequest`):

- the list and the detail show the combined headline if there are open rows, otherwise the plain label of the stored
  kind ("Poslať cenu", "Poslať návrh", "Poslať úvodný email");
- pills, filters, "Na dnes", sorting and dates still use the stored `nextActionKind` only.

Consequence for old deals: after migration every old deal shows **the same step, date and mode** as in V1. The
combined headline appears only where the "Chceli" backfill created open rows (§4) — and for an old deal that is exactly
the one thing its V1 step said (Poslať cenu → cena, Poslať návrh → návrh, Poslať email → info). V1 never had
combinations, so nothing gets lost.

Other V2-only step rules do not affect migrated deals on day one: the step lock needs a manager task (none exist
after migration), and the "recompute the step after a send" rule only runs when someone records a new send in V2.

## 4. "Chceli" for old deals (`LeadRequest`, Wave 5 backfill)

Your earlier rule: whatever the client received, they asked for (row `SENT`). An open deal whose step is
Poslať cenu / návrh / email and that has not received it yet gets an `OPEN` row, so the work is not lost.

**Problem found in the current script:** it creates the `OPEN` row only when the lead has **never** received that
content. So an old deal that got návrh v1 in August and now waits for návrh v2 would show nothing to send in "Chceli"
(the step itself stays "Poslať návrh", but the checklist would be empty). Proposed fix: the `OPEN` row is dated at
the moment that step was set, and it stays open unless something was sent **after** that. Recorded in
`02-data-mapping.md` §6.

---

## 5. What is dropped, and when

| Object | When |
|---|---|
| `Lead.quoteSentAt`, `Lead.aboutUsSentAt`, `Lead.priceDisclosed` | **not** in the first release. V2 stops reading them; they are dropped in a separate later step after V2 is stable (D-006). |
| Old activity rows, `Lead.designUrl`, `lockedById/At` | never in this rollout |

---

## 6. Open questions

Answered 2026-09-21: Q2–Q5, Q7–Q9 (see `DECISIONS.md` D-003). Q6 = (a): reset contacts stay NEW in the pool, old calls
marked reverted, no legacy leftovers. Still open: **Q1** (price on about-us / návrh sends without a CP — decided after
the inventory).
