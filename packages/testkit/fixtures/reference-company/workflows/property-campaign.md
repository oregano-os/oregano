---
type: workflow
description: Reference vertical slice for governed campaign execution.
owner: agents/growth
trigger: authorized human request
input: approved property facts and bounded campaign parameters
execution_mode: supervised
goal: Publish approved assets, launch a sandbox campaign, and report evidence.
---
# Property campaign

1. [growth, R3] Publish each approved asset through `company:publish-asset`.
2. [human:steward] Decide the exact campaign budget.
3. [growth, R4] Launch through `company:launch-campaign` after exact approval.
4. [growth, R0] Record synthetic conversions through `company:record-conversion`.
5. [growth, R0] Read normalized facts through `company:campaign-report`.
6. [growth, R2] Stop a weak asset without increasing approved maximum spend.
