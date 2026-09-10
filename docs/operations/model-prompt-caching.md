---
document_id: operations.model-prompt-caching
title: Model Prompt Caching
kind: guide
status: approved
authority: canonical
language: en
implementation_scope: provider
providers: [anthropic, openai, vercel]
updated: 2026-09-10
owners: [oregano-maintainers]
audience: [human, agent]
availability: experimental
---

# Model Prompt Caching

Model bindings accept `promptCaching: "auto" | "provider-default"`. The selected
binding still follows exact task, profile, default, then legacy/environment
resolution; bindings are not merged. Omission means `auto` for the `agent`
profile and `provider-default` for other profiles. All ordinary Agent and
coordinator calls using this profile share that behavior, independently of
company, Agent identity, or communication channel.

For native Anthropic, `auto` enables automatic conversation caching and marks
the first stable system block and last function Tool definition. This uses at
most three cache slots. It applies to generation, streaming and every Tool-loop
step. Changing workflow context and selected work are separate system blocks,
so they do not invalidate the stable Agent prefix. Explicit caller cache
controls remain intact instead of being mixed with automatic markers. No TTL
is supplied; Anthropic chooses its default lifetime. Prompt length thresholds,
exact-prefix matching and expiry still determine actual cache hits.

OpenAI retains native prompt caching and model/organization retention defaults;
no retention or Anthropic-specific fields are sent. Gateway, Google and
OpenAI-compatible routes likewise retain provider-native behavior until their
own maintained cache adapter is added. `provider-default` suppresses CompanyOS
cache additions; it does not promise to disable provider-side automatic caching.
No provider credential, Agent instruction or Skill change is needed.

Example decoded `COMPANYOS_MODEL_CONFIG_BASE64` (non-secret Instance settings):

```json
{
  "version": 1,
  "profiles": {
    "agent": {
      "route": "anthropic-direct",
      "model": "anthropic/claude-sonnet-5",
      "promptCaching": "auto"
    }
  }
}
```

Execution evidence records the effective requested mode, `cacheReadTokens`,
`cacheWriteTokens` and `uncachedInputTokens`; unavailable counts remain `null`.
Tool-loop usage is summed across steps, including streamed calls. These are
provider usage facts, not claimed discounts or stored prompt text. Qualify
reuse with repeated real calls inside the provider lifetime and compare cache
reads/writes; a mocked SDK response proves transport wiring, not a cache hit.
This does not change separate Knowledge cost estimates or CLI-managed coding
sessions. Restore `provider-default` on the selected binding for rollback.

Provider references: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
and [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
