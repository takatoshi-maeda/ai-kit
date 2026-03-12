import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../../types/tool.js";

interface FindFilesOptions {
  workingDir: string;
}

interface WalkEntry {
  relativePath: string;
  type: "file" | "directory";
}

async function walkDirectory(
  rootDir: string,
  currentDir: string,
  entries: WalkEntry[],
  options: { includeHidden: boolean; type: "file" | "directory" | "all"; maxResults?: number },
): Promise<void> {
  const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of dirEntries) {
    if (!options.includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath) || ".";
    const normalizedPath = relativePath.split(path.sep).join("/");

    if (entry.isDirectory()) {
      if (options.type === "directory" || options.type === "all") {
        entries.push({ relativePath: normalizedPath, type: "directory" });
        if (entries.length >= (options.maxResults ?? Infinity)) {
          return;
        }
      }

      await walkDirectory(rootDir, absolutePath, entries, options);
      if (entries.length >= (options.maxResults ?? Infinity)) {
        return;
      }
      continue;
    }

    if (entry.isFile() && (options.type === "file" || options.type === "all")) {
      entries.push({ relativePath: normalizedPath, type: "file" });
      if (entries.length >= (options.maxResults ?? Infinity)) {
        return;
      }
    }
  }
}

export function createFindFilesTool(options: FindFilesOptions): ToolDefinition {
  const workingDir = path.resolve(options.workingDir);

  return {
    name: "find_files",
    description:
      "Recursively search for file or directory paths under the working directory. Matches are based on path text, not file contents.",
    parameters: z.object({
      query: z.string().describe("Substring to match against relative paths"),
      path: z.string().optional().default(".").describe("Directory to search from, relative to the working directory"),
      type: z.enum(["file", "directory", "all"]).optional().default("file").describe("Which entry types to return"),
      caseSensitive: z.boolean().optional().default(false).describe("Whether path matching is case-sensitive"),
      includeHidden: z.boolean().optional().default(false).describe("Whether to include dotfiles and dot-directories"),
      maxResults: z.number().int().positive().optional().describe("Maximum number of matching paths to return"),
    }),
    async execute(params) {
      const searchPath = params.path ?? ".";
      const includeHidden = params.includeHidden ?? false;
      const entryType = params.type ?? "file";
      const caseSensitive = params.caseSensitive ?? false;

      const startDir = path.resolve(workingDir, searchPath);
      if (!startDir.startsWith(workingDir + path.sep) && startDir !== workingDir) {
        throw new Error(`Path traversal detected: ${searchPath}`);
      }

      let stat;
      try {
        stat = await fs.stat(startDir);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Directory not found: ${searchPath}`);
        }
        throw error;
      }

      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${searchPath}`);
      }

      const allEntries: WalkEntry[] = [];
      await walkDirectory(startDir, startDir, allEntries, {
        includeHidden,
        type: entryType,
        maxResults: params.maxResults,
      });

      const normalizedQuery = caseSensitive ? params.query : params.query.toLowerCase();
      const matches = allEntries
        .filter((entry) => {
          const candidate = caseSensitive ? entry.relativePath : entry.relativePath.toLowerCase();
          return candidate.includes(normalizedQuery);
        })
        .slice(0, params.maxResults);

      if (matches.length === 0) {
        return "No matches found.";
      }

      return matches
        .map((entry) => `${entry.type}: ${entry.relativePath}`)
        .join("\n");
    },
  };
}
