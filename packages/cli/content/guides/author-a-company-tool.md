---
document_id: guide.author-company-tool
title: Author a Company Tool
kind: guide
status: approved
authority: canonical
language: en
updated: 2026-09-13
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
`agent_id` and `path`; a different Agent or unlisted path is rejected. An
Instance may additionally bind `model_task` and `model_profile` together for
a reviewed phase. Supported profiles are `agent`, `utility`, `reasoning` and
`deep`. These fields belong to the trusted binding, never the Tool input.

```typescript
const result = await context.capabilities.call("language.generate", {
  prompt_path: "agents/analyst/skills/summary/SKILL.md",
  data: { observations: input.observations },
});
```

The optional `attachments` array carries inline file evidence with `name`,
`mediaType`, byte `size`, base64 `data` and SHA-256 `digest`. Use bytes already
available through authorized inputs; this field does not grant file or URL
access. The selected model's Core provider policy validates formats, integrity
and combined size/count limits before invocation. See
[Agent attachment policies](../../operations/agent-attachments.md).

The frozen Skill supplies instructions. `data` contains evidence, not additional
instructions. The Connector uses the owning Agent's configured model task
and `agent` profile unless an explicit phase task/profile pair is bound;
the caller cannot select another model, provider or arbitrary prompt. The model
receives no Tools. Validate the returned `text` before a later workflow step
publishes or otherwise uses it. A failed call stops the Tool; do not invent a
successful result. Formatting checks do not prove factual accuracy.

The Skill defaults to at most 16,000 JavaScript string units. A reviewed
binding can set `max_instruction_characters` to a positive integer up to
30,000, based on measured complete instructions and model qualification.
Going above 16,000 also requires the explicit phase task/profile pair.
Unchanged bindings retain the 16,000 default. Serialized evidence remains
bounded at 200,000 JavaScript string units, including any trusted repair-feedback
wrapper. Requests exceeding that serialized bound fail before model dispatch;
linked instruction files are not loaded.
Select only the evidence needed for the task. Runtime permits up to 65 seconds
for Tools declaring this capability; a configured shorter Tool timeout wins.
The host adapter may impose tighter model limits. Successful calls record the
model response evidence and binding, prompt, data and output digests. Workflows retain
completed Tool results for resume; uncertain model calls may need another paid
attempt, while downstream effects retain their ordinary idempotency rules.

For the reference host's configuration and limits, see the provider-specific
[Vercel runner guide](../../operations/vercel-workflow-runner.md).
