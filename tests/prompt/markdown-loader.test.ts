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
