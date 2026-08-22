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

## For Codex — the recommended first step

Open Codex on a new, empty setup folder and paste:

```text
Read and follow every step of:
https://github.com/oregano-os/oregano/releases/latest/download/INSTALL-COMPANYOS.md

Goal: set up Oregano completely as my company's CompanyOS, including a private
GitHub Workspace, Vercel, Neon/Postgres, and Slack. Guide me in my language and
assume I have no technical knowledge. Resolve the latest stable Release to its
exact tag, commit, Workbench version, and checksum before installing. Interview
me before writing company files—never invent answers. Explain every login,
consent, cost, external change, review, and production action before it happens.
Never ask me to paste a password, token, API key, or database URL into chat or
Git. You are not done until `companyos verify-live` exits successfully, I have
received a real Oregano reply in Slack, and you have explained the exact scope
it verified.
```

Codex may request command, network, and workspace-write approvals during the
run. No Codex plugin is required.

## For Claude Code

Open Claude Code on a new, empty setup folder and paste:

```text
Read and follow every step of:
https://github.com/oregano-os/oregano/releases/latest/download/INSTALL-COMPANYOS.md

Goal: set up Oregano completely as my company's CompanyOS, including a private
GitHub Workspace, Vercel, Neon/Postgres, and Slack. Guide me in my language and
assume I have no technical knowledge. Resolve the latest stable Release to its
exact tag, commit, Workbench version, and checksum before installing. Interview
me before writing company files—never invent answers. Explain every login,
consent, cost, external change, review, and production action before it happens.
Never ask me to paste a password, token, API key, or database URL into chat or
Git. You are not done until `companyos verify-live` exits successfully, I have
received a real Oregano reply in Slack, and you have explained the exact scope
it verified.
```

The runbook uses ordinary shell and filesystem operations and does not install
a Claude Code plugin or hook.

Oregano itself is installed from an exact GitHub Release checkout. It is not
published as an npm package. The release manifest pins pnpm, and the agent
invokes that exact version through npm without changing a global pnpm
installation. Its single `pnpm install --frozen-lockfile` installs only the
locked third-party dependencies required to run the repository-local Workbench
and Vercel Runner.

- `docs/` — canonical English product and engineering documentation
- `packages/` — Core runtime, control-plane, Workbench, and test packages
- `packages/testkit/fixtures/` — fictional Company Workspaces used by tests

The Core contains no real company. Each real Company Workspace lives in its own
repository.

## License

Oregano is licensed under the [Apache License 2.0](LICENSE). The license does
not grant trademark rights; see [TRADEMARKS.md](TRADEMARKS.md).
