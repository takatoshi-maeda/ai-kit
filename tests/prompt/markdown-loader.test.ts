import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { MarkdownPromptLoader } from "../../src/prompt/markdown-loader.js";
import type { TemplateEngine } from "../../src/prompt/loader.js";

describe("MarkdownPromptLoader", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "md-prompt-loader-test-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeMarkdown(name: string, content: string) {
    await fs.writeFile(path.join(tmpDir, `${name}.md`), content, "utf-8");
  }

  describe("getTemplate", () => {
    it("loads a markdown file", async () => {
      await writeMarkdown("system", "# System Prompt\n\nYou are helpful.");
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });
      expect(loader.getTemplate("system")).toBe(
        "# System Prompt\n\nYou are helpful.",
      );
    });

    it("prefers a model-specific markdown file when a model is provided", async () => {
      await writeMarkdown("system", "Default prompt");
      await writeMarkdown("system.gpt-5.5", "GPT-5.5 prompt");
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });

      expect(loader.getTemplate("system", { model: "gpt-5.5" })).toBe(
        "GPT-5.5 prompt",
      );
    });

    it("falls back to the default markdown file when a model-specific file is missing", async () => {
      await writeMarkdown("system", "Default prompt");
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });

      expect(loader.getTemplate("system", { model: "gpt-5.2" })).toBe(
        "Default prompt",
      );
    });

    it("throws on non-existent file", () => {
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });
      expect(() => loader.getTemplate("missing")).toThrow();
    });
  });

  describe("format", () => {
    it("replaces ${var} placeholders", async () => {
      await writeMarkdown("greet", "Hello, ${name}!\n\nRole: ${role}");
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });
      const result = loader.format("greet", { name: "Alice", role: "admin" });
      expect(result).toBe("Hello, Alice!\n\nRole: admin");
    });

    it("leaves unmatched placeholders as-is", async () => {
      await writeMarkdown("partial", "${found} and ${missing}");
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });
      expect(loader.format("partial", { found: "yes" })).toBe(
        "yes and ${missing}",
      );
    });

    it("returns template unchanged when no vars given", async () => {
      await writeMarkdown("raw", "No vars ${here}");
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });
      expect(loader.format("raw")).toBe("No vars ${here}");
    });

    it("renders placeholders from model-specific markdown files", async () => {
      await writeMarkdown("greet", "Hello, ${name}.");
      await writeMarkdown("greet.gpt-5.5", "Optimized hello, ${name}.");
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });

      expect(
        loader.format("greet", { name: "Alice" }, { model: "gpt-5.5" }),
      ).toBe("Optimized hello, Alice.");
    });

    it("renders placeholders after falling back to the default markdown file", async () => {
      await writeMarkdown("greet", "Hello, ${name}.");
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir });

      expect(
        loader.format("greet", { name: "Alice" }, { model: "gpt-5.2" }),
      ).toBe("Hello, Alice.");
    });
  });

  describe("custom TemplateEngine", () => {
    it("uses a custom engine for rendering", async () => {
      await writeMarkdown("custom", "Hello, <<name>>!");
      const engine: TemplateEngine = {
        render(template, vars) {
          return template.replace(/<<(\w+)>>/g, (_, key: string) =>
            key in vars ? String(vars[key]) : `<<${key}>>`,
          );
        },
      };
      const loader = new MarkdownPromptLoader({ baseDir: tmpDir, engine });
      expect(loader.format("custom", { name: "Eve" })).toBe("Hello, Eve!");
    });
  });
});
