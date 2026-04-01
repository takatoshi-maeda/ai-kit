import { GoogleSpeechClient } from "./providers/google.js";
import { OpenAISpeechClient } from "./providers/openai.js";
import type { CreateSpeechClientOptions, SpeechClient } from "./types.js";

export function createSpeechClient(options: CreateSpeechClientOptions): SpeechClient {
  switch (options.provider) {
    case "google":
      return new GoogleSpeechClient(options);
    case "openai":
      return new OpenAISpeechClient(options);
  }
}
