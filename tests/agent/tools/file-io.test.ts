import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createFileTools } from "../../../src/agent/tools/file-io.js";
import type { ToolDefinition } from "../../../src/types/tool.js";

describe("createFileTools", () => {
  let tmpDir: string;
  let tools: ToolDefinition[];
  let readFile: ToolDefinition;
  let writeFile: ToolDefinition;
  let listDirectory: ToolDefinition;
  let makeDirectory: ToolDefinition;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-io-test-"));
    tools = createFileTools({ workingDir: tmpDir });
    readFile = tools.find((t) => t.name === "ReadFile")!;
    writeFile = tools.find((t) => t.name === "WriteFile")!;
    listDirectory = tools.find((t) => t.name === "ListDirectory")!;
    makeDirectory = tools.find((t) => t.name === "MakeDirectory")!;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns four tools", () => {
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ListDirectory",
      "MakeDirectory",
      "ReadFile",
      "WriteFile",
    ]);
  });

  describe("ReadFile", () => {
    it("reads an existing file", async () => {
      await fs.writeFile(path.join(tmpDir, "hello.txt"), "world");
      const result = await readFile.execute({ path: "hello.txt" });
      expect(result).toBe("world");
    });

    it("throws for non-existent file", async () => {
      await expect(readFile.execute({ path: "missing.txt" })).rejects.toThrow(
        "File not found",
      );
    });

    it("reads file in subdirectory", async () => {
      await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "sub", "data.txt"), "nested");
      const result = await readFile.execute({ path: "sub/data.txt" });
      expect(result).toBe("nested");
    });
  });

  describe("WriteFile", () => {
    it("writes a new file", async () => {
      const result = await writeFile.execute({
        path: "new.txt",
        content: "hello",
      });
      expect(result).toContain("new.txt");
      const content = await fs.readFile(path.join(tmpDir, "new.txt"), "utf-8");
      expect(content).toBe("hello");
    });

    it("creates parent directories", async () => {
      await writeFile.execute({
        path: "a/b/c.txt",
        content: "deep",
      });
      const content = await fs.readFile(
        path.join(tmpDir, "a", "b", "c.txt"),
        "utf-8",
      );
      expect(content).toBe("deep");
    });

    it("overwrites existing file", async () => {
      await writeFile.execute({ path: "f.txt", content: "v1" });
      await writeFile.execute({ path: "f.txt", content: "v2" });
      const content = await fs.readFile(path.join(tmpDir, "f.txt"), "utf-8");
      expect(content).toBe("v2");
    });
  });

  describe("ListDirectory", () => {
    it("lists files and directories", async () => {
      await fs.writeFile(path.join(tmpDir, "file.txt"), "data");
      await fs.mkdir(path.join(tmpDir, "subdir"));
      const result = await listDirectory.execute({ path: "." });
      expect(result).toEqual(
        expect.arrayContaining([
          { name: "file.txt", type: "file" },
          { name: "subdir", type: "directory" },
        ]),
      );
    });

    it("throws for non-existent directory", async () => {
      await expect(
        listDirectory.execute({ path: "nope" }),
      ).rejects.toThrow("Directory not found");
    });
  });

  describe("MakeDirectory", () => {
    it("creates a directory", async () => {
      await makeDirectory.execute({ path: "newdir" });
      const stat = await fs.stat(path.join(tmpDir, "newdir"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates nested directories", async () => {
      await makeDirectory.execute({ path: "a/b/c" });
      const stat = await fs.stat(path.join(tmpDir, "a", "b", "c"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("is idempotent for existing directory", async () => {
      await makeDirectory.execute({ path: "existing" });
      await expect(
        makeDirectory.execute({ path: "existing" }),
      ).resolves.toBeDefined();
    });
  });

  describe("path traversal prevention", () => {
    it("rejects paths that escape workingDir", async () => {
      await expect(
        readFile.execute({ path: "../../../etc/passwd" }),
      ).rejects.toThrow("Path traversal detected");
    });

    it("rejects absolute paths outside workingDir", async () => {
      await expect(
        readFile.execute({ path: "/etc/passwd" }),
      ).rejects.toThrow("Path traversal detected");
    });
  });

  describe("allowedPaths restriction", () => {
    it("allows paths within allowedPaths", async () => {
      await fs.mkdir(path.join(tmpDir, "allowed"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "allowed", "ok.txt"), "fine");

      const restricted = createFileTools({
        workingDir: tmpDir,
        allowedPaths: ["allowed"],
      });
      const rf = restricted.find((t) => t.name === "ReadFile")!;
      const result = await rf.execute({ path: "allowed/ok.txt" });
      expect(result).toBe("fine");
    });

    it("rejects paths outside allowedPaths", async () => {
      await fs.writeFile(path.join(tmpDir, "secret.txt"), "nope");

      const restricted = createFileTools({
        workingDir: tmpDir,
        allowedPaths: ["allowed"],
      });
      const rf = restricted.find((t) => t.name === "ReadFile")!;
      await expect(rf.execute({ path: "secret.txt" })).rejects.toThrow(
        "outside allowed directories",
      );
    });
  });
});
