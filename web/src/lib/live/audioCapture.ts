export type AudioChunkHandler = (pcm16: Uint8Array) => void;

export class AudioCapture {
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private readonly frameDurationMs: number;

  constructor(frameDurationMs = 40) {
    // 20–100ms is fine; 40ms is a good balance for latency vs overhead.
    this.frameDurationMs = frameDurationMs;
  }

  async start(onChunk: AudioChunkHandler): Promise<void> {
    if (this.stream) return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone streaming is not supported in this browser.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const context = new AudioContext({ sampleRate: 16000 });
    if (context.state === "suspended") {
      await context.resume();
    }

    const idealSize = Math.round((context.sampleRate * this.frameDurationMs) / 1000);
    const frameSize = clampToScriptProcessorBufferSize(idealSize);
    const processor = context.createScriptProcessor(frameSize, 1, 1);
    const source = context.createMediaStreamSource(stream);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const pcmBytes = float32ToPcm16Bytes(input);
      onChunk(pcmBytes);
    };

    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(processor);
    processor.connect(gain);
    gain.connect(context.destination);

    this.stream = stream;
    this.context = context;
    this.source = source;
    this.processor = processor;
  }

  stop(): void {
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.context) {
      void this.context.close();
      this.context = null;
    }
  }
}

/** ScriptProcessor requires buffer size to be a power of 2 between 256 and 16384. */
function clampToScriptProcessorBufferSize(size: number): number {
  const MIN = 256;
  const MAX = 16384;
  const s = Math.max(MIN, Math.min(MAX, size));
  const prev = 2 ** Math.floor(Math.log2(s));
  const next = Math.min(MAX, prev * 2);
  return s - prev <= next - s ? prev : next;
}

function float32ToPcm16Bytes(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, Math.round(int16), true);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

