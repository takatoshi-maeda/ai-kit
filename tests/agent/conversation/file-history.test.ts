import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileHistory } from "../../../src/agent/conversation/file-history.js";

describe("FileHistory", () => {
  let tmpDir: string;
  let history: FileHistory;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "file-history-test-"),
    );
    history = new FileHistory({ sessionId: "test-session", baseDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("starts empty", async () => {
    expect(await history.getMessages()).toEqual([]);
    expect(await history.toLLMMessages()).toEqual([]);
  });

  it("persists messages to JSONL file", async () => {
    await history.addMessage({ role: "user", content: "hello" });
    await history.addMessage({ role: "assistant", content: "hi" });

    const raw = await fs.readFile(
      path.join(tmpDir, "test-session.jsonl"),
      "utf-8",
    );
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.role).toBe("user");
    expect(first.content).toBe("hello");
    expect(first.timestamp).toBeTruthy();
  });

  it("reads back persisted messages", async () => {
    await history.addMessage({ role: "user", content: "q" });
    await history.addMessage({ role: "assistant", content: "a" });

    // Create a fresh instance to verify persistence
    const history2 = new FileHistory({
      sessionId: "test-session",
      baseDir: tmpDir,
    });

    const msgs = await history2.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("q");
    expect(msgs[0].timestamp).toBeInstanceOf(Date);
    expect(msgs[1].role).toBe("assistant");
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

  it("persists and restores content parts", async () => {
    const content = [
      {
        type: "image",
        source: { type: "url", url: "https://example.com/sample.png" },
      },
      { type: "text", text: "check this image" },
    ] as const;

    await history.addMessage({ role: "user", content: [...content] });

    const messages = await history.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual(content);
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

  it("clears all messages", async () => {
    await history.addMessage({ role: "user", content: "hello" });
    await history.clear();
    expect(await history.getMessages()).toEqual([]);
  });

  it("clear is safe when file does not exist", async () => {
    await expect(history.clear()).resolves.toBeUndefined();
  });

  it("preserves metadata", async () => {
    await history.addMessage({
      role: "user",
      content: "hi",
      metadata: { key: "value" },
    });

    const msgs = await history.getMessages();
    expect(msgs[0].metadata).toEqual({ key: "value" });
  });

  it("creates base directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "dir");
    const h = new FileHistory({ sessionId: "s", baseDir: nestedDir });
    await h.addMessage({ role: "user", content: "test" });

    const msgs = await h.getMessages();
    expect(msgs).toHaveLength(1);
  });

  it("throws when persisted content is invalid", async () => {
    const filePath = path.join(tmpDir, "test-session.jsonl");
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        role: "user",
        content: [{ type: "image", source: { type: "base64", data: "abc" } }],
        timestamp: new Date().toISOString(),
      })}\n`,
      "utf-8",
    );

    await expect(history.getMessages()).rejects.toThrow(
      /Invalid conversation history entry/,
    );
  });
});
