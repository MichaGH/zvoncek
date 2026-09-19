# Round 2: one pipeline, one interaction model, real notes and real pricing

Status: **Waves 1, 2, 3a and 3b IMPLEMENTED on the test branch (2026-09-18); waves 3–5 not started.** Wave 3 (manager
tasks) is designed in `wave-3-task-proposal-final.md` (§2b). Decisions below are settled unless
§6 says otherwise. Wave 1 changed application code only – no schema or data change (see `context/domain/db-changes.md`). It collects Michal's feedback after using the shipped round-1 feature
(`context/features/01-salesrep/planning.md` rev. 4, implemented 2026-09-17, reviewed in `context/features/01-salesrep/revision.md`)
and turns each complaint into a decision with options, cost and risk.

Audience: Michal (decision owner) first, coding agents second. Read `AGENTS.md` and `context/app-workflow.md` first.

Decisions marked **Michal (2026-09-17)** are settled. What is still open is listed in §6.

Rules that do not change: locking order Team → User → Lead, one `revision` bump per business transaction, idempotency
keys on every outcome write, server-side scope, strict zod on every client-supplied object, Europe/Bratislava business
calendar. Everything proposed below must fit those rules; where an item touches them, it says so.

Item ids: **D-xx** = design decision, **B-xx** = bug/small fix, **S-xx** = schema change.

**Requests / "tickets" are gone from this design (2026-09-19).** Waves 1–2 built on the round-1 requests
(`DealRequest`, the "Požiadavky" pill, the requests card). Wave 3 replaces them with **manager tasks with a step lock**;
the only design for that is `context/features/01-salesrep/wave-3-task-proposal-final.md` (situations, reasons, rejected
alternatives, rules). Where this file still names requests, it describes what waves 1–2 built, marked as such; nothing
here is a requirement for requests or tickets. Later ideas: `context/features/backlog.md`.

---

## 1. The headline decision: one screen, `/dashboard/pipeline`

`/dashboard/pipeline` and `/dashboard/clients` are the **same data** (`Lead` rows with `pipelineEnteredAt != null`) seen
by two people, with two UI implementations on top. That was a mistake; round 2 undoes it.

**Michal (2026-09-17):** *"why not just make /pipeline for both … only things I see different really are the filters,
and some things in details (like adding design) … they can even see everything the same. The filter for whose work it is
is just limited to them — they can only see their team if they have one. Manager can select ANYONE."*

**Decided:**

- **One route: `/dashboard/pipeline` and `/dashboard/pipeline/[id]`** for every role that works on deals.
- `/dashboard/clients` and `/dashboard/clients/[id]` become **two-line redirect files** (`redirect("/dashboard/pipeline")`),
  so nothing 404s while links in the dashboard, menus and history are updated. They are deleted in a later cleanup.
  This is the only reason redirects were ever mentioned — there is no second view and no second URL for a deal.
- `ClientsBoard.tsx`, `ClientDrawer.tsx`, `ClientDetail.tsx` and `lib/queries/clients/**` are **deleted**, not adapted.
  `lib/actions/clients.ts` stays only if a distinct source label (`ActivitySource.CLIENTS`) is still wanted in the log;
  otherwise it collapses into the pipeline actions.
- The menu label stays role-dependent ("Pipeline" for the manager, "Moji klienti" for the rep) — a label is not a route.

### 1.1 What this needs on the permission side

Today the route guard maps `/dashboard/pipeline → pipeline.view`, a permission the rep does not have; and
`pipeline.view` currently means two things at once ("may open the screen" and "may see everyone's deals"). Those have to
be separated, and the names should say what they mean:

| New permission | Meaning | SALES_REP | MANAGER / ADMIN | future SALES_LEADER |
|---|---|---|---|---|
| `deals.view` | may open `/dashboard/pipeline` | ✅ | ✅ | ✅ |
| `deals.work` | may act on deals in scope (next step, interaction, price, asking the manager, contact data) | ✅ | ✅ | ✅ |
| `deals.viewAll` | scope = every deal (was `pipeline.view`) | ❌ | ✅ | ❌ |
| `deals.viewTeam` | scope = own + team members' deals | ❌ | (implied by `viewAll`) | ✅ |
| `deals.manage` | status, owner, project type, WON, reopen, designs, resolving manager tasks, bulk transfer (was `pipeline.manage`) | ❌ | ✅ | partly – §6.4 |

`clients.view` / `clients.work` are renamed into `deals.view` / `deals.work`; `pipeline.view` / `pipeline.manage` into
`deals.viewAll` / `deals.manage`. This is a rename inside `lib/permissions.ts` plus the guard line, not new behaviour —
but it touches every `can()` call site, so it belongs in the same atomic step as the merge (§5).

### 1.2 Scope is one function, and never comes from the URL

```ts
// lib/domain/dealScope.ts
export function dealScope(viewer: AccessUser): { kind: "own" | "team" | "all"; teamId?: string } {
    if (can(viewer, "deals.viewAll")) return { kind: "all" };
    if (can(viewer, "deals.viewTeam") && viewer.teamId) return { kind: "team", teamId: viewer.teamId };
    return { kind: "own" };
}
```

The `?owner=` filter chooses **within** that scope and is validated server-side: a viewer whose scope is `own` is forced
to themselves whatever the URL says; a team leader may only pass ids of their own team. This is the single place where
"who may see what" is decided, and it gets its own tests. It is also the whole future-proofing story: a sales-rep team
leader is one extra branch here plus one row in the permission matrix — not a new page.

### 1.3 So what actually differs per role? (the full list)

| # | Difference | How it is expressed | Is it a reason for a second screen? |
|---|---|---|---|
| 1 | Which deals you see | `dealScope()` + the owner filter's option list | No — a filter |
| 2 | Status / owner / project type / WON / reopen | `capabilities.manage*` hides the controls; the commands guard anyway | No — buttons |
| 3 | Designs & tracker management | `capabilities.manageDesigns`; the rep keeps the read-only summary | No — one card |
| 4 | Resolving manager tasks (wave 3; waves 1–2: requests) | manager-only actions on the task card | No — buttons |
| 5 | Bulk transfer | manager-only header button | No — one button |
| 6 | The "Rieši" (owner) column | shown only when more than one owner can appear in the current scope | No — data-driven column |
| 7 | Telesales | does not get this screen at all; they work in `/dashboard/calls` | Already separate |
| 8 | **Future** dev role | needs WON deals, the order note and `FOR_BUILD` notes; no price editing, different default filter | Maybe later — §6.5 |

Everything else — contact data, price, sent markers, next step, interactions, notes, asking the manager, history — is identical
for both roles. Nothing on this list justifies a second page.

**Michal (2026-09-17)** also decided:

- **Default filter when the pipeline opens = my own deals**, for *everyone* including the manager. The manager switches
  the owner filter to see a person, a team, or everything. (Today the manager's default is "everyone".)
- **Asking the manager is visible for every role** and never mixes into "my work". Waves 1–2 built it as the scoped
  `Požiadavky` pill; wave 3 replaces it with **"Pre mňa"** (open tasks assigned to me, any owner) and **"Čakám na
  manažéra"** (my deals whose step waits on a task) — `wave-3-task-proposal-final.md` §7.
- Pipeline rows get the `i` icon and the row-click action sheet, exactly like `/clients` has today (D-03, D-05).

---

## 2. Decisions

### D-01 — Route and structure

Settled in §1: one route `/dashboard/pipeline`, permission rename, `dealScope()`, redirects from the old client paths,
the client-side components deleted.

**Open sub-question (§6.1):** whether `ActivitySource.CLIENTS` is kept as a distinct label for actions done by a
non-manager owner, or everything on this screen logs as `PIPELINE`. It changes nothing functionally; it changes what the
history and the (unfinished) statistics can distinguish.

---

### D-02 — One filter row for everyone, table on desktop, real paging

**What you said:** *"I see the pipeline how its made – its great, levels of filters: who is it resolved by / if its
active-sleeping-won-lost / and then what type – all, call, ponuka, navrh, etc."*

**Today** the manager has three filter levels and the rep has none:

| Level | Control | Values |
|---|---|---|
| 1 | owner select | Všetci · nepriradené · each user |
| 2 | status tabs | Aktívne · Spiace · Vyhraté · Stratené · Nedostupné · Všetko |
| 3 | type pills | Požiadavky · Všetko · Volať · Poslať CP · Poslať email · Návrh v procese · Odoslaná CP · Odoslaný návrh |

**Key realisation:** the rep's seven card sections are mostly the same information as level 3, expressed differently:

| `clientSection()` | Equivalent in the filter system |
|---|---|
| Čaká na nás | `Požiadavky` pill (waves 1–2); from wave 3 "Čakám na manažéra" = an open manager task |
| Rozpracované | `Návrh v procese` (`nextActionMode = IN_PROGRESS`) |
| Čaká na klienta | `nextActionKind = WAITING_FOR_CLIENT` (new pill) |
| Spiace | status tab `Spiace` |
| Uzavreté | status tabs `Vyhraté` / `Stratené` |
| Naplánované | `Všetko` minus `Na dnes` |
| **Na dnes** | **the one genuinely missing pill** |

**Decided:** one filter row, identical for both roles —

```
[ Požiadavky (n) ] | [ Na dnes (n) ] [ Všetko ] | [ Volať ] [ Poslať CP ] [ Poslať email ] [ Návrh v procese ]
                                                 | [ Čaká na klienta ] [ Odoslaná CP ] [ Odoslaný návrh ]
```

(As built in waves 1–2. Wave 3 replaces the first pill with "Pre mňa (n)" and "Čakám na manažéra (n)" and gives every
pill a count — `wave-3-task-proposal-final.md` §7.)

- **`Na dnes`** is the new pill and carries the whole value of the old board: due today, overdue, woken from snooze,
  missing a next step, missing a date. Defined once in SQL next to the existing `PIPELINE_RANK_SQL` (which computes
  exactly this ranking after the R-02 fix), so the list and the badge cannot disagree.
- **Default landing:** `Na dnes`, for both roles, with `owner = me`.
- The owner select is rendered only when the viewer's scope has more than one option.
- **Desktop = the existing table**; the actions cell on the right gets `📞 tel:` + `i` (D-03). **Mobile = the current
  card**, unchanged.
- **Paging everywhere:** 50 + "Načítať ďalších 50", the mechanism the pipeline already uses. The endless scroll and the
  anchor chips disappear, so B-02 is fixed by construction.
- `ClientsBoard.tsx` and the section grouping UI are deleted. `clientSection()` itself **stays** — the dashboard
  summaries and the row badges ("zobudený", "bez ďalšieho kroku") use it, and it has 19 tests.

**Cost:** ~1.5 days inside the merge step. **Risk:** low — mostly deletion plus one SQL predicate.

**Michal (2026-09-17): accepted.**

---

### D-03 — One click, two intents: act vs. inspect

Row body click → the action sheet (you just called them). `i` icon next to the phone icon → the detail page, one click,
a real `<Link>` so ctrl-click opens a tab. The action sheet keeps a full-width "Otvoriť detail →" at the bottom.
This applies to the merged pipeline, so the manager finally gets the one-click "record what happened" the rep has.

**Cost:** hours. **Risk:** low.

**Michal (2026-09-17): accepted.**

---

### D-04 — Drawer on phone, dialog on desktop (and what "two columns" meant)

My earlier wording mixed up two screens:

- **The detail page** `/dashboard/pipeline/[id]`: wide left column (next step, last step, price, design, history) +
  narrow right column ("Údaje"), collapsing to one column on the phone with "Údaje" first. **Staying exactly as it is**;
  after the merge the rep gets that layout instead of the flat single-column `ClientDetail.tsx`. Nothing to decide.
- **The action sheet** (opens on row click): today a vaul bottom drawer on *every* screen size, which is what you
  objected to. On desktop it becomes a centred dialog, and because a dialog is much wider than a phone sheet, the
  outcome buttons sit left and the context (phone, pinned notes, last interactions, price, the open manager task) right instead
  of making you scroll. *That* was the "two columns" — inside the popup, not the page.

**Proposal:** `components/shared/ResponsiveSheet.tsx` — vaul `Drawer` below `md`, Radix `Dialog` at `md` and above
(`radix-ui@1.5` is already a dependency; it needs a shadcn-style `components/ui/dialog.tsx`). The call sites
(first call, follow-up, contact info) pass the same children.

Watch out: `data-vaul-no-drag` / `repositionInputs` are vaul-only and must become no-ops in the dialog branch; the media
query must not break hydration (stable first paint, switch after mount).

**Cost:** ~1 day for the primitive + ~0.5 day per call site. **Risk:** low-medium; the phone path stays identical.

**Michal (2026-09-17): accepted.**

---

### D-05 — **The core workflow issue**: "did I already call them?" vs "what is next"

**What you said:** *"its missing 'they picked up' or 'they didnt pick up' … the moment I put next step, I no longer
understand that I already called them … 'Posledný krok' is very confusing, and the new /client doesnt even have it."*

**Today, precisely:** the call stage has a clean model (one call = one outcome, the outcome decides the state). The deal
stage has two disconnected things: `Activity` rows (immutable log, shown as "Posledný krok", with free-text append) and
`Lead.nextAction*` (a field you overwrite). The pipeline detail has **no** "picked up / did not pick up" action at all;
`ClientDrawer` is the only place where the two are joined (`logFollowUpAs`).

**Decided — one concept: an Interaction.** Every touch of a deal records one interaction with three parts:

1. **Contact** — `Dovolal/a som sa` · `Nezdvihli` · `Odpísali (email)` · `Poslali sme (email/CP/návrh)` ·
   `Bez kontaktu (len plán)`.
2. **What they said** — optional quick reply (D-06).
3. **Next step** — kind + when, or "nechať tak" (do not touch `nextAction*`).

Both paths become one flow: `Dovolal som sa → čo povedali → ďalší krok`, or `Nezdvihli → ďalší krok predvyplnený
(Zavolať zajtra)`, or `Bez kontaktu → rovno ďalší krok` (they answered an email).

**What fixes the complaint:** every row and every detail then shows **both lines, always**:

```
Ďalší krok:  Zavolať · zajtra 10:00
Naposledy:   Nezdvihli · dnes 9:12 · 3. pokus
```

"3. pokus" = consecutive `NO_ANSWER` interactions since the last real contact; derived in the query, no schema change.

**Consequences:** the manager detail gains the interaction card it never had; the rep detail gains the "Naposledy"
panel; "Posledný krok" as an editable concept disappears (it becomes "Posledný kontakt", read from the log) and free
text moves to the notes (D-07). Editing the next step directly stays possible — it is just no longer the only thing you
can do.

**Schema:** none. One `Activity` + the lead update inside the existing `logFollowUpAs` transaction (one revision bump,
idempotency key, `expectedRevision`).

**Cost:** ~2 days. **Risk:** medium — `dealStateForFollowUp` gains cases; each needs a check.

**Michal (2026-09-17): accepted.**

---

### D-06 — Vocabulary: what the client actually said

**Your worry:** *"too hardcoded maybe? … option A makes more sense, as hardcoded answers like this shouldnt be
individual column."* Right on both counts, and they have different answers:

- **"Too hardcoded"** — the list lives in one constant in `lib/dictionaries.ts`. Adding, renaming or deleting a reply is
  a one-line edit. It is a *menu*, not a data model.
- **"Should it be a column?"** — no. Store `Activity.meta = { reply: "NOT_LOOKED_YET" }` and copy the human label into
  `Activity.note`, so history stays readable even if the menu changes. An enum is a promise of stability, and this
  vocabulary will change five times in the first month.
- If a reply turns out to matter for statistics, it is promoted to a real column later (**S-04**) with `meta` as the
  backfill source. That upgrade path works; the reverse does not.

Starting menu (to be cut down once we see what gets clicked): ešte sa nepozreli · pozreli, chcú zmeny · neprišlo im to ·
ozvú sa sami · majú poradu / rozhodujú · rieši to niekto iný · cena je vysoko · chcú objednať · vlastné…

**Michal (2026-09-17): accepted — option A.**

---

### D-07 — Notes: origin recorded automatically, pinning for what must not be missed

**What you said:** *"note from scout (their website doesnt work sometimes…), note from telesales (they said they would
like a website like this, they have somebody but if we do a good job they will take us — this needs to be seen by the
person that then communicates with them), then a general note that the manager needs to see at all times… then a good
way to check all the notes."*

**Today there are six places a note can live**, which is the problem:

| Field | Who writes it | Lifetime | Visible where |
|---|---|---|---|
| `Lead.note` | scout when adding, then **anyone** editing contact data | overwritten (diff logged) | Údaje card, calls InfoDrawer |
| `Activity.note` | every action | immutable | history |
| `Lead.nextActionNote` | next-step editor | overwritten each step | list row, next-step card |
| `Lead.callbackNote` | call stage | overwritten | calls queue |
| `Lead.priceNote` | price card | overwritten | price card |
| `DealRequest.note` (waves 1–2; wave 3: `DealTask.text` + task messages) | rep asking the manager | immutable | requests card → task card |

The scout's observation and the caller's handover note fight over one field, and a note for the developer has nowhere to
go at all.

**Decided — `LeadNote`, origin recorded automatically, pinning separate from kind:**

```prisma
model LeadNote {
  id         String       @id @default(cuid())
  lead       Lead         @relation(fields: [leadId], references: [id], onDelete: Cascade)
  leadId     String
  author     User         @relation(fields: [authorId], references: [id])
  authorId   String
  authorRole Role         // rola v čase písania – „od scouta" platí aj po povýšení
  stage      NoteStage    // CALL_STAGE | DEAL_STAGE
  kind       LeadNoteKind @default(GENERAL)
  body       String
  pinnedAt   DateTime?    // pripnuté = v hlavičke akčného okna a hore v detaile
  deletedAt  DateTime?
  createdAt  DateTime     @default(now())
  updatedAt  DateTime     @updatedAt
  @@index([leadId, pinnedAt])
  @@index([leadId, createdAt])
}

enum LeadNoteKind {
  GENERAL   // o klientovi – typicky scout
  FOR_CALL  // pre toho, kto bude komunikovať – typicky telesales
  FOR_BUILD // pre vývoj – čo si objednali, doména, addony (D-08)
  INTERNAL  // interné
}
```

**Why this covers your three cases without anyone categorising the origin:** author + role + stage are stored
automatically, so the note shows `Timea · telesales · 12. 9.`; `kind` answers the only thing the writer knows ("who
needs to read this"); and **pinning** answers "must not be missed" — pinned notes appear in the detail header *and* in
the action sheet header, in front of whoever is about to dial.

**Where you read them (Michal: no separate note board for now):** a **Poznámky** card in the detail showing pinned notes
plus the latest three, with "Zobraziť všetky (n)" opening the full list in the same `ResponsiveSheet` (a simple table:
date · author · kind · text, filterable by kind/author, with a toggle to merge the activity history in by date).
A Trello-style note board on the dashboard is explicitly **later**, not this round.

`Lead.note` is relabelled "Poznámka pri pridaní kontaktu" and stops being the dumping ground; existing text stays, and
optionally mirrors into a GENERAL note on first edit so nothing is lost. `nextActionNote`, `callbackNote`, `priceNote`
stay — they are field annotations, not notes.

**Cost:** ~2 days. **Risk:** low-medium.

**Michal (2026-09-17): accepted**, with the note list living inside the detail (no dashboard board yet). Edit/delete
rules in §6.3.

---

### D-08 — What they order must be written down (the ORDER request is gone)

**What you said:** *"order should be required to note, as we need to know what they want… option 1 is enough, as the
developer will never use this CRM to write detailed notes — here we need to see what they ordered, what price we gave
them, what kind of system, what ADDONS they took (lets say english language additional)."*

**Built in wave 1 (B-05):** the note became required server-side for the ORDER, DESIGN and OTHER requests, with a
kind-specific prompt and chips above the send button.

**Superseded by wave 3 (`wave-3-task-proposal-final.md` D15, §6.8):** the ORDER request and the `ORDER` step are
removed — "Chcú objednať" is only a recorded reply, and handing the client to the manager is an explicit HANDOVER task
with a required note. What survives from this decision:
- the order details (what they ordered, the agreed price, the kind of system, addons such as "EN jazyk") are written
  in the **handover note**; the chip idea (`stránka` `eshop` `katalóg` `admin systém` `iné…` + agreed price and
  addons) can be reused there;
- from wave 4 the same text is kept on the deal as a pinned `FOR_BUILD` note (D-07), so it is never buried;
- the order / WON process itself (several products: web, SEO, marketing, social media) is later work (backlog BL-09).

The structured brief (fields for scope/deadline/hosting) stays dropped.

---

### D-09 — Pricing: "knows the price" is not one boolean any more

> **Superseded in large part by §2c (wave 3a, 2026-09-18):** what the client knows is recorded by `OFFER_SENT` rows;
> `pricelistSentAt`/`priceQuotedAt`/`priceQuotedVia`, the structured `priceItems` and F-01 are dropped. The price stays a
> hand-written total + text lines. What is left for wave 5 must be re-decided before it starts.

**Decided — additive fields, nothing removed, no ambiguous backfill:**

```prisma
// Lead
pricelistSentAt DateTime?     // dostali cenník (PDF/HTML)
priceQuotedAt   DateTime?     // dostali konkrétnu cenu
priceQuotedVia  QuoteChannel? // CALL | EMAIL | BOTH
priceItems      Json?         // [{ label, listAmount?, amount }] – strict zod, súčet vedľa `price`
```

`priceDisclosed` keeps its meaning ("pozná konkrétnu cenu"); old rows get `pricelistSentAt = null`, which is *true* — we
never sent a price list from the app before, so nothing has to be guessed (the "abort on ambiguity" rule holds).

The card then reads:

```
Cena:        699 €   (rozpis: stránka 499 + admin 249 → zľava)
Klient vie:  cenník (12. 9., email)  ·  konkrétnu cenu 699 € (15. 9., telefonicky)
Poslané:     CP 15. 9.  ·  email „o nás" 12. 9.
```

The "email o nás" button becomes a picker — `o nás` · `+ cena` · `+ cenník` — writing `aboutUsSentAt` plus the matching
price fields in **one** transaction (one revision bump).

**Michal (2026-09-17): accepted.** The price list itself stays outside the app for now: *"prices are not so precise…
we need the different ways to see what price way client knows — cenník? or calculated price? if calculated price, what
did they choose?"* So `priceItems` is free-typed lines (label + amount, optional original amount for a discount), and
the *catalogue* idea — clicking items from the cenník so the breakdown builds itself — is recorded as a future item:

> **F-01 (future): cenník in the app.** A constant catalogue (`lib/domain/pricelist.ts`: label, list price, optional
> notes) that the price card offers as pickable items; `priceItems` then stores the chosen ids plus any override, and
> the card can warn when a quoted item is below the list the client already has. Attractive but it invites a whole
> product-configurator; revisit after the free-typed version has been used for a while.

---

### D-10 — Next-step options: one list, but not the same menu for everyone

**What you said:** *"the telesales cannot select they picked up, as its absolutely obvious — if they dont pick up, there
is a call later; if they picked up, you click what they want."* Correct, and that is the shape: **one source of truth,
two menus.**

- **Telesales (first call)** keeps its current model unchanged: the outcome *is* the answer. No "picked up" step.
- **Rep / manager (follow-up)** gets the interaction flow from D-05, because they call the same client repeatedly and
  "picked up, nothing changed" is a real result the first-call model cannot express.

Shared: the next-step list, today inconsistent in three places (the enum, the detail dropdown in raw enum order, the
drawer's four options without "Poslať návrh"):

```ts
export const NEXT_STEP_OPTIONS = [
    { kind: "CALL",               label: "Zavolať",               date: "required" },
    { kind: "WAITING_FOR_CLIENT", label: "Čakáme na klienta",     date: "checkDate" },
    { kind: "SEND_QUOTE",         label: "Poslať cenovú ponuku",  date: "optional" },
    { kind: "SEND_DESIGN",        label: "Poslať návrh",          date: "optional", mode: "IN_PROGRESS" },
    { kind: "SEND_EMAIL",         label: "Poslať email",          date: "optional" },
    { kind: "ORDER",              label: "Objednávka – potvrdiť", date: "optional" },  // S-01
    { kind: "CUSTOM",             label: "Vlastný krok",          date: "optional" },
] as const;
```

**S-01:** add `NextActionKind.ORDER`. Today "chcú objednať" parks the deal on `WAITING_FOR_CLIENT` with the note
"Čaká na potvrdenie manažéra", so the board claims we are waiting for the client when we are waiting for **you**.

**Wave 3 removes `ORDER` again** (`wave-3-task-proposal-final.md` D15, S-11): "Chcú objednať" becomes an ordinary
recorded reply with a normal next step, and handing over is an explicit task.

**Michal (2026-09-17): accepted.**

---

### D-11 — One sheet, two variants

`components/deals/InteractionSheet.tsx` inside the D-04 `ResponsiveSheet`: shared header (name, phone, pinned notes,
the open manager task), shared note and date fields, shared idempotency/revision handling. `variant="firstCall"` (telesales) vs
`variant="followUp"` (rep + manager) supplies the option set; capabilities add the manager-only buttons.

**The commands stay separate** (`logCallAs` vs `logFollowUpAs`) — they enforce different invariants
(`status NEW ⇒ no CALL activity`, assignment rules, handoff routing). Only the UI shell is shared.

**Michal (2026-09-17): accepted.**

---

### D-12 — The owner filter is the whole "see what my rep is doing" feature

**What you said:** *"we dont need read only, as manager should be able to change everything of their sales rep. The idea
is just — okay, I want to see what she is working on, I will put her filter in my pipeline, and see her workspace and
progress. By default, when pipeline is opened, I want to see mine, of course and only mine."*

| Mode | Control | Result |
|---|---|---|
| **My work** (default, everyone) | `owner = me` | your own deals |
| **See what a person is doing** | `owner = <person>` | their board, data-identical to their screen, fully editable by the manager |
| **A team** (future) | `owner = team:<id>` | everyone in that team |
| **Everything** | `owner = all` | today's manager view |
| **Asking the manager** | "Pre mňa" / "Čakám na manažéra" pills (wave 3; waves 1–2: `Požiadavky`) | separate across all statuses, never mixed into "my work" |

New filters: **`handedOffById`** ("deals that came from Timea's calls" — the data exists, the transfer dialog already
offers it, the list does not) and — waves 1–2 only, removed in wave 3 — **request kind** on the requests view. `createdById` belongs on the statistics page,
not here.

The owner select renders only when the viewer's scope offers more than one option, and its values are validated against
`dealScope()` server-side.

**Michal (2026-09-17): accepted.**

---

### D-13 — Capabilities, not roles

**What stays manager-only** after the merge, and is the entire reason the screens ever differed: status change, owner
change, project type, WON, reopen, design/tracker management, resolving manager tasks, bulk transfer, seeing deals you do not
own. Everything else is identical.

**Future-proofing, structural only (no new roles built now):**

1. **Scope is one function** (§1.2). A sales-rep team leader = one branch + one permission.
2. **Capabilities are one object**, derived from `can()`. A new role fills it differently; components do not change.
3. **Teams are already role-neutral** (the `Team` model comment says so): a team is a named group with one leader, and
   what the leader may see is decided by permissions — so a telesales team or a sales-rep team needs no schema work.
4. **Work for the manager is addressed, not implied** — wave 3 tasks name their assignee (`DealTask.assigneeId`) and
   can be reassigned between managers. A developer gets its own project feature later, not these tasks
   (`wave-3-task-proposal-final.md` D10, backlog BL-04). See D-15.
5. **Developer role (later):** the pieces it will need already exist here — `LeadNote.kind = FOR_BUILD` and the
   mandatory order note. Nothing else is prepared now, deliberately.

**Michal (2026-09-17): accepted.** Still open: whether a sales-rep team leader is a separate role or the existing
SALES_REP plus a team leadership flag (§6.4).

---

### D-14 — `lockedById` / `lockedAt` are dead columns

Three similarly-named things, which is where the confusion came from:

- **`assignedCallerId` + `assignedCallerAt`** — what round 1 built. A claimed batch of 10 is hers: no expiry, invisible
  to everyone else's pool, moved only by a manager transfer or deactivation. Real and working.
- **Postgres `FOR UPDATE` row locks** — held for the milliseconds of a transaction so two writes cannot interleave.
  Real, working, unrelated to the columns below.
- **`Lead.lockedById` / `lockedAt`** — legacy columns from the older "someone has this open right now" idea. Written and
  read **nowhere**; the only occurrence in the codebase is a constant `lockedAt: null` serialised into a payload at
  `lib/queries/pipeline/index.ts:271`. The schema comment already says "future-proof, zatiaľ nevyužité".

**Michal (2026-09-17): keep the columns empty, it does not matter.** Consequence to act on: the
"Multi-Telesales Locking" section of `context/additional-features-todo.md` is **obsolete** — its open questions ("does a
contact lock when the drawer opens? when does an abandoned lock expire?") were answered by the claim design (no drawer
lock, no expiry, the batch is hers until transferred). That section gets rewritten to say so (B-10). Dropping the
columns is a destructive migration for two unused nullable columns; not worth it, and never inside a feature round.

---

### D-15 — Work for the manager must be addressed, so team communication works later

**What you said:** *"what is rep requests later? … I mean, yes, it might be a possibility, if not with sales rep, there
will be later a dev that will get [requests] from sales rep or from manager, so this needs to be future proof for this
whole team communication to work later."*

**The problem it named:** round-1 `DealRequest` had no recipient — "open request" implicitly meant "the manager should
do something". That breaks the moment a second manager, a team leader or a developer exists.

**Resolved by wave 3** (`wave-3-task-proposal-final.md`): a task names its **assignee** (an active user with
`requests.resolve`, pre-selected when there is one), can be **reassigned** to another manager, and the manager's inbox
"Pre mňa" is "tasks assigned to me", independent of the owner filter. The developer does **not** get these tasks: it
gets its own project/communication feature later (D10, backlog BL-04). Asking the manager to act on the lead itself
(reopen, reopen and reassign — even on a lead that moved away) is a later, separate *request* concept (backlog BL-01).
The wave-1 step (one read function for requests) and S-07 are retired with `DealRequest`.

---

### Bugs and small fixes found while reading the code

| id | Item | Where | Fix |
|---|---|---|---|
| B-01 | Date field in the clients drawer does not open the picker on click (you have to type it) | `ClientDrawer.tsx` native `<input type="date">` | shared `DateTimeField` with `onClick → showPicker()` (as `NextActionEditor` already does) + `data-vaul-no-drag` |
| B-02 | Section chips jump down with no way back | `ClientsBoard.tsx` anchors | fixed by D-02 |
| B-03 | Rep detail has no "last contact" / interaction card | `ClientDetail.tsx` | D-05 (+ the file is deleted by D-01) |
| B-04 | Manager detail has no "picked up / no answer" action | `PipelineDetail.tsx` | D-05 |
| B-05 | ORDER/DESIGN requests can be sent with an empty note | `createDealRequestAs` | D-08 (done in wave 1; the requests are deleted in wave 3) |
| B-06 | Next-step type lists differ between drawer and detail | `NextActionEditor` vs `FOLLOW_UP_NEXT_KINDS` | D-10 |
| B-07 | "Objednávka" parks the deal in "Čaká na klienta" although we wait for the manager | `dealStateForFollowUp` | D-10 / S-01 |
| B-08 | Desktop uses the phone card layout in `/clients` | `ClientsBoard.tsx` | D-02 |
| B-09 | `Lead.note` is a shared, overwritable field for scout + caller + manager | schema + Údaje card | D-07 |
| B-10 | `additional-features-todo.md` still treats contact locking as an open design question | docs | D-14 |

---

---

## 2b. Wave 3: manager tasks, handover, história — `wave-3-task-proposal-final.md`

**The official wave-3 design is `context/features/01-salesrep/wave-3-task-proposal-final.md`** (decided by Michal
2026-09-19, reviewed externally, not implemented). This section is only the summary and the pointer; the task file wins
wherever they differ.

**Why** (task doc §1a–§1c): using waves 1–2 exposed that the round-1 requests did three jobs at once — a work item, a
state marker that swallowed the deal, and an implied handover — and were created and closed automatically. The pill
counted an outbox, an open request hid the rep's due work, and the note rule differed between two creation paths. The
first wave-3 design (tickets with a parked `WAITING_FOR_MANAGER` step, an inbox with Pre mňa / Od mňa / Vybavené, a
comment thread, "two switches" resolution — the former D-16…D-22) and three later alternatives all failed on keeping
the request and the step in sync; the task doc §1c says why each was dropped.

**What** (task doc §2–§7), built on Michal's three situations — A price, B návrh, C details/technical questions:
- a **task** = the SR asks the manager for a price, a návrh or something else ("Iné"); price and návrh together = one
  task; one open task per deal; never created or closed automatically; telesales never create tasks;
- while a task is open the SR's **step is locked on the server** — the locked step is the task's follow-up ("Poslať
  cenu"); the SR may still record contacts and sends, and may snooze / close / replan by cancelling the task in the same
  save;
- the manager's inbox **"Pre mňa"**, the SR's **"Čakám na manažéra"**, a task card with messages; "Hotovo" delivers the
  price (saved on the deal) or the návrh, the step becomes due, and "✓ od Michala" stays until the SR sends it;
- **handover** = a HANDOVER task the manager accepts or declines; **takeover** at any time; after either the SR loses
  access and keeps a **História** line (`DealOwnership`); transfers to another SR keep the task, transfers to a manager
  close it;
- **counters on every pill**, each computed by the same predicate as its list;
- reopen is **not** a task (a later *request*, backlog BL-01); "Chcú objednať" is only a reply; the `ORDER` step,
  `DealRequest` and every automatic request writer are removed; deactivation is blocked while the user still owns open
  deals or holds tasks.

Still wanted from the dropped ticket design and carried into the task doc (§1d): takeover at any time with the rep
losing access, História ("prevzaté 18. 9. · Michal"), ownership history for statistics and future rep → rep transfers,
counters on every pill, no automatic tasks, the ask text pre-filled from the last call note, ORDER treated as a
handover. Schema: task doc §4 (S-08…S-11, additive towards production).

## 2c. Wave 3a design: what the client received — about us, cenník, price, návrh, SMS (decided 2026-09-18, reviewed four times)

Wave 3a comes **before** wave 3 (manager tasks). It replaces the two-way "CP vs email o nás" model with one record of what
the client actually received, and fixes the action-sheet history bug. Subsection numbers below (§2 … §10) refer to
this section only.

**Rollout revision (2026-09-18, not implemented):** §4.2–4.4 and §5.3 below describe the legacy layer currently
running on test, **not** the chosen production end state. Michal chose conversion of the live old-send data into
canonical `OFFER_SENT` records, followed by reviewed non-additive removal of obsolete send columns. Keep this original
design as implementation history; use `context/domain/db-changes.md` §3.3 for the translation, exception rules and
production-duplicate rehearsal. The current prototype migration script is not approved for apply.

### 2. How it really works (manager's words, condensed)

- **The first email always contains "about us."** Usually the **cenník** is attached. Sometimes, instead of or in
  addition to it, a **calculated price** is included, sometimes for the client's *current* website.
- The company is testing whether a calculated price or the cenník works better, so **what was sent must be measurable**.
- **Later emails** often answer "how much would *this* cost?" with a calculated price only.
- **Návrh (a free design) can come before the price.** It's a "foot in the door" tactic: first call → they want a
  návrh → we send it, with or without the price or cenník → later they ask for the price.
- **Why it matters:**
  - A client who has seen neither the cenník nor a price → any price can be quoted.
  - A client who has seen the cenník → the quote should respect it.
  - A client who already got a price → a new quote is anchored to that price.
- **Routine correspondence** (changing an email address, replies) is **not** recorded as a send.
- Prices change and are written by hand, for example:
  ```
  Web 550 € · admin level 1 250 € · jazyk 100 € · SEO 350 € · správa 35 €/mes.
  ```
  A cenník catalogue/selector in the app is **not wanted**.
- The SR normally sends emails. For a calculated price the SR usually asks the manager (a manager task, wave 3);
  sometimes they talk outside the CRM.

### 3. What exists today, and why it can't simply be reinterpreted

| Thing (all exist in **production**) | What it really records today |
|---|---|
| `Lead.quoteSentAt` + activity `QUOTE_SENT` | "CP marked as sent". It can be marked **with no price saved**; there is no snapshot of the amount; undo clears the date but leaves the activity and `priceDisclosed`. |
| `Lead.aboutUsSentAt` + activity `EMAIL_SENT` | "Email o nás marked as sent". `EMAIL_SENT` was also used for any email; CP sends never set `aboutUsSentAt`. |
| `Lead.designSentAt` + `Design.sentAt` | návrh marked as sent (per design, revertible) |
| `Lead.price`, `Lead.priceNote`, `Lead.priceDisclosed` | the **current** price and its text breakdown (editable at any time), and "the client knows a price" (any channel) |
| `NextActionKind.SEND_QUOTE` / `SEND_EMAIL`, `CallOutcome.WANTS_QUOTE` / `WANTS_EMAIL` | the two "to send" steps and first-call outcomes |

**Conclusion (review point 1):** old sends are **legacy facts with unknown contents**, not verified contents. The
~300 production rows stay exactly as they are. The new model records sends in a **new, separate way** and never
reinterprets old rows.

### 4. The model

#### 4.1 One new kind of history row: `OFFER_SENT`

- New `ActivityType.OFFER_SENT` (additive enum value) = "we gave the client offer material".
- `Activity.meta` (existing jsonb) holds what was in it and what the save changed:
  ```json
  { "channel": "EMAIL",                 // EMAIL | PHONE (phone = price only, §5.7)
    "contents": ["ABOUT_US", "PRICELIST", "PRICE", "DESIGN"],
    "price": { "amount": "1285.00", "note": "Web 550 € · admin 250 € · …" },
    "designs": [{ "id": "…", "label": "smrek1", "url": "smrek1.thegrandpoints.com", "version": 1 }],
    "sentOn": "2026-09-18",             // when the client got it (business date)
    "historical": false,                // true = entered later from memory (§5.3)
    "correction": null }                // filled when crossed out (§5.4)
  ```
- Money is stored as a **decimal string**, never a JSON float.
- The `price` snapshot is copied from `Lead.price`/`priceNote` at save time. Later edits of the lead's price never
  change what the client received.
- A návrh is identified by its **design** (smrek1, smrek2 are separate designs). Label, clean URL and the design's
  current version number are snapshotted for completeness; versions are not otherwise used.
- **Old `QUOTE_SENT` / `EMAIL_SENT` / `DESIGN_SENT` are never written again.** Any row of those types is legacy by
  definition, so the row type itself says whether the contents are known.
- `Activity.createdAt` = when it was **recorded**; `meta.sentOn` = when the client **got** it. History shows both when
  they differ ("poslané 3. 7. · zaznamenané 18. 9."). Order = `sentOn`; on the same day a normal entry is later than
  a historical one (a backdated entry is by definition older), otherwise the one recorded later. **The latest price is
  the anchor**: the last one the client saw. Accepted limit: two normal price entries on the same day are ordered by
  recording time; they are rare and are recorded right after sending anyway.

#### 4.2 Summary columns on `Lead` (for lists, pills, statistics)

| Column | Meaning | How it is kept |
|---|---|---|
| **new** `offerAboutUsAt DateTime?` | first time "about us" was sent | recomputed from valid `OFFER_SENT` rows (earliest `sentOn`) |
| **new** `offerPricelistAt DateTime?` | first time the cenník was sent | recomputed (earliest) |
| **new** `offerPriceAt DateTime?` | last time a calculated price was given (email or phone) | recomputed (latest, §4.1 order) |
| **new** `hadLegacySends Boolean @default(false)` | this deal had sends **before** the new system | set **once** by the rollout data step (§7), never changed afterwards |
| **new** `legacySendsReviewedAt DateTime?` | the manager confirmed what an old deal received (§4.3) | set explicitly, only meaningful when `hadLegacySends` |
| **new** `Design.legacySentAt DateTime?` | the design's sent date **before** the new system | copied once from `Design.sentAt` by the rollout data step, never changed |
| existing `Design.sentAt`, `Lead.designSentAt` | návrh sent (read by tracking, pills, chips) | always recomputed: the **earlier** of the first valid `OFFER_SENT` containing that design and `legacySentAt` (a new send never moves an old date forward — corrected during implementation); `Lead.designSentAt` = latest of the lead's designs |
| legacy `quoteSentAt`, `aboutUsSentAt`, `priceDisclosed` | the **frozen baseline**: never written again | read-only; they only ever produce "?" (§4.3) |

"Valid" = `Activity.revertedAt IS NULL` (existing columns `revertedAt` / `revertedById`, used today for reverted
calls).

**Why corrections are simple and order-independent:** the new model never overwrites a legacy value. What the
client knows is always computed from **valid rows** (new and historical), with the frozen legacy values only turning a
"no" into a "?" until the deal is reviewed (§4.3). Crossing out a row then just means recomputing; there is nothing
to "restore", and the order of corrections doesn't matter.

#### 4.3 Legacy uncertainty is kept per content type

`NULL` means "not recorded", never "not seen".

- **Which deals are legacy is decided once, at rollout:** a one-time data step sets `hadLegacySends = true` on every
  lead with old send evidence (`quoteSentAt`, `aboutUsSentAt`, `priceDisclosed`, any `Design.sentAt`, or old
  `QUOTE_SENT`/`EMAIL_SENT`/`DESIGN_SENT` rows). Every lead created afterwards is `false` by default, so new code and
  new deals never have to think about it.
- ⚠ "Staré záznamy – over, čo klient dostal" shows while `hadLegacySends AND legacySendsReviewedAt IS NULL`. A new send
  does not remove it.
- On such a deal every content type with no valid row is shown as **"?"** (unknown), not as "no", and **old flags
  never mean "yes"**: an old "CP odoslaná" may have had no price, so an old `priceDisclosed` shows "cena ?", not a
  price. Example: `Klient dostal: o nás ? · cenník ? · cenu 1 100 € 20. 9.` (the price here is from a valid row).
- Confirming: "Doplniť staré záznamy" (§5.3) → enter what was really sent → **"Hotovo – toto je všetko, čo klient
  dostal predtým"** sets `legacySendsReviewedAt`. From then on the old flags are ignored: only valid rows count,
  and an empty value means "no".
- Pill **"Neoverené"** (manager) lists the unreviewed legacy deals.
- Dialog defaults on an unreviewed legacy deal: "O nás" and "Cenník" are **not** pre-ticked; "Cena" follows the task.

#### 4.4 What the pricing experiment compares

The question: **does the first email work better with the cenník, with a calculated price, or with both?**

- Each deal is placed in a group by the contents of its **first verified offer email** (first valid, non-historical
  `OFFER_SENT` with channel EMAIL):
  - cenník only
  - price only
  - cenník + price
  - neither (about us only, or návrh first)
- If the client got something **before** that email (a price by phone, a návrh), the deal keeps its email group
  and carries a flag "predtým: cena telefonicky / návrh", so it can be shown separately or excluded.
- The group never changes afterwards. A cenník-first client who later gets a price stays in "cenník only", otherwise the
  comparison would be meaningless.
- Measured per group: how many reached WON / LOST, and how long it took.
- Later prices, phone prices and návrhs are separate follow-on measures ("% of cenník-first clients that later asked for
  a price").
- Excluded, **permanently**: every deal with `hadLegacySends = true`, reviewed or not, since its first real offer
  happened before the system recorded it. Historical entries never count as "first". Both are reported only as counts.
- No extra clicking is needed: the data from §4.1 already supports it. The statistics page itself is later work, but
  this rule is fixed now so the right facts are recorded from day one.

### 5. The user's view: where everything is and how it works

#### 5.1 First call (`/dashboard/calls`), unchanged in shape

Telesales, and an SR making a first call, use the same screen and the same outcomes; there is **one** call workflow.
Only the labels change:

| Outcome (enum stays) | New label | The deal gets the next step |
|---|---|---|
| `WANTS_EMAIL` | "Chcú info emailom" | "Poslať úvodný email" (today) |
| `WANTS_QUOTE` | "Chcú konkrétnu cenu" | "Poslať cenu" (today) |
| `WANTS_DESIGN` | "Chcú návrh" | "Poslať návrh"; no automatic request from wave 3 on (§9a.1) |

Nothing is ever asked of the manager automatically. An SR who needs the manager's price or návrh opens the deal and
asks with "Požiadať manažéra" (a wave-3 task). The automatic DESIGN request still exists in 3a and is removed in wave 3
(§9a.1). Optional: the success toast after the call gets an "Otvoriť obchod" link when the caller owns
the new deal.

#### 5.2 Recording a send: one dialog, **"Čo sme poslali"**

**Where it opens:**
- the deal's action sheet (row click) → "📨 Poslali sme ponuku…"
- the detail page → **Cena & ponuky** card → "Zaznamenať odoslanie"
- the detail page → the návrh in the design card / návrh summary → "Odoslané" (opens the same dialog with that návrh
  ticked)

These replace every current send button: "CP odoslaná", "Email o nás – označiť ako poslané", the sheet's "Cenová
ponuka odoslaná" / "Email o nás odoslaný", the old requests card's "Označiť email ako odoslaný", and the design card's
"odoslané" toggle. **There is one server operation for all of them** (`recordOfferSent`), guarded by
`requireDealWork`: the owner or the manager, checked on the server under the row lock.

**What it shows:**
```
Čo sme poslali                                   Poslané: [ dnes ▾ ]
[✓] O nás                 (predvyplnené, ak ešte nešlo)
[✓] Cenník                (predvyplnené, ak ešte nešiel)
[ ] Cena   1 285 €  · Web 550 · admin 250 · …   [upraviť]
[ ] Návrh  smrek1.thegrandpoints.com   [Skopírovať odkaz do emailu]
Ďalší krok: …                                   (see below)
                                   [ Uložiť ]
```

**Prefills** are suggestions; any box can be unticked:
- "O nás" and "Cenník" are ticked only if they were **not sent yet** (and never on a legacy deal, §4.3).
- "Cena" is ticked when the current next step is "Poslať cenu". It needs a saved price; "[upraviť]" edits the price
  and breakdown right there, before the snapshot.
- "Návrh" lists the deal's designs; an unsent one is ticked when the next step is "Poslať návrh".

**Next step: never replaced silently.**
- If the current next step is the send task this email completes ("Poslať úvodný email", "Poslať cenu", "Poslať
  návrh"), the dialog pre-selects the replacement **"Zavolať, či prišlo · o 7 dní"** and says so.
- Otherwise it pre-selects **"Ponechať: Zavolať 20. 9."** (the existing step). Changing it is an explicit choice.
- Wave 3: while a manager task is open the step is locked, so the dialog records the send without a follow-up
  (`wave-3-task-proposal-final.md` §5.1).

**The manager on someone else's deal (návrh or anything else).** The manager may record a send on a deal he does not
own, but the dialog first asks:
> "⚠ Tento obchod vlastní Jana. Poslal/a si to klientovi naozaj ty? Ak chceš Jane len dať vedieť, že je to hotové,
> vybav radšej požiadavku."

(Text as built in 3a; wave 3 changes the last sentence to point at the task's "Hotovo".)

**Saving does, in one transaction:**
1. one `OFFER_SENT` row (contents, snapshots, `sentOn`)
2. recompute of the summary columns (§4.2)
3. recompute of `Design.sentAt` / `designSentAt` for a ticked návrh (§4.2)
4. the next step, as chosen above
5. (3a only) closing matching open requests as before; wave 3 removes all automatic closing (§6)
6. one revision bump

Double submit is blocked with `idempotencyKey` + `expectedRevision`, the pattern the call outcomes already use (unique
`Activity.idempotencyKey`).

#### 5.3 Historical entry ("Doplniť staré záznamy")

A separate mode, opened only from the ⚠ legacy prompt or the "Neoverené" pill. It never touches current work:
- It shows the legacy facts ("Staré: CP označená 3. 7. bez sumy, email o nás 1. 7.").
- The "Poslané" date is required and in the past; the price amount can be typed as it was then (it's not taken from
  today's `Lead.price`).
- It writes `OFFER_SENT` with `historical: true`.
- **No next step, no request closing, no "Naposledy" change.** It does update the summary columns (and
  `Design.sentAt`) by `sentOn`.
- It ends with "Hotovo – toto je všetko" → `legacySendsReviewedAt` (§4.3).

#### 5.4 Correcting a mistake

Principle: **a correction fixes what the client knows. It never touches the work that happened after.**

- In the history, each `OFFER_SENT`, `SMS_SENT` and `CLIENT_REPLIED` row has **"Opraviť"** (its author or the
  manager). A short reason is required.
- The row is crossed out: `revertedAt`, `revertedById`, and the reason plus who and when in `meta.correction`. The
  row stays visible, struck through.
- The summary columns are recomputed (§4.2). Nothing else changes automatically:
  - **The next step is not restored.** The dialog shows the current one with "Zmeniť", so the user fixes it by hand if
    the mistake was a minute ago. After a month, the later work stays as it was.
  - **Requests / tasks are not touched.** In 3a a mistaken send may have auto-closed a round-1 request (test branch
    only; nothing ships before wave 3). From wave 3 on a send never closes a task, so there is nothing to undo.
- To fix *what* was sent: cross out, then record again (with the original date if needed).
- "Naposledy" and the "N. pokus" counter ignore crossed-out rows. **Today's "Naposledy" query does not filter them**
  (`lib/queries/pipeline/index.ts`, `LIST_SELECT.activities`); fixed in 3a.
- The old "CP odoslaná" undo toggle and the design card's un-send toggle disappear.

#### 5.5 What the user sees afterwards

**Cena & ponuky card (detail):**
```
Aktuálna cena:  1 285 €   Web 550 · admin 250 · jazyk 100 · SEO 350 · správa 35 €/mes.   [upraviť]
Klient dostal:  o nás 12. 9. · cenník 12. 9. · cenu 1 100 € 20. 9. · návrh 15. 9.
                ⚠ aktuálna cena sa líši od poslanej (1 100 €)
[ Zaznamenať odoslanie ]
```
The warning appears when the current price differs from the last one sent, which is exactly the pricing rule from §2.

**Pipeline row:** small chips "cenník", "cena", "návrh" (plus ⚠ for legacy) next to the next step.

**Filter pills** (what the client *has*): "Dostali cenník", "Dostali cenu", "Dostali návrh", plus "Neoverené"
(manager only).

**History:** "Poslali sme: o nás + cenník", "Poslali sme: cena 1 100 € (Web 550 · …)"; legacy rows "CP (starý záznam,
obsah neoverený)".

#### 5.6 The price itself stays hand-written

- `Lead.price` (total) + `Lead.priceNote` (free-text lines, as in §2) remain the editable **current** price.
- The snapshot in `OFFER_SENT` freezes them at send time.
- The planned structured `priceItems` and the cenník catalogue (old wave 5, F-01) are **dropped**: with hand-written,
  changing prices, a catalogue would need a price-list snapshot per lead.

#### 5.7 Channels: email is the main line, phone and SMS are light side doors

Principle: **record what changes what the client knows, plus every real touch that keeps the relationship alive.** Do
not record routine correspondence. Every touch goes through the **one action sheet**, whose first step becomes:

```
Čo sa stalo?
  ✅ Dovolal/a som sa…          → čo povedali (+ [ ] Povedal/a som cenu 1 285 €) → ďalší krok
  📵 Nezdvihli…                 → ďalší krok
  ✉️ Odpísali / ozvali sa…      → čo povedali → ďalší krok
  📨 Poslali sme ponuku…        → dialóg „Čo sme poslali" (§5.2)
  💬 Poslali sme SMS…           → krátka poznámka (nepovinná) → ďalší krok
  🗓️ Bez kontaktu – len naplánovať…
```

| Channel | How it's recorded | Effect on "what the client knows" |
|---|---|---|
| **Email** (main) | `OFFER_SENT`, `meta.channel = "EMAIL"`, contents as §4.1 | yes: about us / cenník / price snapshot / návrh |
| **Phone price** | the call itself stays a normal follow-up `CALL`. If "Povedal/a som cenu" is ticked, the **same transaction** also writes `OFFER_SENT` with `meta.channel = "PHONE"`, contents `["PRICE"]`, the price snapshot and `meta.callActivityId`. **One touch:** "Naposledy" and the history show the call ("Dovolal sa · povedal cenu 1 285 €"), not a second contact | yes: "cenu 1 285 € (telefonicky 18. 9.)". The next step defaults to **"Poslať cenu (potvrdiť emailom)"** today, because a phone price is normally confirmed by email |
| **SMS** | the existing `ActivityType.SMS_SENT` (already in production, unused today), business category, optional free-text note ("web + kontakt", "poslali sme email, ozvite sa") | **none**: no content checkboxes, no snapshot. It counts as a touch ("Naposledy: SMS · dnes"), and the next step is set as usual |

- The "Povedal/a som cenu" checkbox is shown only when the deal has a price. Ticking it with no price opens the price
  field inline.
- The old "klient pozná cenu" toggle is removed from the UI. `priceDisclosed` is frozen (§4.2): "client knows a
  price" = legacy `priceDisclosed` or any valid price row.
- Phone and SMS rows reuse the same correction button ("Opraviť", §5.4).
- Calls themselves need no change: every first call and follow-up is already recorded with an outcome, and the next
  step keeps the relationship alive.

#### 5.8 Návrh sent by the SR (tracking link)

Flow:
1. The manager creates the návrh in the design card, as today. There can be several (smrek1, smrek2), and each is its
   own design.
2. Wave 3: the manager finishes the SR's návrh task ("Hotovo", picking the design — task doc §6.3; he does **not**
   mark it sent), and the SR's locked step "Poslať návrh" becomes due.
3. The SR copies the link, sends the email, and records it in "Čo sme poslali" with the návrh ticked.
4. If the manager owns the deal, or has taken it over, he records the send himself through the same dialog.
5. After the client has seen the návrh, further changes are the manager's work, discussed by email and phone outside
   the CRM. Design versions are not tracked here.

The tracking problem: the email must show a clean address (`example.thegrandpoints.com`) while the link underneath is
the tracking URL (`…/?p=<token>`). The SR must never open the tracking URL, or the view statistics become false.

- **What exists today:** the manager's design card (`DesignTrackingCard`) shows the clean address (clickable, with a
  button that copies the *clean* URL) and the tracking URL as selectable plain text (deliberately not a link, no copy
  button). So the manager currently builds the hyperlink by hand in the email. The SR's read-only návrh summary shows
  no links at all.
- **New:** the dialog **and** the návrh summary in the deal detail (SR and manager) show **"Skopírovať odkaz do
  emailu"**. It puts a **rich-text link** on the clipboard:
  visible text = the clean address, target = the tracking URL. Pasting into Gmail/Outlook produces exactly the right
  link.
- The tracking URL is **never rendered as a clickable link** in the CRM for the SR. The plain-text clipboard fallback
  is the tracking URL itself, for plain-text mail clients.
- The SR sees the result as today: the open/confidence summary ("otvorené 2×, naposledy včera").
- Rule change to note: today reps never receive tracking URLs or tokens (`database-map.md`, Design tracking). With this
  change the SR receives the tracking URL **only through the copy button**, still no IPs, no version numbers.
- Known limit: if someone does click the link, the tracker cannot tell it's one of us (it runs on the client's domain,
  outside the CRM's cookies). Accepted: the team is told not to click it. **Later item, not in 3a:** the manager can
  remove or mark as "ours" a single tracking-history entry (e.g. after testing a link).

### 6. Requests during 3a, tasks from wave 3

- **Release:** nothing goes to production until all waves of this round are done, so no real requests are created in
  between. On the test branch the round-1 request rows are inventoried and removed when wave 3 lands
  (`wave-3-task-proposal-final.md` §10).
- **3a kept the round-1 automatic closing** (except in historical entries), so there was never a half-changed state:
  recording a send with a price closed an open PRICE request; saving a price closed PRICE; the EMAIL request kind lost
  its button and was closed by any `OFFER_SENT` with about-us or the cenník.
- **Wave 3 removes all automatic closing** and replaces the requests with tasks. The price flow the manager asked for is
  kept: the manager types the price **and breakdown** into the task's "Hotovo" dialog, which saves `Lead.price` /
  `priceNote` (the one place the price lives) and the task result; the SR's locked step "Poslať cenu" becomes due; she
  sends it through "Čo sme poslali" with the returned price pre-ticked. "Vybavil som to sám" records the send and
  finishes the task in one transaction. Filling the price directly on the deal does not close anything (task doc D9,
  §6.3–§6.5).

### 7. Schema delta (all additive; production has none of it yet)

| Change | Kind |
|---|---|
| `ActivityType += OFFER_SENT, CLIENT_REPLIED` | new enum values (apply before code that writes them) |
| `Lead.offerAboutUsAt`, `Lead.offerPricelistAt`, `Lead.offerPriceAt`, `Lead.legacySendsReviewedAt` (`DateTime?`) | nullable columns, no backfill |
| `Lead.hadLegacySends Boolean @default(false)` | column with a default (fast on PostgreSQL 11+) |
| `Design.legacySentAt DateTime?` | nullable column |
| **one-time data step**: `hadLegacySends = true` on leads with old send evidence; `Design.legacySentAt = Design.sentAt` for designs sent under the old system | a backfill script with dry-run / `--apply` / `--verify` like the round-1 backfill; only ever sets values, so it is repeatable. On production it runs after the schema, **again right after the new code is live** (old code may have written a send in between), and `--verify` must then report nothing new |
| optional index on `Lead(offerPriceAt)` for the pill | new index |

Nothing is renamed, retyped, dropped or rewritten. Legacy columns and enum values stay and are simply no longer
written.

### 8. Code entry points that must all move to the one new command

`CenovaPonukaCard` (CP toggle; the price-disclosed toggle is replaced by the phone checkbox), `DealDetail` (email o
nás button, návrh summary), `InteractionSheet` "sent" step, `RequestsCard` (email button), `DesignTrackingCard` (the
sent toggle opens the dialog; its "návrh bez ceny" hint reads `offerPriceAt`), `lib/commands/tracking.ts`
`setDesignSentAs`, the list chips and pills (`quote_sent` → `offerPriceAt`), the "Naposledy" query (ignore crossed-out
rows), and `lib/domain/dealMutations.ts` `setQuoteSent` / `logSent`. All of these are removed or rerouted, not kept
alongside the new operation.

**Old write paths to delete, not just their buttons.** Every one of these is a callable server endpoint or
command today and would keep writing the old fields under the old rules:

| Layer | To delete |
|---|---|
| actions `lib/actions/pipeline/index.ts` | `setQuoteSent`, `setDealQuoteSent`, `logSent`, `logDealEmailSent`, `setPriceDisclosed`, `setDealPriceDisclosed`, `logBusinessActivity` (unused `SMS_SENT`, replaced by the new SMS path) |
| action `lib/actions/tracking/index.ts` | `setDesignSent` |
| commands | `setQuoteSentAs`, `logSentAs`, `setPriceDisclosedAs` (`pipeline.ts`); `setDealQuoteSentAs`, `logDealEmailSentAs`, `setDealPriceDisclosedAs` (`dealWork.ts`); `setDesignSentAs` (`tracking.ts`) |
| domain `lib/domain/dealMutations.ts` | `setQuoteSent`, `logSent`, `setPriceDisclosed` |

Gate check at the end of 3a: a grep for writes of `quoteSentAt`, `aboutUsSentAt`, `priceDisclosed`, `QUOTE_SENT`,
`EMAIL_SENT`, `DESIGN_SENT` outside the backfill scripts must return nothing. `context/domain/operations.md` is
updated in the same change.

### 9. Decisions

1. **The SR may record a návrh as sent** (§5.8). Creating and editing designs stays manager-only.
2. **About-us gets its own date** (`offerAboutUsAt`): everything the client received is dated.
3. **A phone price is recorded with its amount** as `OFFER_SENT` channel `PHONE` (§5.7).
4. **SMS is recorded lightly** (`SMS_SENT` + optional note, no contents).

5. **SMS only on deals, not in `/dashboard/calls`.** Telesales sometimes exchange a few SMS, but the contact is handed on
   quickly and their job stays simple. To be revisited after asking the telesales.
6. The návrh copy button is in both places (the dialog and the detail's návrh summary).
7. Our own accidental clicks on tracking links: handled by discipline now; manager removal of a tracking entry later.

### 9a. Related decisions (confirmed)

The wave-3 task design keeps this: no automatic tasks at all (`wave-3-task-proposal-final.md` D9).

1. **Nothing is asked of the manager automatically (wave 3; until then today's behaviour stays).** Today a first call
   "Chcú návrh" silently creates a DESIGN request raised by the *telesales* person (`lib/commands/calls.ts`), and the
   follow-up outcomes do the same (`WANTS_DESIGN`, `WANTS_TO_ORDER`). Telesales must never ask the manager, and an SR
   must not find requests she did not make. Instead:
   - the deal gets the next step "Poslať návrh" (as today), and when the owner cannot make designs its note reads
     "Požiadať manažéra o návrh", so the daily list tells a new SR what to do. The same goes for "Poslať cenu" ("ak ju
     nevieš, požiadaj manažéra"). Once she asks (a wave-3 task), the step is locked and the deal waits on the manager.
   - on a deal whose owner cannot make designs, the action sheet shows a prominent **"Požiadať manažéra"** while no
     task is open
   - on the manager's own deal, it's just his to-do
2. **Setups are team configuration, not code.** A telesales' positive calls go to their team leader. "Timea + manager"
   = Timea in the manager's team; "Timea + SR" = Timea in a team led by that SR; an SR's own calls are theirs.
3. **Contact types stored truthfully (bug fix, part of 3a).** Today every choice in the action sheet except "Nezdvihli" is
   saved as a `CALL` with outcome `POSITIVE`, including "Odpísali" (an email) and "Bez kontaktu" (no contact at all).
   That inflates call counts and resets the "N. pokus" counter. Only the history record changes; the counter
   stays (a visual hint only, it never closes a deal). Fix:
   - "Bez kontaktu" writes only the next-step change
   - "Odpísali" writes a new `ActivityType.CLIENT_REPLIED` (additive) with the reply
   - old rows stay as they are
4. **Inbox (wave 3):** "Pre mňa" (tasks assigned to me) and "Čakám na manažéra" (my deals waiting on a task) — the
   earlier three-tab ticket inbox is dropped (`wave-3-task-proposal-final.md` §7).

### 10. Later, explicitly not in 3a (not scheduled)

- **Team sanity warnings (admin), separate small step after 3a, not part of the email change.** Warn with a confirm dialog when:
  - adding a user to a team, if that team would then have more than one SR, or the new member is an SR who is not the
    leader
  - changing a role to/from SALES_REP (or any role that can own deals) while the user is in a team where that breaks
    routing
  - a team contains telesales but its leader cannot own deals (their positive calls would land unassigned)

  Show a ⚠ on the Tímy overview for any team in such a state. One role per account; a combined role (e.g. SR + scout
  leader) is solved by two accounts, if it ever happens.
- Email templates: open the deal, get a generated email (about us + chosen attachments + návrh link), copy it.
- Removing or marking one's own tracking-history entries (manager).

## 2d. Wave 3b: deal detail rework after testing 3a (Michal, 2026-09-18)

Found while testing 3a. Backup before the change: local commit `1dae205`.

1. **No redirect.** "📨 Poslali sme ponuku" from the list opens "Čo sme poslali" in place; the list rows carry the few
   fields the dialog needs (price, breakdown, what the client got, designs with the copy link).
2. **Follow-up date is editable** in "Čo sme poslali": "Zavolať, či prišlo" has a date field (default +7 days).
3. **One "Ďalší krok · Naposledy" card** at the top of the detail: two tiles side by side (what is next, what happened
   last) and one **"Zaznamenať kontakt"** button that opens the action sheet. The old "+ nový" dropdown editor
   (`NextActionEditor`) is replaced: "Zmeniť krok" on the tile opens the same action sheet at the next-step screen,
   pre-filled, as "bez kontaktu – len naplánovať". The four quick-event buttons and the free "vlastná udalosť" field
   are removed.
4. **Price edit is its own small popup** (price + breakdown, nothing else) behind the pencil in "Cena & ponuky";
   "Zaznamenať odoslanie" stays only for sends. (3a's inline edit kept stale values after a save — bug.)

Decisions from the third external review of 3a/3b (Michal, 2026-09-18):
- **"Naposledy" = the last real contact with the client**: a call, a written reply, an SMS, an email we sent (plus old
  notes and old send records). Edits (price pencil, "Zmeniť krok"), requests / manager tasks, audit rows and entries added from memory
  never change it. The line "Odoslané: …" under it shows the last thing actually sent (never a historical entry).
- Reads may race with a transfer for a moment; the list re-applies the scope when it loads the page, so a deal that was
  just moved away is simply not shown. Mutations were always guarded.

Notes for later, not in 3b:
- **Old-send migration decision (2026-09-18, not implemented):** Michal chose to translate the live old sends to
  `OFFER_SENT` and remove the obsolete send columns after a verified conversion. The live facts he described are
  email sent, current price, "client knows price", design present/sent and tracking history; only roughly the last
  20 emails included the cenník. These are business statements, not an inventory of the live database. A fresh
  production duplicate, explicit cenník recipients and per-exception decisions are required. The prototype
  `prisma/backfill/2026-09-offer-migrate.ts` needs correction before apply; full mapping, blockers, code cutover and
  non-additive rollout plan are in `context/domain/db-changes.md` §3.3.
- **Sorting.** The pipeline is always ordered by the next step's urgency. With ~200 deals, finding the one you just
  touched is hard. Add a sort choice, e.g. "naposledy upravené" vs "podľa ďalšieho kroku".
- **"Pozreli, chcú zmeny"** has no correct next step for a sales rep: once the client wants changes to a návrh, the
  manager takes over (the rep handles introductions only). Resolved by the wave-3 design: small wishes ("make it
  blue") = a new návrh task, the SR keeps the client; deeper changes = "Odovzdať manažérovi" (task doc §1a B6, §6.8).

### 2d rollout proposal — canonical old sends (decision recorded, implementation pending)

- Target schema: keep `OFFER_SENT`, `Lead.offerAboutUsAt` / `offerPricelistAt` / `offerPriceAt`, current
  `Lead.price` / `priceNote`, `Lead.designSentAt`, and all Design/version/tracker/event data. After full conversion,
  remove **production-existing** `Lead.quoteSentAt`, `aboutUsSentAt`, `priceDisclosed` (non-additive P-01…P-03 in
  `db-changes.md` §3.3). Remove test-only `hadLegacySends`, `legacySendsReviewedAt`, `Design.legacySentAt` from the
  final target so they are never added to production. Preserve old activity rows and enum values for audit.
- Safety order: inventory and explicit manager-approved mapping on a fresh production duplicate; implement and test
  the converter; rehearse round 1 → wave 2 → revised 3a additions → conversion/reconciliation → reviewed column
  drops → compatible app; then a separately approved production maintenance window with backup, restore branch,
  frozen writes, the same verified sequence and rollback gate. No data-loss acceptance in `prisma db push`.
- A missing amount/date/channel, undone send, uncertain cenník recipient or ambiguous design is an exception, not a
  guessed event. The current `2026-09-offer-migrate.ts` is **not** the approved converter. Full mapping, prototype
  defects and verification gates: `context/domain/db-changes.md` §3.3. No production database was inspected for
  this decision.

## 3. Target shape

```
app/dashboard/pipeline/page.tsx        → components/deals/DealList.tsx    (table md+, cards below, one filter row, paging)
app/dashboard/pipeline/[id]/page.tsx   → components/deals/DealDetail.tsx  (today's two-column layout, capability-driven)
app/dashboard/clients/**               → redirect("/dashboard/pipeline")  (temporary, deleted later)

components/shared/ResponsiveSheet.tsx      drawer (phone) | dialog (desktop)
components/deals/InteractionSheet.tsx      contact → reply → next step   (variant: firstCall | followUp)
components/deals/NotesCard.tsx             pinned + latest notes, "Zobraziť všetky" opens the full list in the sheet
components/deals/PriceCard.tsx             price, items, what the client knows, what was sent

lib/domain/dealScope.ts                    own | team | all  – the only place scope is decided
lib/domain/dealCapabilities.ts             pure, from can(); a rendering hint, never a permission
lib/domain/nextStepOptions.ts              the one next-step list
lib/queries/deals/index.ts                 one query, scope applied server-side, SQL ordering + paging
(wave 3) task queries + one shared predicate per pill – wave-3-task-proposal-final.md §7
```

Deleted: `components/clients/**`, `lib/queries/clients/**`, the section-board UI.
Unchanged and non-negotiable: `lib/commands/**` transaction bodies, locking order, one revision bump per transaction,
idempotency replay, strict zod at every boundary, business-calendar day math, server-side scope.

## 4. Schema changes

| id | Change | For | Risk |
|---|---|---|---|
| S-01 | `NextActionKind += ORDER` | D-10 | none (additive enum); removed again in wave 3 (task doc S-11) |
| S-02 | `LeadNote` model + `LeadNoteKind`, `NoteStage` enums | D-07 | new table only |
| S-03 | `Lead.pricelistSentAt`, `priceQuotedAt`, `priceQuotedVia`, `priceItems Json?` | D-09 | nullable columns |
| S-04 | *(later, only if stats need it)* `Activity.replyKind` enum | D-06 | column + backfill from `meta` |
| S-05 | *(dropped)* `Lead.brief Json?` | D-08 step 2 | — |
| S-06 | *(rejected)* drop `Lead.lockedById` / `lockedAt` | D-14 | destructive; keep the columns |
| S-07 | *(superseded)* addressed requests → `DealTask.assigneeId` in wave 3 | D-15 | — |

All accepted items are additive, so `prisma db push` on the test branch should be clean. Production keeps the
`migrate diff` → review → `db execute` path from `AGENTS.md`, in a separately approved session.

## 5. Order of work — the merge is one atomic step

**Michal:** *"if we [are] doing this change or migration or merge, this will have to be a single step after which we
need to make checks for everything if it works, and then continue [with the] rest."* — and, on the small fixes:
*"are you sure that we want to first make the small fixes? like fixing the date picker, when later you are remaking it
into one component?"*

**He is right, and wave 0 is gone.** `ClientDrawer.tsx` (the file with the broken date picker, B-01) is *deleted* by the
merge, so fixing it first would be throwing work away. The small fixes are folded into the wave that owns the code they
touch:

| Wave | Contents | Database | Gate before continuing |
|---|---|---|---|
| **1** | **The merge, one step:** permission rename (§1.1), `dealScope()` + `dealCapabilities()`, one list with the full filter row + `Na dnes` + paging, one detail, D-03 click model, D-12 owner/handed-off-by/request-kind filters, `requestsForViewer()` (D-15 step 1), B-05 (ORDER note required server-side), B-10 (docs), redirects, deletion of `components/clients/**` + `lib/queries/clients/**` (which is also how B-01, B-02, B-03, B-08 disappear) | **none — pure application code** | **Full check pass:** `tsc`, lint, business time (both TZs), client sections, concurrency suite incl. the new scope/crafted-call tests, `Na dnes` ↔ `clientSection()` parity, backfill delta, HTTP role checks for every role on every route, and a human click-through of both roles. Nothing else starts until this is green. |
| 2 | D-04 `ResponsiveSheet` + D-11 sheet + D-05 interaction flow + D-06 quick replies + D-10 `ORDER` option (S-01) + B-04, B-06, B-07 | S-01 (additive enum value) | full check pass + click-through |
| **3a** | **What the client received (§2c):** one "Čo sme poslali" record (`OFFER_SENT`), phone price, SMS, truthful contact types (`CLIENT_REPLIED`), legacy ⚠ + review, corrections, old send paths deleted | `OFFER_SENT`, `CLIENT_REPLIED`, 4 `Lead` columns, `Design.legacySentAt` + one-time legacy data step (all additive) | full check pass + click-through |
| **3** | **Manager tasks, handover, história — `wave-3-task-proposal-final.md`** (§2b): one open task per deal with a server-side step lock, "Pre mňa" / "Čakám na manažéra", explicit handover and takeover, ownership history and História, counters on every pill; round-1 requests and the `ORDER` step removed | task doc §4 (S-08…S-11; additive towards production) | full check pass incl. `Na dnes` ↔ `clientSection()` parity and "a locked deal is actionable nowhere" |
| 4 | D-07 notes (S-02) + the ORDER note mirror (D-08 step 3) + B-09 | S-02 (new table + 2 enums) | full check pass |
| 5 | D-09 pricing (S-03) | S-03 (4 columns + 1 enum) | full check pass |

Rough sizes: wave 1 ≈ 3–4 days (done), wave 2 ≈ 3–4 days (done), wave 3 ≈ 4–5 days, wave 4 ≈ 2 days, wave 5 ≈ 1.5–2 days.

Notes and pricing moved **behind** the task model on purpose: "what did they order" is written at handover time and
"what did we quote" is delivered through a task, so building the notes wall first would mean rebuilding half of it.

Every database change, including the ones round 1 still owes production, is tracked in
**`context/domain/db-changes.md`**. Wave 1 deliberately has **zero** database changes: if an agent thinks the merge
needs a migration, something has been misunderstood — stop and ask.

New checks wave 1 must add (to `prisma/backfill/check-concurrency.ts` or a dedicated scope script):

- a rep's list and detail never return another owner's deal, whatever `?owner=` says;
- a manager's `owner=<rep>` returns exactly that rep's list, in the same order;
- every capability-gated action still fails server-side for a rep even when the UI hides it (crafted call);
- the `Na dnes` SQL predicate agrees with `clientSection()` over every deal in the database (parity check, same pattern
  as the R-02 ordering parity test).

## 6. Still open

1. **`ActivitySource.CLIENTS`** — *decided by default while implementing wave 1, flag it if you disagree:* the label is
   **kept**, and it is now chosen by the actor rather than by the route — an actor with `deals.manage` logs `PIPELINE`,
   everyone else logs `CLIENTS`. That keeps the statistics distinction ("first calls = `CALL_QUEUE`, follow-ups =
   `CLIENTS`") working after the merge, and existing history keeps its meaning.
2. **Do reps see the `handedOffBy` line** (which telesales made the first call)? Michal: *"of course, they might manage a
   telesales team later, they should know their stats."* → **yes**; the open part is only whether it is also a *filter*
   for them (recommended: yes, within their scope).
3. **Note edit/delete rules:** author edits their own; manager edits/deletes any; delete is soft and stays in history.
   Confirm.
4. **Sales-rep team leader:** a separate role (`SALES_LEADER`, like `SCOUT_LEADER`) or SALES_REP + team leadership?
   Michal is undecided: *"if salesrep only works alone vs if salesrep manages 3 telesales + her own calls."*
   Recommended: a separate role when it arrives, because permissions are per-role and the Team model already supports
   it — but add the `deals.viewTeam` permission slot now so `dealScope()` has its branch from day one.
5. **Developer role (later):** does it get this same screen with a different filter set and capabilities, or its own
   screen? Not needed now; the decision point is "does it need ≥3 sections the deal screen does not have".
6. **F-01 cenník in the app** (pickable price items): parked. Revisit after the free-typed `priceItems` has been used.

## 7. Non-goals for this round

- Statistics rebuild (`/dashboard/stats` is still unfinished).
- New roles (sales-rep team leader, telesales team leader, developer) — only the structure is prepared (D-13, D-15).
- A dashboard note board (Trello-style) — D-07 keeps notes inside the deal detail for now.
- A developer project feature (backlog BL-04) and manager → rep tasks — not part of wave 3.
- The WON step Michal wants later ("really show end prices, and details and then mark it as won") — wave 5 territory,
  after pricing.
- Contact-level locking (D-14: the claim design already replaced it).
- Any production rollout: the round-1 production rehearsal and rollout (`planning.md` §14) are still pending and remain
  a separate, explicitly approved session. This round must not be mixed into it.
