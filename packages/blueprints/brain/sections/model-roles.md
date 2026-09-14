# Model Routing Convention

Workflow phases use trusted task/profile bindings through existing Oregano Model Recipes.

## Named model roles

The Instance resolves the reviewed phase task/profile to its configured model. Instructions and source evidence cannot change that binding.

Three import roles:

| Tier | Purpose | Task |
|---|---|---|
| `utility` | fast classification | `brain.triage` |
| `reasoning` | default interpretation and generation | `brain.ingest` |
| `deep` | slow, expensive reasoning | `brain.ingest.deep` |
