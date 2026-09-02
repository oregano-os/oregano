import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERCEL_NEON_RECORD_SOURCE_PROFILE_ID = "vercel-neon";

const clean = (value) => String(value ?? "").normalize("NFC").trim();
const safeDiagnostic = (value, secret = "") => {
  let output = clean(value)
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/xox[a-z0-9](?:[.-][A-Za-z0-9-]+)+/gi, "[REDACTED_PROVIDER_CREDENTIAL]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]");
  if (secret) output = output.replaceAll(secret, "[REDACTED_REHEARSAL_BEARER]");
  return output.length <= 2400 ? output : `${output.slice(0, 1200)}\n...[safe diagnostic truncated]...\n${output.slice(-1200)}`;
};

const curlConfigValue = (value) => String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "").replaceAll("\n", "\\n");

export const createRecordSourceCommandExecutor = () => ({
  run(file, args, options = {}) {
    const result = spawnSync(file, args, {
      cwd: options.cwd,
      input: options.input,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: options.env ?? process.env,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
  },
});

const defaultVercelCli = resolve(fileURLToPath(new URL("../../../../../node_modules/.bin/vercel", import.meta.url)));

export function validateVercelNeonRecordSourceProfileInput({ endpoint, runtimeScope, runtimeProject }) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/records/rehearsal") {
    throw new Error("The vercel-neon profile requires an exact HTTPS Preview endpoint ending in /api/records/rehearsal without credentials, query, or fragment.");
  }
  for (const [value, label] of [[runtimeScope, "Vercel scope"], [runtimeProject, "Vercel project"]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(clean(value))) throw new Error(`${label} is invalid.`);
  }
  return { endpoint: url.toString(), runtimeScope: clean(runtimeScope), runtimeProject: clean(runtimeProject) };
}

export function createVercelNeonRecordSourceProfile({ executor = createRecordSourceCommandExecutor(), vercelCli = defaultVercelCli, environment = process.env } = {}) {
  return Object.freeze({
    id: VERCEL_NEON_RECORD_SOURCE_PROFILE_ID,
    runtime_host: "vercel",
    state_store: "neon-postgres",
    required_preview_environment(configuration) {
      const providerReferences = [...new Set(configuration.bindings.map((entry) => entry.binding.secret_ref))];
      return [
        { name: "DATABASE_URL", kind: "sensitive", owner: "instance", purpose: "Isolated Neon/Postgres Preview branch connection" },
        ...providerReferences.map((reference) => ({ name: reference.replace(/^env:/, ""), kind: "sensitive", owner: "instance", purpose: "Record Source Connector credential" })),
        { name: "COMPANYOS_RECORDS_REHEARSAL_CONFIG_GZIP_BASE64", kind: "sensitive", owner: "workbench-rehearsal", purpose: "Credential-free frozen rehearsal configuration" },
        { name: "COMPANYOS_RECORDS_REHEARSAL_SECRET", kind: "sensitive", owner: "workbench-rehearsal", purpose: "Short-lived operator bearer" },
      ];
    },
    async request({ endpoint, runtimeScope, body }) {
      const secret = environment.COMPANYOS_RECORDS_REHEARSAL_SECRET;
      if (!secret || secret.length < 24 || secret.length > 512 || /[\u0000-\u001f\u007f]/.test(secret)) {
        throw new Error("COMPANYOS_RECORDS_REHEARSAL_SECRET must be injected into this one local process and must match the short-lived Preview bearer; it is never stored.");
      }
      const input = [
        'request = "POST"',
        `header = "${curlConfigValue(`Authorization: Bearer ${secret}`)}"`,
        'header = "Content-Type: application/json"',
        `data = "${curlConfigValue(JSON.stringify(body))}"`,
        "",
      ].join("\n");
      const target = new URL(endpoint);
      const result = executor.run(vercelCli, ["curl", target.pathname, "--deployment", target.origin, "--scope", runtimeScope, "--", "--config", "-"], { input });
      if (result.status !== 0) throw new Error(`Vercel Preview request failed: ${safeDiagnostic(result.stderr || result.stdout, secret)}`);
      let parsed;
      try { parsed = JSON.parse(result.stdout); }
      catch { throw new Error(`Vercel Preview returned malformed JSON: ${safeDiagnostic(result.stdout, secret)}`); }
      if (!parsed?.ok) throw new Error(`Vercel Preview rejected the request: ${safeDiagnostic(JSON.stringify(parsed), secret)}`);
      return parsed;
    },
  });
}

export const VERCEL_NEON_RECORD_SOURCE_PROFILE = createVercelNeonRecordSourceProfile();
