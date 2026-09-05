import { getToken } from "@vercel/connect";
import type { CompanyRecordSourceBinding } from "../../../records/source-connector.ts";

export const VERCEL_CONNECT_APP_CREDENTIAL_PROVIDER = "vercel-connect-app";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type ConnectTokenResolver = (connector: string) => Promise<string>;

const environmentHandle = (secretRef: string, environment: RuntimeEnvironment): string => {
  const match = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(secretRef);
  if (!match) throw new Error(`Unsupported runtime SecretRef '${secretRef}'`);
  const value = environment[match[1]!];
  if (!value) throw new Error(`Runtime SecretRef '${secretRef}' is unavailable`);
  return value;
};

const defaultConnectTokenResolver: ConnectTokenResolver = async (connector) => await getToken(connector, {
  subject: { type: "app" },
});

/**
 * Resolve one provider credential at the Vercel Runner boundary.
 *
 * The binding retains an env SecretRef in both modes. In direct mode the env
 * value is the credential. In Vercel Connect mode it is only the connector
 * handle; deployment OIDC exchanges that handle for an ephemeral app token.
 */
export async function resolveRecordSourceCredential(
  binding: CompanyRecordSourceBinding,
  environment: RuntimeEnvironment = process.env,
  connectToken: ConnectTokenResolver = defaultConnectTokenResolver,
): Promise<string> {
  const handle = environmentHandle(binding.secret_ref, environment);
  const provider = binding.configuration.credential_provider;
  if (provider === undefined || provider === "direct-env") return handle;
  if (provider !== VERCEL_CONNECT_APP_CREDENTIAL_PROVIDER) {
    throw new Error(`Unsupported Record Source credential provider '${String(provider)}'`);
  }
  if (binding.connector !== "oregano/slack-record-source") {
    throw new Error(`Credential provider '${VERCEL_CONNECT_APP_CREDENTIAL_PROVIDER}' is supported only for the maintained Slack Record Source`);
  }
  const credential = await connectToken(handle);
  if (!credential) throw new Error(`Vercel Connect did not issue a credential for Record Source '${binding.source_id}'`);
  return credential;
}
