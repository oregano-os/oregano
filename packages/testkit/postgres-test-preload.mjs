import { neonConfig } from "@neondatabase/serverless";
import { assertIsolatedTestDatabase } from "./postgres-test-bridge.mjs";

assertIsolatedTestDatabase(process.env.DATABASE_URL);
const endpoint = new URL(process.env.COMPANYOS_TEST_SQL_ENDPOINT);
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/sql") {
  throw new Error("The database test bridge must be an explicit loopback HTTP endpoint.");
}
neonConfig.fetchEndpoint = endpoint.href;
