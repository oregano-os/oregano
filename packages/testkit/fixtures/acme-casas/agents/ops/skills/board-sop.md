---
type: sop
description: Fictional board rhythm whose parameters expose hardcoded Core assumptions.
nudge_after_hours: 72
nudge_escalations: 2
backlog_max_per_person: 3
quiet_hours: "20:00-07:00"
bundle_window_minutes: 30
---
# Board rhythm (fixture)

Column order of this company: `icebox → ready → doing → checking → shipped`.

Rules the engine must read from the frontmatter above, never from constants:

1. Silence counts after **72** working hours.
2. There are **2** escalation steps before an issue is raised.
3. Backlog cap is **3** projects per person.
4. Quiet hours are **20:00–07:00** local time.
5. Movement posts are bundled every **30** minutes.

Tone: nudge, never judge — same principle, other words.
