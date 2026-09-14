---
document_id: command.brain
title: companyos brain
kind: command
status: building
authority: canonical
language: en
updated: 2026-09-14
owners: [oregano-maintainers]
audience: [human, agent]
availability: experimental
relations:
  depends_on: [specification.brain-read]
---

# companyos brain

Check local knowledge or operate on the explicitly bound Brain projection.
This is an administrator CLI, not a new user authentication interface.

```sh
companyos brain check <workspace> --format json
companyos brain sync --artifact <file> --format json
companyos brain recall --artifact <file> --agent <id> --subject-principal <principal> --input <json-file>
companyos brain entity --artifact <file> --agent <id> --subject-principal <principal> --input <json-file>
companyos brain context_pack --artifact <file> --agent <id> --subject-principal <principal> --input <json-file>
companyos brain synthesize --artifact <file> --agent <id> --subject-principal <principal> --input <json-file>
```

`check` validates the declaration, policy, permitted local files and evidence
chains without provider, database or model access. Errors produce a nonzero exit.
`sync` requires the existing repository and prepared Instance database bindings;
it reports the successful revision, changed-page count and diagnostics. Invalid
pages leave the previous projection intact and produce a nonzero exit.

Reads use the same four Tool contracts as Agents, through the normal runtime,
and return structured output with indexed revision and evidence. They require an
active existing roster principal and an effective grant for the selected Agent.
The trusted Artifact must come from `companyos build` and match the running Core
checkout. The CLI's on-behalf-of principal flag cannot authenticate remote users.
The operator runs outside an active Workflow assignment. Existing Workflow
reservations still apply; this command cannot impersonate an active step.

Input examples are `{"query":"expansion"}`, `{"name":"people/alex"}`,
`{"entities":"people/alex,topics/expansion","budget_tokens":4000}` and
`{"question":"What supports the expansion proposal?"}`. Only synthesis may
call the configured model. No command writes knowledge or deploys an Artifact.

See the [document and read contracts](../../specifications/brain-read.md) and
[maintained operator procedure](../../operations/brain-read.md).
