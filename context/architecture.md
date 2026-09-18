# Architecture

How the app is built. Behaviour is in `context/app-workflow.md`; coding and database rules in
`context/code-standards.md`; the exact callable helpers in `context/domain/operations.md`.

## 1. Stack

| Layer | Technology | Note |
|---|---|---|
| Framework | Next.js **16.2** (App Router) + TypeScript | server components by default, server actions for mutations. APIs differ from older Next versions — check the docs for this version before using one. |
| Styling | Tailwind CSS | see `context/ui-context.md` |
| UI primitives | shadcn/ui (`components/ui/*`), Radix (`radix-ui`), vaul (drawers), lucide-react, sonner | |
| Database | Neon PostgreSQL + Prisma 7.8 (`@prisma/adapter-pg`) | client from `lib/db.ts`; generated code in `app/generated/prisma/` (never edit) |
| Auth | NextAuth v5 (Credentials) + JWT session | `auth.ts`, `auth.config.ts` |
| Validation | zod | strict schemas for new inputs; see the contact-entry exception in `code-standards.md` |

## 2. Where things live

```
proxy.ts                  Next 16 name for middleware: runs NextAuth → auth.config.ts → requiredPermissionForPath().
                          Convenience only; pages and commands re-check against the DB user.
app/**                    pages: requireUser() → can() → query → render
app/api/p/route.ts        public tracking ingest (not behind the proxy); script in public/scripts/tracker.js
lib/actions/**            "use server" endpoints — every export is public; new ones stay thin
lib/commands/**           transaction bodies for business changes (scripts and tests call these directly)
lib/access/**             current DB user, row locks, lead guards, AccessError
lib/domain/**             pure rules and shared mutation bodies; safe to import from client components
                          as long as the file does not import Prisma at runtime
lib/queries/**            server read models; deal scope is applied inside the query
lib/permissions.ts        role → permission matrix, can(), route guard
lib/dictionaries.ts       every enum label shown in the UI
lib/activityLog.ts        Activity payload builders (business / planning / audit)
lib/overdue.ts            the urgency scale for callbacks and next steps
lib/tracking/**           design-tracking tokens and confidence
lib/stats/**              date ranges for the (unfinished) stats page
components/**             UI; capability props decide what renders, never what is allowed
prisma/schema.prisma      the schema; prisma/backfill/** = backfill + all check scripts
```

**Deal command split** (guards differ, bodies are shared in `lib/domain/dealMutations.ts`):

- `lib/commands/dealWork.ts` — owner **or** manager (`requireDealWork`), open deals only for the owner
- `lib/commands/pipeline.ts` — manager only (`requireDealManage`), any deal state
- `lib/commands/offers.ts` — what the client received ("Čo sme poslali", corrections, legacy review); bodies in
  `lib/domain/offerMutations.ts`

All three are exposed through one actions file, `lib/actions/pipeline/index.ts`.

Some older contact, team and admin actions still write directly in the action file (e.g. team create/rename). That is
existing code, not the pattern for new business operations.

## 3. Life of an existing-lead business mutation

This is the pattern for call outcomes and deal work, not a claim that every command has the same inputs or result.
Contact creation inserts a new lead at revision 0; it does not lock a pre-existing lead row.

```
client component  (outcomes and the next-action editor send expectedRevision + idempotencyKey)
  → server action        requireUser(); call one command; revalidatePath on success
    → command            permission pre-check; withLockTx
      → access guard     lock users → lock lead FOR UPDATE → re-check scope/state/revision
        → domain body    decision + Prisma writes + Activity row + exactly one revision bump
  → client               router.refresh(), or react to the error code below
```

## 4. Error codes

Many commands return `{ success: true } | { error, code? }`; others return operation-specific success data (for
example, a claimed or transferred count). When present, the error code tells the client what to do:

| Code | Client behaviour |
|---|---|
| `STALE`, `NOT_ASSIGNED`, `IDEMPOTENCY_CONFLICT`, `DEAL_CLOSED`, `NOT_FOUND` | show the message and refresh — the data moved |
| `RETRYABLE` (deadlock, lock timeout) | offer "Skúsiť znova" with the **same** idempotency key |
| `FORBIDDEN`, `UNAUTHENTICATED` | show the message |

Out-of-scope deal reads and writes return `NOT_FOUND`, never `FORBIDDEN` — a rep must not learn that a deal exists.
Domain invariants and concurrency rules: `context/project-overview.md` §1 and §5.
