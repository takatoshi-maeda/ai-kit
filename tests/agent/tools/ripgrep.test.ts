import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createRipgrepTool } from "../../../src/agent/tools/ripgrep.js";

describe("createRipgrepTool", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createRipgrepTool>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ripgrep-test-"));
    tool = createRipgrepTool({ workingDir: tmpDir });

    // Create test files
    await fs.writeFile(
      path.join(tmpDir, "hello.ts"),
      'const greeting = "hello world";\nexport default greeting;\n',
    );
    await fs.writeFile(
      path.join(tmpDir, "goodbye.ts"),
      'const farewell = "goodbye world";\nexport default farewell;\n',
    );
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "sub", "nested.txt"),
      "hello from nested file\n",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct name and description", () => {
    expect(tool.name).toBe("Ripgrep");
    expect(tool.description).toBeTruthy();
  });

  it("finds matching lines", async () => {
    const result = await tool.execute({ pattern: "hello" });
    expect(result).toContain("hello");
    expect(result).toContain("hello.ts");
  });

  it("returns no-match message when nothing found", async () => {
    const result = await tool.execute({ pattern: "zzz_nonexistent_zzz" });
    expect(result).toBe("No matches found.");
  });

  it("filters by glob", async () => {
    const result = await tool.execute({ pattern: "hello", glob: "*.ts" });
    expect(result).toContain("hello.ts");
    expect(result).not.toContain("nested.txt");
  });

  it("supports case-insensitive search", async () => {
    const result = await tool.execute({
      pattern: "HELLO",
      caseSensitive: false,
    });
    expect(result).toContain("hello");
  });

  it("case-sensitive search respects case", async () => {
    const result = await tool.execute({
      pattern: "HELLO",
      caseSensitive: true,
    });
    expect(result).toBe("No matches found.");
  });

  it("searches recursively into subdirectories", async () => {
    const result = await tool.execute({ pattern: "nested file" });
    expect(result).toContain("nested.txt");
  });
});
