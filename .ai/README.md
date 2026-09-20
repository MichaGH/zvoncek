
# AI Development Workspace

This directory contains tooling and artifacts used by the AI-assisted development
workflow.

Nothing in this directory is authoritative project documentation.

## Directories

### `reviews/`

Historical review records produced during specification and implementation review.

A review records what a reviewer believed needed attention at that point in time.

Review findings may later be:

- resolved,
- superseded,
- rejected,
- made irrelevant by another change.

Therefore review files MUST NOT be used as a source of current project behavior.

### `prompts/`

Reusable instructions for automated Claude/Codex workflow stages.

### `scripts/`

Automation and orchestration.

## Critical rule

Information required to correctly build, maintain, or reason about the application
MUST NOT exist only under `.ai/`.

If resolving a review changes or clarifies:

- architecture,
- domain behavior,
- database invariants,
- canonical operations,
- UI rules,
- feature requirements,
- project constraints,

the appropriate file under `context/` MUST be updated.

`.ai/` records the process.

`context/` records the result.
