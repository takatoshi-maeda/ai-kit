import type { AuthBackendOptions } from "../auth/index.js";

export interface SpeechTranscriptionSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SpeechTranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  segments?: SpeechTranscriptionSegment[];
  provider: string;
  model: string;
  usage?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface SpeechAudioInput {
  mimeType: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface TranscribeInput {
  audio: SpeechAudioInput;
  prompt?: string;
  language?: string;
  temperature?: number;
  responseFormat?: "text" | "json";
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

export interface SpeechClient {
  readonly provider: string;
  readonly model: string;
  transcribe(input: TranscribeInput): Promise<SpeechTranscriptionResult>;
}

export type TranscriptionStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface TranscriptionRecord {
  transcriptionId: string;
  sessionId?: string;
  status: TranscriptionStatus;
  audioAssetRef: string;
  sourceFileName: string;
  mimeType: string;
  provider: string;
  model: string;
  language?: string;
  durationMs?: number;
  text?: string;
  segments?: SpeechTranscriptionSegment[];
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateSpeechServiceOptions {
  client: SpeechClient;
  dataDir?: string;
  maxFileBytes?: number;
  allowedMimeTypes?: string[];
}

export interface SpeechService {
  transcribe(input: TranscribeInput): Promise<TranscriptionRecord>;
  createJob(input: TranscribeInput): Promise<TranscriptionRecord>;
  getJob(transcriptionId: string): Promise<TranscriptionRecord | null>;
  processJob(transcriptionId: string): Promise<TranscriptionRecord | null>;
  processNextJob(): Promise<TranscriptionRecord | null>;
}

export interface CreateSpeechClientOptions {
  provider: "openai" | "google";
  model: string;
  apiKey?: string;
  requestTimeout?: number;
  baseUrl?: string;
  organization?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
}

export interface MountSpeechRoutesOptions {
  service: SpeechService;
  basePath?: string;
  auth?: AuthBackendOptions;
}

export interface StartSpeechWorkerOptions {
  service: SpeechService;
  intervalMs?: number;
}

export interface SpeechWorkerHandle {
  stop(): void;
}
