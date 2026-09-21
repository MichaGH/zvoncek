# 02 — Data mapping specification

This is the working mapping. Final approved rules must be synchronized to authoritative context before implementation.

## Canonical target concepts

- What the client received: `Activity(type = OFFER_SENT)` with canonical metadata, source provenance and
  `meta.migrated = true` for converted history.
- Exact price received: `PRICE` content with an amount snapshot. This is also the statement that the client knew/saw
  that price; there is no separate V2 knowledge flag.
- What the client asked for: `LeadRequest`, generated only after canonical send conversion so receipt-backed requests
  can be marked `SENT` and linked correctly.
- Current editable price: `Lead.price`/`priceNote`; these remain and must not be modified by conversion.

## Draft source -> target matrix

| V1 evidence | Draft V2 result | Required source facts | Exception when |
|---|---|---|---|
| `Lead.price` only | one migrated exact `PRICE` receipt | amount from `Lead.price`; date policy unresolved | no reliable event date |
| `priceDisclosed = true` | exact `PRICE` receipt | amount; best verified source/date/channel | price null, date missing, conflicting events |
| `quoteSentAt` and/or `QUOTE_SENT` | email exact `PRICE` receipt | group matching field/activity; amount snapshot | undo, multiple unmatched rows, missing amount/date |
| `aboutUsSentAt` and/or confirmed about-us `EMAIL_SENT` | email `ABOUT_US + PRICE` | exact price amount; same-email identity | generic email is not about-us, amount/date missing |
| `Design.sentAt`, `Lead.designSentAt`, `DESIGN_SENT` | email `DESIGN + PRICE` | design identity/snapshot; amount; date | undone send, no Design row, multiple ambiguous designs, amount missing |
| explicitly named cennik email | add `PRICELIST` to that same event | exact lead + source event identity | ambiguous event or unnamed recipient |
| no evidence | no migrated receipt | — | — |

## Event grouping

Event identity is not the same as field identity.

- One real email containing info, price and proposal becomes one canonical event with all three contents.
- Separate real emails become separate events even on the same calendar day.
- Matching field/activity rows that describe the same old action become one canonical event with both sources in
  provenance.
- A reversible field being null does not automatically erase a historical activity; the undo sequence must be
  classified.

## Provenance required on every migrated event

- deterministic migration key/source identity;
- `migrated: true`;
- original field names and old activity IDs;
- original timestamps and selected business date;
- original actor where known; never silently substitute the current owner;
- rule ID and whether the target content was directly evidenced or inferred by the approved broad rule;
- amount source and confidence;
- explicit manager decision for an exception;
- no live-action idempotency fingerprint that a future user retry could match.

## Exception classes

Use stable codes in reports and override files:

- `E_AMOUNT_MISSING`: exact price implied, no amount.
- `E_DATE_MISSING`: receipt implied, no defensible business date.
- `E_PRICE_CHANGED`: several events but only one current amount survives.
- `E_GENERIC_EMAIL`: `EMAIL_SENT` cannot be confirmed as the about-us email.
- `E_UNDO_SEQUENCE`: field/activity history indicates a later undo or correction.
- `E_EVENT_GROUPING`: contents may have been in one or several emails.
- `E_DESIGN_IDENTITY`: sent proposal has no unique surviving Design.
- `E_PRE_DEAL`: send evidence exists outside the deal stage.
- `E_EXISTING_CANONICAL`: V2-style `OFFER_SENT` already exists and may overlap.
- `E_ACTOR_UNKNOWN`: only field evidence exists.
- `E_OTHER`: description and explicit decision required.

`skip` is not a successful classification. Every exception must end as a documented representation or an approved
no-op whose source remains covered by verification.

