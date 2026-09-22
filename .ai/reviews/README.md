
# Review Records

Review files are immutable historical artifacts.

They exist to:

1. give the fixing agent a precise list of findings,
2. allow the next reviewer to verify the previous round,
3. provide a lightweight audit trail when investigating how a feature evolved.

They are NOT part of application context.

## Review streams

Each feature may have two independent review streams:

### `spec/`

Reviews the feature specification BEFORE implementation.

Questions include:

- Is the requirement internally consistent?
- Does it conflict with existing architecture/domain rules?
- Are important states or transitions unspecified?
- Are data ownership and invariants clear?
- Are important failure/race/security cases missing?
- Could two reasonable implementers produce materially different behavior?

A passing specification is ready to implement.

### `implementation/`

Reviews the implementation AFTER the specification is approved and built.

Questions include:

- Does the code satisfy the approved specification?
- Are domain invariants actually enforced?
- Is existing canonical behavior reused?
- Are transactions/concurrency/idempotency correct?
- Are authorization and validation correct?
- Are migrations safe?
- Are required tests/checks present?
- Were affected context documents synchronized?

A passing implementation is ready to complete.

## Context rule

Only the CURRENT review round may be supplied to the fixing agent.

Old review rounds should not be loaded unless specifically needed to investigate
review history.

The implementation agent should receive the approved specification and
authoritative context, NOT the specification review history.
