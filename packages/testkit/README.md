# testkit — neutral adapters, companies, Instances, and adversarial tests

The testkit proves that Oregano Core is company-independent and that one exact
Core, Workspace, and Instance pairing can be compiled and exercised without a
production provider.

```text
adapter/          deterministic Runner, clock, board, outbox, and StateStore fakes
fixtures/         fictional Workspaces, Packages, and non-secret Instances
tests/            the complete `pnpm test` suite
```

## Running

```bash
pnpm test
pnpm typecheck
pnpm check
```

When `DATABASE_URL` is present, approval atomicity also runs against a real
Postgres implementation. It self-skips without a configured database. Set
`COMPANYOS_SKIP_DATABASE_TESTS=1` when local checks must not contact external
state.

## Key evidence

| Test | Proves |
|---|---|
| `reference-runtime.test.ts` | deterministic artifact, scoped material, real Tool resolution, sandbox campaign, stale approval rejection, agent self-approval denial, ungranted Tool denial, and Connector failure evidence |
| `tool-sdk-security.test.ts` | Company Tools cannot import provider/Node code, read environment state, use direct network or dynamic imports, or escape the restricted process boundary |
| `toolset-resolver.test.ts` | unknown, duplicate, unavailable, unbound, and disallowed grants fail closed; risk and output hashes are deterministic |
| `json-schema-enforcement.test.ts` | Tool and Capability input/output use real JSON Schema enforcement and invalid schemas fail closed |
| `instance-loader.test.ts` | Instance declarations contain exact non-secret bindings and reject resolved credential indicators |
| `roster.test.ts` | surface-qualified principals, authorization, inactive identities, and agent identities are enforced structurally |
| `approval-atomicity.test.ts` | one approval claims one effect atomically under concurrent clicks |
| `core-neutrality.test.ts` | no real company, provider ID, company role, or retired Runner import enters Core logic |
| `testkit-adapter.test.ts` | deterministic fakes remain honest and reusable |

The reference runtime is executable test evidence, not a production Runner
Adapter or a claim that sandbox provider output is real.
