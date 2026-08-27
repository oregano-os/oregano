import type { KnowledgeBundle, KnowledgeGraphEdge, KnowledgeTraversalResult } from "./contracts.ts";

export function traverseKnowledgeGraph(bundle: KnowledgeBundle, input: {
  path: string;
  direction?: "outbound" | "inbound" | "both";
  maxDepth?: number;
  maxNodes?: number;
}): KnowledgeTraversalResult {
  const direction = input.direction ?? "both";
  const maxDepth = Math.max(0, Math.min(input.maxDepth ?? 2, 5));
  const maxNodes = Math.max(1, Math.min(input.maxNodes ?? 25, 100));
  if (!bundle.documents.some((document) => document.path === input.path)) {
    return { snapshotHash: bundle.bundleHash, startPath: input.path, direction, paths: [], truncated: false, gaps: ["unknown-start-path"] };
  }
  const neighbors = (path: string): Array<{ path: string; via: string }> => {
    const entries: Array<{ path: string; via: string }> = [];
    if (direction !== "inbound") for (const edge of bundle.edges.filter((entry) => entry.from === path)) entries.push({ path: edge.to, via: `${edge.from}->${edge.to}` });
    if (direction !== "outbound") for (const edge of bundle.edges.filter((entry) => entry.to === path)) entries.push({ path: edge.from, via: `${edge.from}->${edge.to}` });
    return entries.sort((a, b) => a.path.localeCompare(b.path) || a.via.localeCompare(b.via));
  };
  const paths: KnowledgeTraversalResult["paths"] = [{ path: input.path, depth: 0 }];
  const seen = new Set([input.path]);
  const queue = [{ path: input.path, depth: 0 }];
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const next of neighbors(current.path)) {
      if (seen.has(next.path)) continue;
      if (paths.length >= maxNodes) { truncated = true; break; }
      seen.add(next.path);
      paths.push({ path: next.path, depth: current.depth + 1, via: next.via });
      queue.push({ path: next.path, depth: current.depth + 1 });
    }
    if (truncated) break;
  }
  return { snapshotHash: bundle.bundleHash, startPath: input.path, direction, paths, truncated, gaps: [] };
}

export const backlinksFor = (edges: readonly KnowledgeGraphEdge[], path: string): string[] => edges
  .filter((edge) => edge.to === path).map((edge) => edge.from).sort();
