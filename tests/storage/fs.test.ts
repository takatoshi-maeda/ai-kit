import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemStorage } from "../../src/storage/fs.js";

describe("FileSystemStorage", () => {
  let tmpDir: string;
  let storage: FileSystemStorage;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-storage-test-"));
    storage = new FileSystemStorage(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("readText / writeText", () => {
    it("writes and reads a file", async () => {
      await storage.writeText("hello.txt", "world");
      const content = await storage.readText("hello.txt");
      expect(content).toBe("world");
    });

    it("returns null for non-existent file", async () => {
      const content = await storage.readText("missing.txt");
      expect(content).toBeNull();
    });

    it("creates parent directories automatically", async () => {
      await storage.writeText("a/b/c.txt", "nested");
      const content = await storage.readText("a/b/c.txt");
      expect(content).toBe("nested");
    });

    it("overwrites existing file", async () => {
      await storage.writeText("f.txt", "v1");
      await storage.writeText("f.txt", "v2");
      expect(await storage.readText("f.txt")).toBe("v2");
    });
  });

  describe("appendText", () => {
    it("appends to an existing file", async () => {
      await storage.writeText("log.txt", "line1\n");
      await storage.appendText("log.txt", "line2\n");
      expect(await storage.readText("log.txt")).toBe("line1\nline2\n");
    });

    it("creates file if it does not exist", async () => {
      await storage.appendText("new.txt", "first");
      expect(await storage.readText("new.txt")).toBe("first");
    });

    it("creates parent directories automatically", async () => {
      await storage.appendText("x/y/z.txt", "data");
      expect(await storage.readText("x/y/z.txt")).toBe("data");
    });
  });

  describe("listFiles", () => {
    it("lists files in a directory", async () => {
      await storage.writeText("dir/a.txt", "a");
      await storage.writeText("dir/b.txt", "b");
      const files = await storage.listFiles("dir");
      expect(files.sort()).toEqual(["a.txt", "b.txt"]);
    });

    it("returns empty array for non-existent directory", async () => {
      const files = await storage.listFiles("nope");
      expect(files).toEqual([]);
    });
  });

  describe("stat", () => {
    it("returns stats for existing file", async () => {
      await storage.writeText("s.txt", "hello");
      const stats = await storage.stat("s.txt");
      expect(stats).not.toBeNull();
      expect(stats!.size).toBe(5);
      expect(stats!.modifiedAt).toBeInstanceOf(Date);
      expect(stats!.createdAt).toBeInstanceOf(Date);
    });

    it("returns null for non-existent file", async () => {
      const stats = await storage.stat("nope.txt");
      expect(stats).toBeNull();
    });
  });

  describe("deleteFile", () => {
    it("deletes an existing file", async () => {
      await storage.writeText("del.txt", "bye");
      await storage.deleteFile("del.txt");
      expect(await storage.readText("del.txt")).toBeNull();
    });

    it("no-ops for non-existent file", async () => {
      await expect(storage.deleteFile("nope.txt")).resolves.toBeUndefined();
    });
  });
});
