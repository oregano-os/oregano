# Brain-First Lookup Convention

**Read this before doing ANY entity/person/company/fact lookup.**

## The Lookup Chain (MANDATORY ORDER)

Route by the SHAPE of the question, then escalate:

1. **Exact known token / name / structured field** → **`recall`** — bounded full-text retrieval, no model call.
2. **Known page ID or alias** → **`entity`** — read the full permitted page, Timeline, Takes and links.
3. **Cross-page question** → **`synthesize`** when needed — one bounded model composition with citations and explicit gaps.
4. **Missing evidence** → report the gap; this procedure has no external lookup authority.

**A nonzero `recall` count is NOT a completeness signal.** Bounded retrieval may omit evidence. Report omissions and gaps; neither recall nor synthesis certifies exhaustive coverage.

- **User's direct statements are highest-authority data.** The brain captures
  what the user said in meetings, conversations, and notes. External sources
  are supplementary.
- **After any brain page write:** trigger a sync so new pages are searchable.
  Oregano remember performs commit then sync; inspect its indexed revision or pending-sync outcome.

- **Every brain page reference in output** should use a clickable link format
  appropriate to the deployment (GitHub URL, local path, or slug).
- **Never use `memory_search` for entity lookups.** Memory tools search
  session notes (MEMORY.md), not the brain knowledge graph. Use
  `recall` or `entity` for entity lookups.

When creating new pages, include proper frontmatter with `type`, `title`,
and `tags` fields.
