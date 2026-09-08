# Oregano

Oregano Core is the generic executable platform behind CompanyOS. A deployed
CompanyOS Instance combines an exact Oregano Core version with an exact Company
Workspace version and environment-specific infrastructure.

Start with [the canonical documentation](docs/README.md). For a new Company
Workspace, use [the maintained onboarding path](docs/onboarding/README.md) and
`companyos onboard`.

Codex and Claude Code share one experimental, plugin-free agent installation:
[INSTALL-COMPANYOS.md](INSTALL-COMPANYOS.md). The public copy-paste entry points
at an immutable GitHub Release asset discovered through `releases/latest`; the
installer resolves that redirect once and pins the exact release tag, Core
commit, Workbench version, and checksum. No `latest-stable` branch exists or is
required.

The recommended live setup requires **Vercel Pro** (Enterprise also works),
Neon/Postgres, and Slack. Oregano checks the selected Vercel team automatically
and manages background scheduling. See [setup choices](docs/onboarding/setup-options.md)
for prerequisites and alternatives.

## For Codex — the recommended first step

Open Codex on a new, empty setup folder and paste:

```text
Set up Oregano using the verified release installer described here:
https://github.com/oregano-os/oregano/releases/latest/download/INSTALL-COMPANYOS.md

Guide me in my language. Use the standard defaults and show me the single
editable setup summary. Handle routine work yourself; ask me only for missing
information, the setup decision, and necessary account actions. Finish when
Oregano has replied to my first message in Slack and verification succeeds.
```

Codex may request command, network, and workspace-write approvals during the
run. No Codex plugin is required.

## For Claude Code

Open Claude Code on a new, empty setup folder and paste:

```text
Set up Oregano using the verified release installer described here:
https://github.com/oregano-os/oregano/releases/latest/download/INSTALL-COMPANYOS.md

Guide me in my language. Use the standard defaults and show me the single
editable setup summary. Handle routine work yourself; ask me only for missing
information, the setup decision, and necessary account actions. Finish when
Oregano has replied to my first message in Slack and verification succeeds.
```

The runbook uses ordinary shell and filesystem operations and does not install
a Claude Code plugin or hook.

The standard release includes a checksummed installer payload and its required
tooling. No npm publication or full developer dependency installation is needed
on this path. The new flow is experimental; the five-minute target requires
measured cold live runs before it can be advertised as achieved.

- `docs/` — canonical English product and engineering documentation
- `packages/` — Core runtime, control-plane, Workbench, and test packages
- `packages/testkit/fixtures/` — fictional Company Workspaces used by tests

The Core contains no real company. Each real Company Workspace lives in its own
repository.

## License

Oregano is licensed under the [Apache License 2.0](LICENSE). The license does
not grant trademark rights; see [TRADEMARKS.md](TRADEMARKS.md).
