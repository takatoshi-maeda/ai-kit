import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../../types/tool.js";

function safePath(workingDir: string, filePath: string, allowedPaths?: string[]): string {
  const resolved = path.resolve(workingDir, filePath);

  if (allowedPaths && allowedPaths.length > 0) {
    const allowed = allowedPaths.some((ap) => {
      const abs = path.resolve(workingDir, ap);
      return resolved === abs || resolved.startsWith(abs + path.sep);
    });
    if (!allowed) {
      throw new Error(`Path is outside allowed directories: ${filePath}`);
    }
  } else {
    if (!resolved.startsWith(workingDir + path.sep) && resolved !== workingDir) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
  }

  return resolved;
}

export function createFileTools(options: {
  workingDir: string;
  allowedPaths?: string[];
}): ToolDefinition[] {
  const { workingDir, allowedPaths } = options;
  const absWorkingDir = path.resolve(workingDir);

  const readFile: ToolDefinition = {
    name: "ReadFile",
    description: "Read the contents of a file at the given path.",
    parameters: z.object({
      path: z.string().describe("The file path to read, relative to the working directory"),
    }),
    async execute(params) {
      const full = safePath(absWorkingDir, params.path, allowedPaths);
      try {
        return await fs.readFile(full, "utf-8");
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File not found: ${params.path}`);
        }
        throw err;
      }
    },
  };

  const writeFile: ToolDefinition = {
    name: "WriteFile",
    description: "Write content to a file at the given path. Creates parent directories if needed.",
    parameters: z.object({
      path: z.string().describe("The file path to write, relative to the working directory"),
      content: z.string().describe("The content to write to the file"),
    }),
    async execute(params) {
      const full = safePath(absWorkingDir, params.path, allowedPaths);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, params.content, "utf-8");
      return `File written: ${params.path}`;
    },
  };

  const listDirectory: ToolDefinition = {
    name: "ListDirectory",
    description: "List files and directories at the given path.",
    parameters: z.object({
      path: z.string().describe("The directory path to list, relative to the working directory").default("."),
    }),
    async execute(params) {
      const full = safePath(absWorkingDir, params.path, allowedPaths);
      try {
        const entries = await fs.readdir(full, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
        }));
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Directory not found: ${params.path}`);
        }
        throw err;
      }
    },
  };

  const makeDirectory: ToolDefinition = {
    name: "MakeDirectory",
    description: "Create a directory at the given path, including any necessary parent directories.",
    parameters: z.object({
      path: z.string().describe("The directory path to create, relative to the working directory"),
    }),
    async execute(params) {
      const full = safePath(absWorkingDir, params.path, allowedPaths);
      await fs.mkdir(full, { recursive: true });
      return `Directory created: ${params.path}`;
    },
  };

  return [readFile, writeFile, listDirectory, makeDirectory];
}
