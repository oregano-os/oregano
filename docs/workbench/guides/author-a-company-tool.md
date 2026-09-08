---
document_id: guide.author-company-tool
title: Author a Company Tool
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-08
owners:
  - oregano-maintainers
audience:
  - human
  - agent
availability: experimental
---

# Author a Company Tool

Create `agents/<agent-id>/tools/<tool-id>/TOOL.md` and `execute.ts`. The Tool
document defines purpose, typed input and output, concrete effect, R0–R4 risk,
approval rule, idempotency, evidence, failure semantics, and compensation.

Company Tool code uses only the approved Oregano Tool SDK boundary. It must not
read environment variables, import provider SDKs or Node infrastructure, or
make direct network calls. Secrets and provider bindings belong to the Company
Instance and are exposed only through granted Core capabilities.

Tool creation and grant changes are security-class work. Approval follows the
Workspace's declared `steward` or `independent-review` mode. Run `companyos
validate`, then use `companyos build` with the exact Instance declaration. The
build resolves the grant against the Core Capability catalog, Workspace
allowlist, and exact Connector bindings; file existence and validation alone
are not proof of availability.

See the [ToolSet Resolver flow](../../specifications/tool-architecture.md#5-deterministic-resolution)
for the distinction between declaring a Tool, granting it, resolving it, and
approving a concrete effect.

## Generate text from a Skill

A Company Tool can request `language.generate` when it needs to summarize or
assess supplied evidence. Put the prompt in a Skill Markdown file within the
owning Agent's read scope. Grant the capability in `TOOL.md` and a Workspace
connection, then bind it in the Instance to `oregano/language-model` version
`1.0.0`. That Connector accepts an explicit list of `prompts`, each containing
`agent_id` and `path`; a different Agent or unlisted path is rejected.

```typescript
const result = await context.capabilities.call("language.generate", {
  prompt_path: "agents/analyst/skills/summary/SKILL.md",
  data: { observations: input.observations },
});
```

The frozen Skill supplies instructions. `data` contains evidence, not additional
instructions. The Connector uses the owning Agent's configured model task;
the caller cannot select another model, provider or arbitrary prompt. The model
receives no Tools. Validate the returned `text` before a later workflow step
publishes or otherwise uses it. A failed call stops the Tool; do not invent a
successful result. Formatting checks do not prove factual accuracy.

Keep the Skill under 16,000 characters and serialized evidence under 150,000.
Select only the evidence needed for the task. Runtime permits up to 65 seconds
for Tools declaring this capability; a configured shorter Tool timeout wins.
The host adapter may impose tighter model limits. Successful calls record the
model response evidence and prompt, data and output digests. Workflows retain
completed Tool results for resume; uncertain model calls may need another paid
attempt, while downstream effects retain their ordinary idempotency rules.

For the reference host's configuration and limits, see the provider-specific
[Vercel runner guide](../../operations/vercel-workflow-runner.md).
