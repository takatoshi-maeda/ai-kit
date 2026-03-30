import { OpenAISpeechClient } from "./providers/openai.js";
import type { CreateSpeechClientOptions, SpeechClient } from "./types.js";

export function createSpeechClient(options: CreateSpeechClientOptions): SpeechClient {
  return new OpenAISpeechClient(options);
}
