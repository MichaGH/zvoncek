# Round 2: one pipeline, one interaction model, real notes and real pricing

Status: **Waves 1 and 2 IMPLEMENTED on the test branch (2026-09-18); waves 3–4 not started.** Decisions below are settled unless
§6 says otherwise. Wave 1 changed application code only – no schema or data change (see `context/new-feature/db-changes.md`). It collects Michal's feedback after using the shipped round-1 feature
(`context/new-feature/planning.md` rev. 4, implemented 2026-09-17, reviewed in `context/new-feature/revision.md`)
and turns each complaint into a decision with options, cost and risk.

Audience: Michal (decision owner) first, coding agents second. Read `AGENTS.md` and `context/app-workflow.md` first.

Decisions marked **Michal (2026-09-17)** are settled. What is still open is listed in §6.

Rules that do not change: locking order Team → User → Lead, one `revision` bump per business transaction, idempotency
keys on every outcome write, server-side scope, strict zod on every client-supplied object, Europe/Bratislava business
calendar. Everything proposed below must fit those rules; where an item touches them, it says so.

Item ids: **D-xx** = design decision, **B-xx** = bug/small fix, **S-xx** = schema change.

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
| `deals.work` | may act on deals in scope (next step, interaction, price, requests, contact data) | ✅ | ✅ | ✅ |
| `deals.viewAll` | scope = every deal (was `pipeline.view`) | ❌ | ✅ | ❌ |
| `deals.viewTeam` | scope = own + team members' deals | ❌ | (implied by `viewAll`) | ✅ |
| `deals.manage` | status, owner, project type, WON, reopen, designs, resolving requests, bulk transfer (was `pipeline.manage`) | ❌ | ✅ | partly – §6.4 |

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
| 4 | Resolving requests | manager-only actions inside the requests card | No — buttons |
| 5 | Bulk transfer | manager-only header button | No — one button |
| 6 | The "Rieši" (owner) column | shown only when more than one owner can appear in the current scope | No — data-driven column |
| 7 | Telesales | does not get this screen at all; they work in `/dashboard/calls` | Already separate |
| 8 | **Future** dev role | needs WON deals, the order note and `FOR_BUILD` notes; no price editing, different default filter | Maybe later — §6.5 |

Everything else — contact data, price, sent markers, next step, interactions, notes, requests, history — is identical
for both roles. Nothing on this list justifies a second page.

**Michal (2026-09-17)** also decided:

- **Default filter when the pipeline opens = my own deals**, for *everyone* including the manager. The manager switches
  the owner filter to see a person, a team, or everything. (Today the manager's default is "everyone".)
- **`Požiadavky` stays visible for every role**, scoped: the rep sees the requests they raised and their state, the
  manager sees everything open. It is a separate pill and never mixes into "my work".
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
| Čaká na nás | `Požiadavky` pill |
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
  outcome buttons sit left and the context (phone, pinned notes, last interactions, price, open requests) right instead
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
| `DealRequest.note` | rep asking the manager | immutable | requests card |

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

### D-08 — "Požiadavka: Objednávka" without knowing what they want to order

**What you said:** *"order should be required to note, as we need to know what they want… option 1 is enough, as the
developer will never use this CRM to write detailed notes — here we need to see what they ordered, what price we gave
them, what kind of system, what ADDONS they took (lets say english language additional)."*

**Today:** `createDealRequest(leadId, kind, note)` accepts `null` for every kind, and the note box sits *below* the kind
buttons, so the order of operations reads backwards.

**Decided (step 1 only):**

1. The note is **required server-side** for `ORDER`, `DESIGN` and `OTHER` (in the command — a UI-only rule is not a rule).
2. The field moves **above** the send button, with a kind-specific prompt and chips that append text:
   ORDER → "Čo si objednávajú?" · `stránka` `eshop` `katalóg` `admin systém` `iné…` + a line for the agreed price and
   addons ("EN jazyk", "rezervácie", …). DESIGN → "Čo má návrh obsahovať?" · PRICE → "Čo treba naceniť?"
3. The ORDER text is stored as the request note **and** mirrored as a pinned `FOR_BUILD` note (D-07), so it stays on the
   deal permanently instead of being buried in a resolved request.

The structured brief (fields for scope/deadline/hosting) is **dropped from this round**.

**Cost:** ~3 hours (+ the mirror once D-07 exists). **Risk:** low.

**Michal (2026-09-17): accepted, step 1 only.**

---

### D-09 — Pricing: "knows the price" is not one boolean any more

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

**Michal (2026-09-17): accepted.**

---

### D-11 — One sheet, two variants

`components/deals/InteractionSheet.tsx` inside the D-04 `ResponsiveSheet`: shared header (name, phone, pinned notes,
open requests), shared note and date fields, shared idempotency/revision handling. `variant="firstCall"` (telesales) vs
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
| **Requests** | `Požiadavky` pill | separate across all statuses, never mixed into "my work" |

New filters: **`handedOffById`** ("deals that came from Timea's calls" — the data exists, the transfer dialog already
offers it, the list does not) and **request kind** on the requests view. `createdById` belongs on the statistics page,
not here.

The owner select renders only when the viewer's scope offers more than one option, and its values are validated against
`dealScope()` server-side.

**Michal (2026-09-17): accepted.**

---

### D-13 — Capabilities, not roles

**What stays manager-only** after the merge, and is the entire reason the screens ever differed: status change, owner
change, project type, WON, reopen, design/tracker management, resolving requests, bulk transfer, seeing deals you do not
own. Everything else is identical.

**Future-proofing, structural only (no new roles built now):**

1. **Scope is one function** (§1.2). A sales-rep team leader = one branch + one permission.
2. **Capabilities are one object**, derived from `can()`. A new role fills it differently; components do not change.
3. **Teams are already role-neutral** (the `Team` model comment says so): a team is a named group with one leader, and
   what the leader may see is decided by permissions — so a telesales team or a sales-rep team needs no schema work.
4. **Requests are addressed, not implied** — see D-15. That is the piece that makes manager → rep → developer
   communication possible later.
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

### D-15 — Requests: make them addressed, so team communication works later

**What you said:** *"what is rep requests later? … I mean, yes, it might be a possibility, if not with sales rep, there
will be later a dev that will get [requests] from sales rep or from manager, so this needs to be future proof for this
whole team communication to work later."*

**Today** `DealRequest` has no recipient: "open request" implicitly means "the manager should do something". That works
with one manager and breaks the moment a developer or a team leader is added.

**Proposal (design now, minimal code now):**

1. **Now, no schema change:** every read of requests goes through one function
   `requestsForViewer(viewer, scope)` instead of ad-hoc `where: { status: "OPEN" }` clauses. Today it returns
   "everything open" for `deals.manage` and "the ones I raised" otherwise. The `Požiadavky` pill and the dashboard block
   both use it, so the definition lives in one place.
2. **Later, when a second recipient exists (S-07):** add `DealRequest.toRole Role?` and/or `toUserId String?`, defaulting
   to the manager for existing rows, and `requestsForViewer` becomes "addressed to me or to my role". No UI redesign
   needed at that point — the pill, the card and the resolve flow already exist.
3. The kinds stay as they are for now; a developer-facing kind (`BUILD`, `HANDOVER`) is added with the role.

**Cost:** ~2 hours now (the function), the rest deferred. **Risk:** none now.

**Michal (2026-09-17): accepted as the future-proofing approach.**

---

### Bugs and small fixes found while reading the code

| id | Item | Where | Fix |
|---|---|---|---|
| B-01 | Date field in the clients drawer does not open the picker on click (you have to type it) | `ClientDrawer.tsx` native `<input type="date">` | shared `DateTimeField` with `onClick → showPicker()` (as `NextActionEditor` already does) + `data-vaul-no-drag` |
| B-02 | Section chips jump down with no way back | `ClientsBoard.tsx` anchors | fixed by D-02 |
| B-03 | Rep detail has no "last contact" / interaction card | `ClientDetail.tsx` | D-05 (+ the file is deleted by D-01) |
| B-04 | Manager detail has no "picked up / no answer" action | `PipelineDetail.tsx` | D-05 |
| B-05 | ORDER/DESIGN requests can be sent with an empty note | `createDealRequestAs` | D-08 |
| B-06 | Next-step type lists differ between drawer and detail | `NextActionEditor` vs `FOLLOW_UP_NEXT_KINDS` | D-10 |
| B-07 | "Objednávka" parks the deal in "Čaká na klienta" although we wait for the manager | `dealStateForFollowUp` | D-10 / S-01 |
| B-08 | Desktop uses the phone card layout in `/clients` | `ClientsBoard.tsx` | D-02 |
| B-09 | `Lead.note` is a shared, overwritable field for scout + caller + manager | schema + Údaje card | D-07 |
| B-10 | `additional-features-todo.md` still treats contact locking as an open design question | docs | D-14 |

---

---

## 2b. Wave 3 design: tickets, handover, history (decided 2026-09-18, NOT implemented)

Wave 1 and 2 shipped; using them exposed a modelling mistake that is bigger than a UI tweak. This section is the agreed
design for wave 3. Nothing here exists in code yet.

### The problem, as found in use

Michal, as SALES_REP `sales`, made four first calls (email, CP, CP, návrh) and then saw **"Požiadavky (4)"** on his own
screen. Three separate faults, all from the same root:

1. **The pill counts the wrong thing.** It means "my deals that carry an open request" – an *outbox* – but it is labelled
   like a to-do list. For the manager the same pill is empty by default, because requests sit on *other people's* deals
   and the default owner filter is "ja".
2. **A ticket swallows the deal.** The requests view filters *deals with an open request*, and `clientSection()` sends
   any deal with an open request to "Čaká na nás". So a deal disappears from the rep's normal work the moment a ticket
   exists, and stays in the ticket bucket no matter what else happens on it (call → "chcú CP" → still in Požiadavky).
3. **Two doors, one lock.** `createDealRequestAs` requires a note for ORDER/DESIGN/OTHER (wave 1, B-05), but a request
   created from a call outcome goes through `ensureOpenRequest` and requires nothing. So "chcú návrh" from `/calls`
   creates a note-less ticket while the manual path refuses one. That inconsistency is ours, not the user's.

Underneath: `DealRequest` is doing three jobs at once – a **ticket** ("make me a price"), a **state marker** (the deal
leaves the rep's list), and an implied **handover** ("this client is yours now"). Wave 3 separates them.

### D-16 — A ticket is a ticket; the next step says where the ball is

- **`Požiadavky` becomes an inbox of tickets, not a filter over deals.** Rows are requests: kind · deal · who asked ·
  age · text · the action that resolves it. Tabs: **Pre mňa / Od mňa / Vybavené**. The inbox **ignores the owner
  filter** (an inbox is not a slice of my deals) – that alone fixes fault 1 for the manager.
- **The deal list stops filtering by open request.** A deal with an open ticket keeps its normal place and shows a small
  badge ("čaká na manažéra: návrh").
- **Where the deal sits is decided by its next step**, not by a ticket: `WAITING_FOR_MANAGER` (S-11) with the reason
  taken from the ticket. `clientSection()` loses the `openRequestCount > 0` rule; "Čaká na nás" becomes
  "next step = WAITING_FOR_MANAGER". **The `Na dnes` SQL predicate must lose its `NOT EXISTS (open request)` clause in
  the same commit** – the W1-C parity test will fail loudly otherwise, which is the point.
- The `ORDER` next-step kind added in wave 2 is superseded by `WAITING_FOR_MANAGER` + reason. The enum value stays in
  the database as legacy (dropping an enum value is a destructive migration for no gain) and disappears from
  `NEXT_STEP_OPTIONS`.

### D-17 — Ticket kinds match how the work actually splits

**Michal:** *"until client asks for CP or about us email, its managed by sales rep"* – the rep owns the relationship, the
manager owns the artifacts (price, design) and any technical conversation.

| Kind | Meaning | Typical trigger |
|---|---|---|
| `PRICE` | naceň to | rep unsure of the price (b2) |
| `DESIGN` | sprav návrh | "chcú návrh" (a1) – created automatically from the call outcome |
| `CALL_CLIENT` | zavolaj im, sú tam technické detaily | "chcú návrh, ale majú otázky" (a2) |
| `HANDOVER` | prevezmi si klienta | after the návrh: "áno, ideme do toho"; or manually, any time |
| `OTHER` | čokoľvek iné | rare |

**`ORDER` is removed as a ticket kind.** When the client says "ideme do toho" nobody yet knows what exactly is being
built – that is a *handover*, not an order specification. Marking **WON stays a manager action on the deal**, always
(Michal: *"won is only mine"*), and later grows an end-price/detail step before it can be set (see §7 future).
No backfill is needed: production has no `DealRequest` rows at all yet (round 1 is unshipped), and test rows are
fixtures.

Consequence for the note rule: **the note is required only for `OTHER`**, and every creation path – outcome or manual –
goes through one function so the rule cannot differ again. The box is **pre-filled with the last call note**, because
the context usually already exists from the call (Michal: *"the note is possibly already after telesales call"*).

### D-18 — Tickets are a conversation, and they are editable

- The author may **edit the ticket text while it is open** (missclick, reword). Every edit is logged with who and when.
- **Both sides append comments** ("volali mi, chcú aj eshop") – the ticket accumulates context up to the moment it is
  resolved, which is exactly the case Michal described: the manager is already building when the client calls the rep
  with more requirements.
- **Age is set at creation and editing does not reset it.** Cancel + re-create does, which is honest – that is a new ask.
- **Cancelling un-parks the deal**: the next step is cleared and the deal appears in "Na dnes" with the badge
  "bez ďalšieho kroku". No forced replacement step (Michal: *"maybe dont ask for replacement"*), but it cannot silently
  vanish either.
- One open ticket per (deal, kind) stays; a second create appends to the open one, which is already today's behaviour.

### D-19 — Resolving a ticket is two switches, not three branches

The manager resolves with two choices, so the three endings Michal listed are combinations rather than special cases:

| Switch | Values |
|---|---|
| **Kto posiela klientovi** | manažér · obchodník |
| **Kto pokračuje** | obchodník (deal stays) · manažér (owner moves) |

| Ending | Switches | Result |
|---|---|---|
| a) rep sends, rep continues | obchodník / obchodník | rep's next step := "Poslať návrh" |
| b) manager sends, rep continues | manažér / obchodník | rep's next step := "Zavolať – overiť, či videli návrh" |
| c) manager sends, manager continues | manažér / manažér | owner moves to the manager, ticket closes as "prevzal som si klienta" |

(b) is unlikely today but costs nothing, and the same two switches will carry manager → developer delegation later.

**No manager → rep tickets in this wave.** When the manager hands work back, the resolution sets the rep's next step and
it shows up in their "Na dnes"; that is enough (Michal: *"they will just see it in Na dnes"*). The *direction* is in the
model from day one so the inbox tabs work and a developer inbox is an addition, not a redesign.

### D-20 — Handover is an explicit act, and the rep loses the deal

- The manager can take any deal over **at any time**, with or without a ticket: filter by the rep, open the deal,
  "Preberám si klienta". One click, no typing; an optional note is shown to the rep in *Vybavené*.
- A `HANDOVER` ticket resolved with "kto pokračuje = manažér" does the same thing.
- **After a takeover the rep loses access** (Michal: *"I dont see reason except curiosity, and when there will be
  hundreds of contacts its just clutter"*). Out of scope = 404, as today.
- The transfer asks once: **"Zavrieť otvorené tikety? (2)"**, default yes; the ticket text is carried into the deal so
  nothing is lost. "Nechať otvorené" stays available for future rep → rep transfers.

### D-21 — "História" for the rep, and statistics

A small **ownership-history** record (S-12) stores every change of owner: which deal, from whom, to whom, by whom,
when, optional note. It powers three things at once:

1. the rep's **História** view – a button next to "Obnoviť", listing deals that were taken over: for now only
   `prevzaté 18. 9. · Michal` (Michal: *"for now, only prevzaté michal, in future we maybe change it"*);
2. **statistics** – "she brought 14 deals" survives the takeover;
3. future **rep → rep** transfers, which need the same record.

The list shows names and dates only. Whether a rep may open the detail of a handed-over deal is a **single capability
flag** (`deals.viewHandedOver`, nobody holds it), so flipping it on later is one line, not a rewrite.

### D-22 — Counters on every pill

Michal spent a whole session believing "Všetko" was empty. Every pill gets its count (`Všetko`, `Na dnes`, each
next-step pill, `Požiadavky`), computed with the same scope + owner filter as the list, so a number always matches what
clicking it shows. The inbox pill is the exception by design: it counts **tickets addressed to me**, regardless of the
owner filter.

### Walk-through of Michal's flows

| Flow | What happens after wave 3 |
|---|---|
| INITIATE → návrh | `DESIGN` ticket created automatically, text pre-filled from the call note and editable; deal next step = "Čaká na manažéra · návrh"; it stays in the rep's list, parked, and appears in the manager's inbox |
| …manager needs details (a2) | manager resolves or adds `CALL_CLIENT`; after calling, usually resolves with "kto pokračuje = manažér" → takeover |
| INITIATE → CP → cenník | no ticket – the rep sends it and marks it sent |
| INITIATE → CP → treba naceniť | `PRICE` ticket; deal parked on "Čaká na manažéra · cena"; manager fills the price and resolves → rep's next step = "Poslať cenovú ponuku" |
| after návrh: "áno, ideme do toho" | `HANDOVER` ticket (not "objednávka"); manager takes over, the rep's list loses it, História keeps it |
| rep cancels a ticket | next step cleared → deal shows in "Na dnes" as "bez ďalšieho kroku" |

### Schema for wave 3 (all additive; rows go in `db-changes.md`)

| id | Change | Note |
|---|---|---|
| S-08 | `DealRequestKind += CALL_CLIENT, HANDOVER` | `ORDER` stays as a legacy value, unused by new code |
| S-09 | `DealRequest.toUserId`, `DealRequest.toRole`, `DealRequest.updatedAt` | direction + edit tracking; existing rows mean "for the manager" |
| S-10 | `DealRequestComment` (requestId, authorId, body, createdAt) | the ticket thread |
| S-11 | `NextActionKind += WAITING_FOR_MANAGER` | replaces the wave-2 `ORDER` step |
| S-12 | `DealOwnership` (leadId, fromUserId, toUserId, byUserId, note, createdAt) | História + stats + future rep → rep |

### What wave 3 must re-verify

- `clientSection()` loses a rule → `check-client-sections.ts` expectations change, and the `Na dnes` SQL must change
  with it (the W1-C parity test is the gate).
- New checks: a rep's inbox never shows another rep's tickets; a manager's inbox ignores the owner filter; resolving with
  each switch combination produces the right owner and next step; a takeover closes tickets and removes the rep's access
  while the ownership record survives; cancelling a ticket clears the next step.

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
lib/queries/deals/requests.ts              requestsForViewer() – one definition of "requests I care about"
```

Deleted: `components/clients/**`, `lib/queries/clients/**`, the section-board UI.
Unchanged and non-negotiable: `lib/commands/**` transaction bodies, locking order, one revision bump per transaction,
idempotency replay, strict zod at every boundary, business-calendar day math, server-side scope.

## 4. Schema changes

| id | Change | For | Risk |
|---|---|---|---|
| S-01 | `NextActionKind += ORDER` | D-10 | none (additive enum) |
| S-02 | `LeadNote` model + `LeadNoteKind`, `NoteStage` enums | D-07 | new table only |
| S-03 | `Lead.pricelistSentAt`, `priceQuotedAt`, `priceQuotedVia`, `priceItems Json?` | D-09 | nullable columns |
| S-04 | *(later, only if stats need it)* `Activity.replyKind` enum | D-06 | column + backfill from `meta` |
| S-05 | *(dropped)* `Lead.brief Json?` | D-08 step 2 | — |
| S-06 | *(rejected)* drop `Lead.lockedById` / `lockedAt` | D-14 | destructive; keep the columns |
| S-07 | *(later, with the dev role)* `DealRequest.toRole` / `toUserId` | D-15 | nullable columns |

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
| **3** | **Tickets, handover, história (§2b, D-16…D-22)** – inbox with Pre mňa / Od mňa / Vybavené, `WAITING_FOR_MANAGER`, `HANDOVER` instead of `ORDER`, ticket thread + editing, two-switch resolution, ownership history, counters on every pill | S-08…S-12 (all additive) | full check pass incl. the new `Na dnes` ↔ `clientSection()` parity after its rule change |
| 4 | D-07 notes (S-02) + the ORDER note mirror (D-08 step 3) + B-09 | S-02 (new table + 2 enums) | full check pass |
| 5 | D-09 pricing (S-03) | S-03 (4 columns + 1 enum) | full check pass |

Rough sizes: wave 1 ≈ 3–4 days (done), wave 2 ≈ 3–4 days (done), wave 3 ≈ 4–5 days, wave 4 ≈ 2 days, wave 5 ≈ 1.5–2 days.

Notes and pricing moved **behind** the ticket model on purpose: "what did they order" and "what did we quote" end up
inside tickets and handovers, so building the notes wall first would mean rebuilding half of it.

Every database change, including the ones round 1 still owes production, is tracked in
**`context/new-feature/db-changes.md`**. Wave 1 deliberately has **zero** database changes: if an agent thinks the merge
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
- Manager → rep tickets and a developer inbox — the direction is in the model (D-19), the UI is not.
- The WON step Michal wants later ("really show end prices, and details and then mark it as won") — wave 5 territory,
  after pricing.
- Contact-level locking (D-14: the claim design already replaced it).
- Any production rollout: the round-1 production rehearsal and rollout (`planning.md` §14) are still pending and remain
  a separate, explicitly approved session. This round must not be mixed into it.
