import * as fs from "node:fs/promises";
import path from "node:path";
import type { LLMToolCall, LLMToolResult, OpenAINativeApplyPatchTool } from "../../types/tool.js";
const OPENAI_APPLY_PATCH_DEBUG_ENV = "CODEFLEET_DEBUG_OPENAI_APPLY_PATCH";

type PatchOperation =
  | { type: "raw_patch"; patch: string }
  | { type: "create_file"; path: string; diff: string }
  | { type: "update_file"; path: string; diff: string }
  | { type: "delete_file"; path: string };

export async function executeOpenAIApplyPatchToolCall(
  toolCall: LLMToolCall,
  tool: OpenAINativeApplyPatchTool,
): Promise<LLMToolResult> {
  try {
    debugOpenAIApplyPatch("runtime.execute.start", {
      toolCallId: toolCall.id,
      toolArguments: toolCall.arguments,
      allowedPaths: tool.allowedPaths,
    });
    const operation = parsePatchOperation(toolCall.arguments);
    debugOpenAIApplyPatch("runtime.execute.parsed", {
      toolCallId: toolCall.id,
      operation,
    });
    if (operation.type === "raw_patch") {
      const outputs = await applyRawPatch(operation.patch, tool.allowedPaths);
      const output = outputs.join("\n");
      debugOpenAIApplyPatch("runtime.execute.raw_patch.completed", {
        toolCallId: toolCall.id,
        outputs,
      });
      return {
        toolCallId: toolCall.id,
        content: output,
        extra: {
          providerRaw: {
            provider: "openai",
            inputItems: [
              {
                type: "apply_patch_call_output",
                call_id: toolCall.id,
                status: "completed",
                output,
              },
            ],
          },
        },
      };
    }
    const absolutePath = resolveAllowedPath(operation.path, tool.allowedPaths);

    let output: string;
    switch (operation.type) {
      case "create_file": {
        const content = applyDiff("", operation.diff, "create");
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, "utf8");
        output = `Created ${operation.path}`;
        break;
      }
      case "update_file": {
        const current = await fs.readFile(absolutePath, "utf8");
        const content = applyDiff(current, operation.diff, "update");
        await fs.writeFile(absolutePath, content, "utf8");
        output = `Updated ${operation.path}`;
        break;
      }
      case "delete_file":
        await fs.unlink(absolutePath);
        output = `Deleted ${operation.path}`;
        break;
    }
    debugOpenAIApplyPatch("runtime.execute.operation.completed", {
      toolCallId: toolCall.id,
      operation,
      output,
    });

    return {
      toolCallId: toolCall.id,
      content: output,
      extra: {
        providerRaw: {
          provider: "openai",
          inputItems: [
            {
              type: "apply_patch_call_output",
              call_id: toolCall.id,
              status: "completed",
              output,
            },
          ],
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugOpenAIApplyPatch("runtime.execute.failed", {
      toolCallId: toolCall.id,
      toolArguments: toolCall.arguments,
      error: message,
    });
    return {
      toolCallId: toolCall.id,
      content: message,
      isError: true,
      extra: {
        providerRaw: {
          provider: "openai",
          inputItems: [
            {
              type: "apply_patch_call_output",
              call_id: toolCall.id,
              status: "failed",
              output: message,
            },
          ],
        },
      },
    };
  }
}

function parsePatchOperation(argumentsValue: unknown): PatchOperation {
  const patch = extractPatchText(argumentsValue);
  if (patch) {
    debugOpenAIApplyPatch("runtime.parse.raw_patch", {
      source: summarizePatchArguments(argumentsValue),
    });
    return { type: "raw_patch", patch };
  }
  const asRecord = isRecord(argumentsValue) ? argumentsValue : {};
  const operation = isRecord(asRecord.operation) ? asRecord.operation : asRecord;
  const type = operation.type;
  const targetPath = operation.path;
  if (typeof type !== "string" || typeof targetPath !== "string") {
    debugOpenAIApplyPatch("runtime.parse.missing_operation_fields", {
      argumentsValue,
      operationCandidate: operation,
    });
    throw new Error("apply_patch call is missing operation.type or operation.path");
  }
  if (type === "delete_file") {
    return { type, path: targetPath };
  }
  const diff = operation.diff;
  if (typeof diff !== "string") {
    debugOpenAIApplyPatch("runtime.parse.missing_diff", {
      type,
      path: targetPath,
      operationCandidate: operation,
    });
    throw new Error(`apply_patch ${type} is missing operation.diff`);
  }
  if (type === "create_file" || type === "update_file") {
    return { type, path: targetPath, diff };
  }
  throw new Error(`Unsupported apply_patch operation type: ${type}`);
}

function extractPatchText(argumentsValue: unknown): string | null {
  if (typeof argumentsValue === "string" && argumentsValue.includes("*** Begin Patch")) {
    return argumentsValue;
  }

  if (!isRecord(argumentsValue)) {
    return null;
  }

  if (typeof argumentsValue.patch === "string" && argumentsValue.patch.includes("*** Begin Patch")) {
    return argumentsValue.patch;
  }

  if (typeof argumentsValue.input === "string" && argumentsValue.input.includes("*** Begin Patch")) {
    return argumentsValue.input;
  }

  if (Array.isArray(argumentsValue.input)) {
    for (const entry of argumentsValue.input) {
      const nested = extractPatchText(entry);
      if (nested) {
        return nested;
      }
    }
  }

  if (Array.isArray(argumentsValue.content)) {
    for (const entry of argumentsValue.content) {
      const nested = extractPatchText(entry);
      if (nested) {
        return nested;
      }
    }
  }

  if (typeof argumentsValue.text === "string" && argumentsValue.text.includes("*** Begin Patch")) {
    return argumentsValue.text;
  }

  const values = Object.values(argumentsValue);
  for (const value of values) {
    const nested = extractPatchText(value);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function summarizePatchArguments(argumentsValue: unknown): Record<string, unknown> {
  if (typeof argumentsValue === "string") {
    return {
      kind: "string",
      hasBeginPatch: argumentsValue.includes("*** Begin Patch"),
      length: argumentsValue.length,
      preview: previewString(argumentsValue),
    };
  }
  return {
    kind: Array.isArray(argumentsValue) ? "array" : typeof argumentsValue,
    value: argumentsValue,
  };
}

function previewString(value: string): string {
  if (value.length <= 240) {
    return value;
  }
  return `${value.slice(0, 240)}...[truncated ${value.length - 240} chars]`;
}

function debugOpenAIApplyPatch(stage: string, payload: Record<string, unknown>): void {
  const envValue = process.env[OPENAI_APPLY_PATCH_DEBUG_ENV]?.trim().toLowerCase();
  if (envValue !== "1" && envValue !== "true") {
    return;
  }
  console.error(
    `[ai-kit:openai:apply_patch] stage=${stage} payload=${safeSerializeForDebug(payload)}`,
  );
}

function safeSerializeForDebug(value: unknown): string {
  try {
    return JSON.stringify(value, createDebugReplacer());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ serializationError: message });
  }
}

function createDebugReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "string" && value.length > 2_000) {
      return `${value.slice(0, 2_000)}...[truncated ${value.length - 2_000} chars]`;
    }
    if (value && typeof value === "object") {
      if (seen.has(value as object)) {
        return "[circular]";
      }
      seen.add(value as object);
    }
    return value;
  };
}

async function applyRawPatch(patch: string, allowedPaths: string[]): Promise<string[]> {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("apply_patch patch must start with *** Begin Patch");
  }

  const outputs: string[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line === "*** End Patch") {
      return outputs;
    }

    if (line.startsWith("*** Update File: ")) {
      const targetPath = line.slice("*** Update File: ".length);
      const absolutePath = resolveAllowedPath(targetPath, allowedPaths);
      index += 1;
      const patchLines: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (
          candidate === "*** End Patch" ||
          candidate.startsWith("*** Update File: ") ||
          candidate.startsWith("*** Add File: ") ||
          candidate.startsWith("*** Delete File: ")
        ) {
          break;
        }
        patchLines.push(candidate);
        index += 1;
      }
      const current = await fs.readFile(absolutePath, "utf8");
      const next = applyDiff(current, patchLines.join("\n"), "update");
      await fs.writeFile(absolutePath, next, "utf8");
      outputs.push(`Updated ${targetPath}`);
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const targetPath = line.slice("*** Add File: ".length);
      const absolutePath = resolveAllowedPath(targetPath, allowedPaths);
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (
          candidate === "*** End Patch" ||
          candidate.startsWith("*** Update File: ") ||
          candidate.startsWith("*** Add File: ") ||
          candidate.startsWith("*** Delete File: ")
        ) {
          break;
        }
        if (!candidate.startsWith("+")) {
          throw new Error(`Invalid add-file patch line: ${candidate}`);
        }
        contentLines.push(candidate.slice(1));
        index += 1;
      }
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, joinLines(contentLines, true), "utf8");
      outputs.push(`Created ${targetPath}`);
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const targetPath = line.slice("*** Delete File: ".length);
      const absolutePath = resolveAllowedPath(targetPath, allowedPaths);
      await fs.unlink(absolutePath);
      outputs.push(`Deleted ${targetPath}`);
      index += 1;
      continue;
    }

    throw new Error(`Unsupported apply_patch directive: ${line}`);
  }

  throw new Error("apply_patch patch must end with *** End Patch");
}

function resolveAllowedPath(targetPath: string, allowedPaths: string[]): string {
  const workspaceRoot = process.cwd();
  const absoluteTarget = path.resolve(workspaceRoot, targetPath);
  const relativeTarget = path.relative(workspaceRoot, absoluteTarget);

  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(`Path escapes workspace root: ${targetPath}`);
  }

  const isAllowed = allowedPaths.some((allowedPath) => {
    const absoluteAllowed = path.resolve(workspaceRoot, allowedPath);
    const relativeToAllowed = path.relative(absoluteAllowed, absoluteTarget);
    return relativeToAllowed === "" || (!relativeToAllowed.startsWith("..") && !path.isAbsolute(relativeToAllowed));
  });

  if (!isAllowed) {
    throw new Error(`Path is outside the allowed apply_patch scope: ${targetPath}`);
  }

  return absoluteTarget;
}

// This implements a small V4A-compatible subset that is sufficient for
// targeted create/update file patches emitted by GPT-style coding models.
export function applyDiff(
  currentContent: string,
  diff: string,
  mode: "create" | "update" = "update",
): string {
  const normalizedCurrent = splitLines(currentContent);
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const hunks = collectHunks(lines);

  if (mode === "create" && hunks.length === 0) {
    return diff;
  }

  const output: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const anchor = findHunkStart(normalizedCurrent, hunk, cursor);
    if (anchor < 0) {
      throw new Error(`Error: Invalid Context:\n${hunk.header}`);
    }
    output.push(...normalizedCurrent.slice(cursor, anchor));
    for (const line of hunk.lines) {
      if (line.kind === " " || line.kind === "+") {
        output.push(line.value);
      }
    }
    cursor = anchor + hunk.lines.filter((line) => line.kind !== "+").length;
  }

  output.push(...normalizedCurrent.slice(cursor));
  return joinLines(output, currentContent.endsWith("\n") || diff.endsWith("\n"));
}

function collectHunks(lines: string[]): Array<{
  header: string;
  lines: Array<{ kind: " " | "+" | "-"; value: string }>;
}> {
  const hunks: Array<{
    header: string;
    lines: Array<{ kind: " " | "+" | "-"; value: string }>;
  }> = [];
  let currentHunk: { header: string; lines: Array<{ kind: " " | "+" | "-"; value: string }> } | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) {
      continue;
    }
    const prefix = line[0];
    if (prefix === " " || prefix === "+" || prefix === "-") {
      currentHunk.lines.push({ kind: prefix, value: line.slice(1) });
    }
  }

  return hunks;
}

function findHunkStart(
  currentLines: string[],
  hunk: { lines: Array<{ kind: " " | "+" | "-"; value: string }> },
  minIndex: number,
): number {
  const context = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.value);
  if (context.length === 0) {
    return minIndex;
  }

  for (let index = minIndex; index <= currentLines.length - context.length; index++) {
    let matches = true;
    for (let offset = 0; offset < context.length; offset++) {
      if (currentLines[index + offset] !== context[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return index;
    }
  }

  return -1;
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n").filter((_, index, parts) => !(index === parts.length - 1 && parts[index] === ""));
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  const text = lines.join("\n");
  return trailingNewline ? `${text}\n` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
