# Oregano bootstrap for Codex and Claude Code

This compatibility entrypoint supports Codex and Claude Code without a plugin,
MCP server, hook, or OpenClaw component.

The maintained bootstrap now includes the complete live starter path rather
than stopping at a local authoring Workspace. Read and follow every step of the
release-matched `INSTALL-COMPANYOS.md`. When this file was obtained from a
GitHub Release, use `release-manifest.json` from the same exact Release to
verify the runbook, tag, Core commit, Workbench version, and checksums before
installing.

Public stable runbook:

```text
https://github.com/oregano-os/oregano/releases/latest/download/INSTALL-COMPANYOS.md
```

The `latest` redirect is discovery only. Resolve it to one exact non-prerelease
tag and commit, then keep those pins for the entire installation. Completion
requires `companyos verify-live --state <file>` with scope
`live-starter-instance`; `companyos bootstrap verify` remains only the local
authoring checkpoint.
