# CompanyOS Builder worker

This private package is the portable process bundle for one proposal-only
Builder job. It contains the exact ACP v1 client and the exactly pinned Claude
Code and Codex ACP profiles. It is installed into a qualified worker image or
snapshot; ordinary Company Agents and the synchronous Runner do not load it.

The worker accepts one validated JSON request, edits only the supplied
workspace, emits non-secret evidence, and exits. Repository acquisition,
proposal publication, approval, merge, and deployment remain outside this
process.
