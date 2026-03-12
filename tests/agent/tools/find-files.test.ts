import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createFindFilesTool } from "../../../src/agent/tools/find-files.js";

describe("createFindFilesTool", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createFindFilesTool>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "find-files-test-"));
    tool = createFindFilesTool({ workingDir: tmpDir });

    await fs.mkdir(path.join(tmpDir, "docs", "maintenance"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".hidden-dir"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "docs", "maintenance", "plan.md"), "# plan\n");
    await fs.writeFile(path.join(tmpDir, "docs", "Maintenance-Notes.md"), "# notes\n");
    await fs.writeFile(path.join(tmpDir, ".hidden-dir", "maintenance-secret.md"), "# secret\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds files by partial path match", async () => {
    const result = await tool.execute({ query: "maintenance" });
    expect(result).toContain("file: docs/maintenance/plan.md");
    expect(result).toContain("file: docs/Maintenance-Notes.md");
  });

  it("finds directories when requested", async () => {
    const result = await tool.execute({ query: "maintenance", type: "directory" });
    expect(result).toContain("directory: docs/maintenance");
    expect(result).not.toContain("plan.md");
  });

  it("searches from a subdirectory", async () => {
    const result = await tool.execute({ query: "maintenance", path: "docs" });
    expect(result).toContain("file: maintenance/plan.md");
    expect(result).toContain("file: Maintenance-Notes.md");
  });

  it("excludes hidden paths by default", async () => {
    const result = await tool.execute({ query: "secret" });
    expect(result).toBe("No matches found.");
  });

  it("includes hidden paths when requested", async () => {
    const result = await tool.execute({ query: "secret", includeHidden: true });
    expect(result).toContain("file: .hidden-dir/maintenance-secret.md");
  });

  it("supports case-sensitive matching", async () => {
    const result = await tool.execute({ query: "Maintenance", caseSensitive: true });
    expect(result).toContain("file: docs/Maintenance-Notes.md");
    expect(result).not.toContain("plan.md");
  });

  it("limits the number of returned paths", async () => {
    const result = await tool.execute({ query: "maintenance", type: "all", maxResults: 1 });
    expect(result.split("\n")).toHaveLength(1);
  });

  it("rejects path traversal", async () => {
    await expect(tool.execute({ query: "maintenance", path: "../.." })).rejects.toThrow(
      "Path traversal detected",
    );
  });
});
