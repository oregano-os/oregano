const SETUP_NONCE = /\bSetup-Test\s+(oregano-[0-9a-f]{12})\b/i;

export function setupVerificationResponse(text: string): string | null {
  const nonce = text.match(SETUP_NONCE)?.[1]?.toLowerCase();
  return nonce ? `Setup-Test ${nonce} successful.` : null;
}

export function setupVerificationPrompt(expectedResponse: string): string {
  return `This is a CompanyOS installation probe. Reply with exactly this single line and no quotation marks or additional text:\n${expectedResponse}`;
}

export interface SetupExchange {
  version: 1;
  artifact_hash: string;
  core_commit: string;
  workspace_commit: string;
  principal: string;
  message_id: string;
  conversation_key: string;
  response_id: string;
  model_route: string;
  model: string;
  delivered_at: string;
}

export function setupExchangeKey(artifactHash: string, principal: string): string {
  if (!/^[0-9a-f]{64}$/.test(artifactHash) || !/^slack:[A-Z0-9]+:[A-Z0-9]+$/.test(principal)) throw new Error('Invalid setup exchange identity.');
  return `setup-exchange:${artifactHash}:${principal}`;
}

export function matchesSetupExchange(value: unknown, expected: {
  artifact_hash: string; core_commit: string; workspace_commit: string;
  principal: string; model_route: string; model: string; since: string;
}): value is SetupExchange {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as SetupExchange;
  return receipt.version === 1 && receipt.artifact_hash === expected.artifact_hash
    && receipt.core_commit === expected.core_commit && receipt.workspace_commit === expected.workspace_commit
    && receipt.principal === expected.principal && receipt.model_route === expected.model_route && receipt.model === expected.model
    && Boolean(receipt.response_id && receipt.message_id && receipt.conversation_key)
    && Number.isFinite(Date.parse(expected.since)) && Date.parse(receipt.delivered_at) >= Date.parse(expected.since)
    && Date.parse(receipt.delivered_at) <= Date.now() + 60_000;
}
