---
type: workflow
description: Silent reconciliation of registered operational record sources into rebuildable Company Records projections.
owner: agents/sprint
trigger: a verified provider event or configured reconciliation schedule
execution_mode: deterministic
goal: Keep Sprint projections current without making synchronized records a second provider authority.
output: immutable source observation, object version, projection update, freshness evidence, and reconciliation receipt
boundary:
  - only registered sources, objects, fields, and lifecycle states are processed
  - provider callbacks are verified before payload parsing or Agent resolution
  - synchronization never writes curated Workspace files directly
  - reconciliation is silent unless an unresolved discrepancy requires an authorized human
required_capabilities:
  - records.query
  - work-item.read
---
# Records reconciliation

1. [service:records-sync, R0] Verify the provider callback or claim the configured source lease; block stale, replayed, unbound, or unauthorized input.
2. [service:records-sync, R0] Normalize the event using the Workspace mapping and reread the provider object when the event is partial.
3. [service:records-sync, R0] Append a deduplicated source event and immutable object version with source and mapping provenance.
4. [service:records-sync, R0] Rebuild affected projection rows and record freshness, watermark, counts, and field coverage.
5. [service:records-sync, R0] On a scheduled full pass, reconcile the complete declared inventory, including explicit lifecycle handling, and produce one receipt.
6. [service:records-sync, R0] Suppress self-authored echoes without discarding external changes that follow an Agent effect.
7. [service:records-sync, R0] Release the lease and retain an explicit failure state when the provider cannot be reconciled safely.
