import path from "node:path";
import { AiKitError } from "../errors.js";
import { FileSystemSpeechStore } from "./storage.js";
import type {
  CreateSpeechServiceOptions,
  SpeechAudioInput,
  SpeechService,
  TranscribeInput,
  TranscriptionRecord,
} from "./types.js";

const DEFAULT_ALLOWED_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
];

export function createSpeechService(options: CreateSpeechServiceOptions): SpeechService {
  const store = new FileSystemSpeechStore(
    path.resolve(options.dataDir ?? path.join("data", "speech")),
  );
  const allowedMimeTypes = new Set(
    (options.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES).map(normalizeMimeType),
  );
  const maxFileBytes = options.maxFileBytes ?? 25 * 1024 * 1024;

  return {
    async transcribe(input) {
      validateAudioInput(input.audio, allowedMimeTypes, maxFileBytes);
      const asset = await store.saveAudio(input.audio);
      const createdAt = new Date().toISOString();
      const baseRecord: TranscriptionRecord = {
        transcriptionId: crypto.randomUUID(),
        sessionId: input.sessionId,
        status: "processing",
        audioAssetRef: asset.assetRef,
        sourceFileName: input.audio.fileName,
        mimeType: normalizeMimeType(input.audio.mimeType),
        provider: options.client.provider,
        model: options.client.model,
        metadata: input.metadata,
        createdAt,
        updatedAt: createdAt,
      };
      await store.writeRecord(baseRecord);
      return await executeTranscription(store, options.client, baseRecord, input);
    },

    async createJob(input) {
      validateAudioInput(input.audio, allowedMimeTypes, maxFileBytes);
      const asset = await store.saveAudio(input.audio);
      const createdAt = new Date().toISOString();
      const record: TranscriptionRecord = {
        transcriptionId: crypto.randomUUID(),
        sessionId: input.sessionId,
        status: "queued",
        audioAssetRef: asset.assetRef,
        sourceFileName: input.audio.fileName,
        mimeType: normalizeMimeType(input.audio.mimeType),
        provider: options.client.provider,
        model: options.client.model,
        metadata: buildPendingMetadata(input),
        createdAt,
        updatedAt: createdAt,
      };
      await store.writeRecord(record);
      return record;
    },

    async getJob(transcriptionId) {
      return await store.getRecord(transcriptionId);
    },

    async processJob(transcriptionId) {
      const record = await store.getRecord(transcriptionId);
      if (!record || record.status !== "queued") {
        return record;
      }
      const audio = await store.readAudio(record.audioAssetRef);
      if (!audio) {
        const failed = {
          ...record,
          status: "failed" as const,
          errorMessage: "audio asset not found",
          updatedAt: new Date().toISOString(),
        };
        await store.writeRecord(failed);
        return failed;
      }
      const processing = {
        ...record,
        status: "processing" as const,
        updatedAt: new Date().toISOString(),
      };
      await store.writeRecord(processing);
      return await executeTranscription(
        store,
        options.client,
        processing,
        {
          audio: {
            bytes: audio.bytes,
            fileName: record.sourceFileName,
            mimeType: record.mimeType,
          },
          ...readPendingMetadata(processing.metadata),
          sessionId: record.sessionId,
        },
      );
    },

    async processNextJob() {
      const [nextJob] = await store.listQueuedRecords(1);
      if (!nextJob) {
        return null;
      }
      return await this.processJob(nextJob.transcriptionId);
    },
  };
}

async function executeTranscription(
  store: FileSystemSpeechStore,
  client: CreateSpeechServiceOptions["client"],
  record: TranscriptionRecord,
  input: TranscribeInput,
): Promise<TranscriptionRecord> {
  const startedAt = Date.now();

  try {
    const result = await client.transcribe(input);
    const completedAt = new Date().toISOString();
    const completed: TranscriptionRecord = {
      ...record,
      status: "completed",
      provider: result.provider,
      model: result.model,
      language: result.language,
      durationMs: result.durationMs,
      text: result.text,
      segments: result.segments,
      completedAt,
      updatedAt: completedAt,
    };
    await store.writeRecord(completed);
    logTranscriptionEvent("completed", completed, input.audio.bytes.byteLength, startedAt);
    return completed;
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failed: TranscriptionRecord = {
      ...record,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: failedAt,
    };
    await store.writeRecord(failed);
    logTranscriptionEvent("failed", failed, input.audio.bytes.byteLength, startedAt);
    return failed;
  }
}

function validateAudioInput(
  audio: SpeechAudioInput,
  allowedMimeTypes: Set<string>,
  maxFileBytes: number,
): void {
  const mimeType = normalizeMimeType(audio.mimeType);
  if (!allowedMimeTypes.has(mimeType)) {
    throw new AiKitError(`unsupported audio mime type: ${mimeType}`);
  }
  if (audio.bytes.byteLength === 0) {
    throw new AiKitError("audio file is empty");
  }
  if (audio.bytes.byteLength > maxFileBytes) {
    throw new AiKitError(`audio file exceeds max size of ${maxFileBytes} bytes`);
  }
}

function normalizeMimeType(value: string): string {
  return value.trim().toLowerCase().split(";")[0] ?? "";
}

function buildPendingMetadata(input: TranscribeInput): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    ...input.metadata,
  };
  if (typeof input.prompt === "string" && input.prompt.length > 0) {
    metadata.prompt = input.prompt;
  }
  if (typeof input.language === "string" && input.language.length > 0) {
    metadata.language = input.language;
  }
  if (typeof input.temperature === "number") {
    metadata.temperature = input.temperature;
  }
  if (typeof input.responseFormat === "string") {
    metadata.responseFormat = input.responseFormat;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readPendingMetadata(metadata: Record<string, unknown> | undefined) {
  return {
    prompt: typeof metadata?.prompt === "string" ? metadata.prompt : undefined,
    language: typeof metadata?.language === "string" ? metadata.language : undefined,
    temperature: typeof metadata?.temperature === "number" ? metadata.temperature : undefined,
    responseFormat: metadata?.responseFormat === "text" || metadata?.responseFormat === "json"
      ? metadata.responseFormat
      : undefined,
    metadata,
  } as Pick<
    TranscribeInput,
    "prompt" | "language" | "temperature" | "responseFormat" | "metadata"
  >;
}

function logTranscriptionEvent(
  status: "completed" | "failed",
  record: TranscriptionRecord,
  sourceFileSize: number,
  startedAt: number,
): void {
  console.log(
    JSON.stringify({
      type: "speech.transcription",
      transcriptionId: record.transcriptionId,
      provider: record.provider,
      model: record.model,
      sourceFileSize,
      durationMs: record.durationMs ?? null,
      latencyMs: Date.now() - startedAt,
      status,
      mimeType: record.mimeType,
    }),
  );
}
