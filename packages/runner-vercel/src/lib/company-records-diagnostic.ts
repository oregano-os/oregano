/** Restricted to an already authenticated Records operator; never log this text. */
export function recordsOperatorDiagnostic(error: unknown, environment: Readonly<Record<string, string | undefined>> = process.env): { message: string } {
  if (!(error instanceof Error) || typeof error.message !== "string") return { message: "Unexpected Records operation failure." };
  if (error.message.length > 65536) return { message: "Records diagnostic exceeded its size limit; retain the error digest." };
  let message = error.message;
  const secrets = Object.entries(environment).filter(([key, value]) =>
    /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL|CREDENTIAL|AUTHORIZATION|COOKIE/.test(key) && value && value.length >= 8)
    .flatMap(([, value]) => [value!, encodeURIComponent(value!), JSON.stringify(value!).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) message = message.split(secret).join("[redacted]");
  message = message
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/gi, "[redacted credentials]@")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]+)/g, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  return { message: message.slice(0, 1500) };
}
