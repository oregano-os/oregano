export type BuilderAcpProfileId = "claude-code" | "codex";

export interface BuilderAcpProfile {
  readonly id: BuilderAcpProfileId;
  readonly protocol: "acp-v1";
  readonly packageName: string;
  readonly version: string;
  readonly binaryName: string;
}

export const BUILDER_ACP_PROFILES: Readonly<Record<BuilderAcpProfileId, BuilderAcpProfile>> = Object.freeze({
  "claude-code": Object.freeze({
    id: "claude-code",
    protocol: "acp-v1",
    packageName: "@agentclientprotocol/claude-agent-acp",
    version: "0.70.0",
    binaryName: "claude-agent-acp",
  }),
  codex: Object.freeze({
    id: "codex",
    protocol: "acp-v1",
    packageName: "@agentclientprotocol/codex-acp",
    version: "1.6.2",
    binaryName: "codex-acp",
  }),
});

export function resolveBuilderAcpProfile(id: string): BuilderAcpProfile {
  const profile = BUILDER_ACP_PROFILES[id as BuilderAcpProfileId];
  if (!profile) throw new Error(`Unsupported Builder ACP profile '${id}'.`);
  return profile;
}

export function assertBuilderAcpProfilePin(profile: BuilderAcpProfile): void {
  if (profile.protocol !== "acp-v1") throw new Error("Builder profiles must use stable ACP v1.");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(profile.version)) {
    throw new Error(`Builder ACP profile '${profile.id}' must use an exact version.`);
  }
  if (/[~^*]|latest|next/i.test(profile.version)) {
    throw new Error(`Builder ACP profile '${profile.id}' cannot use a floating version.`);
  }
}
