import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  KnowledgeAccessPolicy,
  KnowledgeProvider,
  KnowledgeSearchResult,
} from "../../knowledge/contracts.ts";
import type { SourceBindingV2, SourceRequirementV2 } from "../../knowledge/source-contracts-v2.ts";
import { createUnifiedKnowledgeProvider, type BrainKnowledgeProjection } from "../../knowledge/unified-provider.ts";
import { sha256 } from "../../runtime/canonical.ts";
import { createCompanyOSRuntimeConnectors } from "../../runner-vercel/src/lib/bot.ts";
import { activateVerifiedKnowledgeSnapshot } from "../../state-postgres/knowledge-store.ts";
import { assertPermittedSourceRebinding } from "../../state-postgres/source-pipeline-store.ts";

const now = "2026-08-27T10:00:00.000Z";
const companyPolicy: KnowledgeAccessPolicy = {
  policyId: "policy:company",
  policyVersion: 1,
  visibility: "company",
  sourceRoot: true,
  status: "active",
  entries: [],
};
const privatePolicy: KnowledgeAccessPolicy = {
  policyId: "policy:private",
  policyVersion: 1,
  visibility: "private",
  sourceRoot: true,
  status: "active",
  entries: [{ subjectKind: "principal", subjectId: "human:peter", permission: "read", effect: "allow" }],
};

const emptySearch = (query: string): KnowledgeSearchResult => ({
  query,
  snapshotHash: null,
  hits: [],
  gaps: ["no-active-snapshot"],
  mode: "lexical",
  degradations: [],
});

const handbook: KnowledgeProvider = {
  stage: async () => { throw new Error("not used"); },
  verify: async () => { throw new Error("not used"); },
  activate: async () => { throw new Error("not used"); },
  activeSnapshot: async () => undefined,
  search: async ({ query }) => emptySearch(query),
  get: async () => undefined,
  traverse: async ({ path, direction }) => ({ snapshotHash: null, startPath: path, direction: direction ?? "both", paths: [], truncated: false, gaps: ["no-active-snapshot"] }),
  health: async () => ({ ok: false, activeSnapshotHash: null, lexical: true, vectorIndex: false, embeddingAdapter: null, degradation: "embedding-disabled" }),
};

const record = (identity: string, policy: string, text: string) => ({
  identity,
  kind: "page" as const,
  pageId: identity,
  title: identity,
  aliases: [],
  text,
  contentDigest: sha256(text),
  accessPolicyId: policy,
  label: "evidence" as const,
  observedAt: now,
  sourceIds: ["source:registered"],
  confidence: 0.9,
  authority: 0.6,
  freshness: 1,
  expectedValue: 0.5,
  graphNeighbors: [] as string[],
});

const publicRecord = record("page:public", "policy:company", "Project Cedar launches in September.");
const privateRecord = record("page:private", "policy:private", "Private compensation planning for Project Cedar.");
publicRecord.graphNeighbors = [privateRecord.identity];
privateRecord.graphNeighbors = [publicRecord.identity];
const projection: BrainKnowledgeProjection = {
  projectionHash: sha256("projection"),
  policies: [companyPolicy, privatePolicy],
  records: [publicRecord, privateRecord],
  citations: {
    [publicRecord.identity]: { path: "company-knowledge/pages/public", fragmentId: "version:public", heading: "Public", startLine: 1, endLine: 1, digest: publicRecord.contentDigest },
    [privateRecord.identity]: { path: "company-knowledge/pages/private", fragmentId: "version:private", heading: "Private", startLine: 1, endLine: 1, digest: privateRecord.contentDigest },
  },
  edges: [{ from: publicRecord.identity, to: privateRecord.identity }],
  deltas: [],
};

test("unified production retrieval authorizes Company Knowledge before search, get, and traversal", async () => {
  const provider = createUnifiedKnowledgeProvider({ handbook, brain: { load: async () => structuredClone(projection) } });
  const unresolved = { principalId: "human:other", principalType: "human" as const, status: "active" as const, groupIds: [] };
  const search = await provider.search({ query: "Project Cedar", subject: unresolved });
  assert.deepEqual(search.hits.map((hit) => hit.citation.path), ["company-knowledge/pages/public"]);
  assert.equal(await provider.get({ path: "company-knowledge/pages/private", subject: unresolved }), undefined);
  const traversal = await provider.traverse({ path: "company-knowledge/pages/public", subject: unresolved });
  assert.deepEqual(traversal.paths.map((entry) => entry.path), ["company-knowledge/pages/public"]);

  const authorized = { ...unresolved, principalId: "human:peter" };
  const privateDocument = await provider.get({ path: "company-knowledge/pages/private", subject: authorized });
  assert.equal(privateDocument?.document.body, privateRecord.text);
  const authorizedTraversal = await provider.traverse({ path: "company-knowledge/pages/public", subject: authorized });
  assert.deepEqual(authorizedTraversal.paths.map((entry) => entry.path), ["company-knowledge/pages/public", "company-knowledge/pages/private"]);
});

test("production Agent runtime registers both the Artifact and Company Knowledge connectors", () => {
  assert.deepEqual(createCompanyOSRuntimeConnectors().map((connector) => connector.id), ["oregano/artifact-postgres", "oregano/knowledge-postgres"]);
});

test("source-backed retrieval stays available while a malformed Handbook snapshot is explicitly degraded", async () => {
  const unavailableHandbook: KnowledgeProvider = {
    ...handbook,
    search: async () => { throw new Error("legacy snapshot has no complete bundle"); },
  };
  const provider = createUnifiedKnowledgeProvider({ handbook: unavailableHandbook, brain: { load: async () => structuredClone(projection) } });
  const result = await provider.search({ query: "Project Cedar", subject: { principalId: "human:peter", principalType: "human", status: "active", groupIds: [] } });
  assert.equal(result.hits.length, 2);
  assert.ok(result.degradations.includes("handbook-unavailable"));
});

const sourceRequirement: SourceRequirementV2 = {
  version: 2,
  type: "knowledge-source",
  contractVersion: "2.0.0",
  sourceId: "source:granola",
  sourceKind: "meeting",
  deliveryMode: "hybrid",
  dataOwner: "role:company-owner",
  dataClass: "restricted",
  personalData: true,
  retention: { mode: "retain" },
  legalHold: false,
  staleAfterSeconds: 86_400,
  content: { mediaTypes: ["text/plain"], maxInlineBytes: 1_000_000, maxAssetBytes: 1_000_000 },
  access: { mode: "fixed-policy", rootPolicyId: "policy:company" },
  providerScope: { kind: "workspace", workspaceId: "workspace:oregano-hq" },
};

const sourceBinding: SourceBindingV2 = {
  version: 2,
  contractVersion: "2.0.0",
  sourceId: sourceRequirement.sourceId,
  installationId: "installation:granola",
  connectorId: "oregano/granola",
  connectorVersion: "2.0.0",
  secretRefs: { apiKey: "env:GRANOLA_API_KEY" },
  requiredScopes: ["personal", "public"],
  providerIdentity: { kind: "workspace", workspaceId: "workspace:oregano-hq" },
  state: "active",
  qualification: {
    qualifiedAt: now,
    receiptId: "receipt:old",
    implementationDigest: "digest:connector",
  },
};

test("a Source binding only rotates to a newly qualified active binding for the same provider identity", () => {
  assert.equal(assertPermittedSourceRebinding({
    existingRequirement: sourceRequirement,
    existingBinding: sourceBinding,
    nextRequirement: structuredClone(sourceRequirement),
    nextBinding: structuredClone(sourceBinding),
  }), "unchanged");

  const workspaceBinding: SourceBindingV2 = {
    ...structuredClone(sourceBinding),
    requiredScopes: ["workspace"],
    secretRefs: { apiKey: "env:GRANOLA_WORKSPACE_API_KEY" },
    qualification: { ...sourceBinding.qualification!, receiptId: "receipt:workspace" },
  };
  assert.equal(assertPermittedSourceRebinding({
    existingRequirement: sourceRequirement,
    existingBinding: sourceBinding,
    nextRequirement: structuredClone(sourceRequirement),
    nextBinding: workspaceBinding,
  }), "rebind");

  assert.throws(() => assertPermittedSourceRebinding({
    existingRequirement: sourceRequirement,
    existingBinding: sourceBinding,
    nextRequirement: structuredClone(sourceRequirement),
    nextBinding: { ...workspaceBinding, state: "bound", qualification: undefined },
  }), /newly qualified active binding/);

  assert.throws(() => assertPermittedSourceRebinding({
    existingRequirement: sourceRequirement,
    existingBinding: sourceBinding,
    nextRequirement: structuredClone(sourceRequirement),
    nextBinding: { ...workspaceBinding, providerIdentity: { kind: "workspace", workspaceId: "workspace:other" } },
  }), /cannot change Connector, installation, or provider identity/);
});

test("Knowledge snapshot activation retires the prior snapshot before activating the verified replacement", async () => {
  const statements: string[] = [];
  let isolationLevel: string | undefined;
  const sql = {
    async transaction(
      build: (query: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>) => Array<Promise<Array<Record<string, unknown>>>>,
      options: { isolationLevel: "Serializable" },
    ) {
      isolationLevel = options.isolationLevel;
      const query = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const statement = strings.join("?");
        statements.push(statement);
        return statement.includes("status = 'active'") ? [{ snapshot_hash: "snapshot:new" }] : [{ snapshot_hash: "snapshot:old" }];
      };
      const queries = build(query);
      const results = [];
      for (const queryPromise of queries) results.push(await queryPromise);
      return results;
    },
  };

  const activated = await activateVerifiedKnowledgeSnapshot(
    sql as unknown as Parameters<typeof activateVerifiedKnowledgeSnapshot>[0],
    "snapshot:new",
  );
  assert.equal(activated?.snapshot_hash, "snapshot:new");
  assert.equal(isolationLevel, "Serializable");
  assert.match(statements[0], /status = 'retired'/);
  assert.match(statements[1], /status = 'active'/);
});
