import type { Chat } from "chat";
import type { Connector, JsonValue } from "../../../capabilities/contracts.ts";
import type { CompanyOSArtifact, RuntimeConnectorConfiguration } from "../../../companyos-builder/types.ts";
import { CompanyRecordsConnector } from "../../../connectors/company-records.ts";
import { MondayClient } from "../../../connectors/monday/client.ts";
import { MondayWorkItemConnector } from "../../../connectors/monday/connector.ts";
import type { MondayResourceBinding } from "../../../connectors/monday/contracts.ts";
import {
  SlackCommunicationConnector,
  type SlackDestinationBinding,
} from "../../../connectors/slack/communication.ts";
import { CompanyRecordsService } from "../../../records/service.ts";
import { createPostgresCompanyRecordsStore } from "../../../state-postgres/records-store.ts";
import { createPostgresMondayEchoStore } from "../../../state-postgres/monday-echo-store.ts";
import {
  decodeCompanyRecordsRehearsalConfiguration,
  decodeCompanyRecordsRuntimeConfiguration,
  validatedCompanyRecordsSelection,
} from "./company-records-rehearsal.ts";

type JsonObject = Record<string, JsonValue>;

const object = (value: JsonValue | undefined, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
};

const text = (value: JsonValue | undefined, label: string, pattern: RegExp): string => {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
};

const exactKeys = (value: JsonObject, allowed: readonly string[], label: string): void => {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${label} contains unsupported field '${extra[0]}'.`);
};

function resolveEnvironmentSecretRef(value: JsonValue | undefined, environment: NodeJS.ProcessEnv, label: string): string {
  const reference = text(value, label, /^env:[A-Z][A-Z0-9_]{0,127}$/);
  const name = reference.slice(4);
  const resolved = environment[name];
  if (!resolved) throw new Error(`${label} points to unavailable runtime secret '${name}'.`);
  return resolved;
}

function parseCompanyRecordsConfiguration(
  entry: RuntimeConnectorConfiguration,
  artifact: CompanyOSArtifact,
  environment: NodeJS.ProcessEnv,
): CompanyRecordsConnector {
  const configuration = entry.configuration;
  exactKeys(configuration, ["configuration_ref"], `Connector instance '${entry.id}'`);
  const encoded = resolveEnvironmentSecretRef(configuration.configuration_ref, environment, `Connector instance '${entry.id}'.configuration_ref`);
  const recordsConfiguration = artifact.instance.environment === "preview"
    ? decodeCompanyRecordsRehearsalConfiguration(encoded)
    : artifact.instance.environment === "production"
      ? decodeCompanyRecordsRuntimeConfiguration(encoded, "production", String(configuration.configuration_ref).slice(4))
      : (() => { throw new Error(`Company Records runtime Connector is unsupported in environment '${artifact.instance.environment}'.`); })();
  if (recordsConfiguration.instance_id !== artifact.instance.id
    || recordsConfiguration.core.ref !== artifact.provenance.coreCommit
    || recordsConfiguration.workspace.ref !== artifact.provenance.workspaceCommit) {
    throw new Error(`Connector instance '${entry.id}' does not match the immutable Artifact identity.`);
  }
  let registry;
  for (const source of recordsConfiguration.sources) {
    const selected = validatedCompanyRecordsSelection(recordsConfiguration, String(source.id));
    registry = selected.registry;
  }
  if (!registry) throw new Error(`Connector instance '${entry.id}' contains no validated Record Source.`);
  return new CompanyRecordsConnector(new CompanyRecordsService({
    instanceId: artifact.instance.id,
    registry,
    store: createPostgresCompanyRecordsStore(),
    now: () => new Date(),
  }));
}

function parseMondayConfiguration(
  entry: RuntimeConnectorConfiguration,
  artifact: CompanyOSArtifact,
  environment: NodeJS.ProcessEnv,
): MondayWorkItemConnector {
  const configuration = entry.configuration;
  exactKeys(configuration, ["token_ref", "api_version", "actor_id", "resources"], `Connector instance '${entry.id}'`);
  if (!Array.isArray(configuration.resources) || configuration.resources.length === 0 || configuration.resources.length > 20) {
    throw new Error(`Connector instance '${entry.id}' requires between one and twenty Monday resources.`);
  }
  const resources: MondayResourceBinding[] = configuration.resources.map((raw, index) => {
    const value = object(raw, `Connector instance '${entry.id}' resources[${index}]`);
    exactKeys(value, ["id", "board_id", "permission", "fields"], `Connector instance '${entry.id}' resources[${index}]`);
    const fieldsValue = object(value.fields, `Connector instance '${entry.id}' resources[${index}].fields`);
    const fields: Record<string, string> = {};
    for (const [logical, provider] of Object.entries(fieldsValue)) {
      if (!/^[a-z][a-z0-9_-]{0,62}$/.test(logical) || typeof provider !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(provider)) {
        throw new Error(`Connector instance '${entry.id}' contains an invalid Monday field binding.`);
      }
      fields[logical] = provider;
    }
    const permission = text(value.permission, `Connector instance '${entry.id}' resources[${index}].permission`, /^(?:read|read-write)$/) as "read" | "read-write";
    return {
      id: text(value.id, `Connector instance '${entry.id}' resources[${index}].id`, /^[a-z][a-z0-9-]{1,62}$/),
      boardId: text(value.board_id, `Connector instance '${entry.id}' resources[${index}].board_id`, /^\d{1,20}$/),
      permission,
      fields,
    };
  });
  return new MondayWorkItemConnector({
    client: new MondayClient({
      token: resolveEnvironmentSecretRef(configuration.token_ref, environment, `Connector instance '${entry.id}'.token_ref`),
      apiVersion: text(configuration.api_version, `Connector instance '${entry.id}'.api_version`, /^[A-Za-z0-9._-]{1,32}$/),
    }),
    bindings: resources,
    actorId: text(configuration.actor_id, `Connector instance '${entry.id}'.actor_id`, /^[A-Za-z0-9._:-]{1,128}$/),
    instanceId: artifact.instance.id,
    echoStore: createPostgresMondayEchoStore(),
  });
}

function parseSlackConfiguration(
  entry: RuntimeConnectorConfiguration,
  chat: () => Chat,
): SlackCommunicationConnector {
  const configuration = entry.configuration;
  exactKeys(configuration, ["destinations"], `Connector instance '${entry.id}'`);
  if (!Array.isArray(configuration.destinations) || configuration.destinations.length === 0 || configuration.destinations.length > 100) {
    throw new Error(`Connector instance '${entry.id}' requires between one and one hundred Slack destinations.`);
  }
  const bindings: SlackDestinationBinding[] = configuration.destinations.map((raw, index) => {
    const value = object(raw, `Connector instance '${entry.id}' destinations[${index}]`);
    exactKeys(value, ["id", "account_id", "kind", "channel_id", "user_id"], `Connector instance '${entry.id}' destinations[${index}]`);
    const kind = text(value.kind, `Connector instance '${entry.id}' destinations[${index}].kind`, /^(?:channel|direct-message)$/) as "channel" | "direct-message";
    return {
      id: text(value.id, `Connector instance '${entry.id}' destinations[${index}].id`, /^[a-z][a-z0-9-]{1,62}$/),
      accountId: text(value.account_id, `Connector instance '${entry.id}' destinations[${index}].account_id`, /^[A-Za-z0-9._:-]{1,128}$/),
      kind,
      ...(value.channel_id === undefined ? {} : { channelId: text(value.channel_id, `Connector instance '${entry.id}' destinations[${index}].channel_id`, /^[A-Z0-9]{5,32}$/) }),
      ...(value.user_id === undefined ? {} : { userId: text(value.user_id, `Connector instance '${entry.id}' destinations[${index}].user_id`, /^[A-Z0-9]{5,32}$/) }),
    };
  });
  return new SlackCommunicationConnector({
    bindings,
    publisher: {
      async publishChannel(channelId, content) {
        const message = await chat().channel(`slack:${channelId}`).post(content);
        return { messageId: message.id, threadReference: message.threadId, publishedAt: message.metadata.dateSent.toISOString() };
      },
      async publishDirect(userId, content) {
        const thread = await chat().openDM(userId);
        const message = await thread.post(content);
        return { messageId: message.id, threadReference: message.threadId, publishedAt: message.metadata.dateSent.toISOString() };
      },
    },
  });
}

export function createConfiguredRuntimeConnectors(args: {
  artifact: CompanyOSArtifact;
  environment?: NodeJS.ProcessEnv;
  chat: () => Chat;
}): Connector[] {
  const environment = args.environment ?? process.env;
  const connectors: Connector[] = [];
  const instanceIds = new Set<string>();
  for (const entry of args.artifact.connectors ?? []) {
    if (instanceIds.has(entry.id)) throw new Error(`Duplicate runtime Connector instance '${entry.id}'.`);
    instanceIds.add(entry.id);
    if (entry.connector === "oregano/company-records" && entry.connectorVersion === "0.1.0") {
      connectors.push(parseCompanyRecordsConfiguration(entry, args.artifact, environment));
      continue;
    }
    if (entry.connector === "oregano/monday-work-items" && entry.connectorVersion === "0.1.0") {
      connectors.push(parseMondayConfiguration(entry, args.artifact, environment));
      continue;
    }
    if (entry.connector === "oregano/slack-communication" && entry.connectorVersion === "0.1.0") {
      connectors.push(parseSlackConfiguration(entry, args.chat));
      continue;
    }
    throw new Error(`Unsupported runtime Connector '${entry.connector}@${entry.connectorVersion}' in instance '${entry.id}'.`);
  }
  return connectors;
}
