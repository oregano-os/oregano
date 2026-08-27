import assert from "node:assert/strict";
import { test } from "node:test";
import { GRANOLA_SOURCE_V2_DESCRIPTOR } from "../../../connectors/source-registry-maintained.ts";
import { COMPANY_KNOWLEDGE_POLICY } from "../../../knowledge/access-control.ts";
import { InMemorySourcePipelineStore } from "../../../knowledge/in-memory-source-pipeline-store.ts";
import { SOURCE_CONNECTOR_V2_CONTRACT_VERSION, type SourceBindingV2, type SourceRequirementV2 } from "../../../knowledge/source-contracts-v2.ts";
import {
  authorizeScheduledKnowledgeRequest,
  classifyKnowledgeSourceRuntimeError,
  decodeGranolaRuntimeConfiguration,
  GranolaKnowledgeSourceRuntime,
  type GranolaRuntimeConfiguration,
  type GranolaRuntimeStore,
} from "./knowledge-source-runtime.ts";

const now = "2026-08-26T17:00:00.000Z";
const workspaceId = "workspace:oregano-hq";

const requirement: SourceRequirementV2 = {
  version: 2,
  type: "knowledge-source",
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: "oregano-hq-granola",
  sourceKind: "meeting",
  deliveryMode: "hybrid",
  dataOwner: "human:peter-noetzel",
  dataClass: "restricted",
  personalData: true,
  retention: { mode: "retain" },
  legalHold: false,
  staleAfterSeconds: 21_600,
  content: { mediaTypes: ["text/markdown"], maxInlineBytes: 262_144, maxAssetBytes: 10_485_760 },
  access: { mode: "fixed-policy", rootPolicyId: "policy:company-handbook" },
  providerScope: { kind: "workspace", workspaceId },
};

const binding: SourceBindingV2 = {
  version: 2,
  contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  sourceId: requirement.sourceId,
  installationId: "installation:oregano-hq-granola",
  connectorId: GRANOLA_SOURCE_V2_DESCRIPTOR.connectorId,
  connectorVersion: GRANOLA_SOURCE_V2_DESCRIPTOR.connectorVersion,
  secretRefs: { primary: "env:GRANOLA_API_KEY", webhook: "env:GRANOLA_WEBHOOK_SECRET" },
  requiredScopes: ["personal", "public"],
  providerIdentity: { kind: "workspace", workspaceId, apiBaseUrl: "https://public-api.granola.test" },
  state: "active",
  qualification: { qualifiedAt: now, receiptId: "receipt:granola-qualified", implementationDigest: GRANOLA_SOURCE_V2_DESCRIPTOR.implementationDigest },
};

class RuntimeStore extends InMemorySourcePipelineStore implements GranolaRuntimeStore {
  readonly registrations: Array<{ requirement: SourceRequirementV2; binding: SourceBindingV2 }> = [];
  readonly statuses: string[] = [];
  async registerSource(target: SourceRequirementV2, targetBinding: SourceBindingV2) { this.registrations.push({ requirement: target, binding: targetBinding }); }
  async setSourceStatus(_sourceId: string, status: "registered" | "healthy" | "stale" | "error" | "revoked") { this.statuses.push(status); }
}

const configuration: GranolaRuntimeConfiguration = { version: 1, requirement, binding };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("Granola runtime configuration remains SecretRef-only and scheduler authorization fails closed", () => {
  const encoded = Buffer.from(JSON.stringify(configuration), "utf8").toString("base64");
  assert.deepEqual(decodeGranolaRuntimeConfiguration(encoded), configuration);
  assert.equal(authorizeScheduledKnowledgeRequest(new Request("https://company.test", { headers: { authorization: "Bearer expected" } }), "expected"), true);
  assert.equal(authorizeScheduledKnowledgeRequest(new Request("https://company.test", { headers: { authorization: "Bearer wrong" } }), "expected"), false);
  assert.throws(() => decodeGranolaRuntimeConfiguration(Buffer.from(JSON.stringify({ ...configuration, token: "forbidden" })).toString("base64")), /unsupported shape/);
});

test("Knowledge source runtime failures expose bounded categories rather than provider messages", () => {
  assert.equal(classifyKnowledgeSourceRuntimeError(new Error("Source 'source:test' conflicts with an existing requirement.")), "source-registration");
  assert.equal(classifyKnowledgeSourceRuntimeError(new Error("Granola API request failed after bounded retry (HTTP 503).")), "provider-response");
  assert.equal(classifyKnowledgeSourceRuntimeError(new Error("unexpected protected provider detail")), "unclassified");
});

test("Granola runtime resumes bounded provider-wide reconciliation under one durable lease", async () => {
  const store = new RuntimeStore();
  await store.putPolicy(COMPANY_KNOWLEDGE_POLICY, "a".repeat(64));
  const noteIds = ["not_1d3tmYTlCICgjy", "not_2d3tmYTlCICgjy"];
  const runtime = new GranolaKnowledgeSourceRuntime({
    configuration,
    store,
    resolveSecret: () => "test-provider-token",
    now: () => now,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/notes" && url.searchParams.get("page_size") === "1") return response({ notes: [], hasMore: false, cursor: null });
      if (url.pathname === "/v1/notes") {
        assert.equal(url.searchParams.has("folder_id"), false);
        return url.searchParams.get("cursor") === "next-page"
          ? response({ notes: [{ id: noteIds[1], updated_at: "2026-08-26T16:35:00.000Z" }], hasMore: false, cursor: null })
          : response({ notes: [{ id: noteIds[0], updated_at: "2026-08-26T16:30:00.000Z" }], hasMore: true, cursor: "next-page" });
      }
      if (noteIds.some((noteId) => url.pathname === `/v1/notes/${noteId}`)) return response({
        id: url.pathname.split("/").at(-1),
        object: "note",
        title: "Company review",
        owner: { name: "Peter", email: "peter@example.test" },
        created_at: "2026-08-26T16:00:00.000Z",
        updated_at: url.pathname.endsWith(noteIds[0]) ? "2026-08-26T16:30:00.000Z" : "2026-08-26T16:35:00.000Z",
        attendees: [],
        folder_membership: [],
        summary_text: "The company review completed.",
        transcript: [{ speaker: { name: "Peter" }, text: "The complete transcript remains available." }],
      });
      return response({ message: "not found" }, 404);
    },
  });
  const first = await runtime.reconcile({ maxPages: 1 });
  assert.equal(first.status, "partial");
  assert.equal(store.syncLeases.size, 0);
  assert.ok(await store.currentRawEvidence(requirement.sourceId, noteIds[0]));
  assert.equal(await store.currentRawEvidence(requirement.sourceId, noteIds[1]), undefined);

  const second = await runtime.reconcile({ maxPages: 1 });
  assert.equal(second.status, "complete");
  assert.equal(store.registrations.length, 2);
  assert.deepEqual(store.statuses, ["healthy"]);
  assert.equal(store.syncLeases.size, 0);
  assert.ok(await store.currentRawEvidence(requirement.sourceId, noteIds[1]));
});
