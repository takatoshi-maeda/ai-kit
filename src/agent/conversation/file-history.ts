import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LLMMessage } from "../../types/llm.js";
import type { ContentPart, FileSource, ImageSource } from "../../types/llm.js";
import type {
  ConversationHistory,
  ConversationMessage,
} from "../../types/agent.js";

interface StoredMessage {
  role: ConversationMessage["role"];
  content: string | ContentPart[];
  timestamp: string;
  name?: string;
  toolCallId?: string;
  extra?: LLMMessage["extra"];
  metadata?: Record<string, unknown>;
}

export class FileHistory implements ConversationHistory {
  private readonly filePath: string;

  constructor(options: { sessionId: string; baseDir: string }) {
    this.filePath = path.join(options.baseDir, `${options.sessionId}.jsonl`);
  }

  private async readAll(): Promise<ConversationMessage[]> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const messages: ConversationMessage[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let storedRaw: unknown;
      try {
        storedRaw = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Failed to parse JSONL entry at ${this.filePath}:${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const stored = parseStoredMessage(
        storedRaw,
        this.filePath,
        index + 1,
      );
      messages.push({
        role: stored.role,
        content: stored.content,
        timestamp: new Date(stored.timestamp),
        name: stored.name,
        toolCallId: stored.toolCallId,
        extra: stored.extra,
        metadata: stored.metadata,
      });
    }
    return messages;
  }

  async getMessages(options?: {
    limit?: number;
    before?: Date;
  }): Promise<ConversationMessage[]> {
    let result = await this.readAll();
    if (options?.before) {
      result = result.filter((m) => m.timestamp < options.before!);
    }
    if (options?.limit) {
      result = result.slice(-options.limit);
    }
    return result;
  }

  async addMessage(
    message: Omit<ConversationMessage, "timestamp">,
  ): Promise<void> {
    const stored: StoredMessage = {
      role: message.role,
      content: message.content,
      timestamp: new Date().toISOString(),
      name: message.name,
      toolCallId: message.toolCallId,
      extra: message.extra,
      metadata: message.metadata,
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, JSON.stringify(stored) + "\n", "utf-8");
  }

  async toLLMMessages(): Promise<LLMMessage[]> {
    const messages = await this.readAll();
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
      name: m.name,
      toolCallId: m.toolCallId,
      extra: m.extra,
    }));
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}

function parseStoredMessage(
  value: unknown,
  filePath: string,
  lineNumber: number,
): StoredMessage {
  const asRecord = asObjectRecord(value);
  const role = asRecord.role;
  if (
    role !== "user" &&
    role !== "assistant" &&
    role !== "system" &&
    role !== "tool"
  ) {
    throw invalidLineError(filePath, lineNumber, "invalid role");
  }

  const content = asRecord.content;
  if (typeof content !== "string" && !isContentPartArray(content)) {
    throw invalidLineError(filePath, lineNumber, "invalid content");
  }

  const timestamp = asRecord.timestamp;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw invalidLineError(filePath, lineNumber, "invalid timestamp");
  }

  const metadata = asRecord.metadata;
  if (metadata !== undefined && !isPlainObject(metadata)) {
    throw invalidLineError(filePath, lineNumber, "invalid metadata");
  }

  const name = asRecord.name;
  if (name !== undefined && typeof name !== "string") {
    throw invalidLineError(filePath, lineNumber, "invalid name");
  }

  const toolCallId = asRecord.toolCallId;
  if (toolCallId !== undefined && typeof toolCallId !== "string") {
    throw invalidLineError(filePath, lineNumber, "invalid toolCallId");
  }

  const extra = asRecord.extra;
  if (extra !== undefined && !isPlainObject(extra)) {
    throw invalidLineError(filePath, lineNumber, "invalid extra");
  }

  return {
    role,
    content,
    timestamp,
    name,
    toolCallId,
    extra: extra as LLMMessage["extra"] | undefined,
    metadata: metadata as Record<string, unknown> | undefined,
  };
}

function isContentPartArray(value: unknown): value is ContentPart[] {
  return Array.isArray(value) && value.every((part) => isContentPart(part));
}

function isContentPart(value: unknown): value is ContentPart {
  const asRecord = asObjectRecord(value);
  if (asRecord.type === "text") {
    return typeof asRecord.text === "string";
  }
  if (asRecord.type === "image") {
    return isImageSource(asObjectRecord(asRecord.source));
  }
  if (asRecord.type === "audio") {
    return typeof asRecord.data === "string" &&
      typeof asRecord.format === "string";
  }
  if (asRecord.type === "file") {
    const file = asObjectRecord(asRecord.file);
    return typeof file.name === "string" &&
      typeof file.mimeType === "string" &&
      typeof file.sizeBytes === "number" &&
      isFileSource(asObjectRecord(file.source));
  }
  return false;
}

function isImageSource(value: ImageSource | Record<string, unknown>): value is ImageSource {
  if (value.type === "url") {
    return typeof value.url === "string";
  }
  if (value.type === "base64") {
    return typeof value.mediaType === "string" &&
      typeof value.data === "string";
  }
  return false;
}

function isFileSource(value: FileSource | Record<string, unknown>): value is FileSource {
  if (value.type === "asset-ref") {
    return typeof value.assetRef === "string";
  }
  if (value.type === "url") {
    return typeof value.url === "string";
  }
  if (value.type === "base64") {
    return typeof value.mediaType === "string" &&
      typeof value.data === "string";
  }
  return false;
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return {};
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidLineError(filePath: string, lineNumber: number, reason: string): Error {
  return new Error(
    `Invalid conversation history entry at ${filePath}:${lineNumber} (${reason})`,
  );
}
