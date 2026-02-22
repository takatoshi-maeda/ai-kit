import { describe, it, expect, vi } from "vitest";
import {
  runBeforeTurnHooks,
  runAfterTurnHooks,
  runBeforeToolCallHooks,
  runAfterToolCallHooks,
  runAfterRunHooks,
} from "../../src/agent/hooks.js";
import type {
  AgentHooks,
  BeforeTurnContext,
  AfterTurnContext,
  BeforeToolCallContext,
  AfterToolCallContext,
  AfterRunContext,
} from "../../src/types/agent.js";

const stubBeforeTurnCtx = {} as BeforeTurnContext;
const stubAfterTurnCtx = {} as AfterTurnContext;
const stubBeforeToolCallCtx = {} as BeforeToolCallContext;
const stubAfterToolCallCtx = {} as AfterToolCallContext;
const stubAfterRunCtx = {} as AfterRunContext;

describe("Hook execution utilities", () => {
  describe("runBeforeTurnHooks", () => {
    it("runs hooks sequentially", async () => {
      const order: number[] = [];
      const hooks: AgentHooks = {
        beforeTurn: [
          async () => { order.push(1); },
          async () => { order.push(2); },
        ],
      };

      await runBeforeTurnHooks(hooks, stubBeforeTurnCtx);
      expect(order).toEqual([1, 2]);
    });

    it("does nothing with undefined hooks", async () => {
      await runBeforeTurnHooks(undefined, stubBeforeTurnCtx);
    });

    it("does nothing with empty hook array", async () => {
      await runBeforeTurnHooks({}, stubBeforeTurnCtx);
    });
  });

  describe("runAfterTurnHooks", () => {
    it("runs hooks sequentially", async () => {
      const order: number[] = [];
      const hooks: AgentHooks = {
        afterTurn: [
          async () => { order.push(1); },
          async () => { order.push(2); },
        ],
      };

      await runAfterTurnHooks(hooks, stubAfterTurnCtx);
      expect(order).toEqual([1, 2]);
    });
  });

  describe("runBeforeToolCallHooks", () => {
    it("runs hooks sequentially", async () => {
      const fn = vi.fn();
      const hooks: AgentHooks = { beforeToolCall: [fn] };

      await runBeforeToolCallHooks(hooks, stubBeforeToolCallCtx);
      expect(fn).toHaveBeenCalledWith(stubBeforeToolCallCtx);
    });
  });

  describe("runAfterToolCallHooks", () => {
    it("runs hooks sequentially", async () => {
      const fn = vi.fn();
      const hooks: AgentHooks = { afterToolCall: [fn] };

      await runAfterToolCallHooks(hooks, stubAfterToolCallCtx);
      expect(fn).toHaveBeenCalledWith(stubAfterToolCallCtx);
    });
  });

  describe("runAfterRunHooks", () => {
    it("returns done when no hooks", async () => {
      const action = await runAfterRunHooks(undefined, stubAfterRunCtx);
      expect(action).toEqual({ type: "done" });
    });

    it("returns done when all hooks return done", async () => {
      const hooks: AgentHooks = {
        afterRun: [
          async () => ({ type: "done" as const }),
          async () => ({ type: "done" as const }),
        ],
      };

      const action = await runAfterRunHooks(hooks, stubAfterRunCtx);
      expect(action).toEqual({ type: "done" });
    });

    it("returns rerun when any hook returns rerun", async () => {
      const hooks: AgentHooks = {
        afterRun: [
          async () => ({ type: "rerun" as const, reason: "retry" }),
          async () => ({ type: "done" as const }),
        ],
      };

      const action = await runAfterRunHooks(hooks, stubAfterRunCtx);
      expect(action).toEqual({ type: "rerun", reason: "retry" });
    });

    it("stops at first rerun", async () => {
      const secondHook = vi.fn(async () => ({ type: "done" as const }));
      const hooks: AgentHooks = {
        afterRun: [
          async () => ({ type: "rerun" as const }),
          secondHook,
        ],
      };

      await runAfterRunHooks(hooks, stubAfterRunCtx);
      expect(secondHook).not.toHaveBeenCalled();
    });
  });
});
