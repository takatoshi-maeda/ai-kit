export interface FileStats {
  size: number;
  modifiedAt: Date;
  createdAt: Date;
}

export interface DataStorage {
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  appendText(path: string, content: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  stat(path: string): Promise<FileStats | null>;
  deleteFile(path: string): Promise<void>;
}
