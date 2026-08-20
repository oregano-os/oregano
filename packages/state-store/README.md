# state-store — generic authority and evidence state

`interface.ts` defines runner-neutral operations for runs, append-only events,
approval requests and decisions, atomic approval consumption, idempotent effect
claims, dispatch state, completion, failure, unknown outcome, and evidence.

`action-approval.ts` is the generic R3/R4 orchestration path. Domain-specific
sends, campaigns, provider tables, and mock outboxes do not belong here.
