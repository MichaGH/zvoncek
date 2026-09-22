# Wave 5 — the interaction workflow, written down (2026-09-21)

**Why this file exists.** Michal, after the second click-through: *"We need to plan this workflow, I can see both AIs
are guessing a little."* He is right. The screens were built one question at a time, so the same thing gets asked
twice and contradictory answers are possible ("chcú návrh" **and** next step "Zavolať" at once). This file is the
contract the interaction sheet must obey. Design (the cards, the grouping, the colours) is **not** the problem —
Michal likes the redesign. The **model underneath** is.

Status: written 2026-09-21, implemented on `feature/wave5-workflow-fix`. Backup of the state it was written against:
`backup/wave5-ui-redesign-2026-09-21`.

---

## 1. The one rule everything follows

> **"Poslať niečo" is never a step you choose. It is what the client is still waiting for.**

The rep chooses **when we talk to them again** (call / wait / something custom) or **closes** the deal. What has to be
*sent* is already known: it is the outstanding set from wave 5 (open client requests + what the manager is making +
what the manager returned and nobody sent yet). The step headline is derived from it — "Poslať návrh + cenu + cenník".

Consequences, all of which are currently violated somewhere:

| Rule | Where it is broken today |
|---|---|
| A step picker never offers `SEND_QUOTE` / `SEND_DESIGN` / `SEND_EMAIL` | the sheet after every answer, "Zmeniť krok", "Nezdvihli", "Poslali sme SMS" |
| Saying *what* they want already sets the step — there is no second question | after "Chcú niečo…" the sheet asks "aký je ďalší krok?" and lets you pick "Zavolať", which then shows "Zavolať" + "⚠ Chceli návrh" |
| "Úvodný email" is not a thing any more | `NEXT_ACTION_LABEL.SEND_EMAIL = "Poslať úvodný email"`, and the sheet writes "(cenník + info)" |
| Nothing outstanding can be *snoozed away* silently | "Ozvať sa o pár mesiacov" with an unsent price asks nothing |

**The five things that exist**, and nothing else: **Info · Cenník · Cena · Návrh · Rozbor webu**. Any combination.
"Úvodný email" is dead as a concept — it was one fixed bundle (o nás + cenník) from before wave 5. The enum value
`SEND_EMAIL` stays in the database (production rows use it) but it means *"send the e-mail contents that are
outstanding"*, and the UI must never print the word "úvodný".

**Ordering, everywhere it is listed:** Info · Cenník · Cena · Návrh · **Rozbor webu last**.

---

## 2. The interaction, as three questions

The sheet asks at most three questions, and skips any it can already answer.

```
Q0  Čo sa stalo?        Dovolal/a som sa · Nezdvihli · Odpísali · Poslali sme SMS
                        (+ Odoslanie a plán: Poslali sme ponuku · Zmeniť krok · Ozvať sa o pár mesiacov)
                        (+ Nemajú záujem / zlé číslo · Požiadať manažéra · Otvoriť detail)

Q1  Povedali cenu?      only after "Dovolal/a som sa" — its own screen, not a tick box wedged
                        between other things. Skippable in one click.

Q2  Čo povedali?        single choice. One of the answers is "Chcú niečo…" → Q2b.
Q2b Čo chcú?            multi-select of the five contents → SAVE. No third question.

Q3  Kedy ďalej?         only for answers that do not decide it themselves.
```

### Q0 — what happened

"Dovolal/a som sa" and "Odpísali" behave **identically** from Q1 on — the only difference is the history row
(`CALL` vs `CLIENT_REPLIED`). Michal: *"if I go into Odpísali, everything should be the same as in Dovolal/a som sa."*

### Q1 — "Povedal/a som cenu" is its own screen

Today it is a tick box that sits above the answers and has **no way to continue** — a dead end. It becomes its own
step, asked only after "Dovolal/a som sa":

- **"Áno, povedal/a som im cenu"** → amount + optional breakdown → continue to Q2.
- **"Nie"** (default, one click) → straight to Q2.

The price is recorded as a `PHONE` receipt either way; it is a fact about the client, not a step.

### Q2 — what they said

**Single choice.** Picking one replaces the previous one. Pressing "Späť" clears it. The two states cannot coexist.

| Answer | What it means | Q3 |
|---|---|---|
| **Chcú niečo…** | they asked for content → Q2b | **no Q3** |
| Ešte sa na to nepozreli | posted, not read yet | Zavolať · Čakáme na klienta |
| Pozreli, chcú zmeny | the návrh has to be reworked | **no Q3** — see §3 |
| Neprišlo im to | resend | **no Q3** — see §4 |
| Ozvú sa sami | ball in their court | Čakáme na klienta · Zavolať |
| Majú poradu / rozhodujú sa | deciding | Zavolať · Čakáme na klienta |
| Cena je vysoká | negotiating | Zavolať · Čakáme na klienta · Vlastný krok |
| Chcú objednať | closing | Zavolať · Vlastný krok (+ the handover offer, unchanged) |

**"Rieši to niekto iný" is removed** — Michal: *"doesn't make sense"*. If the contact person changes that is a
contact edit, not a call outcome.

### Q2b — what they want

The five contents as toggle cards, then **Uložiť**. That is the end of the chain:

- each tick creates a `LeadRequest` row (wave 5, unchanged);
- the step becomes the derived send step, due today — **the sheet does not ask "aký je ďalší krok?"**;
- if the rep really wants a call instead, that is a separate, deliberate act ("Zmeniť krok" afterwards), and then the
  ⚠ warning is correct and wanted, because she chose a step that does not cover what they asked for.

This is exactly Michal's P3: *"next step should be — send info, cena, rozbor webu, cenník, návrh. We do not select
the new next step now."*

### Q3 — when next

Only two real choices plus an escape hatch:

- **Zavolať** + date (required);
- **Čakáme na klienta** — `IN_PROGRESS`, so the list shows *how long we have been waiting*, not a deadline
  (Michal: *"this should be rozpracované — not when to wait, but how long we have been waiting"*);
- **Vlastný krok** for anything else.

No send kinds. Ever.

---

## 3. "Pozreli, chcú zmeny"

The návrh has to be reworked, and the manager does that. So the answer sets the step to **"Poslať návrh"**
(outstanding DESIGN — a reworked návrh is a návrh they have not received) and offers, in the same breath,
**"Požiadať manažéra o úpravu"**, exactly like "Chcú objednať" offers the handover today.

Open, needs Michal: whether ticking this should also create a new `DESIGN` request row (so the checklist says "chceli
návrh") or whether the existing sent návrh plus a note is enough. **Proposed: create the row** — they did ask for
something they do not have yet, which is precisely what a request row means.

---

## 4. "Neprišlo im to"

Michal: *"do we select that we sent them the email, or just write it into the note? I think we might just have a
modified last step — 'Neprišlo im – poslal som znovu' … next step will be call in X days."*

**Decision taken here:** resending is **not** a new `OFFER_SENT`. The client received nothing new; the same contents
went out again. So:

- the history row says *"Neprišlo im to – poslané znova"*;
- no receipt is written, no request row is closed or reopened;
- the step goes to **Zavolať** (date) or **Čakáme na klienta**.

If the rep genuinely sent something *different*, that is "Poslali sme ponuku" — the normal path.

---

## 5. "Nezdvihli" and "Poslali sme SMS"

Michal: *"why is there poslať cenu, poslať návrh again? Just either call again or trash the contact."*

- **Nezdvihli** → Zavolať (default: next working day) · Čakáme na klienta · Nemajú záujem / zlé číslo.
- **Poslali sme SMS** → the SMS text, then Zavolať · Čakáme na klienta.

Neither offers a send step. If something is outstanding, the headline keeps saying so and the ⚠ appears — that is the
warning doing its job, not a step to pick.

---

## 6. "Ozvať sa o pár mesiacov" and closing with unsent work

Michal (P7): snoozing a deal whose step is "Poslať návrh + cenu + cenník" asks nothing. It must.

**Rule:** if anything is outstanding, snoozing or closing the deal shows what is unsent and requires a short reason,
the same way "Neposielam" already does for a returned manager result. The wave-3 machinery for that exists
(`dismissItems`, `dropReason`); it just is not wired to the client requests. When the reason is given, every open
request is **withdrawn** with it — the client asked, we consciously decided not to send it, and that is recorded.

---

## 7. "Čo sme poslali" (P1, P6)

- **No "Späť".** Add one.
- **Návrh cannot be ticked** when the deal has no `Design` row, because the list is built from the designs. A návrh
  can be sent without a tracked design row existing (old deals, a PDF, a link in the mail). Offer a plain "Návrh"
  tick that records `DESIGN` without a design id when there is nothing to pick.
- **Order:** Info · Cenník · Cena · Návrh · **Rozbor webu**.

Open, needs Michal: **is the dialog additive or absolute?** Today it is *additive* — it records one send, and the
contents are pre-ticked from what is still outstanding. Michal asked: *"ask for cenník → tick cenník; later ask for
návrh → is the cenník already ticked, and we just add návrh?"* **Proposed: it stays additive and pre-ticks only what
is outstanding**, because each row is one real e-mail. Already-received contents show under "Klient dostal" with
their date, so nothing is lost.

---

## 8. Small things from the same click-through

| # | What | Decision |
|---|---|---|
| P0 | Card content is not vertically centred | **done** — see §10 |
| P1 | "Poslali sme ponuku" has no "Späť" | add it |
| P2 | Q1 (cena v hovore) forced the answers to be tick-boxes | Q1 is its own screen (§2) |
| — | "Naposledy" says *Majú záujem* from `/calls` but *Pozitívny posun* in pipeline | Michal: *"this kinda makes sense"* — left alone |

---

## 9. What this does **not** change

The data model. `LeadRequest`, the reconciliation, `OFFER_SENT`, the step lock, the manager tasks — all stay exactly
as wave 5 built and tested them. Everything above is the **question order and the choices offered**, plus two small
server rules (§6 withdraw-on-snooze, §4 resend writes no receipt).

---

## 10. Card rhythm and colour (Michal, 2026-09-21)

**Vertical rhythm.** The cards were `items-start` with ad-hoc `mt-0.5` / `mt-1` nudges, so a one-line card sat
differently from a two-line one. Now the card is `items-center` with symmetric `py-3`: the icon tile, the title +
subtitle block and the radio/checkbox are one horizontal row, centred as a group, evenly spaced from the top and
bottom edge. **Nothing is centred horizontally** — the text stays left-aligned, as Michal asked.

**Colour carries meaning, and only the icon is coloured.** Card text and borders stay neutral, so a screen full of
cards does not turn into a rainbow; the selected state is still the primary border + ring. One tone per meaning:

**The tile is the colour, the icon is white** (Michal, 2026-09-21: *"the whole area around the icon should be the
contrasty colour and the icon itself white"* — a pale tint behind a coloured glyph looked washed out). The shades are
the ones shadcn uses in its themes, picked so white keeps enough contrast in light and dark mode.

| Tone | Class | Means | Used by |
|---|---|---|---|
| blue | `bg-blue-500` | contact / information | Dovolal/a som sa, Odpísali, Zavolať, Info / ukážky, Chcú niečo poslať, Majú poradu |
| teal | `bg-teal-600` | waiting, general price list | Čakáme na klienta, Cenník, Poslali sme SMS, Ozvú sa sami |
| green | `bg-emerald-600` | money, a win | Konkrétna cena, Cena v hovore, Poslali sme ponuku, Chcú objednať, Cena (úloha) |
| violet | `bg-violet-500` | návrh / design | Návrh, Pozreli chcú zmeny, Ozvať sa o pár mesiacov, Návrh (úloha) |
| orange | `bg-orange-500` | attention, something is off | Rozbor webu, Neprišlo im to, Cena je vysoká |
| rose | `bg-rose-500` | the end | reserved for Nemajú záujem / zlé číslo |
| slate | `bg-slate-500` | no signal | Nezdvihli, Iná odpoveď, Vlastný krok, Iné (úloha) |

The same tones are used in **"Požiadať manažéra"**, so the two dialogs agree: Cena is emerald, Návrh is violet, Iné
is neutral. Every tone has a dark-mode pair.

**Quick dates.** "Zavolať" (and every step that takes a date) now has one-click presets above the date field —
**Zajtra · O 3 dni · O týždeň · O 2 týždne**, in business calendar days, the same arithmetic the answer defaults use.
Clicking the active one clears it, and the manual date picker stays underneath for anything else.
