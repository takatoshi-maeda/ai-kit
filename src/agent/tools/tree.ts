import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../../types/tool.js";

interface TreeToolOptions {
  workingDir: string;
}

interface TreeEntry {
  name: string;
  absolutePath: string;
  type: "file" | "directory";
}

function formatBranch(prefix: string, isLast: boolean, name: string): string {
  return `${prefix}${isLast ? "└── " : "├── "}${name}`;
}

async function readTreeEntries(
  directory: string,
  options: { includeHidden: boolean; type: "file" | "directory" | "all" },
): Promise<TreeEntry[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => options.includeHidden || !entry.name.startsWith("."))
    .map((entry): TreeEntry => ({
      name: entry.name,
      absolutePath: path.join(directory, entry.name),
      type: entry.isDirectory() ? "directory" : "file",
    }))
    .filter((entry) => options.type === "all" || entry.type === options.type || entry.type === "directory")
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

async function buildTreeLines(
  directory: string,
  prefix: string,
  depth: number,
  state: { remaining: number },
  options: { includeHidden: boolean; maxDepth: number; type: "file" | "directory" | "all" },
): Promise<string[]> {
  if (depth >= options.maxDepth || state.remaining <= 0) {
    return [];
  }

  const entries = await readTreeEntries(directory, options);
  const lines: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    if (state.remaining <= 0) {
      break;
    }

    const entry = entries[index]!;
    const isLast = index === entries.length - 1;

    if (options.type === "directory" && entry.type === "file") {
      continue;
    }

    lines.push(formatBranch(prefix, isLast, entry.name));
    state.remaining -= 1;

    if (entry.type === "directory" && depth + 1 < options.maxDepth && state.remaining > 0) {
      const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
      lines.push(...await buildTreeLines(entry.absolutePath, childPrefix, depth + 1, state, options));
    }
  }

  return lines;
}

export function createTreeTool(options: TreeToolOptions): ToolDefinition {
  const workingDir = path.resolve(options.workingDir);

  return {
    name: "tree",
    description:
      "Render a directory tree under the working directory. Useful for understanding repository structure without reading file contents.",
    parameters: z.object({
      path: z.string().optional().default(".").describe("Directory to render, relative to the working directory"),
      maxDepth: z.number().int().positive().optional().default(3).describe("Maximum directory depth to include"),
      maxResults: z.number().int().positive().optional().default(200).describe("Maximum number of displayed entries"),
      includeHidden: z.boolean().optional().default(false).describe("Whether to include dotfiles and dot-directories"),
      type: z.enum(["file", "directory", "all"]).optional().default("all").describe("Which entry types to display"),
    }),
    async execute(params) {
      const targetPath = params.path ?? ".";
      const maxDepth = params.maxDepth ?? 3;
      const maxResults = params.maxResults ?? 200;
      const includeHidden = params.includeHidden ?? false;
      const entryType = params.type ?? "all";

      const rootDir = path.resolve(workingDir, targetPath);
      if (!rootDir.startsWith(workingDir + path.sep) && rootDir !== workingDir) {
        throw new Error(`Path traversal detected: ${targetPath}`);
      }

      let stat;
      try {
        stat = await fs.stat(rootDir);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Directory not found: ${targetPath}`);
        }
        throw error;
      }

      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${targetPath}`);
      }

      const rootLabel = targetPath === "." ? "." : targetPath.split(path.sep).join("/");
      const state = { remaining: maxResults };
      const childLines = await buildTreeLines(rootDir, "", 0, state, {
        includeHidden,
        maxDepth,
        type: entryType,
      });

      if (childLines.length === 0) {
        return rootLabel;
      }

      return [rootLabel, ...childLines].join("\n");
    },
  };
}
