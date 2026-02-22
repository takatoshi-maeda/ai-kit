import { z } from "zod";
import type { DataStorage } from "../../storage/storage.js";
import type { ToolDefinition } from "../../types/tool.js";

export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  priority?: number;
  createdAt: string;
  updatedAt: string;
}

interface TodoState {
  items: TodoItem[];
  nextId: number;
}

const STORAGE_PATH_PREFIX = "todos";

function storagePath(sessionId: string): string {
  return `${STORAGE_PATH_PREFIX}/${sessionId}.json`;
}

async function loadState(storage: DataStorage, sessionId: string): Promise<TodoState> {
  const raw = await storage.readText(storagePath(sessionId));
  if (!raw) return { items: [], nextId: 1 };
  return JSON.parse(raw) as TodoState;
}

async function saveState(storage: DataStorage, sessionId: string, state: TodoState): Promise<void> {
  await storage.writeText(storagePath(sessionId), JSON.stringify(state, null, 2));
}

export function createTodoTools(options: {
  storage: DataStorage;
  sessionId: string;
}): ToolDefinition[] {
  const { storage, sessionId } = options;

  const todoWrite: ToolDefinition = {
    name: "TodoWrite",
    description: "Create or update a TODO item. To create, provide title. To update, provide id and fields to change.",
    parameters: z.object({
      id: z.string().optional().describe("ID of the item to update. Omit to create a new item."),
      title: z.string().optional().describe("Title of the TODO item"),
      status: z.enum(["pending", "in_progress", "completed"]).optional().describe("Status of the item"),
      priority: z.number().optional().describe("Priority (lower = higher priority)"),
    }),
    async execute(params) {
      const state = await loadState(storage, sessionId);
      const now = new Date().toISOString();

      if (params.id) {
        const item = state.items.find((i) => i.id === params.id);
        if (!item) throw new Error(`TODO item not found: ${params.id}`);
        if (params.title !== undefined) item.title = params.title;
        if (params.status !== undefined) item.status = params.status;
        if (params.priority !== undefined) item.priority = params.priority;
        item.updatedAt = now;
        await saveState(storage, sessionId, state);
        return item;
      }

      if (!params.title) throw new Error("Title is required when creating a new TODO item");

      const item: TodoItem = {
        id: String(state.nextId++),
        title: params.title,
        status: params.status ?? "pending",
        priority: params.priority,
        createdAt: now,
        updatedAt: now,
      };
      state.items.push(item);
      await saveState(storage, sessionId, state);
      return item;
    },
  };

  const todoRead: ToolDefinition = {
    name: "TodoRead",
    description: "Read all TODO items.",
    parameters: z.object({}),
    async execute() {
      const state = await loadState(storage, sessionId);
      return state.items;
    },
  };

  const todoShowNext: ToolDefinition = {
    name: "TodoShowNext",
    description: "Show the next TODO item to work on (highest priority pending item).",
    parameters: z.object({}),
    async execute() {
      const state = await loadState(storage, sessionId);
      const pending = state.items
        .filter((i) => i.status === "pending" || i.status === "in_progress")
        .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));

      if (pending.length === 0) return "No pending TODO items.";
      return pending[0];
    },
  };

  const todoListPending: ToolDefinition = {
    name: "TodoListPending",
    description: "List all pending and in-progress TODO items, sorted by priority.",
    parameters: z.object({}),
    async execute() {
      const state = await loadState(storage, sessionId);
      return state.items
        .filter((i) => i.status === "pending" || i.status === "in_progress")
        .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
    },
  };

  return [todoWrite, todoRead, todoShowNext, todoListPending];
}
