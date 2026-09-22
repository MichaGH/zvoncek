# Zvonček — start here

Internal CRM and calling dashboard of The Grand Points. Real internal tool, also a learning project.
**Do not add features outside the requested scope.**

This file is an index. The content lives in `context/`.

| Read this | For |
|---|---|
| `context/ai-workflow-rules.md` | **how to work here** — read order, what each file may contain, what you must never touch |
| `context/project-overview.md` | what the app is, roles, permissions, routes, concurrency rules, design tracking, statistics |
| `context/app-workflow.md` | how people use it; shipped vs `[WAVE n]` / `[ROLLOUT]` |
| `context/architecture.md` | stack and basic code layout |
| `context/code-standards.md` | how to write code, **database rules**, the checks to run, safety |
| `context/ui-context.md` | screen and component conventions |
| `context/domain/database-map.md` | what the database holds **today** |
| `context/domain/operations.md` | reusable server operations — call them, do not re-implement them |
| `context/domain/db-changes.md` | verified test–production DB delta (applied entries cleared after rollout) |
| `context/features/<feature>/` | design decisions per feature (currently `01-salesrep`) |
| `context/features/backlog.md` | ideas and unfinished business not scheduled in any wave — not requirements |
| `context/progress-tracker.md` | what has been implemented, with check results |

## The five things people get wrong

1. **`Lead` is the central model — never rename it.** Call stage vs deal is decided by `pipelineEnteredAt`, not status.
2. **Deal scope is server-side**, from `dealScope()`. Never from the path, the URL or a client value. UI capabilities are a
   rendering hint, never a permission.
3. **Every mutation of an existing `Lead`** runs in `withLockTx`, through an access guard, in lock order
   `Team → User → Lead`, and bumps `Lead.revision` exactly once per business transaction. Creating a contact inserts
   a new `Lead` at revision 0; there is no existing row to lock or bump.
4. **Never spread client input into a Prisma write** — use named fields. Strict zod is the standard for new inputs;
   existing contact intake deliberately keeps phone entry flexible.
5. **Test branch only.** No production writes, no `--accept-data-loss`, no commits or deploys unless asked. Add a schema
   proposal to the feature design before applying it on test; record the verified test–production delta in
   `context/domain/db-changes.md` after applying it.

Checks to run before declaring anything done: `context/code-standards.md` §7. A check that did not run did not pass.
