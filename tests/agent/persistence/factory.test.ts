import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createPersistenceBundle } from "../../../src/agent/persistence/factory.js";
import { FilesystemPersistence } from "../../../src/agent/persistence/filesystem.js";
import { FileSystemPublicAssetStorage } from "../../../src/agent/public-assets/filesystem.js";

describe("createPersistenceBundle", () => {
  it("creates a filesystem-backed bundle rooted at appName within dataDir", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-bundle-"));
    const bundle = await createPersistenceBundle("chat-app", {
      persistence: {
        kind: "filesystem",
        dataDir,
      },
    });

    expect(bundle.persistence).toBeInstanceOf(FilesystemPersistence);
    expect(bundle.publicAssetStorage).toBeInstanceOf(FileSystemPublicAssetStorage);
    expect(bundle.publicAssetsDir).toBe(path.resolve(dataDir, "chat-app", "public"));

    await bundle.persistence.appendConversationTurn("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      userMessage: "Hello",
      assistantMessage: "Hi",
      status: "success",
    });

    const stored = await readFile(
      path.join(dataDir, "chat-app", "conversations", "session-1.jsonl"),
      "utf8",
    );
    expect(stored).toContain('"type":"turn"');
  });
});
