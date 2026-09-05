import { createServer } from "node:http";
import pg from "pg";

/** Test infrastructure only. Production stores still use the real Neon driver. */
export function assertIsolatedTestDatabase(connectionString) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || url.pathname !== "/companyos_test" || url.username !== "companyos_test") {
    throw new Error("Database tests require loopback 127.0.0.1 and database/user companyos_test; Company Instance URLs are refused.");
  }
  return url;
}

export async function startPostgresTestBridge(connectionString) {
  assertIsolatedTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString, max: 12, connectionTimeoutMillis: 5_000 });
  await pool.query("select 1");
  const server = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/sql"
      || request.headers["neon-connection-string"] !== connectionString) {
      json(403, { message: "Unrecognized test database request" });
      return;
    }
    let client;
    let transaction = false;
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4 * 1024 * 1024) throw new Error("Test SQL request exceeds 4 MiB");
      }
      const payload = JSON.parse(body);
      const queries = payload.queries ?? [payload];
      if (!Array.isArray(queries) || !queries.length) throw new Error("A query is required");
      client = await pool.connect();
      if (payload.queries) {
        const isolation = request.headers["neon-batch-isolation-level"] ?? "ReadCommitted";
        const levels = { ReadCommitted: "READ COMMITTED", RepeatableRead: "REPEATABLE READ", Serializable: "SERIALIZABLE" };
        if (!Object.hasOwn(levels, isolation)) throw new Error("Unsupported isolation level");
        const readOnly = request.headers["neon-batch-read-only"] === "true";
        const deferrable = request.headers["neon-batch-deferrable"] === "true";
        await client.query(`BEGIN ISOLATION LEVEL ${levels[isolation]} ${readOnly ? "READ ONLY" : "READ WRITE"} ${deferrable ? "DEFERRABLE" : "NOT DEFERRABLE"}`);
        transaction = true;
      }
      const results = [];
      for (const query of queries) {
        if (typeof query.query !== "string" || !Array.isArray(query.params)) throw new Error("Invalid SQL envelope");
        const result = await client.query({ text: query.query, values: query.params, rowMode: "array",
          types: { getTypeParser: () => (value) => value } });
        if (Array.isArray(result)) throw new Error("Use a transaction for multiple SQL statements");
        results.push({ fields: result.fields, rows: result.rows, command: result.command, rowCount: result.rowCount });
      }
      if (transaction) await client.query("COMMIT");
      transaction = false;
      json(200, payload.queries ? { results } : results[0]);
    } catch (error) {
      if (transaction) await client.query("ROLLBACK").catch(() => {});
      // Do not include query text, values or connection details in diagnostics.
      json(400, { message: error.message, code: error.code, constraint: error.constraint,
        schema: error.schema, table: error.table, column: error.column });
    } finally {
      client?.release();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/sql`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}
