import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryHistory } from "../../../src/agent/conversation/memory-history.js";

describe("InMemoryHistory", () => {
  let history: InMemoryHistory;

  beforeEach(() => {
    history = new InMemoryHistory();
  });

  it("starts empty", async () => {
    expect(await history.getMessages()).toEqual([]);
    expect(await history.toLLMMessages()).toEqual([]);
  });

  it("adds and retrieves messages", async () => {
    await history.addMessage({ role: "user", content: "hello" });
    await history.addMessage({ role: "assistant", content: "hi" });

    const msgs = await history.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
    expect(msgs[0].timestamp).toBeInstanceOf(Date);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("hi");
  });

  it("converts to LLMMessages", async () => {
    await history.addMessage({ role: "user", content: "question" });
    await history.addMessage({ role: "assistant", content: "answer" });

    const llmMsgs = await history.toLLMMessages();
    expect(llmMsgs).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("filters by limit", async () => {
    await history.addMessage({ role: "user", content: "a" });
    await history.addMessage({ role: "user", content: "b" });
    await history.addMessage({ role: "user", content: "c" });

    const msgs = await history.getMessages({ limit: 2 });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("b");
    expect(msgs[1].content).toBe("c");
  });

  it("filters by before date", async () => {
    const now = new Date();
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    await history.addMessage({ role: "user", content: "old" });

    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
    await history.addMessage({ role: "user", content: "new" });

    const msgs = await history.getMessages({
      before: new Date("2025-03-01T00:00:00Z"),
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("old");

    vi.useRealTimers();
  });

  it("clears all messages", async () => {
    await history.addMessage({ role: "user", content: "hello" });
    await history.clear();
    expect(await history.getMessages()).toEqual([]);
  });

  it("preserves metadata", async () => {
    await history.addMessage({
      role: "user",
      content: "hi",
      metadata: { source: "test" },
    });

    const msgs = await history.getMessages();
    expect(msgs[0].metadata).toEqual({ source: "test" });
  });
});
