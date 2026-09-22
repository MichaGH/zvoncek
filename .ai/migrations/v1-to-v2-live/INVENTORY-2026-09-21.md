# Inventory 1 — first production clone, 2026-09-21

Read-only inventory of the first clone. Every query ran inside `BEGIN TRANSACTION READ ONLY` and was rolled back.
Scripts: `inventory/` in this directory. The output is sanitized: lead numbers, statuses, dates and amounts only.
No names, contacts, notes or URLs were written here.

## Identity

| | |
|---|---|
| Neon branch | "V2 migration (Sales rep implementation) testing", parent `Production`, data up to creation, auto-delete 7 days |
| Endpoint | `ep-dark-band-asjtba8q` (direct, not pooler); production `…m0xyun` refused by the tool |
| Database / server | `neondb`, PostgreSQL 18.6 |
| Created | 2026-09-21, shortly before 12:24 Europe/Bratislava |
| Canary | Michal edited live lead #3237's note at 12:24 after branching. The clone does **not** contain the edit, so this is a real point-in-time copy and not live. |

## Schema (Stage A) — matches V1 exactly

- 9 tables: `Activity, Design, DesignVersion, Invite, Lead, Team, Tracker, TrackerEvent, User`. There is no
  `_prisma_migrations` table: live was managed with `db push`.
- Every column, type, nullability and default, all 12 enums (values identical, `Role` has `SCOUT_LEADER` last), 33
  indexes and 12 FKs are equal to `origin/main:prisma/schema.prisma` (`8e8b183`, same schema as `7beb689`).
  `price` is `numeric(10,2)` and every timestamp is `timestamp(3) without time zone`.
- Extensions: `plpgsql` only. No views, triggers or extra sequences (only `Lead_number_seq`).
- **Consequence:** the Git baseline assumption in `context/domain/db-changes.md` holds for this snapshot. The additive
  diff `7beb689 → V2 target` applies as generated. It must be re-checked on the final clone.

## Row counts

| Table | Rows | | Table | Rows |
|---|---|---|---|---|
| User | 7 (3 SCOUT, 1 TELESALES, 1 MANAGER, 1 ADMIN, 1 SCOUT_LEADER; none deleted) | | Design | 19 |
| Team | 1 (with leader, 3 members) | | DesignVersion | 19 |
| Invite | 0 | | Tracker | 19 |
| Lead | 3 626 | | TrackerEvent | 128 |
| Activity | 4 340 | | | |

Leads by status: NEW 334 (+6 soft-deleted), CALLING 1 267, ACTIVE 63, SNOOZED 21, WON 1, LOST 1 588, UNREACHABLE 346.
**Only the WON deal has an `ownerId`.** Every other deal is ownerless and becomes Michal's (Q8).

Activities: CALL 3 554 (all `CALL_QUEUE`, no follow-up calls from the pipeline), EMAIL_SENT 61, QUOTE_SENT 21,
DESIGN_SENT 15, NOTE 16, NEXT_ACTION_SET 199 / CHANGED 157 / CLEARED 3, CONTACT_UPDATED 230, STATUS_CHANGED 64,
OWNER_CHANGED 1, TRACKER_ATTACHED 19. `OUTCOME_CORRECTED` **0**, `SMS_SENT` 0, `TRACKER_UPDATED` 0 (no návrh was
ever un-sent), `TRACKER_OPENED` 0.

Positive first calls: WANTS_EMAIL 65, WANTS_DESIGN 38, WANTS_QUOTE 13; `POSITIVE` 0. That is 116 deals: 113 from
TELESALES and 3 from ADMIN.

## Round 1 backfill (simulated read-only on the V1 schema, every V2 column taken as NULL)

| Class | Count | Statuses |
|---|---|---|
| DEAL_TO_MIGRATE | 116 | ACTIVE 63, LOST 39, SNOOZED 6, UNREACHABLE 7, WON 1 |
| CALLWORK_TO_MIGRATE | 1 282 | CALLING 1 267, SNOOZED 15. Last caller: TELESALES 1 280, ADMIN 2 |
| POOL | 334 (340 with the 6 deleted) | NEW |
| TERMINAL_OK | 1 888 | LOST 1 549, UNREACHABLE 339 |
| CONFLICT / NEW_WITH_HISTORY / STRAY / multi-match | **0** | |

- The `closedAt` fallback to `updatedAt` is never needed: every closed deal has a STATUS_CHANGED row.
- The one V1 "Vrátené do volaní" lead (#1204) was called again after the reset. It is now LOST with
  `TERMINAL_OK`, so **Q6 has 0 cases**.
- All 6 soft-deleted leads are NEW, never called, with no sends. They classify as POOL and nothing changes, so
  **Q9 has 0 practical cases**.
- 75 call-stage leads (CALLING 60 from CALL_AGAIN, call-stage SNOOZED 15 from SNOOZE) carry a V1 `nextAction*`.
  V2 reads the step only where `pipelineEnteredAt IS NOT NULL` (verified in `lib/queries/today/*`, pipeline), so
  this is harmless. **Leave it untouched.** A later positive call overwrites it.
- Closed deals (LOST/UNREACHABLE) often keep a stale step, e.g. LOST + SEND_DESIGN ×10, because V1 "Stav zmenený na …"
  did not clear it. It is harmless in V2: open-step logic uses ACTIVE/SNOOZED only, and reopening sets its own
  step. **Leave it untouched.**

## Sends (Stage B)

Field vs activity consistency:

| | Field | Activities | Note |
|---|---|---|---|
| about-us | `aboutUsSentAt` 60 | EMAIL_SENT 61 | #3237 has two EMAIL_SENT 71 s apart (double click, same day) |
| CP | `quoteSentAt` 18 | QUOTE_SENT 21 | #36 has 2 undone CPs; #41 was double-clicked in the same second |
| návrh | `designSentAt` 12 leads | DESIGN_SENT 15 | 15 sent Designs, **all matched 1:1** to a DESIGN_SENT within 2 s; no un-send, no sent+deleted Design |
| price | `price` 21 | "Cena:" rows 22 (21 leads) | every price has history; every QUOTE_SENT note carries an amount |
| tick | `priceDisclosed` 19 | manual "Klient oboznámený s cenou" 5 | the rest were set automatically by CP sends |

Zero field-only events: every field has its activity, so the actor is always known. Zero sends on non-deals.
Zero sends on deleted leads. Zero existing `OFFER_SENT` (the enum value does not exist yet).

**86 leads have sends. After same-day merging and dropping undone CPs, they become 88 converted sends:**

| Converted send | Count |
|---|---|
| Info only (old about-us) | 58 |
| Info + Cena (old CP, 2 of them merged with the same-day about-us: #659, #572) | 18 |
| Info + Návrh (old návrh; 3 of them carry two Designs sent the same day: #98, #2365, #618) | 12 |

Leads with two separate sends on different days: #131 (about-us 20.6, návrh 21.7) and #98 (about-us 17.6, návrh 9.7).

Same-day merges (Q5): #41 CP+CP, #3237 about+about, #659 about+CP, #572 about+CP, and #98, #2365, #618 návrh+návrh.

Undo (Q4): #36 had CP 18.6 (no amount) undone, CP 18.6 again undone on 25.6, then price 698 set and CP 25.6 with
698. Result: one CP on 25.6, 698 €.

### Per-lead decisions (Q1) — decided by Michal 2026-09-21: #628 Info + Cena 499 €; #98 no price; #404 689 €

| Lead | V1 timeline | Question |
|---|---|---|
| **#628** | about-us email 12.7 22:01:59 → price 499 € entered at 22:02:05 → "Klient oboznámený s cenou" at 22:02:07 | Was the 499 € in that email? The timing strongly suggests yes. Recommended: Info + Cena 499 € on 12.7. |
| **#98** | about-us 17.6 (no price yet) → 24.6 price 800 € + "Klient oboznámený" tick (no send that day) → 9.7 two návrhy sent | When did the client learn 800 €? (a) told on 24.6 → a phone price on 24.6; (b) in the návrh email 9.7; (c) not at all. |
| **#404** | CP 5.7 with 689 € → on 29.7 the price was lowered to 639 € (no new CP) | Which price did the client get? Recommended: the CP's 689 € as sent. V2 will then show "current price 639 € differs from sent", which is the truth. |

No decision needed: #916 (WON, price 499 €, nothing ever sent) gets no receipt (Q2).

## "Chceli" backfill (Stage D) — expected result

- Receipt rows (SENT, MIGRATED_RECEIPT): INFO 86, PRICE 19 (18 CP + #628), DESIGN 12.
- Open-step rows (OPEN, MIGRATED_OPEN_STEP): 12. These are 11 ACTIVE `SEND_DESIGN` (IN_PROGRESS, from WANTS_DESIGN,
  step set 10. 8. – 4. 9. 2026) and 1 ACTIVE `SEND_EMAIL` (#2886). **None of them has an older receipt of the same content**, so the
  current script already gives the right answer. D-007 has 0 cases.
- There are no open `SEND_QUOTE` steps at all, so Q3 has 0 cases.

## What this changes in the plan

The data is small and clean. Rules for situations that do not occur are **not implemented**. Each becomes an
abort gate that the inventory re-checks on the final clone (`02-data-mapping.md` §9). Q6, Q7, Q9 fallbacks, D-007
and field-only events all have 0 cases.

## Technical notes for the implementer

- `pg` parses `timestamp without time zone` in the Node process's local time zone. The V2 app stores UTC, so the
  converter must set a UTC parser for type 1114 (or compute business days in SQL:
  `("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Bratislava'`).
- V1 planning notes start with the step kind (`"SEND_DESIGN · …"`), so the step kind is reliably readable.
- Never print `CONTACT_UPDATED` notes other than those starting with `Cena:`: they contain contact data.
