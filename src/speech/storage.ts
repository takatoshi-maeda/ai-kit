import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SpeechAudioInput, TranscriptionRecord } from "./types.js";

export interface SpeechStore {
  saveAudio(input: SpeechAudioInput): Promise<{ assetRef: string }>;
  readAudio(assetRef: string): Promise<SpeechAudioInput | null>;
  writeRecord(record: TranscriptionRecord): Promise<void>;
  getRecord(transcriptionId: string): Promise<TranscriptionRecord | null>;
  listQueuedRecords(limit?: number): Promise<TranscriptionRecord[]>;
}

export class FileSystemSpeechStore implements SpeechStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async saveAudio(input: SpeechAudioInput): Promise<{ assetRef: string }> {
    const now = new Date();
    const extension = inferFileExtension(input.mimeType, input.fileName);
    const relativePath = [
      "assets",
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      `${crypto.randomUUID()}.${extension}`,
    ].join("/");
    const fullPath = this.resolve(relativePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.bytes);

    return {
      assetRef: toSpeechAssetRef(relativePath),
    };
  }

  async readAudio(assetRef: string): Promise<SpeechAudioInput | null> {
    const relativePath = fromSpeechAssetRef(assetRef);
    if (!relativePath) {
      return null;
    }
    const fullPath = this.resolve(relativePath);
    try {
      const bytes = await fs.readFile(fullPath);
      return {
        bytes,
        fileName: path.basename(fullPath),
        mimeType: contentTypeFromPath(fullPath),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeRecord(record: TranscriptionRecord): Promise<void> {
    const fullPath = this.resolve(`records/${record.transcriptionId}.json`);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  }

  async getRecord(transcriptionId: string): Promise<TranscriptionRecord | null> {
    const fullPath = this.resolve(`records/${transcriptionId}.json`);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      return JSON.parse(content) as TranscriptionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async listQueuedRecords(limit = 10): Promise<TranscriptionRecord[]> {
    const dir = this.resolve("records");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const content = await fs.readFile(path.join(dir, entry), "utf-8");
          return JSON.parse(content) as TranscriptionRecord;
        }),
    );

    return records
      .filter((record) => record.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  private resolve(relativePath: string): string {
    const normalized = path.posix.normalize(`/${relativePath}`);
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    const fullPath = path.resolve(this.rootDir, ...segments);
    if (fullPath !== this.rootDir && !fullPath.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error("speech path escapes root directory");
    }
    return fullPath;
  }
}

export function toSpeechAssetRef(relativePath: string): string {
  const segments = relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return `speech+file:///${segments.join("/")}`;
}

export function fromSpeechAssetRef(assetRef: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(assetRef);
  } catch {
    return null;
  }
  if (parsed.protocol !== "speech+file:") {
    return null;
  }
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length < 2 || segments[0] !== "assets") {
    return null;
  }
  return segments.join("/");
}

function inferFileExtension(mimeType: string, fileName: string): string {
  const explicit = path.extname(fileName).slice(1).toLowerCase();
  if (/^[a-z0-9]+$/.test(explicit)) {
    return explicit;
  }
  if (mimeType === "audio/mpeg") return "mp3";
  if (mimeType === "audio/mp4") return "mp4";
  if (mimeType === "audio/wav") return "wav";
  if (mimeType === "audio/webm") return "webm";
  if (mimeType === "audio/ogg") return "ogg";
  return "bin";
}

function contentTypeFromPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (extension === "mp3" || extension === "mpeg") return "audio/mpeg";
  if (extension === "mp4" || extension === "m4a") return "audio/mp4";
  if (extension === "wav") return "audio/wav";
  if (extension === "webm") return "audio/webm";
  if (extension === "ogg") return "audio/ogg";
  return "application/octet-stream";
}
