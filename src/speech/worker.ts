import type { SpeechWorkerHandle, StartSpeechWorkerOptions } from "./types.js";

export function startSpeechWorker(options: StartSpeechWorkerOptions): SpeechWorkerHandle {
  const intervalMs = Math.max(250, options.intervalMs ?? 2000);
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      await options.service.processNextJob();
    } catch (error) {
      console.error(
        "[ai-kit] speech worker failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
