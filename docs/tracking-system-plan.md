# Proposal tracking system — build plan

Source of truth for the multi-round build. Update the checkboxes as phases land.

## Locked design decisions

- **Goal:** know whether a client opened a design/quote we sent, when, and whether
  they opened it **after we updated it**. Treat every signal as *probabilistic*
  (a browser loaded the page), **never proof of who**.
- **Tracking = query param on the proposal page**, not email pixels, not redirect links.
  - Param: **`?p=TOKEN`** (short, neutral; avoid `track`/`utm` so ad-blockers don't strip it).
  - Snippet reads token, then `history.replaceState` to strip it (clean URL + less Referer leak).
  - Page also sets `<meta name="referrer" content="no-referrer">`.
- **Universal dumb snippet.** Same ~30-line script pasted into every proposal site.
  It always sends the standard events; you never configure "what to track" per site or
  in Zvonček. New signals (time-on-page, scroll, CTA) are added to the snippet **once**
  and flow into the flexible `TrackedEvent` schema (`durationMs`, `meta Json?`).
- **Version vs variant — behavioral rule:** decide by *"do both designs need to be live
  at the same time?"*
  - Replace content at the **same URL** → **version bump** (covers tweaks *and* full remakes).
  - Two+ designs **live at once** (legar) → **separate variants** = separate `TrackedLink`s.
- **Design has its own environment** (not an inline textbox). First send asks for the URL.
  "Update version" lets you optionally change the URL **and** add an optional note
  ("changed DNS", "fixed what client wanted", or nothing) → that's a `TrackedLinkVersion` row.
- **Quote/price offer:** usually plain email text → nothing to track. Only spin up a
  `kind = QUOTE` tracked page when a deal is worth the open-signal. No pixels, no PDFs.
- **Design-without-price:** keep `quoteSentAt` and `designSentAt` as independent facts.
  When sending design WITH price, set BOTH. Surface a ⚠ "design sent, no price yet" badge
  when `designSentAt != null && quoteSentAt == null`.
- **Permissions:** public ingest endpoint is anonymous and must never return lead data.
  All reads/management go through auth + a single `canManagePipeline(user)` gate (stub
  returns true today; flip when MEMBER/MANAGER/ADMIN arrive). Tracking is manager/dev territory.
- **Call-at-time:** NO "mark as called" tick. Logging the call outcome (a timestamped CALL
  activity) is the completion signal; clear `callbackAt` when a CALL activity lands.
- **Future-proofing (NOT built now, must stay possible):** clients-as-users portal,
  per-version change requests, price-per-version, CTA/scroll events. They bolt onto
  `TrackedLink` + `versionAtView` with no rewrite.

## Schema (DONE — Phase 0)

`prisma/schema.prisma`, synced via `npx prisma db push` (Prisma 7, no migrations folder).

- `Lead.origin LeadOrigin @default(MARKETING_CALL)` — supports non-marketing leads (restaurant client).
- `Activity.meta Json?` — field-diffs + tracker milestone metadata.
- `ActivityType` += `TRACKER_ATTACHED`, `TRACKER_UPDATED`, `TRACKER_OPENED`.
- New enums: `LeadOrigin`, `TrackedLinkKind {DESIGN,QUOTE,OTHER}`, `TrackedEventType {PAGE_VIEW,ENGAGED_VIEW}`.
- New models: `TrackedLink`, `TrackedLinkVersion`, `TrackedEvent` (see schema for fields).
  - `TrackedLink.leadId` is NULLABLE → standalone trackers.
  - `TrackedEvent` carries `durationMs`, `ip` (raw, authorized — coarse geo later), `uaShort`, `botFlag`, `meta`.

## Confidence logic (derive on read, don't store)

- **none** — no events.
- **weak / maybe-bot** — only PAGE_VIEW, no ENGAGED_VIEW ever; or `botFlag`; or fired within
  ~X s of `designSentAt`.
- **medium** — PAGE_VIEW, not bot-flagged, never crossed engagement threshold.
- **high** — ≥1 ENGAGED_VIEW.
- **very high** — ENGAGED_VIEW on a separate day/session, or engaged with `versionAtView == currentVersion`
  after an update, or (later) CTA click.
- **"viewed after update"** is separate: `exists ENGAGED_VIEW where versionAtView == currentVersion`.

## Remaining phases

### Phase 1 — ingest + snippet + tracking lib  ✅ DONE (verified end-to-end)
- [x] `app/api/p/route.ts` — public `POST` collector, body `{ p, e, d? }`. Resolves token→link,
      always 204 (no token-validity leak), ACAO `*` + OPTIONS, text/plain simple-request, 45s PAGE_VIEW
      dedup per IP, `botFlag` from UA, coarse `uaShort` + raw `ip`. Never returns lead data.
      (Rate-limiting beyond dedup deferred — low volume.)
- [x] `lib/queries/tracking/index.ts` — `resolveTokenForIngest` + `getTrackedLinksForLead` (with summary).
- [x] `lib/actions/tracking/index.ts` — `createTrackedLink`, `markTrackedLinkUpdated` (new version + url/note),
      `revokeTrackedLink`. Gated by `canManagePipeline` (`lib/permissions.ts`). Logs TRACKER_ATTACHED/UPDATED.
- [x] token generation — `lib/tracking/tokens.ts` (`generateToken`, `looksLikeBot`, `shortUa`).
- [x] confidence — `lib/tracking/confidence.ts` (`summarizeEvents`).
- [x] universal snippet — `public/p.js` (self-hosting: infers `/api/p` from its own origin; PAGE_VIEW +
      ENGAGED_VIEW heartbeat/scroll, durationMs, replaceState token strip).
- [x] dev test page `app/dev/proposal/page.tsx` (dev-only) + seed `prisma/seedTracking.ts` (`npm run seed:tracking`).
- [x] `NEXT_PUBLIC_APP_URL` in `.env` (placeholder `http://localhost:3000` — swap on deploy).
- [ ] STILL TODO: real public base URL value once deployed; add `addVariant` convenience action (or just call
      `createTrackedLink` again with same leadId).

### Phase 2 — pipeline [id] Design & tracking UI  ✅ DONE (tsc + lint + build pass)
- [x] `components/pipeline/DesignTrackingCard.tsx` — create tracker (URL + label), copy tracked URL
      (`targetUrl?p=token`), confidence badge + "viewed after update" badge, ⚠ design-no-price warning,
      last-opened summary, **"Označiť ako aktualizovaný"** (url+note → new version), "Pridať variant", revoke.
- [x] Wired into `PipelineDetail.tsx` (new `trackedLinks` prop) + `page.tsx` (`getTrackedLinksForLead`).
- [x] dictionaries: `CONFIDENCE_LABEL/VARIANT`, `TRACKED_LINK_KIND_LABEL`.
- [ ] STILL TODO: when design sent + tracker attached, optionally auto-set `nextAction = WAITING_FOR_CLIENT`
      (currently `logSent` already sets a CALL follow-up; revisit if it should change). Tracking only suggests,
      never auto-rewrites nextAction.

### Phase 3 — Activity integration
- [ ] `lib/activityLog.ts` — write field-diff into `Activity.meta` on contact/price edits so history shows
      WHAT changed (phone/web/email/price: from → to), not just "changed".
- [ ] Emit milestone activities: `TRACKER_ATTACHED`, `TRACKER_UPDATED`. Defer auto `TRACKER_OPENED` until
      confidence logic is proven on real data (avoid bot-driven false timeline entries).
- [ ] `lib/dictionaries.ts` — Slovak labels for new ActivityType values + LeadOrigin + tracker kinds.

### Phase 4 — tracking hub + standalone trackers
- [ ] `app/dashboard/tracking/page.tsx` (top-level, NOT under pipeline) — flat table of all tracked links
      across leads + standalone + quotes; "New standalone tracker" button lives here (role-gated, not /admin).

## Security / privacy notes
- Token random & unguessable; guessing one only pollutes one lead's stats (low blast radius).
- Origin/Referer check = soft filter only (spoofable), never a security boundary.
- Bot detection = flag, don't drop.
- Raw IP stored intentionally for coarse geo (user-authorized). Consider purging/aging raw IPs later.
- No third-party scripts, no fingerprinting, no cross-site cookies. First-party, single-purpose.

## Won't build yet
- Version→User FK, client portal, change requests, CTA/scroll events, tracked quote pages, real RBAC contents.
