import assert from "node:assert/strict";
import { test } from "node:test";
import { isStagedProductionQualificationRequest } from "./deployed-acp-qualification.ts";

test("deployed ACP qualification accepts only the exact staged Production deployment host", () => {
  const environment = {
    VERCEL_ENV: "production",
    VERCEL_URL: "oregano-qualification-abc.vercel.app",
  };
  assert.equal(isStagedProductionQualificationRequest(new Request(
    "https://oregano-qualification-abc.vercel.app/api/builder/qualification",
    { headers: { host: "oregano-qualification-abc.vercel.app" } },
  ), environment), true);
  assert.equal(isStagedProductionQualificationRequest(new Request(
    "https://oregano-hq-companyos.vercel.app/api/builder/qualification",
    { headers: { host: "oregano-hq-companyos.vercel.app" } },
  ), environment), false);
  assert.equal(isStagedProductionQualificationRequest(new Request(
    "https://oregano-qualification-abc.vercel.app/api/builder/qualification",
    { headers: { host: "oregano-qualification-abc.vercel.app" } },
  ), { ...environment, VERCEL_ENV: "preview" }), false);
});
