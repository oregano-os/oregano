import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { protectProductionWorker } from "./production-worker-gate.ts";

const request = () => new Request("https://staged.example.invalid/api/builder/worker");
const production = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_candidate", VERCEL_PROJECT_PRODUCTION_URL: "live.example.invalid" };

test("scheduled work waits for the exact deployment served by production", async () => {
  let effects = 0;
  let liveId = "dpl_previous";
  const guarded = protectProductionWorker(async () => { effects++; return Response.json({ ok: true }); }, {
    environment: production,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://live.example.invalid/api/health");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.headers, undefined);
      return Response.json({ ok: true, deploymentId: liveId });
    },
  });
  assert.equal((await guarded(request())).status, 409);
  assert.equal(effects, 0);
  liveId = "dpl_candidate";
  assert.equal((await guarded(request())).status, 200);
  assert.equal(effects, 1);
  liveId = "dpl_newer";
  assert.equal((await guarded(request())).status, 409);
  assert.equal(effects, 1);
});

test("unverified production health never invokes the worker", async () => {
  let effects = 0;
  const handler = async () => { effects++; return Response.json({ ok: true }); };
  for (const fetcher of [
    async () => { throw new Error("network unavailable"); },
    async () => new Response("", { status: 503 }),
    async () => Response.json({ ok: true }),
    async () => Response.json({ ok: false, deploymentId: "dpl_candidate" }),
  ]) {
    assert.equal((await protectProductionWorker(handler, { environment: production, fetch: fetcher })(request())).status, 503);
  }
  assert.equal((await protectProductionWorker(handler, { environment: { VERCEL_ENV: "production" } })(request())).status, 503);
  assert.equal(effects, 0);
});

test("the exact release binding takes precedence over the generated domain", async () => {
  const environment = { ...production, COMPANYOS_BUILDER_RELEASE_BINDING_BASE64: Buffer.from(JSON.stringify({ productionUrl: "https://company.example.invalid" })).toString("base64") };
  const guarded = protectProductionWorker(async () => new Response(), { environment, fetch: async (url) => {
    assert.equal(String(url), "https://company.example.invalid/api/health");
    return Response.json({ ok: true, deploymentId: "dpl_candidate" });
  } });
  assert.equal((await guarded(request())).status, 200);
  environment.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64 = "not-json";
  assert.equal((await guarded(request())).status, 503);
});

test("local and isolated Preview workers retain their existing authorization", async () => {
  for (const environment of [{}, { VERCEL_ENV: "preview" }]) {
    assert.equal((await protectProductionWorker(async () => new Response(null, { status: 401 }), { environment })(request())).status, 401);
  }
});

test("every maintained scheduled route cold-starts without local checkout metadata and blocks before effects", async () => {
  const originalRead = fs.readFileSync;
  const originalFetch = globalThis.fetch;
  const before = { VERCEL_ENV: process.env.VERCEL_ENV, VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID, VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL, COMPANYOS_BUILDER_RELEASE_BINDING_BASE64: process.env.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64 };
  const crons = JSON.parse(originalRead(new URL("../../vercel.json", import.meta.url), "utf8")).crons;
  fs.readFileSync = ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    const name = String(path);
    if (!name.includes("/node_modules/") && (name.includes("/cli/") || name.endsWith("/package.json"))) throw new Error("Hosted startup attempted local Workbench metadata: " + name);
    return (originalRead as Function)(path, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  Object.assign(process.env, production);
  delete process.env.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64;
  globalThis.fetch = async () => Response.json({ ok: true, deploymentId: "dpl_previous" });
  try {
    for (const cron of crons) {
      const route = await import(new URL(`../app${cron.path}/route.ts`, import.meta.url).href);
      assert.equal((await route.GET(request())).status, 409, cron.path);
      if (route.POST) assert.equal((await route.POST(request())).status, 409, cron.path + " POST");
    }
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
