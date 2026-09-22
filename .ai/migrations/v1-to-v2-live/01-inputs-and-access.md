# 01 — Inputs and access

No inventory work begins until the items below are available. No secret value is recorded in this repository.

## Code identity

1. Record the exact Vercel production deployment commit SHA.
2. Confirm whether that deployment came from `origin/main`.
3. Compare its `prisma/schema.prisma` with local `origin/main` and the recorded `7beb689` baseline.
4. After reviews finish, record one exact V2 target SHA. Do not use a moving branch name as the release identity.

Known local fact on 2026-09-21: `origin/main` is `8e8b1836bc91a67587783cf1443cd26c68a74f58`, and its Prisma schema matches
the repository's `7beb689` production baseline. This does **not** prove the actual live database matches it.

## Fresh production duplicate

1. In the Neon project that contains ZVONCEK LIVE, create a new branch from the current live branch at the current
   point in time.
2. Use a name such as `v2-migration-rehearsal-YYYY-MM-DD-N`.
3. Record the parent branch, creation timestamp, Neon branch ID and endpoint suffix in `PROGRESS.md`; never record the
   full URL or password.
4. Store the connection locally in a gitignored env file under a dedicated variable such as
   `MIGRATION_REHEARSAL_DATABASE_URL`. Do not replace `DATABASE_URL`.
5. Prefer a read-only database role for Phase 1 inventory. If one is unavailable, every inventory connection starts a
   read-only transaction and the tool contains no write path.
6. Do not connect a public V2 deployment to the clone until external side effects and access are controlled.

## Exactly how Michal hands over the clone (agreed 2026-09-21)

1. Neon console → project with ZVONCEK LIVE → Branches → *Create branch* from the live branch, "current point in
   time", name `v2-migration-rehearsal-YYYY-MM-DD-N`. Do **not** reset or touch the live branch.
2. Optional but preferred: in that branch create a role with read-only rights (`GRANT pg_read_all_data`) for Phase 1.
3. Copy the **direct** (not `-pooler`) connection string of the new branch.
4. Create `C:\000_DEV\0_ZVONCEK\zvoncek\.env.migration` (ignored by git via `.env*`) containing one line:
   `MIGRATION_REHEARSAL_DATABASE_URL="postgresql://…"`. Do not paste it into chat and do not change `.env`.
5. Tell Claude the branch name and the endpoint suffix only (e.g. `…ab12cd`), plus the Vercel production commit SHA.

No schema dump or export is needed from Michal: the V1 schema in Git is known (`origin/main`), and the inventory tool
reads the clone's real schema from `pg_catalog` / `information_schema` itself (read-only transaction), then diffs it
against `origin/main:prisma/schema.prisma`.

## Data handling

- Do not paste full live rows into an AI chat.
- Do not commit exports, exception files or raw reports containing company names, people, email, phone, notes or URLs.
- Prefer anonymous `Lead.id`/`number`, booleans, enum values, dates and counts.
- If a free-text note is required to recover an amount, process it locally and put only the parsed amount plus source ID
  in the sanitized report. Flag ambiguous text for authorized local review.
- Store sensitive reports outside the repository in a restricted temporary directory. Record only their path and hash
  in `PROGRESS.md`.

## Side-effect isolation

Before launching V2 against the clone, prove that it cannot:

- send real email or SMS;
- call external customer-facing integrations;
- publish a public tracker URL that writes misleading events;
- overwrite Vercel production environment variables;
- use the production domain or production authentication secret accidentally.

## Required people and approvals

- Michal: business mapping and exception decisions; production go/no-go.
- Migration implementer: deterministic scripts, reports and exact runbook.
- Independent reviewer: schema SQL, mapping coverage, safety, idempotency, tests and rollback.
- Human testers: manager and sales-rep paths on desktop and phone.

One person operates the production runbook. A second person reads/verifies each gate. Two tools or people must not run
competing production commands.

