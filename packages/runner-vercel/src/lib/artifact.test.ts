import assert from "node:assert/strict";
import { test } from "node:test";
import { assertArtifactDeploymentEnvironment } from "./artifact.ts";

test("Artifact environment must exactly match the trusted Vercel environment", () => {
  assert.doesNotThrow(() => assertArtifactDeploymentEnvironment("production", "production"));
  assert.doesNotThrow(() => assertArtifactDeploymentEnvironment("preview", "preview"));
  assert.doesNotThrow(() => assertArtifactDeploymentEnvironment("development", "development"));

  assert.throws(
    () => assertArtifactDeploymentEnvironment("production", "preview"),
    /does not match Vercel deployment environment/,
  );
  assert.throws(
    () => assertArtifactDeploymentEnvironment("preview", "production"),
    /does not match Vercel deployment environment/,
  );
});

test("missing or unknown deployment identity fails closed", () => {
  assert.doesNotThrow(() => assertArtifactDeploymentEnvironment("production", undefined));
  assert.throws(
    () => assertArtifactDeploymentEnvironment("preview", undefined),
    /without an explicit deployment environment/,
  );
  assert.throws(
    () => assertArtifactDeploymentEnvironment("preview", "staging"),
    /unknown Vercel deployment environment/,
  );
});
