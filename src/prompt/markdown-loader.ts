import * as fs from "node:fs";
import * as path from "node:path";
import type { TemplateEngine } from "./loader.js";

export interface MarkdownPromptLookupOptions {
  model?: string;
}

const defaultEngine: TemplateEngine = {
  render(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\$\{(\w+)\}/g, (match, key: string) => {
      if (key in vars) {
        return String(vars[key]);
      }
      return match;
    });
  },
};

export class MarkdownPromptLoader {
  private readonly baseDir: string;
  private readonly engine: TemplateEngine;

  constructor(options: { baseDir: string; engine?: TemplateEngine }) {
    this.baseDir = options.baseDir;
    this.engine = options.engine ?? defaultEngine;
  }

  getTemplate(
    promptKey: string,
    options?: MarkdownPromptLookupOptions,
  ): string {
    const filePath = this.resolveTemplatePath(promptKey, options);
    return fs.readFileSync(filePath, "utf-8");
  }

  format(
    promptKey: string,
    vars?: Record<string, unknown>,
    options?: MarkdownPromptLookupOptions,
  ): string {
    const template = this.getTemplate(promptKey, options);
    if (!vars || Object.keys(vars).length === 0) return template;
    return this.engine.render(template, vars);
  }

  private resolveTemplatePath(
    promptKey: string,
    options?: MarkdownPromptLookupOptions,
  ): string {
    const defaultPath = path.resolve(this.baseDir, `${promptKey}.md`);
    const model = options?.model;
    if (!model) {
      return defaultPath;
    }

    const modelPath = path.resolve(this.baseDir, `${promptKey}.${model}.md`);
    return fs.existsSync(modelPath) ? modelPath : defaultPath;
  }
}
