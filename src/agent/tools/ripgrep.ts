import { execFile } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition } from "../../types/tool.js";

function runRg(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("rg", args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // rg exits with code 1 when no matches found — not an error
        if (error.code === 1) {
          resolve("");
          return;
        }
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export function createRipgrepTool(options: {
  workingDir: string;
}): ToolDefinition {
  const { workingDir } = options;

  return {
    name: "Ripgrep",
    description:
      "Search file contents using ripgrep (rg). Returns matching lines with file paths and line numbers.",
    parameters: z.object({
      pattern: z.string().describe("The search pattern (regex supported)"),
      glob: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
      maxResults: z.number().optional().describe("Maximum number of matching lines per file to return"),
      caseSensitive: z.boolean().optional().describe("Whether the search is case-sensitive"),
    }),
    async execute(params) {
      const args: string[] = [
        "--line-number",
        "--no-heading",
        "--color", "never",
      ];

      if (params.caseSensitive === false) {
        args.push("--ignore-case");
      }

      if (params.glob) {
        args.push("--glob", params.glob);
      }

      if (params.maxResults !== undefined) {
        args.push("--max-count", String(params.maxResults));
      }

      args.push("--", params.pattern, ".");

      const output = await runRg(args, workingDir);
      if (!output) {
        return "No matches found.";
      }
      return output;
    },
  };
}
