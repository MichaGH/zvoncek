# Zvonček — Agent Instructions

## What this app is

Internal CRM + calling dashboard for **The Grand Points**, a small webdesign company.
Stack: Next.js 16 App Router · TypeScript · Prisma 7 + Neon Postgres (`@prisma/adapter-pg`) · NextAuth v5 Credentials · shadcn/ui · vaul drawer · Tailwind 4.

The app is a real internal tool and a learning project. Do not add features beyond what is explicitly asked.

---

## Critical naming rules

The central Prisma model is `Lead`. **Never rename it** — not in the schema, not in relations, not in generated imports.

In business terms a `Lead` can be:
- a raw contact to call,
- a call target,
- an active pipeline opportunity (once interested),
- a won/lost record.

Route and UI names should describe the business view (`pipeline`, `calls`, `contacts`), not the Prisma model.

---

## Roles and who does what

There are **4 roles**. Permission checks must use `can(user, permission)` from `lib/permissions.ts` — **never check roles directly in components or actions**.

### SCOUT
Adds raw contacts to the database. That is their only job.
- Can see and manage **only their own** contacts (scoped server-side via `createdById`).
- Cannot call, cannot see pipeline, cannot see other users' contacts.
- Contacts they added become "locked" (read-only) once they have been called by TELESALES.

### TELESALES
Works the **marketing call queue** (`/dashboard/calls`). That is their only job.
- Calls contacts, logs outcomes (NO_ANSWER, CALL_AGAIN, NOT_INTERESTED, WANTS_QUOTE, WANTS_DESIGN, WANTS_EMAIL, POSITIVE, SNOOZE…).
- Can view their own call history (`/dashboard/calls/history`).
- Can quickly add a new contact (contacts.create).
- **TELESALES has no access to pipeline or leads.** They hand off a lead by logging a positive outcome; from that point the MANAGER takes over. TELESALES never sees or edits pipeline data.

### MANAGER
Handles the full **pipeline** for active business opportunities and everything else except admin.
- Sees all contacts, all call history, all pipeline.
- Creates/updates quotes, designs, email sends.
- Manages lead owners, follow-ups, project types.
- Can revert call history rows (with stage-lock: locked when price/design/owner/WON/LOST touched).

### ADMIN
All permissions including `admin.access` and `users.manage`.

---

## Permission system (`lib/permissions.ts`)

Single source of truth. The `ROLE_PERMISSIONS` record maps each role to a flat list of `Permission` strings.

Key permissions:
- `today.view` — dashboard home
- `calls.view` / `calls.work` — call queue (view vs act)
- `callHistory.access` / `callHistory.viewAll` / `callHistory.revert`
- `contacts.access` / `contacts.viewAll` / `contacts.create` / `contacts.deleteOwnUncalled` / `contacts.deleteAny`
- `pipeline.view` / `pipeline.manage`
- `stats.view` / `stats.viewAll`
- `admin.access` / `users.manage`

Usage:
```ts
import { can } from "@/lib/permissions";
if (!can(session.user, "pipeline.manage")) return { error: "Nemáš oprávnenie." };
```

Route guard lives in `auth.config.ts` via `requiredPermissionForPath(path)`.

---

## Database rules

- **`prisma db push` only.** Never `prisma migrate dev`. There is no migrations folder.
- Schema file: `prisma/schema.prisma`.
- Generated client: `app/generated/prisma/` (custom output, not `node_modules/.prisma`).
- Import enums from `@/app/generated/prisma/enums`, client from `@/lib/db`.
- After schema changes run `npx prisma db push` then `npx prisma generate`.
- If `db push` is blocked by a destructive change and you are sure no live data will be lost, `--accept-data-loss` is acceptable.

---

## Key schema models

```
Lead            — central record (contact + opportunity + result)
Activity        — append-only audit log (type, note, meta JSON with field diffs)
User            — app user with Role enum
Design          — a design proposal attached to a Lead (soft-delete via deletedAt)
DesignVersion   — version bump of a Design (label, url, note)
Tracker         — 1:1 with Design, holds a unique token for link tracking
TrackerEvent    — PAGE_VIEW or ENGAGED_VIEW logged by the public ingest endpoint
```

Enums: `Role` (SCOUT TELESALES MANAGER ADMIN), `LeadStatus`, `LeadOrigin`, `ProjectType` (WEBSITE ESHOP CATALOG WEBAPP PORTFOLIO OTHER), `ActivityType`, `CallOutcome`, `TrackedEventType` (PAGE_VIEW ENGAGED_VIEW).

---

## Business views

### `/dashboard` (Dnes)
Dashboard home. Visible to all logged-in users (each role sees what is relevant).

### `/dashboard/calls`
**TELESALES only.** Marketing call queue. Shows contacts grouped by status/snooze. Caller logs outcomes via `CallDrawer`. Snoozed contacts appear in a "Spiace" group.

### `/dashboard/calls/history`
Call history. TELESALES sees own rows; MANAGER/ADMIN can switch to "Všetci" to see all users. Has a revert action (Vrátiť) guarded by stage-lock.

### `/dashboard/pipeline`
**MANAGER/ADMIN only.** Table of active opportunities. Shows: #, Firma, Telefón, Typ projektu, Posledný krok, Ďalší krok, Cena, Stav. Fixed row height.

### `/dashboard/pipeline/[id]`
Full detail view for one opportunity. Two-column layout (main + sidebar).

Main column cards (in order):
1. **Ďalší krok** — next action editor + Posledný krok display + Zaznamenať udalosť
2. **Cenová ponuka** — price + note + revertible "sent" checkbox
3. **Dizajn & Tracking** — design list with tracked URLs
4. **Email "O nás"** — about-us email sent toggle
5. **História** — activity log with revert actions

Sidebar: **Údaje** (contact fields, pencil-icon edit), status/owner/projectType pills, phone number.

### `/dashboard/contacts`
Contact database. SCOUT sees only their own (server-scoped). MANAGER sees all with filters. Rows grayed when `status !== NEW` (already called → locked).

### `/dashboard/admin`
Admin-only placeholder. Returns `notFound()` for non-admins.

---

## Proposal tracking system

Tracks whether clients actually viewed design proposals.

**Flow:**
1. MANAGER creates a `Design` on the lead. Zvonček auto-creates a `Tracker` with a unique token.
2. `DesignTrackingCard` shows two URLs: plain URL (clickable) + tracked URL (`https://zvoncek.com/?p=TOKEN`) as muted text.
3. Manager copies the tracked URL and sends it to the client (email, messenger, etc.).
4. Client's browser loads `?p=TOKEN` on the proposal site, which has the universal snippet `public/scripts/tracker.js` embedded.
5. Snippet POSTs to `https://zvoncek.com/api/p` (always 204). Logs `PAGE_VIEW` immediately, then `ENGAGED_VIEW` after 8 s active time or scroll event.
6. Confidence summary: none / weak (all bot) / medium (pageview only) / high (engaged) / very_high (multi-day or viewed after version update).

**Ingest:** `app/api/p/route.ts` — public, no auth, always returns 204.
**Snippet:** `public/scripts/tracker.js` — reads `?p=TOKEN`, strips it from URL with `history.replaceState`, POSTs events.
**Confidence:** `lib/tracking/confidence.ts` → `summarizeEvents(events, currentVersion)`.

---

## Folder conventions

```
lib/queries/calls/index.ts      — call queue queries
lib/queries/calls/history.ts    — history queries (accepts userId|null for all-users)
lib/queries/contacts/index.ts   — contacts list + overview (createdById scoping)
lib/queries/pipeline/index.ts   — pipeline table query
lib/queries/tracking/index.ts   — resolveTrackerToken, getDesignsForLead
lib/actions/calls/index.ts      — logCall, snooze, resetLeadToCalls
lib/actions/contacts/index.ts   — createContact, updateContact, deleteContact
lib/actions/pipeline/index.ts   — updateLead, saveQuote, setQuoteSent, setProjectType, setOwner…
lib/actions/tracking/index.ts   — createDesign, addDesignVersion, updateDesignMeta, removeDesign, setDesignSent
lib/permissions.ts              — ROLE_PERMISSIONS, can(), canAny(), requiredPermissionForPath()
lib/dictionaries.ts             — STATUS_LABEL/VARIANT, OUTCOME_LABEL, ACTIVITY_LABEL, PROJECT_TYPE_LABEL, ROLE_LABEL, CONFIDENCE_LABEL/VARIANT
lib/leadFlow.ts                 — outcome → lead state transitions (CallOutcome → LeadStatus + ActivityType)
```

---

## UI conventions

- shadcn/ui components. Import from `@/components/ui/*`.
- `CardHeader` with actions: use `className="flex-row items-center justify-between space-y-0 pb-3"`. Structure must be `<CardTitle> + <div className="flex gap-1">{buttons}</div>` — no extra wrapper divs.
- Icon-only buttons: `variant="ghost" size="icon"` (no outline box). Pencil = `Pencil`, trash = `Trash2`, lock = `Lock` from `lucide-react`.
- Scrollbar layout shift fix in `app/globals.css`: `scrollbar-gutter: stable` + `--removed-body-scroll-bar-size: 0px !important`.
- Drawers use `vaul` (not shadcn Sheet).
- `DashboardContent` width prop: use `"full"` for two-column pipeline detail, default for single-column pages.

---

## Safety rules

- Preserve existing behavior unless the task explicitly asks to change it.
- All server actions must check permissions with `can(session.user, "...")` before doing anything.
- Queries that are role-scoped (scout contacts, user-specific history) must enforce the scope **server-side** — never rely on UI hiding alone.
- After changes: fix broken imports, check `tsc --noEmit`, summarize changed files.
- Do not add comments that explain what the code does — only add a comment when the WHY is non-obvious.
