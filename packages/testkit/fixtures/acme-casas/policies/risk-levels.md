---
type: concept
description: Risk constitution of the fixture company. Same R0–R4 semantics, other examples — and one deliberate tightening to prove companies may tighten, never loosen.
---
# Risk levels (fixture)

| Level | Meaning | Behaviour | Fixture examples |
|---|---|---|---|
| R0 | Read & compute | always runs | read the board, compute a progress bar |
| R1 | Internal artifacts | runs, logged | draft a brief, draft a post |
| R2 | Reversible internal change | runs, logged | comment on a card, reshuffle inside a limit |
| R3 | External / irreversible | **parks until verified approval** | publish anything, write a card status |
| R4 | Money, contracts, people | preparation only, human decides | budgets, permits, contractor engagements |

## Rules

1. **Missing declaration = R3.**
2. **Tightening allowed, loosening never.** Fixture tightening on purpose:
   writing a card status counts as **R3** here (elsewhere it may be R2) — a
   test asserts the effective level is the maximum, not the tool's own floor.
3. Effective risk = max(step, tool, connection, policy).
4. Approval RIGHTS live exclusively in `handbook/roster.md`.
