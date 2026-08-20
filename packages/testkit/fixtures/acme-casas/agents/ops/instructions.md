---
description: Fixture ops agent for exercising scope, grants, and Tool resolution with fictional values.
tools:
  - oregano:sprint/write-card-field
  - company:check-permit-status
scope:
  read:
    - company.md
    - handbook/**
    - policies/**
    - workflows/board-rhythm.md
  state:
    - board/**
---
# Ops agent (fixture)

The fixture company's only working agent. Its scope deliberately EXCLUDES
`brain/**`, `connections/**` and the other agent — the scope-allowlist test
asserts that those never reach the model sandbox.

Two grants on purpose: one `oregano:` (granted, never copied) and one
`company:` (resolved relative to this agent's own tools/ directory) — that pair
is what the tool-resolver tests check.
