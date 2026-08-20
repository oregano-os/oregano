---
name: acme-casas
workspace_version: "0.1.0"
type: fixture-company
language: en
timezone: America/New_York
companyos_spec: "0.7-draft"
workspace_mode: operating
---
Acme Casas is a fictional company that exists only to prove that Core behavior
comes from Company Workspace configuration. It uses distinctive language,
timezone, role names, channels, board columns, and thresholds.

If a Core package assumes a particular column ID, channel name, role, threshold,
or language, tests against this fixture must fail immediately. It is a boundary
guard, not a deployment example.

Never point a real deployment at this directory.
