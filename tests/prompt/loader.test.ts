import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { PromptLoader } from "../../src/prompt/loader.js";
import type { TemplateEngine } from "../../src/prompt/loader.js";

describe("PromptLoader", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-loader-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writePromptFile(
    promptKey: string,
    content: string,
    fileName = "prompt.yaml",
  ) {
    const dir = path.join(tmpDir, promptKey);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), content, "utf-8");
  }

  describe("getTemplate", () => {
    it("loads a YAML file with a prompt key", async () => {
      await writePromptFile("greeting", 'prompt: "Hello, world!"');
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(loader.getTemplate("greeting")).toBe("Hello, world!");
    });

    it("loads a plain string YAML", async () => {
      await writePromptFile("simple", "This is a plain prompt\n");
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(loader.getTemplate("simple")).toBe("This is a plain prompt");
    });

    it("loads from a custom file name", async () => {
      await writePromptFile(
        "multi",
        'prompt: "From custom file"',
        "system.yaml",
      );
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(loader.getTemplate("multi", "system.yaml")).toBe(
        "From custom file",
      );
    });

    it("throws on invalid YAML structure", async () => {
      await writePromptFile("bad", "items:\n  - one\n  - two\n");
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(() => loader.getTemplate("bad")).toThrow("Invalid prompt YAML");
    });

    it("throws on non-existent file", () => {
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(() => loader.getTemplate("missing")).toThrow();
    });
  });

  describe("format", () => {
    it("replaces ${var} placeholders", async () => {
      await writePromptFile(
        "greet",
        'prompt: "Hello, ${name}! You are ${role}."',
      );
      const loader = new PromptLoader({ baseDir: tmpDir });
      const result = loader.format("greet", { name: "Alice", role: "admin" });
      expect(result).toBe("Hello, Alice! You are admin.");
    });

    it("leaves unmatched placeholders as-is", async () => {
      await writePromptFile("partial", 'prompt: "${found} and ${missing}"');
      const loader = new PromptLoader({ baseDir: tmpDir });
      const result = loader.format("partial", { found: "yes" });
      expect(result).toBe("yes and ${missing}");
    });

    it("returns template unchanged when vars is undefined", async () => {
      await writePromptFile("raw", 'prompt: "No vars ${here}"');
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(loader.format("raw")).toBe("No vars ${here}");
    });

    it("returns template unchanged when vars is empty", async () => {
      await writePromptFile("raw2", 'prompt: "No vars ${here}"');
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(loader.format("raw2", {})).toBe("No vars ${here}");
    });

    it("converts non-string values to strings", async () => {
      await writePromptFile("nums", 'prompt: "count: ${n}, flag: ${b}"');
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(loader.format("nums", { n: 42, b: true })).toBe(
        "count: 42, flag: true",
      );
    });
  });

  describe("custom TemplateEngine", () => {
    it("uses a custom engine for rendering", async () => {
      await writePromptFile("custom", 'prompt: "Hello, {{name}}!"');
      const engine: TemplateEngine = {
        render(template, vars) {
          return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
            key in vars ? String(vars[key]) : `{{${key}}}`,
          );
        },
      };
      const loader = new PromptLoader({ baseDir: tmpDir, engine });
      expect(loader.format("custom", { name: "Bob" })).toBe("Hello, Bob!");
    });
  });

  describe("multiline YAML prompt", () => {
    it("handles YAML block scalars", async () => {
      const yamlContent = `prompt: |
  Line one
  Line two
  Line three`;
      await writePromptFile("block", yamlContent);
      const loader = new PromptLoader({ baseDir: tmpDir });
      expect(loader.getTemplate("block")).toBe(
        "Line one\nLine two\nLine three\n",
      );
    });
  });
});
