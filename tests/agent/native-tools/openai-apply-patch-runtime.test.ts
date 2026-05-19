import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeOpenAIApplyPatchToolCall } from "../../../src/agent/native-tools/openai-apply-patch-runtime.js";
import type { LLMToolCall, OpenAINativeApplyPatchTool } from "../../../src/types/tool.js";

describe("executeOpenAIApplyPatchToolCall", () => {
  let originalCwd: string;
  let tmpDir: string;
  let tool: OpenAINativeApplyPatchTool;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-apply-patch-runtime-test-"));
    process.chdir(tmpDir);
    tool = {
      kind: "provider_native",
      provider: "openai",
      type: "apply_patch",
      allowedPaths: ["files"],
    };
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("normalizes structured create_file diffs before writing file contents", async () => {
    const result = await executeOpenAIApplyPatchToolCall(createToolCall({
      operation: {
        type: "create_file",
        path: "files/sample.json",
        diff: '+[\n+  {"name": "first"}\n+]\n',
      },
    }), tool);

    expect(result).toMatchObject({
      content: "Created files/sample.json",
    });
    expect(result.isError).toBeUndefined();
    const content = await fs.readFile(path.join(tmpDir, "files", "sample.json"), "utf8");
    expect(content).toBe('[\n  {"name": "first"}\n]\n');
    expect(JSON.parse(content)).toEqual([{ name: "first" }]);
  });

  it("keeps plain structured create_file content supported", async () => {
    await executeOpenAIApplyPatchToolCall(createToolCall({
      operation: {
        type: "create_file",
        path: "files/plain.md",
        diff: "# Title\n\nBody\n",
      },
    }), tool);

    await expect(fs.readFile(path.join(tmpDir, "files", "plain.md"), "utf8")).resolves.toBe("# Title\n\nBody\n");
  });

  it("keeps raw add-file patches normalized", async () => {
    await executeOpenAIApplyPatchToolCall(createToolCall({
      patch: [
        "*** Begin Patch",
        "*** Add File: files/raw.json",
        "+{",
        '+  "ok": true',
        "+}",
        "*** End Patch",
      ].join("\n"),
    }), tool);

    const content = await fs.readFile(path.join(tmpDir, "files", "raw.json"), "utf8");
    expect(content).toBe('{\n  "ok": true\n}\n');
  });
});

function createToolCall(argumentsValue: Record<string, unknown>): LLMToolCall {
  return {
    id: "call_apply_patch",
    name: "apply_patch",
    provider: "openai",
    executionKind: "provider_native",
    arguments: argumentsValue,
  };
}
