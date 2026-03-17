import { FilesystemPersistence } from "../persistence/filesystem.js";

/**
 * Backward-compatible class name for the existing JSONL filesystem backend.
 */
export class JsonlMcpPersistence extends FilesystemPersistence {}

export { FilesystemPersistence } from "../persistence/filesystem.js";
