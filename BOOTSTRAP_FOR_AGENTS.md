# Oregano bootstrap for Codex and Claude Code

This compatibility entrypoint supports Codex and Claude Code without a plugin,
MCP server, hook, or OpenClaw component. Read the exact Release's
`INSTALL-COMPANYOS.md` and verify its `release-manifest.json`.

The public discovery URL is:

```text
https://github.com/oregano-os/oregano/releases/latest/download/INSTALL-COMPANYOS.md
```

Use the verified release installer and let `companyos setup` own the session.
Ask which model provider to use, offering OpenAI or Anthropic with no default.
Other supported providers and models are available only on request.
Show one editable setup decision, including the first deployment, and necessary
provider actions. Do not add a configuration interview or permission requests
for routine work. The CLI invokes `companyos verify-live` before reporting that
Oregano is ready in Slack. Local authoring verification alone is not completion.
