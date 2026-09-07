import { engineArtifact, engineFixture } from "./workflow-engine-fixture.ts";
import { sha256 } from "../runtime/canonical.ts";

export function collectionFixture(options: Parameters<typeof engineFixture>[0] = {}) {
  const artifact = structuredClone(engineArtifact());
  const workflow = artifact.workflows!.find((entry) => entry.id === "monday-handoff")!;
  const message = structuredClone(workflow.steps.find((entry) => entry.message)!);
  message.id = "ask"; message.next = ["facts"]; message.forEach = undefined; message.requiredOutputPaths = [];
  message.message = { template: "synthetic-question", vars: {}, destination: "sprint-direct", recipient: "jonas-owner" };
  const { tool, message: _message, ...base } = message;
  const collect = { ...base, id: "facts", kind: "collect" as const, allowedTools: [], maxRisk: "R0" as const, next: ["end"],
    collect: { from: "$steps.ask.thread_reference", context: {}, fields: ["summary"], timeoutBusinessDays: 1, calendarPath: workflow.schedules[0]!.path } };
  workflow.steps = [message, collect]; workflow.entry = "ask";
  workflow.templates = [{ path: "synthetic-question", content: "Please explain the intended outcome.", format: "plain-text", digest: sha256("question") }];
  const { manifestHash, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
  const { artifactHash, ...content } = artifact; artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  return engineFixture({ ...options, artifact });
}
