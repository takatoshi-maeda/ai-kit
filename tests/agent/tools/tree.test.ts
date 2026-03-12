import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createTreeTool } from "../../../src/agent/tools/tree.js";

describe("createTreeTool", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createTreeTool>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-tool-test-"));
    tool = createTreeTool({ workingDir: tmpDir });

    await fs.mkdir(path.join(tmpDir, "docs", "spec"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".hidden"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "README.md"), "root\n");
    await fs.writeFile(path.join(tmpDir, "docs", "overview.md"), "overview\n");
    await fs.writeFile(path.join(tmpDir, "docs", "spec", "requirements.md"), "requirements\n");
    await fs.writeFile(path.join(tmpDir, ".hidden", "secret.txt"), "secret\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("renders a tree from the working directory", async () => {
    const result = await tool.execute({});
    expect(result).toContain(".");
    expect(result).toContain("docs");
    expect(result).toContain("README.md");
    expect(result).toContain("requirements.md");
  });

  it("supports subdirectory roots", async () => {
    const result = await tool.execute({ path: "docs" });
    expect(result).toContain("docs");
    expect(result).toContain("overview.md");
    expect(result).toContain("spec");
  });

  it("respects maxDepth", async () => {
    const result = await tool.execute({ maxDepth: 2 });
    expect(result).toContain("docs");
    expect(result).toContain("overview.md");
    expect(result).not.toContain("requirements.md");
  });

  it("omits hidden entries by default", async () => {
    const result = await tool.execute({});
    expect(result).not.toContain(".hidden");
  });

  it("includes hidden entries when requested", async () => {
    const result = await tool.execute({ includeHidden: true });
    expect(result).toContain(".hidden");
    expect(result).toContain("secret.txt");
  });

  it("can show directories only", async () => {
    const result = await tool.execute({ type: "directory" });
    expect(result).toContain("docs");
    expect(result).toContain("spec");
    expect(result).not.toContain("README.md");
  });

  it("limits entry count", async () => {
    const result = await tool.execute({ maxResults: 1 });
    expect(result.split("\n")).toHaveLength(2);
  });

  it("rejects path traversal", async () => {
    await expect(tool.execute({ path: "../.." })).rejects.toThrow("Path traversal detected");
  });
});
