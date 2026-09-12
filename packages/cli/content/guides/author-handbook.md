---
document_id: guide.author-handbook
title: Author the Handbook
kind: guide
status: implemented
authority: canonical
language: en
updated: 2026-09-11
owners:
  - oregano-maintainers
audience:
  - human
  - agent
---

# Author the Handbook

Write ordinary Markdown under `handbook/` in the Company Workspace. Articles
need no type, description, search index registration, database projection, or
activation step. An optional `handbook/index.md` can provide human navigation.
Existing content and links remain readable as files.

Use the normal Workspace editing, review, and governance process. Builder may
propose changes through its existing governed repository path. There is no
separate Handbook curator, Knowledge administrator, or promotion approval.

`handbook/roster.md` retains its structured `members` frontmatter. It supplies
Core identities, roles, groups, status and approval authority; these are not
Handbook-search features. Its existing protected-path rules remain in force.

Agents receive only files selected by their existing `scope.read`. Removing a
search grant does not grant access to all Handbook files. Old per-document
access metadata blocks inclusion in Agent materials until the company reviews
and migrates access through existing Workspace file scopes. Remove obsolete
metadata only after that review; descriptive frontmatter may remain.

Core provides no Handbook search/get/traverse service, embeddings, automatic
source ingestion or database-backed Handbook state. For an existing Instance,
follow [Retire Knowledge](retire-knowledge.md).
