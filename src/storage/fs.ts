import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DataStorage, FileStats } from "./storage.js";

export class FileSystemStorage implements DataStorage {
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private resolve(filePath: string): string {
    return path.resolve(this.baseDir, filePath);
  }

  async readText(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(filePath), "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeText(filePath: string, content: string): Promise<void> {
    const full = this.resolve(filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
  }

  async appendText(filePath: string, content: string): Promise<void> {
    const full = this.resolve(filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, content, "utf-8");
  }

  async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.resolve(dir));
      return entries;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async stat(filePath: string): Promise<FileStats | null> {
    try {
      const s = await fs.stat(this.resolve(filePath));
      return {
        size: s.size,
        modifiedAt: s.mtime,
        createdAt: s.birthtime,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(filePath));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}
