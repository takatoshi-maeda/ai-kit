import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ToolExecutor } from "../../../src/llm/tool/executor.js";
import { defineTool } from "../../../src/llm/tool/define.js";
import { ToolExecutionError } from "../../../src/errors.js";

function makeTool(name: string, fn: (params: { input: string }) => Promise<string>) {
  return defineTool({
    name,
    description: `Tool ${name}`,
    parameters: z.object({ input: z.string() }),
    execute: fn,
  });
}

describe("ToolExecutor", () => {
  describe("findTool", () => {
    it("returns tool by name", () => {
      const tool = makeTool("echo", async ({ input }) => input);
      const executor = new ToolExecutor([tool]);
      expect(executor.findTool("echo")).toBe(tool);
    });

    it("returns undefined for unknown tool", () => {
      const executor = new ToolExecutor([]);
      expect(executor.findTool("unknown")).toBeUndefined();
    });
  });

  describe("execute", () => {
    it("executes tool and returns result", async () => {
      const tool = makeTool("echo", async ({ input }) => input);
      const executor = new ToolExecutor([tool]);

      const result = await executor.execute({
        id: "call-1",
        name: "echo",
        arguments: { input: "hello" },
      });

      expect(result.toolCallId).toBe("call-1");
      expect(result.content).toBe("hello");
      expect(result.isError).toBeUndefined();
    });

    it("returns error result for unknown tool", async () => {
      const executor = new ToolExecutor([]);

      const result = await executor.execute({
        id: "call-1",
        name: "unknown",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Tool not found");
    });

    it("throws ToolExecutionError on tool failure", async () => {
      const tool = makeTool("fail", async () => {
        throw new Error("boom");
      });
      const executor = new ToolExecutor([tool]);

      await expect(
        executor.execute({
          id: "call-1",
          name: "fail",
          arguments: { input: "x" },
        }),
      ).rejects.toThrow(ToolExecutionError);
    });

    it("serializes non-string results to JSON", async () => {
      const tool = defineTool({
        name: "obj",
        description: "Returns object",
        parameters: z.object({}),
        execute: async () => ({ key: "value" }),
      });
      const executor = new ToolExecutor([tool]);

      const result = await executor.execute({
        id: "call-1",
        name: "obj",
        arguments: {},
      });

      expect(JSON.parse(result.content)).toEqual({ key: "value" });
    });

    it("attaches artifacts derived from raw tool results", async () => {
      const tool = defineTool({
        name: "plan",
        description: "Returns a plan",
        parameters: z.object({ builderId: z.number() }),
        execute: async () => ({
          id: "meeting_plan_template_1",
          status: "draft",
          updatedAt: "2026-05-20T10:30:00.000Z",
        }),
        artifacts: (result, params) => [
          {
            type: "data",
            artifactId: `meeting_plan_template:${params.builderId}:${result.id}`,
            dataType: "meeting_plan_template",
            data: {
              builderId: params.builderId,
              id: result.id,
              status: result.status,
              updatedAt: result.updatedAt,
            },
          },
        ],
      });
      const executor = new ToolExecutor([tool]);

      const result = await executor.execute({
        id: "call-1",
        name: "plan",
        arguments: { builderId: 93 },
      });

      expect(JSON.parse(result.content)).toEqual({
        id: "meeting_plan_template_1",
        status: "draft",
        updatedAt: "2026-05-20T10:30:00.000Z",
      });
      expect(result.artifacts).toEqual([
        {
          type: "data",
          artifactId: "meeting_plan_template:93:meeting_plan_template_1",
          dataType: "meeting_plan_template",
          data: {
            builderId: 93,
            id: "meeting_plan_template_1",
            status: "draft",
            updatedAt: "2026-05-20T10:30:00.000Z",
          },
        },
      ]);
    });

    it("normalizes tool result envelopes with output content", async () => {
      const tool = defineTool({
        name: "doc",
        description: "Returns document",
        parameters: z.object({}),
        execute: async () => ({
          content: "summary",
          structuredContent: { id: "doc-1" },
          outputContent: [
            { type: "text" as const, text: "summary" },
            { type: "file" as const, fileId: "file-1", filename: "doc.pdf" },
          ],
        }),
      });
      const executor = new ToolExecutor([tool]);

      const result = await executor.execute({
        id: "call-1",
        name: "doc",
        arguments: {},
        provider: "openai",
      });

      expect(result.content).toBe("summary");
      expect(result.structuredContent).toEqual({ id: "doc-1" });
      expect(result.outputContent).toEqual([
        { type: "text", text: "summary" },
        { type: "file", fileId: "file-1", filename: "doc.pdf" },
      ]);
      expect(result.extra?.providerRaw).toEqual({
        provider: "openai",
        inputItems: [
          {
            type: "function_call_output",
            call_id: "call-1",
            output: [
              { type: "input_text", text: "summary" },
              { type: "input_file", file_id: "file-1" },
            ],
          },
        ],
      });
    });
  });

  describe("executeAll", () => {
    it("executes multiple tools in parallel", async () => {
      const order: string[] = [];
      const tool1 = makeTool("t1", async ({ input }) => {
        order.push("t1");
        return `t1:${input}`;
      });
      const tool2 = makeTool("t2", async ({ input }) => {
        order.push("t2");
        return `t2:${input}`;
      });

      const executor = new ToolExecutor([tool1, tool2]);
      const results = await executor.executeAll([
        { id: "c1", name: "t1", arguments: { input: "a" } },
        { id: "c2", name: "t2", arguments: { input: "b" } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].content).toBe("t1:a");
      expect(results[1].content).toBe("t2:b");
    });

    it("returns error results for failed tools without throwing", async () => {
      const tool = makeTool("fail", async () => {
        throw new Error("boom");
      });
      const executor = new ToolExecutor([tool]);

      const results = await executor.executeAll([
        { id: "c1", name: "fail", arguments: { input: "x" } },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(true);
      expect(results[0].content).toContain("boom");
    });
  });
});
