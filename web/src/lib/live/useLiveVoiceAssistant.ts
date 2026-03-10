import { useCallback, useEffect, useRef, useState } from "react";

import { AudioCapture } from "./audioCapture";
import { GeminiLiveSession } from "./geminiLiveSession";
import { AudioPlaybackQueue } from "./playbackQueue";

type AssistantState = "idle" | "answering" | "connecting";

function computeRms(pcm16: Uint8Array): number {
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  let sum = 0;
  const n = Math.floor(pcm16.length / 2);
  for (let i = 0; i < n; i += 1) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return n > 0 ? Math.sqrt(sum / n) * 32768 : 0;
}

export function useLiveVoiceAssistant(config: { apiKey: string; liveModel: string }) {
  const [isListening, setIsListening] = useState(false);
  const [assistantState, setAssistantState] = useState<AssistantState>("idle");
  const [lastText, setLastText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  const captureRef = useRef<AudioCapture | null>(null);
  const playbackRef = useRef<AudioPlaybackQueue | null>(null);
  const sessionRef = useRef<GeminiLiveSession | null>(null);

  // Initialise / reinitialise session when API key or model changes.
  useEffect(() => {
    setIsReady(false);
    if (!config.apiKey || !config.liveModel) {
      return;
    }

    const session = new GeminiLiveSession({
      apiKey: config.apiKey,
      model: config.liveModel,
    });
    const playback = new AudioPlaybackQueue();

    session.on("state", (st) => {
      if (st === "ready") {
        setIsReady(true);
      }
      if (st === "answering") {
        setAssistantState("answering");
      } else if (st === "connecting") {
        setAssistantState("connecting");
      } else {
        setAssistantState("idle");
      }
    });

    session.on("audioChunk", (b64, mime) => {
      playback.enqueueBase64Audio(b64, mime);
    });

    session.on("text", (text) => {
      setLastText(text);
    });

    session.on("error", (message) => {
      setError(message);
    });

    sessionRef.current = session;
    playbackRef.current = playback;

    void session.connect().catch((err) => setError(String(err)));

    return () => {
      void session.close();
      void playback.stop();
      sessionRef.current = null;
      playbackRef.current = null;
    };
  }, [config.apiKey, config.liveModel]);

  const startListening = useCallback(async () => {
    if (isListening) {
      return;
    }
    if (!config.apiKey || !config.liveModel) {
      setError("Gemini Live is not configured.");
      return;
    }

    setError(null);
    setLastText(null);

    const session = sessionRef.current;
    const playback = playbackRef.current;
    if (!session || !playback) {
      setError("Live session is not ready.");
      return;
    }

    try {
      await session.waitUntilReady();
    } catch {
      setError("Gemini Live connection timeout. Please try again.");
      return;
    }

    // Interrupt any current playback when user starts talking.
    await playback.stop();

    // Unlock AudioContext on this user gesture so playback works when chunks arrive.
    await playback.prepare();

    const capture = new AudioCapture(40);
    captureRef.current = capture;

    let silenceFrames = 0;
    let hasHadSpeech = false;
    let hasSentEndForUtterance = false;
    const SILENCE_THRESHOLD_FRAMES = 25;
    const SPEECH_ENERGY_THRESHOLD = 300;

    await capture.start(async (pcm16) => {
      const rms = computeRms(pcm16);
      const isSpeech = rms > SPEECH_ENERGY_THRESHOLD;

      if (isSpeech) {
        hasHadSpeech = true;
        silenceFrames = 0;
        hasSentEndForUtterance = false;
      } else if (hasHadSpeech) {
        silenceFrames += 1;
        if (
          silenceFrames >= SILENCE_THRESHOLD_FRAMES &&
          !hasSentEndForUtterance
        ) {
          hasSentEndForUtterance = true;
          void session.endAudioStream();
        }
      }

      await session.sendAudioChunk(pcm16);
    });

    setIsListening(true);
  }, [config.apiKey, config.liveModel, isListening]);

  const stopListening = useCallback(async () => {
    if (!isListening) {
      return;
    }

    setIsListening(false);
    captureRef.current?.stop();
    captureRef.current = null;

    if (sessionRef.current) {
      await sessionRef.current.endAudioStream();
    }
  }, [isListening]);

  const sendText = useCallback(async (text: string) => {
    setError(null);
    setLastText(null);

    if (playbackRef.current) {
      await playbackRef.current.stop();
    }
    if (!sessionRef.current) {
      setError("Live session is not ready.");
      return;
    }
    await sessionRef.current.startTurnWithText(text);
  }, []);

  return {
    isListening,
    assistantState,
    lastText,
    error,
    isReady,
    startListening,
    stopListening,
    sendText,
  };
}

