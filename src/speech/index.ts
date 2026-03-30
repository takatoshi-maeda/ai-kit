export { createSpeechClient } from "./client.js";
export { createSpeechService } from "./service.js";
export { startSpeechWorker } from "./worker.js";
export type {
  CreateSpeechClientOptions,
  CreateSpeechServiceOptions,
  MountSpeechRoutesOptions,
  SpeechAudioInput,
  SpeechClient,
  SpeechService,
  SpeechTranscriptionResult,
  SpeechTranscriptionSegment,
  SpeechWorkerHandle,
  StartSpeechWorkerOptions,
  TranscribeInput,
  TranscriptionRecord,
  TranscriptionStatus,
} from "./types.js";
