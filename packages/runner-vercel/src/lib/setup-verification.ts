const SETUP_NONCE = /\bSetup-Test\s+(oregano-[0-9a-f]{12})\b/i;

export function setupVerificationResponse(text: string): string | null {
  const nonce = text.match(SETUP_NONCE)?.[1]?.toLowerCase();
  return nonce ? `Setup-Test ${nonce} successful.` : null;
}
