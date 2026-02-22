import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

export interface TemplateEngine {
  render(template: string, vars: Record<string, unknown>): string;
}

export interface PromptLoaderOptions {
  baseDir: string;
  engine?: TemplateEngine;
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

export class PromptLoader {
  private readonly baseDir: string;
  private readonly engine: TemplateEngine;

  constructor(options: PromptLoaderOptions) {
    this.baseDir = options.baseDir;
    this.engine = options.engine ?? defaultEngine;
  }

  getTemplate(promptKey: string, fileName?: string): string {
    const dir = path.resolve(this.baseDir, promptKey);
    const file = fileName ?? "prompt.yaml";
    const filePath = path.join(dir, file);

    const raw = fs.readFileSync(filePath, "utf-8");
    const doc = yaml.load(raw) as Record<string, unknown>;

    if (typeof doc === "string") return doc;
    if (doc && typeof doc.prompt === "string") return doc.prompt;

    throw new Error(
      `Invalid prompt YAML at ${filePath}: expected a string or an object with a "prompt" key`,
    );
  }

  format(
    promptKey: string,
    vars?: Record<string, unknown>,
    fileName?: string,
  ): string {
    const template = this.getTemplate(promptKey, fileName);
    if (!vars || Object.keys(vars).length === 0) return template;
    return this.engine.render(template, vars);
  }
}
