# runner — adapter contracts

This directory contains runner-neutral interfaces only. Model conversation,
message transport, approval presentation, and clocks are replaceable surfaces;
they never own roster authorization, Tool grants, effect claims, or evidence.

The deterministic test adapter proves the boundary without a provider. The
legacy Eve adapter has been retired. `packages/runner-vercel` is the maintained
production-capable adapter for the reference stack: Vercel Connect and Chat SDK
provide Slack transport, AI SDK and AI Gateway provide model turns, and
Postgres provides durable chat state. Provider-neutral contracts remain here;
deployment code remains in the adapter package.

A production adapter must consume only the compiled agent instructions,
scoped material, and resolved ToolSet. It must pass canonical principals into
Core approval enforcement and must not register an ungranted Tool or execute a
provider effect directly.
