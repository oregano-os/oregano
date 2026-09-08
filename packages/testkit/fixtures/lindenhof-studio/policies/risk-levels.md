---
type: concept
description: Risk constitution of Lindenhof Studio. Core semantics, one tightening.
---
# Risk levels

| Level | Meaning | Behaviour |
|---|---|---|
| R0 | Read and compute | runs |
| R1 | Internal draft or direct message to a roster member | runs, logged |
| R2 | Reversible internal change, shared-channel message | runs, logged |
| R3 | External, customer-facing, or hard to reverse | parks until a bound human decision |
| R4 | Money, contracts, people | preparation only, human decides, separation of duties |

## Rules

1. A step without a risk marker is invalid. The validator rejects the file.
   (Tightening of the Core default "missing declaration is R3".)
2. Effective risk = max(step, tool, connection, policy). Core minimums cannot
   be lowered here.
3. Approval rights live only in `handbook/roster.md`.
4. A decision step binds to the exact payload digest it approves. A changed
   payload invalidates the decision.
