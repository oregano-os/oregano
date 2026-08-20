import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";

export const walkFiles = (root, { include, skip = [] } = {}) => {
  const output = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!include || include(path)) output.push(path);
    }
  };
  walk(root);
  return output;
};

export const relativePath = (root, path) => relative(root, path).replaceAll("\\", "/");

export const parseFrontmatter = (raw, file = "document") => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: null, body: raw, error: null, bodyOffset: 0 };
  try {
    return {
      data: YAML.parse(match[1]),
      body: raw.slice(match[0].length),
      error: null,
      bodyOffset: match[0].split("\n").length - 1,
    };
  } catch (error) {
    return {
      data: null,
      body: raw,
      error: new Error(`${file}: ${error.message.split("\n")[0]}`),
      bodyOffset: 0,
    };
  }
};

export const readDocument = (root, path) => {
  const raw = readFileSync(path, "utf8");
  return { path, relative: relativePath(root, path), raw, ...parseFrontmatter(raw, path) };
};
