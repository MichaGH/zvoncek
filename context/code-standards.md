# Code Standards

Rules for writing code in this repo. Architecture and layer boundaries: `context/architecture.md`.
Database procedure: §6 below — it is the part that gets forgotten and it is the part that can destroy data.

## 1. General

- Keep modules small and single-purpose; fix root causes instead of layering workarounds.
- Preserve the existing workflow design unless the task explicitly changes it. Keep edits scoped.
- Write code that reads like the code around it: same naming, same comment density, same idioms.
- Comments are in Slovak where the surrounding file is, and explain **why**, not what. Do not add explanatory comments
  for obvious code.
- One concept, one source of truth. If you need the same list in UI and on the server, export it from `lib/domain/`.
- After code changes: fix imports and run the checks in §7.

## 2. TypeScript

- Strict mode everywhere. No `any`; no `as` to silence a real type error.
- Use `type` for unions and compositions (the codebase does not use `interface`).
- Derive types from the source of truth: Prisma payload types for rows, `ReturnType<typeof …>` for read models,
  `satisfies` for constant tables.
- Use **strict** zod (`.strict()`) for new structured client-input schemas at the boundary where they are used.
  Strict means rejecting unknown object keys, not imposing narrow content formats. Validate useful constraints
  (types, enums, lengths, required fields); allow flexible phone and website strings, pasted links, and free text
  where their formats legitimately vary. Existing contact add/edit actions are an exception for now: keep their
  named-field writes and flexible phone entry during this context cleanup.

## 3. Next.js

- Server components by default. `"use client"` only for real browser interactivity.
- `lib/actions/**` files are `"use server"`: `requireUser()`, call one command, `revalidatePath`. **Never export a
  helper from such a file** — every export is a public endpoint.
- Pages do: `requireUser()` → `can()` → query → render. No business rules in pages or components.
- A client component must not import a module that pulls in Prisma. Shared constants belong in `lib/domain/*`
  (a client importing `lib/queries/**` for a *value* breaks the build; `import type` is fine).

## 4. Security and data access

- Permissions are checked with `can()` against the **DB user** from `requireUser()`, never `session.user`.
- UI hiding is not access control. Every command re-checks its own permission under the row lock.
- Scope (`own | team | all`) comes from `dealScope()`; never from the URL, the path or a client-sent value.
- **Never spread a client object into a Prisma `update`/`create`.** Build the write from named fields, using a strict
  schema for new structured inputs except the existing contact-entry exception above. (This was a real P1 finding — see
  `context/features/01-salesrep/revision.md` R-01.)
- Out-of-scope reads return `NOT_FOUND`.
- Never log connection strings, tokens or passwords. Scripts print sanitized identity only.

## 5. Concurrency (non-negotiable)

Full rules in `context/project-overview.md` §5. When mutating an existing lead:

- wrap it in `withLockTx`, go through an access guard (`requireCallLead` / `requireDealWork` / `requireDealManage`),
- keep lock order `Team → User → Lead`, ascending id,
- bump `Lead.revision` exactly once per business transaction,
- accept `expectedRevision` + `idempotencyKey` for anything a user can double-submit, and return the prior logical
  success without a duplicate write on a unique-violation or a lost race; persist a response snapshot if an exact
  replay of mutable display data is required,
- add a case to `prisma/backfill/check-concurrency.ts` for anything with a race.

**Rules that exist twice (TypeScript + SQL).** Two rules are written once in TypeScript (to label a row) and once in
SQL (so the database can filter, sort and page the whole list):

| TypeScript | SQL copy in `lib/queries/pipeline/index.ts` | Test that they agree (`check-concurrency.ts`) |
|---|---|---|
| `clientSection()` — is a deal "Na dnes" | `TODAY_SQL` | `w1TodayParity` |
| `nextActionSort()` — list order | `DEAL_RANK_SQL` | `R-02` ordering test |

Change both copies in the same change and run that test. A new SQL copy of a TS rule gets the same kind of test.

## 6. Database rules

- Use `prisma db push`. **Never** `prisma migrate dev`, `--accept-data-loss` or `--force-reset`.
- **Before any schema command**: document the proposal and safe application order in the active feature design,
  confirm the target is the test branch (`DATABASE_URL` endpoint suffix), and review the generated SQL. After the
  change is applied and verified on test, record the actual delta in `context/domain/db-changes.md`.
- If `db push` stops on a **data-loss warning for a purely additive change** (it does this for new unique indexes),
  do not accept it. Review and apply the diff instead:
  ```bash
  npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o <file outside the repo>
  npx prisma db execute --file <that file>
  npx prisma db push      # must now report "already in sync"
  ```
- `ALTER TYPE … ADD VALUE` (new enum value) must be applied **before** deploying code that writes it, and a value added
  inside a transaction cannot be used by that same transaction.
- A required column without a database default needs a verified plan for existing rows. `@updatedAt` is maintained by
  Prisma, not a database default: add nullable, backfill, then consider `NOT NULL` in a separately reviewed step.
- Removing, renaming or retyping anything that **production already has** is non-additive: it needs an explicit decision
  in the feature design and a row flagged non-additive in `context/domain/db-changes.md`.
- Production is touched only in a separately approved rollout session, after a backup and a restore-point branch.
- Schema file `prisma/schema.prisma`; run `npx prisma generate` after changes; never edit `app/generated/prisma/**`.
- Backfills: dry-run by default, `--apply` requires an explicit endpoint confirmation, abort on ambiguity, repeatable,
  with a `--verify` mode.

## 7. Checks

Run what the change touches; run all of them before declaring a wave done.

```bash
npx tsc --noEmit
npx eslint .                       # known pre-existing error: components/layout/MobileNav.tsx
npx next build
npx tsx prisma/backfill/check-business-time.ts          # also with TZ=UTC
npx tsx prisma/backfill/check-client-sections.ts
npx tsx prisma/backfill/check-concurrency.ts --expect-endpoint <test endpoint> --iterations 100
npx tsx prisma/backfill/check-backfill-delta.ts --expect-endpoint <ep> --expect-db <db> --owner-username <admin>
```

Never claim a check passed if it did not run. If something cannot be verified (a drawer, a form, anything needing a
browser session), say so explicitly and leave it to a human click-through.

## 8. Safety

- Do not commit, push or deploy unless asked.
- Do not rename the Prisma model `Lead`.
- Do not rely on client-side hiding for permissions.
- Do not introduce broad layout changes unless requested.
- Summarize changed files and any check that could not be run.
