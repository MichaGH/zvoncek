# Feature 02 — Recycling: production rollout runbook

Companion to `recycling-spec.md`. **Draft 2026-10-25 — not executed.** Fill in the bracketed values and the log at the
bottom while you go. Each production step runs **only after Michal says "go" for that step** in chat. Any surprise =
STOP and decide.

Why this rollout is small: the schema change is **additive only** (4 columns, 1 index, 2 foreign keys on `Lead`, no
enum, no drop), there is **no data migration** (every existing contact simply becomes round 1), and old code runs
fine on the new schema. Recycling itself happens later, through the app, contact by contact.

Order: **schema first, then code.** Never the other way round — the new code reads `round` / `roundStartedAt`.

## Environments (never paste full connection strings anywhere)

| Name | Endpoint | Used for |
|---|---|---|
| dev copy | `ep-divine-waterfall-asbkuort` (copy of production from 2026-10-24) | development, checks, click-through. This is `DATABASE_URL` in `.env` |
| production | `ep-ancient-glitter-asm0xyun` | only in this window, only through the wrapper below |

**"Changing the URI" — what it means here:**

- The live app's `DATABASE_URL` is set in **Vercel** and does **not** change. No new environment variables.
- The local `.env` `DATABASE_URL` stays on the dev copy **the whole time**. Never edit it to production.
- To run a command against production, the direct (non-pooler) production string goes into `.env.migration` as
  `MIGRATION_PRODUCTION_URL`, and every command is run through the wrapper, which injects it for that one command,
  refuses a pooler host, a wrong endpoint, and production without `--production-window`:

```bash
node .ai/migrations/v1-to-v2-live/tools/with-target.mjs --var MIGRATION_PRODUCTION_URL --expect ep-ancient-glitter-asm0xyun --production-window -- <command>
```

Below this prefix is written as `$PROD`.

---

## A. Before the window (no production access)

- [ ] **A1. Housekeeping:** remove `MIGRATION_PRODUCTION_URL` from `.env.migration` until step B2 (it is still there
      from the 2026-09-22 migration).
- [ ] **A2. Code done:** all checks of `context/code-standards.md` §7 passed against the dev copy
      (`--expect-endpoint ep-divine-waterfall-asbkuort`), including the new `rc*` cases. Results recorded in
      `context/progress-tracker.md`.
- [ ] **A3. Click-through:** Michal recycled a few contacts on localhost against the dev copy, saw them in the pool,
      claimed them as a caller, checked a recycled deal disappeared from the pipeline.
- [ ] **A4. Reviewed schema SQL** saved as `context/features/02-recycling/sql/01-recycling-schema.sql`, generated
      offline from the production schema (= `origin/main`) to the new schema:
      ```bash
      git show origin/main:prisma/schema.prisma > <scratch>/schema-main.prisma
      npx prisma migrate diff --from-schema <scratch>/schema-main.prisma --to-schema prisma/schema.prisma --script -o context/features/02-recycling/sql/01-recycling-schema.sql
      ```
      **Expect exactly:** 4 × `ADD COLUMN` on `Lead` (`round` NOT NULL DEFAULT 1, `roundStartedAt`, `archiveOfId`,
      `archivedById`), 1 × `CREATE INDEX "Lead_archiveOfId_idx"`, 2 × `ADD CONSTRAINT … FOREIGN KEY`. Anything else
      (`DROP`, `ALTER COLUMN … TYPE`, another table) = STOP.
- [ ] **A5. The same SQL was applied to the dev copy** with `npx prisma db execute --file …` and a following
      `migrate diff --from-config-datasource --to-schema prisma/schema.prisma` came back empty. Recorded in
      `context/domain/db-changes.md`.
- [ ] **A6. Commit + PR** (only when Michal asks): branch → PR into `main`. **Do not merge yet** — Vercel production
      builds from `main`; merging is the deploy.
- [ ] **A7. Vercel:** note the current production deployment id — the rollback target: `[deployment id]`.
- [ ] **A8. Team told:** a ~10 minute pause in Zvonček at `[HH:MM]` (the deploy restarts the app; the schema change
      itself takes a lock for well under a second).

## B. The window

- [ ] **B1. Backup = restore point.** Neon → project → Branches → *Create branch* from `Production`, current point in
      time, name `pre-recycling-restore-[YYYY-MM-DD]`. Leave it untouched. Time: `[HH:MM:SS]`.
- [ ] **B2. Production access.** Neon → Production → *Connect* → connection pooling **OFF** → copy the direct string
      into `.env.migration` as `MIGRATION_PRODUCTION_URL`. Tell Claude only the endpoint id.
- [ ] **B3. Identity + pre-state check (read-only):** production must equal `origin/main` before we touch it.
      ```bash
      $PROD npx prisma migrate diff --from-config-datasource --to-schema <scratch>/schema-main.prisma --script
      ```
      **Expect:** `-- This is an empty migration.` Anything else = STOP (production drifted; show Michal).
- [ ] **B4. Apply the schema.**
      ```bash
      $PROD npx prisma db execute --file context/features/02-recycling/sql/01-recycling-schema.sql
      ```
      **Expect:** `Script executed successfully.`
- [ ] **B5. Verify the schema.**
      ```bash
      $PROD npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
      ```
      **Expect:** empty migration. Then a read-only count (via a small read-only script or the Neon SQL editor):
      ```sql
      SELECT count(*) FILTER (WHERE round <> 1) AS not_round_1,
             count(*) FILTER (WHERE "archiveOfId" IS NOT NULL) AS archives,
             count(*) AS leads
        FROM "Lead";
      ```
      **Expect:** `not_round_1 = 0`, `archives = 0`, `leads` ≈ 4 212 + what was added since 2026-10-24.
- [ ] **B6. Deploy.** Merge the approved PR → Vercel builds → wait for *Ready*.
- [ ] **B7. Smoke test** (Michal, logged in as himself, on the live URL):
      1. `/dashboard` and `/dashboard/pipeline` open as before.
      2. Admin → **Recyklácia kontaktov** opens; bucket counts are plausible (2026-10-24 copy: call LOST 2 061, call
         UNREACHABLE 420, call RETRY 1 432, deal LOST 61, deal UNREACHABLE 7 — slightly more by now).
      3. Recycle **one** harmless contact Michal picks (e.g. a call-stage "Nemajú záujem" from June). Note its `#number`:
         `[#…]`.
      4. The pool count in the page header went up by 1; the contact shows as new ("2. kolo") in Kontakty.
      5. Read-only SQL check for that contact (replace the number):
         ```sql
         SELECT l.number, l.status, l.round, l."assignedCallerId" IS NULL AS unassigned,
                (SELECT count(*) FROM "Activity" a WHERE a."leadId" = l.id) AS live_activities,
                a.id IS NOT NULL AS has_archive, a.status AS archived_status, a."deletedAt" IS NOT NULL AS archive_hidden,
                (SELECT count(*) FROM "Activity" x WHERE x."leadId" = a.id) AS archived_activities
           FROM "Lead" l LEFT JOIN "Lead" a ON a."archiveOfId" = l.id
          WHERE l.number = [#…];
         ```
         **Expect:** `NEW`, round 2, unassigned, 0 live activities, an archive with the old status, hidden, and all
         the old activities.
- [ ] **B8. GO / NO-GO.** GO → the team may work; NO-GO → section C.
- [ ] **B9. First real batch.** Michal selects and recycles the first batch (size decided by him, e.g. 100–200,
      oldest first). The caller presses "Vziať ďalších 10" and gets recycled contacts.

## After the window

- [ ] Remove `MIGRATION_PRODUCTION_URL` from `.env.migration` again.
- [ ] Keep `pre-recycling-restore-[date]` for at least 7 days, then delete it in Neon.
- [ ] Clear the applied rows in `context/domain/db-changes.md`; record the rollout in `context/progress-tracker.md`
      and in the log below.

## C. Rollback

| Situation | What to do | Data loss |
|---|---|---|
| Before B4 | nothing changed — stop | none |
| After B4, before B6 (old code still deployed) | nothing needed: old code ignores the new columns. Leave the schema; fix and retry the deploy later | none |
| After B6, the new code misbehaves | Vercel → the deployment from A7 → **Instant Rollback**. The schema stays (old code ignores it). Contacts already recycled remain ordinary new contacts in the pool; their archives stay hidden | none |
| Contacts were recycled by mistake | **Do not restore the database for this.** Leave them in the pool or, if it matters, write and review a one-off undo for exactly those contacts (move children back, restore columns from the archive, delete the archive row — only while the live row is untouched). Design: `recycling-spec.md` §12 | none |
| Something unforeseen corrupted data | Neon → Production → Restore to the B1 timestamp (or from `pre-recycling-restore-[date]`) **and** Vercel Instant Rollback. Last resort: every write in Zvonček since B1 is lost | everything since B1 |

Never drop the new columns once any archive row exists — the link between a contact and its old rounds would be lost.

## Log

| Date / time | Step | Environment (sanitized) | Result | By |
|---|---|---|---|---|
| | | | | |
