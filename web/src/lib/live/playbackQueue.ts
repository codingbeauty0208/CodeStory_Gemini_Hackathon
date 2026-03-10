import { base64ToBytes, parseSampleRateFromMime, pcm16ToAudioBuffer } from "./pcmUtils";

export class AudioPlaybackQueue {
  private ctx: AudioContext | null = null;
  private queue: Promise<void> = Promise.resolve();

  private async getOrCreateContext(): Promise<AudioContext> {
    if (typeof window === "undefined") {
      throw new Error("Audio output is not supported in this environment.");
    }
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Unlock AudioContext on user gesture so playback works when chunks arrive.
   * Call from startListening (mic click) before streaming begins.
   */
  async prepare(): Promise<void> {
    if (typeof window === "undefined") return;
    await this.getOrCreateContext();
  }

  enqueueBase64Audio(base64: string, mimeType: string): void {
    this.queue = this.queue
      .then(async () => {
        const audioContext = await this.getOrCreateContext();
        const bytes = base64ToBytes(base64);

        if (mimeType.toLowerCase().includes("audio/pcm")) {
          const sampleRate = parseSampleRateFromMime(mimeType);
          const buffer = pcm16ToAudioBuffer(audioContext, bytes, sampleRate);
          await playAudioBuffer(audioContext, buffer);
          return;
        }

        const arrayBuffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const decoded = await audioContext.decodeAudioData(arrayBuffer);
        await playAudioBuffer(audioContext, decoded);
      })
      .catch(() => {
        // Keep playback queue alive even if one chunk fails.
      });
  }

  async stop(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.ctx) {
        await this.ctx.close();
        this.ctx = null;
      }
    });
    await this.queue;
  }
}

function playAudioBuffer(audioContext: AudioContext, audioBuffer: AudioBuffer): Promise<void> {
  return new Promise((resolve) => {
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.onended = () => resolve();
    source.start();
  });
}

