import assert from "node:assert/strict";
import { test } from "node:test";
import { engineArtifact } from "../workflow-engine-fixture.ts";
import { verifySlackPublicationNotSent } from "../../connectors/slack/publication-recovery.ts";

function fixture() {
  const artifact = structuredClone(engineArtifact());
  const binding = artifact.bindings.find((b) => b.capability === "communication.message.publish")!;
  binding.connector = "oregano/slack-communication"; binding.connectorVersion = "0.1.0";
  artifact.connectors = [{ id: "slack", connector: binding.connector, connectorVersion: binding.connectorVersion, configuration: {
    destinations: [{ id: "owner-direct", account_id: "T10001", kind: "direct-message", user_id: "U10002" }],
  } }];
  const input = { destination_binding: "owner-direct", thread_reference: "slack:D10001:1.000001" };
  const effect = { status: "failed", evidence: { error: "A direct-message destination cannot accept an unverified thread reference" } };
  return { artifact, input, effect };
}

test("Slack proves only the historical pre-publish guard of the exact maintained single-call Tool", async () => {
  const args = fixture();
  const proof = await verifySlackPublicationNotSent(args) as any;
  assert.equal(proof.reason, "legacy-direct-thread-guard-before-provider-call");
  assert.equal(proof.destination_binding, args.input.destination_binding);
});

for (const scenario of ["unknown", "other-error", "receipt", "channel", "missing-thread", "changed-tool", "changed-source-digest", "different-connector"] as const) test(`Slack no-send proof rejects ${scenario}`, async () => {
  const args = fixture();
  if (scenario === "unknown") args.effect.status = "unknown";
  if (scenario === "other-error") args.effect.evidence.error = "provider timeout";
  if (scenario === "receipt") Object.assign(args.effect.evidence, { message_id: "1.000001" });
  if (scenario === "channel") args.input.thread_reference = "slack:C10001:1.000001";
  if (scenario === "missing-thread") args.input.thread_reference = "";
  if (scenario === "changed-tool" || scenario === "changed-source-digest") {
    const tool = args.artifact.agents.flatMap((a) => a.tools).find((t) => t.contract.runtimeId === "oregano:communications/publish")!;
    if (scenario === "changed-tool") tool.compiledSource += "\n// changed";
    else tool.sourceDigest = "1".repeat(64);
  }
  if (scenario === "different-connector") args.artifact.bindings.find((b) => b.capability === "communication.message.publish")!.connector = "test/other";
  if (scenario === "different-connector") await assert.rejects(verifySlackPublicationNotSent(args), /configured Slack destination/);
  else assert.equal(await verifySlackPublicationNotSent(args), undefined);
});
