import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  outputFileTracingIncludes: {
    "/api/builder/worker": [
      "../cli/src/**/*",
      "../capabilities/**/*",
      "../security/**/*",
      "../tool-sdk/**/*",
      "../runtime/**/*",
      "../../docs/governance/core-change-policy.yaml",
      "../../docs/vision.md",
      "../../docs/glossary.md"
    ]
  },
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default config;
