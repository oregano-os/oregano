export interface CredentialIndicator {
  label: string;
  index: number;
}

const specificPatterns: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:DSA |EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["Stripe secret key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["OpenAI-style secret key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
];
const genericAssignment = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'#]{12,})/gi;
const placeholder = /(?:\$\{|<[^>]+>|change[-_]?me|dummy|example|fake|placeholder|redacted|replace[-_]?me|sample|test[-_]?only)/i;

export function scanCredentialIndicators(content: string): CredentialIndicator[] {
  const findings: CredentialIndicator[] = [];
  for (const [label, expression] of specificPatterns) {
    expression.lastIndex = 0;
    for (const match of content.matchAll(expression)) findings.push({ label, index: match.index });
  }
  genericAssignment.lastIndex = 0;
  for (const match of content.matchAll(genericAssignment)) {
    if (!placeholder.test(match[1])) findings.push({ label: "credential-like assignment", index: match.index });
  }
  return findings.sort((left, right) => left.index - right.index || left.label.localeCompare(right.label));
}
