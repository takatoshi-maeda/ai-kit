import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createPersistenceBundle } from "../../../src/agent/persistence/factory.js";
import { FilesystemPersistence } from "../../../src/agent/persistence/filesystem.js";
import { FileSystemPublicAssetStorage } from "../../../src/agent/public-assets/filesystem.js";
import { createFakeSupabaseClient } from "../../helpers/fake-supabase.js";

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

  it("creates a supabase-backed bundle when the backend kind is supabase", async () => {
    const fakeClient = createFakeSupabaseClient();

    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: vi.fn(() => fakeClient),
    }));

    const { createPersistenceBundle: createSupabaseBundle } = await import(
      "../../../src/agent/persistence/factory.js"
    );
    const { SupabasePersistence } = await import(
      "../../../src/agent/persistence/supabase.js"
    );
    const { SupabasePublicAssetStorage } = await import(
      "../../../src/agent/public-assets/supabase.js"
    );

    const bundle = await createSupabaseBundle("chat-app", {
      persistence: {
        kind: "supabase",
        url: "https://example.supabase.co",
        serviceRoleKey: "service-role-key",
        tablePrefix: "custom_",
        bucket: "uploads-bucket",
        signedUrlExpiresInSeconds: 90,
      },
    });

    expect(bundle.persistence).toBeInstanceOf(SupabasePersistence);
    expect(bundle.publicAssetStorage).toBeInstanceOf(SupabasePublicAssetStorage);
    expect(bundle.publicAssetsDir).toBeUndefined();

    await bundle.persistence.appendConversationTurn("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      userMessage: "Hello",
      assistantMessage: "Hi",
      status: "success",
      agentId: "chat-app",
    });

    expect(fakeClient.tableRows("custom_conversations")).toHaveLength(1);
    expect(fakeClient.tableRows("custom_conversation_events")).toHaveLength(2);

    vi.doUnmock("@supabase/supabase-js");
  });
});
