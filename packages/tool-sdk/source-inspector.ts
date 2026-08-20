import { stripTypeScriptTypes } from "node:module";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

export interface SourceInspection {
  diagnostics: string[];
  compiledSource?: string;
}

const forbiddenIdentifiers = new Set([
  "process", "fetch", "require", "global", "globalThis", "eval", "Function",
  "WebAssembly", "WebSocket", "XMLHttpRequest", "Deno", "Bun", "constructor",
  "prototype", "__proto__", "Reflect", "Proxy",
]);

interface Token {
  kind: SyntaxKind;
  text: string;
  value: string;
  start: number;
}

const scanTokens = (source: string): Token[] => {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: Token[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue(), start: scanner.getTokenStart() });
  }
  return tokens;
};

export function inspectAndCompileCompanyTool(source: string, file = "execute.ts"): SourceInspection {
  const diagnostics: string[] = [];
  if (Buffer.byteLength(source, "utf8") > 64 * 1024) diagnostics.push(`${file}: Company Tool source exceeds 64 KiB.`);
  let tokens: Token[] = [];
  try {
    tokens = scanTokens(source);
  } catch (error) {
    diagnostics.push(`${file}: TypeScript scanner failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const positionOf = (token: Token) => {
    const before = source.slice(0, token.start);
    const line = before.split("\n").length;
    const column = token.start - before.lastIndexOf("\n");
    return `${file}:${line}:${column}`;
  };
  let hasDefaultDefinition = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === SyntaxKind.ImportKeyword) {
      const allowed = tokens[index + 1]?.kind === SyntaxKind.OpenBraceToken &&
        tokens[index + 2]?.kind === SyntaxKind.Identifier && tokens[index + 2]?.value === "defineCompanyTool" &&
        tokens[index + 3]?.kind === SyntaxKind.CloseBraceToken &&
        tokens[index + 4]?.kind === SyntaxKind.FromKeyword &&
        tokens[index + 5]?.kind === SyntaxKind.StringLiteral && tokens[index + 5]?.value === "@companyos/tool-sdk";
      if (!allowed) diagnostics.push(`${positionOf(token)}: only the named defineCompanyTool import from '@companyos/tool-sdk' is allowed.`);
    }
    const forbiddenName = forbiddenIdentifiers.has(token.text)
      ? token.text
      : token.kind === SyntaxKind.Identifier && forbiddenIdentifiers.has(token.value) ? token.value : undefined;
    if (forbiddenName) {
      diagnostics.push(`${positionOf(token)}: identifier '${forbiddenName}' is forbidden in Company Tools.`);
    }
    if (token.kind === SyntaxKind.ExportKeyword && tokens[index + 1]?.kind === SyntaxKind.DefaultKeyword &&
      tokens[index + 2]?.kind === SyntaxKind.Identifier && tokens[index + 2]?.value === "defineCompanyTool" &&
      tokens[index + 3]?.kind === SyntaxKind.OpenParenToken) hasDefaultDefinition = true;
  }
  if (!hasDefaultDefinition) diagnostics.push(`${file}: default export must call defineCompanyTool({...}).`);
  if (diagnostics.length > 0) return { diagnostics };
  try {
    const compiledSource = stripTypeScriptTypes(source, { mode: "strip", sourceMap: false });
    return { diagnostics, compiledSource };
  } catch (error) {
    return { diagnostics: [`${file}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
