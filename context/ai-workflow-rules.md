# AI Workflow Rules

How to work in this repo. Read this first, then the file the task points at.

## 1. Read order

| Question | File |
|---|---|
| What is this app, who are the roles, what routes exist | `context/project-overview.md` |
| How do people use it, what is shipped vs planned | `context/app-workflow.md` |
| Where does code go, what must not break | `context/architecture.md` |
| How do I write the code | `context/code-standards.md` |
| Screen conventions | `context/ui-context.md` |
| What is in the database **today** | `context/domain/database-map.md` |
| Which reusable operation already does this | `context/domain/operations.md` |
| What the production database still lacks | `context/domain/db-changes.md` |
| What we decided and why, for the feature being built | `context/features/<feature>/…` |
| What has been done so far | `context/progress-tracker.md` |

## 2. What each file is allowed to contain

- `context/domain/database-map.md` and `context/domain/operations.md` — **only what exists right now.** No plans,
  no "will be". They are the structural source of truth.
- `context/app-workflow.md` — behaviour, including what we *want*; anything unbuilt carries a marker (`[WAVE n]`,
  `[ROLLOUT]`).
- `context/features/<feature>/**` — design discussion, decisions, revisions for one feature. **Do not edit these while
  implementing** unless the task is explicitly to record a decision.
- `context/progress-tracker.md` — implementation progress only. Update it **while working on the app**, with what you
  changed and which checks ran. Never put context/documentation reorganisation into it.
- `context/domain/db-changes.md` — the **net** difference between the test branch and live production (what a rollout
  still owes), plus the rollout procedure. Only changes already applied on test. Clear the applied entries after a
  rollout, not the procedure.

**Older text.** The feature documents and the progress tracker are records written over time. They mention things that
no longer exist: `/dashboard/clients`, `components/clients|deals`, `lib/queries/clients|deals`, `lib/actions/deals`,
`lib/commands/clients.ts`, `context/additional-features-todo.md`. When they disagree with the code or with
`context/domain/*`, the code and `context/domain/*` are current; the older text is history.

## 3. Working rules

1. **Never touch production.** Development and checks run against the Neon test branch only. Verify the endpoint before
   any schema or backfill command; scripts must refuse a non-matching endpoint.
2. **Before applying a schema change on test**, record the proposal and data-safety plan in the active feature design.
   If the design does not already cover the change, stop and ask for a decision before editing the protected feature
   file or touching the schema. Verify the test endpoint and review the generated SQL. After applying and verifying
   it on test, add the actual test–production delta to `db-changes.md`. Never put unbuilt proposals in that ledger.
3. **Do not commit, push or deploy** unless asked.
4. **Run the checks** in `context/code-standards.md` §7 and report honestly. A check that did not run did not pass.
   Anything needing a browser session (drawers, forms, real clicking) is a human click-through — say so.
5. **One wave at a time.** Finish the wave, run the full check pass, update the tracker, then start the next.
6. **Distinguish an intended change from a mistaken description of today's app.** An active feature design may
   deliberately change existing behaviour or architecture. If it refers to an existing operation, permission, style,
   or workflow incorrectly, or an unexplained conflict would affect implementation, stop and discuss it instead of
   silently choosing one version. Historical implemented plans are not the current source of truth.
7. Preserve unrelated changes in the working tree. Do not "clean up" files the task did not ask about.

## 4. When you add behaviour

- Put the rule in `lib/domain/**` (pure, testable), the transaction in `lib/commands/**`, the endpoint in
  `lib/actions/**`, the read in `lib/queries/**`.
- If it can race, add a case to `prisma/backfill/check-concurrency.ts`.
- If a TypeScript rule also has to exist in SQL (for filtering or sorting in the database), add a test that both give the
  same answer — see "Rules that exist twice" in `context/code-standards.md` §5.
- If it introduces a reusable operation, document it in `context/domain/operations.md` in the same commit.
- If it changes what the database holds, update `context/domain/database-map.md` in the same commit.

## 5. Handoff

Finish a session with: changed files, sanitized database identity, schema/backfill results, check results, unresolved
issues, and anything that must wait for a production rollout.
