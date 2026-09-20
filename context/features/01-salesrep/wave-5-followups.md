# Wave 5 — problems found in Michal's click-through (2026-09-20)

Found by Michal on the test branch right after wave 5 was built, in a real click-through. **Reviews must not close
these as "works as designed" without a decision from Michal.** Backup of the state where they were found:
branch `backup/wave5-built-pre-ui-fix-2026-09-20` (not pushed).

| # | What | Status |
|---|---|---|
| F1 | `/calls` handoff toast says "Odovzdané: Jana Obchodníková" when Jana **is** the caller and the new owner | **open** |
| F2 | "Poslať návrh" does not land in "Na dnes", so asking the manager today is invisible today | **open — needs a decision** |
| F3 | The `/pipeline` interaction sheet repeats the same options and has no way to confirm the ticks | **fixed 2026-09-20**, branch `feature/wave5-interaction-ui` |

---

## F1 — "Odovzdané: <myself>"

`/dashboard/calls`, a caller who may own deals (SALES_REP / MANAGER) makes a positive first call. The deal is routed
to **herself** (`resolveDealOwner` returns the caller), and the toast still says *"Odovzdané: Jana Obchodníková"* —
as if she had passed it to someone else.

Where: `components/calls/CallQueue.tsx` (`handleOutcome`, the `"recipient" in r` branch) and the recipient built in
`lib/commands/calls.ts` / `lib/domain/idempotency.ts`.

**Proposed fix (not applied):** when `recipient.id === viewer.id`, say something like *"Máš to ty – obchod je v
Pipeline"* instead of "Odovzdané: …". The recipient id is already returned, so this is a client-side change only; the
page would need the viewer's id passed into `CallQueue`. Nothing about ownership or routing changes.

---

## F2 — "Poslať návrh" is not "Na dnes", but the work **is** for today

What Michal saw: a first call asking for a price / info / cenník / rozbor lands in **Na dnes** (right — it means
"send it now"). A first call that includes **návrh** lands in **Všetko** instead, because `SEND_DESIGN` is
`IN_PROGRESS` ("trvá X dní") and `clientSection` puts in-progress deals in **Rozpracované**, never in "Na dnes".

Michal: *"it kinda makes sense, I wouldn't change it"* — **but** the rep still has something to do **today**: tell the
manager to start on the návrh. Today nothing reminds her of that.

> **This is a concept to think through, not a quick fix.** "Na dnes" must mean *work I have to do today*. Sending a
> price, info or rozbor is today's work. Asking the manager for a návrh is **also** today's work; only *waiting* for
> the návrh is not.

Ideas to weigh (none decided):

1. A deal whose návrh is outstanding and that has **no open manager task yet** is "Na dnes" ("Požiadať manažéra o
   návrh"); once the task exists it moves to "Čaká na manažéra" — which already happens through the step lock. This
   keeps `IN_PROGRESS` meaning "somebody is already working on it".
2. Keep `SEND_DESIGN` `SCHEDULED` + due today until a task is opened, and only then let it become in-progress.
3. Leave the sections alone and add a separate nudge ("Návrh ešte nikto nerobí").

Whatever is chosen touches `clientSection()` **and** its SQL twin `TODAY_SQL` (`lib/queries/pipeline/index.ts`)
together, plus the `w1TodayParity` test — see `context/code-standards.md` §5.

---

## F3 — The interaction sheet repeated itself (fixed)

What Michal saw on `/pipeline` → contact → "Dovolala som sa":

- a tick box "Povedal/a som cenu", then the "Čo povedali" buttons, then a second block of tick boxes
  "Chcú aj info / cenník / konkrétna cena / návrh / rozbor webu" — **with no way to confirm them**;
- the "Čo povedali" list itself still contained "Chcú konkrétnu cenu" / "Chcú návrh" / "Chcú info", so the same thing
  could be said in two places;
- whatever was picked, the next screen offered **all** six step kinds again, including "Poslať cenu" / "Poslať návrh"
  / "Poslať úvodný email" — the very thing that had just been selected.

Michal: *"it doesn't make sense, the options repeat multiple times in the chain … it has to be a high-efficiency,
working, beautiful chain of windows"*, and: the style of **"Požiadať manažéra"** (the Cena / Návrh / Iné cards) is
the one to follow, with horizontal cards on a phone.

**What was changed** (`components/pipeline/InteractionSheet.tsx`, `lib/domain/clientReplies.ts`):

1. "Dovolala som sa" now asks one question — *what happened?* — as selectable cards in the `AskManagerDialog` style:
   a primary **"Chcú niečo…"** card, then the follow-up answers.
2. **"Chcú niečo…"** opens its own screen with the five contents as **toggle cards** (not tick boxes) and one
   "Pokračovať" button. The next step is then **derived** from what they asked for and shown as the default; the
   only alternatives offered are a call, waiting for the client or a custom step — never another "Poslať …".
3. Every follow-up answer now carries its **own** short list of sensible next steps, so the screen shows two or three
   choices instead of six: "Ozvú sa sami" → čakáme na klienta / zavolať; "Majú poradu" and "Ešte sa nepozreli" →
   zavolať / čakáme na klienta; "Neprišlo im to" → poslať znova / zavolať / čakáme; "Pozreli, chcú zmeny" → poslať
   návrh / vlastný krok; "Cena je vysoká" → zavolať / poslať cenu / vlastný krok; "Chcú objednať" → zavolať /
   vlastný krok (and the handover offer, as before).
4. "Chcú konkrétnu cenu" / "Chcú návrh" / "Chcú info" disappeared from "Čo povedali" — they are the "Chcú niečo…"
   path now. Their keys stay valid in `CLIENT_REPLIES` (marked `legacy`) so old history rows and the existing tests
   keep working.

Still open from Michal's message and **not** decided here: what "Pozreli, chcú zmeny" should really do once wave 4
lets a rep hand a change request to the manager in one move, and whether "Cena je vysoká" deserves its own path.
