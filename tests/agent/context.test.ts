import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgentContextImpl } from "../../src/agent/context.js";
import type { ConversationHistory } from "../../src/types/agent.js";
import type { LLMMessage } from "../../src/types/llm.js";

function stubHistory(): ConversationHistory {
  const messages: { role: string; content: string | unknown[] }[] = [];
  return {
    async getMessages() {
      return [];
    },
    async addMessage(msg) {
      messages.push(msg);
    },
    async toLLMMessages(): Promise<LLMMessage[]> {
      return [];
    },
    async clear() {
      messages.length = 0;
    },
  };
}

describe("AgentContextImpl", () => {
  it("initializes with required fields", () => {
    const ctx = new AgentContextImpl({ history: stubHistory() });

    expect(ctx.sessionId).toBeTruthy();
    expect(ctx.toolCallResults).toEqual([]);
    expect(ctx.turns).toEqual([]);
    expect(ctx.metadata.size).toBe(0);
    expect(ctx.progress).toBeDefined();
    expect(ctx.selectedAgentName).toBeUndefined();
  });

  it("uses provided sessionId", () => {
    const ctx = new AgentContextImpl({
      history: stubHistory(),
      sessionId: "my-session",
    });

    expect(ctx.sessionId).toBe("my-session");
  });

  it("uses provided progress tracker", () => {
    const progress = {
      goals: [],
      subscribe: () => () => {},
      addGoal: () => ({ id: "0", title: "", type: "thinking" as const, status: "pending" as const, steps: [] }),
      updateGoalStatus: () => {},
      addStep: () => ({ id: "0", title: "", status: "pending" as const }),
      updateStepStatus: () => {},
    };

    const ctx = new AgentContextImpl({
      history: stubHistory(),
      progress,
    });

    expect(ctx.progress).toBe(progress);
  });

  describe("collectToolResults", () => {
    it("collects results matching schema", () => {
      const ctx = new AgentContextImpl({ history: stubHistory() });

      ctx.toolCallResults.push(
        {
          id: "c1",
          name: "t1",
          arguments: {},
          result: {
            toolCallId: "c1",
            content: JSON.stringify({ score: 42 }),
          },
        },
        {
          id: "c2",
          name: "t2",
          arguments: {},
          result: {
            toolCallId: "c2",
            content: JSON.stringify({ score: 99 }),
          },
        },
      );

      const schema = z.object({ score: z.number() });
      const results = ctx.collectToolResults(schema);

      expect(results).toEqual([{ score: 42 }, { score: 99 }]);
    });

    it("skips non-matching results", () => {
      const ctx = new AgentContextImpl({ history: stubHistory() });

      ctx.toolCallResults.push(
        {
          id: "c1",
          name: "t1",
          arguments: {},
          result: {
            toolCallId: "c1",
            content: JSON.stringify({ name: "hello" }),
          },
        },
        {
          id: "c2",
          name: "t2",
          arguments: {},
          result: {
            toolCallId: "c2",
            content: JSON.stringify({ score: 42 }),
          },
        },
      );

      const schema = z.object({ score: z.number() });
      const results = ctx.collectToolResults(schema);

      expect(results).toEqual([{ score: 42 }]);
    });

    it("skips error results", () => {
      const ctx = new AgentContextImpl({ history: stubHistory() });

      ctx.toolCallResults.push({
        id: "c1",
        name: "t1",
        arguments: {},
        result: {
          toolCallId: "c1",
          content: "Tool failed",
          isError: true,
        },
      });

      const schema = z.object({ score: z.number() });
      expect(ctx.collectToolResults(schema)).toEqual([]);
    });

    it("skips results without content", () => {
      const ctx = new AgentContextImpl({ history: stubHistory() });

      ctx.toolCallResults.push({
        id: "c1",
        name: "t1",
        arguments: {},
      });

      const schema = z.object({ score: z.number() });
      expect(ctx.collectToolResults(schema)).toEqual([]);
    });
  });
});
