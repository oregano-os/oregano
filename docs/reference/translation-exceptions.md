---
document_id: reference.translation-exceptions
title: Translation Exception Report
kind: report
status: building
authority: canonical
language: en
updated: 2026-08-19
owners:
  - core-maintainers
audience:
  - human
  - agent
---

# Translation Exception Report

This report tracks semantic hotspots discovered while migrating the German
sources to canonical English documentation. Items are not silently resolved by
translation.

## Open exceptions

| ID | Source | Issue | Current treatment |
|---|---|---|---|
| TR-001 | CompanyOS v0.6 §2 | “One company is a directory” predates the repository split and does not name Company Workspace or Company Instance. | v0.7 draft uses the approved model; detailed migration review remains open. |
| TR-002 | CompanyOS v0.6 philosophy | “No registry, no setup” conflicts with the new documentation registry and pinned Workbench. | Interpret as no second company-policy registry or proprietary admin truth; wording needs approval. |
| TR-003 | CompanyOS v0.6 §7 and Builder overview | Builder authority is assigned to “the owner”; this mixes legal ownership and access authority. | English docs use Workspace Steward and Process Steward. Legacy roster-role mappings remain explicit. |
| TR-004 | Legacy property-campaign workflow | Human steps are written as `[human:owner, R3/R4]`, although a human action has no agent risk. | Validator warns. Do not rewrite until a behavior Change Plan separates human decision from agent effect. |
| TR-005 | Tool architecture §21 | The obsolete GWC proof Tool remained after the PRD replaced it. | Source corrected to `calculate-weekly-facts-log`; detailed English Tool specification is pending. |
| TR-007 | Identity retention | One source required inactive roster history while another removed the entry. | Workspace retention now requires inactive status and rights removal without deleting history. |
| TR-008 | Core/Workspace distribution | Co-checkout now uses an immutable Core commit and exact Workbench version, but a Workspace-only Contributor cannot yet install a published Workbench package. | CLI source and package are experimental; registry, package scope, signing, and release policy remain open. |
| TR-010 | Instance environment isolation | Existing decisions assume one Vercel project and one Neon database per company, while the new model identifies production and staging as separate Instances. | Architecture recommends isolation; concrete project/database topology needs approval. |
| TR-012 | Language policy | Engineering artifacts are English, while operational Company content may use company language. | Runtime language remains configured per Workspace; Agent Contributors must use English. |
| TR-014 | CompanyOS v0.6 §1 and legacy profile decisions | Global A/B/C profiles combine Workspace structure, workflow autonomy, Instance enforcement, and effect risk into one label and have already diverged from actual implementation. | The v0.7 draft replaces them with `workspace_mode`, per-workflow `execution_mode`, derived Instance readiness, and unchanged per-effect R0–R4. The German v0.6 source and old Change Plans remain historical evidence, not the active contract. |

## Resolved exceptions

| ID | Source | Resolution |
|---|---|---|
| TR-009 | Core capability grants | The experimental Core now compiles local Company Tool contracts, enforces JSON Schemas, resolves grants against allowed Capabilities and exact Instance bindings, and records a stable ToolSet hash. Published Tool Package activation remains a separate ecosystem stage. |
| TR-013 | Legacy Eve runtime | The Core-resident Eve adapter and company-specific demo Tools were removed after the generic Builder, Tool SDK, Resolver, Capability, sandbox Connector, and reference runtime path passed end-to-end tests. The maintained Vercel Runner loads an immutable Artifact; the old Eve Git integration and aliases were removed. |

## Translation safety checks

Every translation review pays special attention to:

- modal strength (`must`, `should`, `may`),
- R0–R4 meaning and approval identity,
- roles and delegated authority,
- numbers, thresholds, deadlines, and spend limits,
- paths, field names, schemas, and IDs,
- proposal and open-decision markers,
- compensation, rollback, and irreversible effects.
