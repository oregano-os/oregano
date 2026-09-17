import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({ async execute(input: any) {
  // Records supply a reviewed semantic kind. Never guess from provider IDs,
  // URL suffixes, source instructions or a paid classification call.
  const { source, routes } = input;
  if (source.kind === "publication") throw new Error("Publication enumeration is required before item ingestion. No publication discovery Connector is bound by this workflow; no model was called.");
  const instructions = routes[source.kind];
  if (!Array.isArray(instructions) || !instructions.length || instructions.length > 8
    || instructions.some((path: unknown) => typeof path !== "string" || !/^agents\/[a-z][a-z0-9-]*\/skills\/brain-[a-z-]+\/SKILL\.md$/.test(path))
    || new Set(instructions).size !== instructions.length) throw new Error("Unsupported content kind or invalid reviewed ingestion route");
  return { kind: source.kind, instructions };
} });
