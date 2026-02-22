import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemStorage } from "../../../src/storage/fs.js";
import { createTodoTools } from "../../../src/agent/tools/todo.js";
import type { TodoItem } from "../../../src/agent/tools/todo.js";
import type { ToolDefinition } from "../../../src/types/tool.js";

describe("createTodoTools", () => {
  let tmpDir: string;
  let storage: FileSystemStorage;
  let tools: ToolDefinition[];
  let todoWrite: ToolDefinition;
  let todoRead: ToolDefinition;
  let todoShowNext: ToolDefinition;
  let todoListPending: ToolDefinition;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-test-"));
    storage = new FileSystemStorage(tmpDir);
    tools = createTodoTools({ storage, sessionId: "test-session" });
    todoWrite = tools.find((t) => t.name === "TodoWrite")!;
    todoRead = tools.find((t) => t.name === "TodoRead")!;
    todoShowNext = tools.find((t) => t.name === "TodoShowNext")!;
    todoListPending = tools.find((t) => t.name === "TodoListPending")!;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns four tools", () => {
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "TodoListPending",
      "TodoRead",
      "TodoShowNext",
      "TodoWrite",
    ]);
  });

  describe("TodoWrite (create)", () => {
    it("creates a new item", async () => {
      const item = (await todoWrite.execute({ title: "Buy milk" })) as TodoItem;
      expect(item.id).toBe("1");
      expect(item.title).toBe("Buy milk");
      expect(item.status).toBe("pending");
      expect(item.createdAt).toBeTruthy();
    });

    it("creates with priority", async () => {
      const item = (await todoWrite.execute({
        title: "Urgent task",
        priority: 1,
      })) as TodoItem;
      expect(item.priority).toBe(1);
    });

    it("creates with custom status", async () => {
      const item = (await todoWrite.execute({
        title: "Ongoing",
        status: "in_progress",
      })) as TodoItem;
      expect(item.status).toBe("in_progress");
    });

    it("assigns incrementing IDs", async () => {
      const a = (await todoWrite.execute({ title: "A" })) as TodoItem;
      const b = (await todoWrite.execute({ title: "B" })) as TodoItem;
      expect(a.id).toBe("1");
      expect(b.id).toBe("2");
    });

    it("throws when creating without title", async () => {
      await expect(todoWrite.execute({})).rejects.toThrow(
        "Title is required",
      );
    });
  });

  describe("TodoWrite (update)", () => {
    it("updates title", async () => {
      await todoWrite.execute({ title: "Old title" });
      const updated = (await todoWrite.execute({
        id: "1",
        title: "New title",
      })) as TodoItem;
      expect(updated.title).toBe("New title");
    });

    it("updates status", async () => {
      await todoWrite.execute({ title: "Task" });
      const updated = (await todoWrite.execute({
        id: "1",
        status: "completed",
      })) as TodoItem;
      expect(updated.status).toBe("completed");
    });

    it("throws for non-existent ID", async () => {
      await expect(
        todoWrite.execute({ id: "999", title: "Nope" }),
      ).rejects.toThrow("not found");
    });
  });

  describe("TodoRead", () => {
    it("returns empty array initially", async () => {
      const items = await todoRead.execute({});
      expect(items).toEqual([]);
    });

    it("returns all items", async () => {
      await todoWrite.execute({ title: "A" });
      await todoWrite.execute({ title: "B" });
      const items = (await todoRead.execute({})) as TodoItem[];
      expect(items).toHaveLength(2);
    });
  });

  describe("TodoShowNext", () => {
    it("returns message when no pending items", async () => {
      const result = await todoShowNext.execute({});
      expect(result).toBe("No pending TODO items.");
    });

    it("returns highest priority pending item", async () => {
      await todoWrite.execute({ title: "Low", priority: 10 });
      await todoWrite.execute({ title: "High", priority: 1 });
      await todoWrite.execute({ title: "Medium", priority: 5 });

      const next = (await todoShowNext.execute({})) as TodoItem;
      expect(next.title).toBe("High");
    });

    it("excludes completed items", async () => {
      await todoWrite.execute({ title: "Done", priority: 1 });
      await todoWrite.execute({ id: "1", status: "completed" });
      await todoWrite.execute({ title: "Pending", priority: 2 });

      const next = (await todoShowNext.execute({})) as TodoItem;
      expect(next.title).toBe("Pending");
    });

    it("includes in_progress items", async () => {
      await todoWrite.execute({
        title: "Working",
        status: "in_progress",
        priority: 1,
      });
      const next = (await todoShowNext.execute({})) as TodoItem;
      expect(next.title).toBe("Working");
    });
  });

  describe("TodoListPending", () => {
    it("returns empty array when no pending items", async () => {
      const items = await todoListPending.execute({});
      expect(items).toEqual([]);
    });

    it("returns pending and in_progress items sorted by priority", async () => {
      await todoWrite.execute({ title: "Low", priority: 10 });
      await todoWrite.execute({ title: "High", priority: 1 });
      await todoWrite.execute({ title: "Done", priority: 0, status: "completed" });

      // Mark first as completed from the original creation, then set done status
      // Actually "Done" was created with status completed already

      const items = (await todoListPending.execute({})) as TodoItem[];
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("High");
      expect(items[1].title).toBe("Low");
    });
  });

  describe("persistence", () => {
    it("persists across tool instances with same storage/session", async () => {
      await todoWrite.execute({ title: "Persisted" });

      // Create new tool instances with same storage and session
      const newTools = createTodoTools({ storage, sessionId: "test-session" });
      const newRead = newTools.find((t) => t.name === "TodoRead")!;
      const items = (await newRead.execute({})) as TodoItem[];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("Persisted");
    });

    it("isolates sessions", async () => {
      await todoWrite.execute({ title: "Session A" });

      const otherTools = createTodoTools({
        storage,
        sessionId: "other-session",
      });
      const otherRead = otherTools.find((t) => t.name === "TodoRead")!;
      const items = await otherRead.execute({});
      expect(items).toEqual([]);
    });
  });
});
