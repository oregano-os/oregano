import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default config;
