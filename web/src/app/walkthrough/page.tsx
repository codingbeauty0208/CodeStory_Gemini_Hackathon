"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DocsPreview } from "@/components/docs-preview";
import { SlideCanvas } from "@/components/slide-canvas";
import type { WalkthroughContentResponse, WalkthroughStatusResponse } from "@/lib/walkthrough/types";

type ViewMode = "slides" | "docs";
type LiveState = "playing" | "interrupted" | "answering" | "resuming" | "idle";
type LiveMode = "live-ready" | "mock";
type SpeechRecognitionResultLike = {
  transcript: string;
};
type SpeechRecognitionEventLike = {
  results: ArrayLike<ArrayLike<SpeechRecognitionResultLike>>;
};
type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;
type LiveSessionBootstrapResponse = {
  ok: boolean;
  mode?: LiveMode;
  bidi?: {
    enabled?: boolean;
    model?: string;
    apiKey?: string | null;
  };
};
type GeminiLiveConfig = {
  apiKey: string;
  model: string;
};

export default function WalkthroughPage() {
  const [jobId, setJobId] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>("slides");
  const [error, setError] = useState<string | null>(null);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [activeModuleIndex, setActiveModuleIndex] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [liveState, setLiveState] = useState<LiveState>("idle");
  const [liveMode, setLiveMode] = useState<LiveMode>("mock");
  const [liveAnswer, setLiveAnswer] = useState<string | null>(null);
  const [liveBidiEnabled, setLiveBidiEnabled] = useState(false);
  const [content, setContent] = useState<WalkthroughContentResponse | null>(null);
  const [job, setJob] = useState<WalkthroughStatusResponse["job"] | null>(null);
  const [isNarratingSlides, setIsNarratingSlides] = useState(false);
  const narrationRef = useRef(false);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const geminiLiveConfigRef = useRef<GeminiLiveConfig | null>(null);
  const geminiSocketRef = useRef<WebSocket | null>(null);
  const geminiAudioContextRef = useRef<AudioContext | null>(null);
  const geminiPlaybackQueueRef = useRef<Promise<void>>(Promise.resolve());
  const geminiPendingTextRef = useRef("");
  const geminiAudioChunksInTurnRef = useRef(0);
  const geminiTurnCompleteResolverRef = useRef<(() => void) | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCaptureContextRef = useRef<AudioContext | null>(null);
  const micSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);

  const pollStatus = useCallback(async () => {
    const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
    const response = await fetch(`/api/walkthrough/status${query}`, { cache: "no-store" });
    const data = (await response.json()) as WalkthroughStatusResponse;
    if (!response.ok || !data.ok || !data.job) {
      throw new Error(data.error ?? "Failed to fetch walkthrough status.");
    }
    setJob(data.job);
    if (data.job.stage === "failed") {
      throw new Error(data.job.error ?? "Walkthrough generation failed.");
    }
    return data.job.stage;
  }, [jobId]);

  const fetchContent = useCallback(async () => {
    const response = await fetch("/api/walkthrough/content", { cache: "no-store" });
    const data = (await response.json()) as WalkthroughContentResponse;
    if (!response.ok || !data.ok) {
      throw new Error("Failed to load walkthrough content.");
    }
    setContent(data);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setJobId(params.get("jobId"));
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    async function startPolling() {
      try {
        const initialStage = await pollStatus();
        if (initialStage === "ready") {
          await fetchContent();
          return;
        }

        interval = setInterval(async () => {
          try {
            const stage = await pollStatus();
            if (stage === "ready" && !cancelled) {
              if (interval) {
                clearInterval(interval);
              }
              await fetchContent();
            }
          } catch (pollError) {
            if (interval) {
              clearInterval(interval);
            }
            if (!cancelled) {
              setError(
                pollError instanceof Error
                  ? pollError.message
                  : "Unexpected status polling error.",
              );
            }
          }
        }, 1500);
      } catch (initialError) {
        if (!cancelled) {
          setError(
            initialError instanceof Error
              ? initialError.message
              : "Unexpected walkthrough startup error.",
          );
        }
      }
    }

    void startPolling();

    return () => {
      cancelled = true;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [fetchContent, pollStatus]);

  useEffect(() => {
    async function bootstrapLive() {
      try {
        const response = await fetch("/api/live/session", { method: "POST" });
        const data = (await response.json()) as LiveSessionBootstrapResponse;
        if (data.ok && data.mode) {
          setLiveMode(data.mode);
          setLiveState("playing");
          const liveKey = data.bidi?.apiKey?.trim();
          const liveModel = data.bidi?.model?.trim();
          if (data.bidi?.enabled && liveKey && liveModel) {
            geminiLiveConfigRef.current = { apiKey: liveKey, model: liveModel };
            setLiveBidiEnabled(true);
          } else {
            geminiLiveConfigRef.current = null;
            setLiveBidiEnabled(false);
          }
        }
      } catch {
        setLiveMode("mock");
      }
    }

    void bootstrapLive();
  }, []);

  const modules = useMemo(() => content?.deck?.modules ?? [], [content?.deck?.modules]);
  const docs = useMemo(() => content?.docs ?? [], [content?.docs]);

  const activeModule = modules[activeSlideIndex] ?? null;

  const groupedModules = useMemo(() => {
    const groups = new Map<string, Array<{ module: (typeof modules)[number]; index: number }>>();
    modules.forEach((module, index) => {
      const deckName = module.source_deck || "Slides";
      const current = groups.get(deckName) ?? [];
      current.push({ module, index });
      groups.set(deckName, current);
    });
    return Array.from(groups.entries()).map(([deckName, entries]) => ({
      deckName,
      entries,
    }));
  }, [modules]);

  const activeModuleGroup = groupedModules[activeModuleIndex] ?? null;
  const activeModuleIndexes = useMemo(
    () => activeModuleGroup?.entries.map((entry) => entry.index) ?? [],
    [activeModuleGroup],
  );

  useEffect(() => {
    if (!groupedModules.length) {
      return;
    }
    if (activeModuleIndex >= groupedModules.length) {
      setActiveModuleIndex(0);
      setActiveSlideIndex(groupedModules[0]?.entries[0]?.index ?? 0);
      return;
    }

    const currentGroup = groupedModules[activeModuleIndex];
    if (!currentGroup) {
      return;
    }

    const activeIsInGroup = currentGroup.entries.some((entry) => entry.index === activeSlideIndex);
    if (!activeIsInGroup) {
      setActiveSlideIndex(currentGroup.entries[0]?.index ?? 0);
    }
  }, [activeModuleIndex, activeSlideIndex, groupedModules]);

  const activeSlideIndexInModule = useMemo(() => {
    if (!activeModuleIndexes.length) {
      return 0;
    }
    const foundIndex = activeModuleIndexes.findIndex((index) => index === activeSlideIndex);
    return foundIndex >= 0 ? foundIndex : 0;
  }, [activeModuleIndexes, activeSlideIndex]);

  const activeDocForModule = useMemo(() => {
    if (!docs.length) {
      return null;
    }

    const deckName = activeModuleGroup?.deckName ?? "";
    const deckKey = normalizeSectionKey(deckName);
    const docsWithKeys = docs.map((doc) => ({
      doc,
      sectionKey: normalizeSectionKey(doc.sectionName),
      filenameKey: normalizeSectionKey(doc.filename.replace(/\.md$/i, "")),
    }));

    if (deckKey) {
      const exactDeckMatch = docsWithKeys.find(
        ({ sectionKey, filenameKey }) => sectionKey === deckKey || filenameKey === deckKey,
      )?.doc;
      if (exactDeckMatch) {
        return exactDeckMatch;
      }

      const partialDeckMatch = docsWithKeys.find(({ sectionKey, filenameKey }) => {
        return (
          sectionKey.includes(deckKey) ||
          filenameKey.includes(deckKey) ||
          deckKey.includes(sectionKey) ||
          deckKey.includes(filenameKey)
        );
      })?.doc;
      if (partialDeckMatch) {
        return partialDeckMatch;
      }
    }

    const titleKey = normalizeSectionKey(activeModule?.title ?? "");
    if (titleKey) {
      const byTitle = docsWithKeys.find(
        ({ sectionKey, filenameKey }) => sectionKey === titleKey || filenameKey === titleKey,
      )?.doc;
      if (byTitle) {
        return byTitle;
      }

      const byTitlePartial = docsWithKeys.find(({ sectionKey, filenameKey }) => {
        return (
          sectionKey.includes(titleKey) ||
          filenameKey.includes(titleKey) ||
          titleKey.includes(sectionKey) ||
          titleKey.includes(filenameKey)
        );
      })?.doc;
      if (byTitlePartial) {
        return byTitlePartial;
      }
    }

    return null;
  }, [activeModule?.title, activeModuleGroup?.deckName, docs]);

  useEffect(() => {
    narrationRef.current = isNarratingSlides;
  }, [isNarratingSlides]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      recognitionRef.current?.stop();
      if (micProcessorRef.current) {
        micProcessorRef.current.disconnect();
        micProcessorRef.current.onaudioprocess = null;
        micProcessorRef.current = null;
      }
      if (micSourceNodeRef.current) {
        micSourceNodeRef.current.disconnect();
        micSourceNodeRef.current = null;
      }
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
      }
      if (micCaptureContextRef.current) {
        void micCaptureContextRef.current.close();
        micCaptureContextRef.current = null;
      }
      if (geminiSocketRef.current) {
        geminiSocketRef.current.close();
        geminiSocketRef.current = null;
      }
      if (geminiAudioContextRef.current) {
        void geminiAudioContextRef.current.close();
        geminiAudioContextRef.current = null;
      }
    };
  }, []);

  const buildLivePrompt = useCallback(
    (rawQuestion: string) => {
      const context = [
        activeModule ? `${activeModule.title}\n${activeModule.speaker_notes}` : "",
        activeDocForModule ? activeDocForModule.markdown.slice(0, 1800) : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return context ? `Repository walkthrough context:\n${context}\n\nQuestion:\n${rawQuestion}` : rawQuestion;
    },
    [activeDocForModule, activeModule],
  );

  const speakTextFallback = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !text.trim()) {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 0.95;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }, []);

  const closeGeminiLive = useCallback(() => {
    if (geminiSocketRef.current) {
      geminiSocketRef.current.close();
      geminiSocketRef.current = null;
    }
  }, []);

  const stopMicrophoneStreaming = useCallback(() => {
    if (micProcessorRef.current) {
      micProcessorRef.current.disconnect();
      micProcessorRef.current.onaudioprocess = null;
      micProcessorRef.current = null;
    }
    if (micSourceNodeRef.current) {
      micSourceNodeRef.current.disconnect();
      micSourceNodeRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (micCaptureContextRef.current) {
      void micCaptureContextRef.current.close();
      micCaptureContextRef.current = null;
    }
  }, []);

  const getOrCreateAudioContext = useCallback(async () => {
    if (typeof window === "undefined") {
      throw new Error("Audio output is not supported in this environment.");
    }
    if (!geminiAudioContextRef.current) {
      geminiAudioContextRef.current = new AudioContext();
    }
    if (geminiAudioContextRef.current.state === "suspended") {
      await geminiAudioContextRef.current.resume();
    }
    return geminiAudioContextRef.current;
  }, []);

  const startMicrophoneStreaming = useCallback(
    async (socket: WebSocket) => {
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

      const captureContext = new AudioContext({ sampleRate: 16000 });
      if (captureContext.state === "suspended") {
        await captureContext.resume();
      }

      const sourceNode = captureContext.createMediaStreamSource(stream);
      const processorNode = captureContext.createScriptProcessor(4096, 1, 1);

      processorNode.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        const pcmBytes = float32ToPcm16Bytes(input);
        const chunk = bytesToBase64(pcmBytes);

        socket.send(
          JSON.stringify({
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: "audio/pcm;rate=16000",
                  data: chunk,
                },
              ],
            },
          }),
        );
      };

      sourceNode.connect(processorNode);
      processorNode.connect(captureContext.destination);

      micStreamRef.current = stream;
      micCaptureContextRef.current = captureContext;
      micSourceNodeRef.current = sourceNode;
      micProcessorRef.current = processorNode;
    },
    [],
  );

  const enqueueGeminiAudioChunk = useCallback(
    (base64Audio: string, mimeType: string) => {
      geminiPlaybackQueueRef.current = geminiPlaybackQueueRef.current
        .then(async () => {
          const audioContext = await getOrCreateAudioContext();
          const bytes = base64ToBytes(base64Audio);

          if (mimeType.toLowerCase().includes("audio/pcm")) {
            const sampleRate = parseSampleRateFromMime(mimeType);
            const pcmBuffer = pcm16ToAudioBuffer(audioContext, bytes, sampleRate);
            await playAudioBuffer(audioContext, pcmBuffer);
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
    },
    [getOrCreateAudioContext],
  );

  const getOrCreateGeminiSocket = useCallback(async (): Promise<WebSocket> => {
    const existing = geminiSocketRef.current;
    if (existing && existing.readyState === WebSocket.OPEN) {
      return existing;
    }

    const liveConfig = geminiLiveConfigRef.current;
    if (!liveConfig) {
      throw new Error("Gemini Live is not configured.");
    }

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
      liveConfig.apiKey,
    )}`;

    const socket = new WebSocket(wsUrl);
    geminiSocketRef.current = socket;

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Unable to open Gemini live connection."));
    });

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as GeminiLivePayload;
        const serverContent = (payload.serverContent ?? payload.server_content) as
          | {
              turnComplete?: boolean;
              turn_complete?: boolean;
              modelTurn?: { parts?: GeminiLivePart[] };
              model_turn?: { parts?: GeminiLivePart[] };
            }
          | undefined;
        const modelTurn = serverContent?.modelTurn ?? serverContent?.model_turn;
        const parts = modelTurn?.parts ?? [];

        for (const part of parts) {
          if (part.text) {
            geminiPendingTextRef.current = `${geminiPendingTextRef.current}${part.text}`;
            setLiveState("answering");
          }
          const inlineData = part.inlineData ?? part.inline_data;
          const audioData = inlineData?.data;
          const mimeType = inlineData?.mimeType ?? inlineData?.mime_type;
          if (audioData && mimeType) {
            geminiAudioChunksInTurnRef.current += 1;
            enqueueGeminiAudioChunk(audioData, mimeType);
            setLiveState("answering");
          }
        }

        const turnComplete = Boolean(
          serverContent?.turnComplete ?? serverContent?.turn_complete ?? payload.generationComplete,
        );
        if (turnComplete) {
          const finalText = geminiPendingTextRef.current.trim();
          if (finalText) {
            setLiveAnswer(finalText);
            if (geminiAudioChunksInTurnRef.current === 0) {
              speakTextFallback(finalText);
            }
          }
          geminiPendingTextRef.current = "";
          geminiAudioChunksInTurnRef.current = 0;
          if (geminiTurnCompleteResolverRef.current) {
            geminiTurnCompleteResolverRef.current();
            geminiTurnCompleteResolverRef.current = null;
          }
          setLiveState("resuming");
          void sleep(280).then(() => setLiveState("playing"));
        }
      } catch {
        // Ignore malformed messages; live stream can continue.
      }
    };
    socket.onclose = () => {
      if (geminiSocketRef.current === socket) {
        geminiSocketRef.current = null;
      }
    };

    socket.send(
      JSON.stringify({
        setup: {
          model: `models/${liveConfig.model}`,
          generationConfig: {
            responseModalities: ["AUDIO", "TEXT"],
          },
          realtimeInputConfig: {
            automaticActivityDetection: {},
          },
        },
      }),
    );

    return socket;
  }, [enqueueGeminiAudioChunk, speakTextFallback]);

  const submitQuestionWithGeminiLive = useCallback(
    async (rawQuestion: string, options?: { withContext?: boolean }) => {
      const trimmedQuestion = rawQuestion.trim();
      if (!trimmedQuestion) {
        return;
      }

      setLiveAnswer(null);
      setLiveState("interrupted");
      await sleep(300);
      setLiveState("answering");

      // Unlock AudioContext on this user gesture so Gemini audio playback works.
      await getOrCreateAudioContext().catch(() => {});

      try {
        const socket = await getOrCreateGeminiSocket();
        geminiPendingTextRef.current = "";
        geminiAudioChunksInTurnRef.current = 0;
        const prompt = options?.withContext === false ? trimmedQuestion : buildLivePrompt(trimmedQuestion);
        const turnCompletePromise = new Promise<void>((resolve) => {
          geminiTurnCompleteResolverRef.current = resolve;
        });

        socket.send(
          JSON.stringify({
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [{ text: prompt }],
                },
              ],
              turnComplete: true,
            },
          }),
        );

        const timedOut = await Promise.race([
          turnCompletePromise.then(() => false),
          sleep(9000).then(() => true),
        ]);
        if (timedOut) {
          geminiTurnCompleteResolverRef.current = null;
          const pendingText = geminiPendingTextRef.current.trim();
          if (pendingText) {
            setLiveAnswer(pendingText);
            speakTextFallback(pendingText);
          } else {
            const fallbackLine = "Live audio response is delayed. Please retry your question.";
            setLiveAnswer(fallbackLine);
            speakTextFallback(fallbackLine);
          }
          geminiPendingTextRef.current = "";
          geminiAudioChunksInTurnRef.current = 0;
        }
      } catch {
        geminiTurnCompleteResolverRef.current = null;
        closeGeminiLive();
        throw new Error("Gemini live bidirectional request failed.");
      }

      setLiveState("resuming");
      await sleep(400);
      setLiveState("playing");
    },
    [buildLivePrompt, closeGeminiLive, getOrCreateAudioContext, getOrCreateGeminiSocket],
  );

  const submitQuestion = useCallback(
    async (rawQuestion: string) => {
      const trimmedQuestion = rawQuestion.trim();
      if (!trimmedQuestion) {
        return;
      }

      setLiveAnswer(null);
      setLiveState("interrupted");

      await sleep(300);
      setLiveState("answering");

      const context = [
        activeModule ? `${activeModule.title}\n${activeModule.speaker_notes}` : "",
        activeDocForModule ? activeDocForModule.markdown.slice(0, 1800) : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      try {
        const response = await fetch("/api/live/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmedQuestion, context }),
        });
        const data = (await response.json()) as { ok: boolean; answer?: string; error?: string };
        if (!response.ok || !data.ok) {
          throw new Error(data.error ?? "Failed to get live answer.");
        }
        setLiveAnswer(data.answer ?? "No answer generated.");
      } catch (askError) {
        setLiveAnswer(
          askError instanceof Error ? askError.message : "Unexpected error while fetching answer.",
        );
      }

      setLiveState("resuming");
      await sleep(400);
      setLiveState("playing");
    },
    [activeDocForModule, activeModule],
  );

  const onToggleSlideNarration = () => {
    setViewMode("slides");
    if (narrationRef.current) {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      stopMicrophoneStreaming();
      setIsListening(false);
      closeGeminiLive();
      setIsNarratingSlides(false);
      return;
    }

    if (!modules.length) {
      setError("No slides available to narrate.");
      return;
    }

    setError(null);
    stopMicrophoneStreaming();
    setIsListening(false);
    setIsNarratingSlides(true);
    if (liveBidiEnabled) {
      void getOrCreateAudioContext().catch(() => {
        // Keep flow alive; text fallback still handles output.
      });
      void speakSlideWithGeminiLive(activeSlideIndex);
      return;
    }
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setError("Speech synthesis is not supported in this browser.");
      setIsNarratingSlides(false);
      return;
    }
    speakSlide(activeSlideIndex);
  };

  const speakSlide = (slideIndex: number) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setIsNarratingSlides(false);
      return;
    }

    if (slideIndex < 0 || slideIndex >= modules.length) {
      setIsNarratingSlides(false);
      return;
    }

    const slideModule = modules[slideIndex];
    if (!slideModule) {
      setIsNarratingSlides(false);
      return;
    }

    setActiveSlideIndex(slideIndex);
    const synth = window.speechSynthesis;
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(buildSlideNarration(slideModule));
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.lang = "en-US";

    utterance.onend = () => {
      if (!narrationRef.current) {
        return;
      }

      const currentPosition = activeModuleIndexes.findIndex((index) => index === slideIndex);
      const nextSlideIndex =
        currentPosition >= 0 ? activeModuleIndexes[currentPosition + 1] : undefined;

      if (nextSlideIndex === undefined) {
        setIsNarratingSlides(false);
        return;
      }
      speakSlide(nextSlideIndex);
    };

    utterance.onerror = () => {
      setIsNarratingSlides(false);
      setError("Unable to narrate slides. Please check browser audio permissions.");
    };

    synth.speak(utterance);
  };

  const speakSlideWithGeminiLive = async (slideIndex: number): Promise<void> => {
    if (!narrationRef.current) {
      return;
    }
    if (slideIndex < 0 || slideIndex >= modules.length) {
      setIsNarratingSlides(false);
      return;
    }

    const slideModule = modules[slideIndex];
    if (!slideModule) {
      setIsNarratingSlides(false);
      return;
    }

    setActiveSlideIndex(slideIndex);
    const narrationPrompt = `Narrate this slide clearly and concisely for a live walkthrough.\n\n${buildSlideNarration(
      slideModule,
    )}`;

    try {
      await submitQuestionWithGeminiLive(narrationPrompt, { withContext: false });
    } catch {
      setError("Gemini Live narration failed. Falling back to browser narration.");
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        speakSlide(slideIndex);
      } else {
        setIsNarratingSlides(false);
      }
      return;
    }

    if (!narrationRef.current) {
      return;
    }
    const currentPosition = activeModuleIndexes.findIndex((index) => index === slideIndex);
    const nextSlideIndex = currentPosition >= 0 ? activeModuleIndexes[currentPosition + 1] : undefined;
    if (nextSlideIndex === undefined) {
      setIsNarratingSlides(false);
      return;
    }
    await speakSlideWithGeminiLive(nextSlideIndex);
  };

  const onTestSpeaker = useCallback(async () => {
    if (typeof window === "undefined") {
      return;
    }
    setError(null);
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    try {
      const ctx = await getOrCreateAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(0, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
      await sleep(250);
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance("If you can hear this, your speaker is working.");
        u.lang = "en-US";
        u.rate = 0.95;
        window.speechSynthesis.speak(u);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Speaker test failed. Check system volume and permissions.",
      );
    }
  }, [getOrCreateAudioContext]);

  const onToggleListening = () => {
    if (typeof window === "undefined") {
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      stopMicrophoneStreaming();
      if (geminiSocketRef.current?.readyState === WebSocket.OPEN) {
        geminiSocketRef.current.send(
          JSON.stringify({
            realtimeInput: {
              audioStreamEnd: true,
            },
          }),
        );
      }
      setIsListening(false);
      setLiveState((current) => (current === "interrupted" ? "playing" : current));
      return;
    }

    if (liveBidiEnabled) {
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        setIsNarratingSlides(false);
      }
      recognitionRef.current?.stop();
      stopMicrophoneStreaming();
      closeGeminiLive();

      setError(null);
      setLiveAnswer(null);
      setIsListening(true);
      setLiveState("interrupted");

      // Unlock AudioContext on this user gesture so Gemini playback works when chunks arrive.
      void getOrCreateAudioContext().catch(() => {});

      void (async () => {
        try {
          const socket = await getOrCreateGeminiSocket();
          await startMicrophoneStreaming(socket);
        } catch {
          setIsListening(false);
          setLiveState("playing");
          setError("Unable to stream microphone to Gemini Live. Falling back to browser speech capture.");
        }
      })();
      return;
    }

    const speechRecognitionCtor = (
      window as Window & {
        SpeechRecognition?: BrowserSpeechRecognitionConstructor;
        webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
      }
    ).SpeechRecognition ??
      (
        window as Window & {
          SpeechRecognition?: BrowserSpeechRecognitionConstructor;
          webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
        }
      ).webkitSpeechRecognition;

    if (!speechRecognitionCtor) {
      setError("Speech recognition is not supported in this browser.");
      return;
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setIsNarratingSlides(false);
    }
    stopMicrophoneStreaming();
    closeGeminiLive();

    const recognition = new speechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result?.[0]?.transcript ?? "")
        .join(" ")
        .trim();

      if (!transcript) {
        return;
      }

      if (liveBidiEnabled) {
        void submitQuestionWithGeminiLive(transcript).catch(async () => {
          await submitQuestion(transcript);
        });
        return;
      }

      void submitQuestion(transcript);
    };

    recognition.onerror = () => {
      setIsListening(false);
      setLiveState("playing");
      setError("Unable to capture microphone input. Please allow mic access and try again.");
    };

    recognition.onend = () => {
      setIsListening(false);
      setLiveState((current) => (current === "interrupted" ? "playing" : current));
    };

    try {
      setError(null);
      recognitionRef.current = recognition;
      setIsListening(true);
      setLiveState("interrupted");
      recognition.start();
    } catch {
      setIsListening(false);
      setLiveState("playing");
      setError("Failed to start microphone. Please retry.");
    }
  };

  return (
    <div className="h-[100dvh] overflow-hidden bg-[#F4F7FF] p-3 text-slate-900 md:p-6">
      <header className="fixed top-0 left-0 right-0 z-40 bg-white/80 backdrop-blur-md border-b border-[#E2E8F0] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Image src="/logo.png" alt="CodeStory logo" width={108} height={30} priority />
          <div>
            <h1 className="text-base font-bold text-[#0F172A] leading-none">CodeStory</h1>
            <p className="text-[11px] font-medium text-[#64748B] mt-1 tracking-wide">Live Walkthrough</p>
          </div>
        </div>

        <div className="hidden md:flex items-center gap-8 text-[13px] font-semibold text-[#64748B]">
          <button className="hover:text-[#0F172A] transition-colors">Dashboard</button>
          <button className="text-[#3B82F6]">Walkthroughs</button>
          <button className="hover:text-[#0F172A] transition-colors">Settings</button>
        </div>

        <div className="flex items-center gap-4">
          <button className="relative text-[#64748B] hover:text-[#0F172A] transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
            <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-[#EF4444] border-2 border-white"></span>
          </button>
          <div className="w-8 h-8 rounded-lg bg-[#F1F5F9] border border-[#E2E8F0] overflow-hidden flex items-center justify-center text-[#64748B] font-medium text-xs">
            <div className="w-full h-full bg-[#FDBA74] opacity-40"></div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid h-[calc(100dvh-84px)] max-w-[1400px] gap-4 lg:grid-cols-[320px_1fr] pt-18 relative">
        <aside className="rounded-[1.5rem] bg-white p-4 shadow-[0_2px_12px_rgb(0,0,0,0.03)] border border-[#E2E8F0] h-full flex flex-col relative z-10 overflow-hidden">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <svg className="w-5 h-5 text-[#334155]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                <h1 className="text-[15px] font-bold text-[#0F172A] tracking-tight">{job?.githubUrl?.split("/").pop() || "CodeStory"}</h1>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#64748B]">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <span>{job?.id?.slice(0, 7) || "latest"}</span>
              </div>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold tracking-widest uppercase ${liveMode === "live-ready" ? "bg-[#ECFDF5] text-[#10B981]" : "bg-[#F0FDF4] text-[#16A34A]"
              }`}>
              {liveMode === "live-ready" ? "LIVE" : "LIVE"}
            </span>
          </div>

          <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
            Modules
          </p>

          <div className="flex-1 overflow-y-auto pr-2 -mr-2 space-y-1 scrollbar-thin scrollbar-thumb-[#CBD5E1] scrollbar-track-transparent">
            <div className="space-y-1">
              {groupedModules.map((group, groupIndex) => {
                const isActive = groupIndex === activeModuleIndex;
                return (
                  <button
                    key={group.deckName}
                    type="button"
                    onClick={() => {
                      setActiveModuleIndex(groupIndex);
                      setActiveSlideIndex(group.entries[0]?.index ?? 0);
                    }}
                    className={`w-full group rounded-xl px-3 py-2.5 text-left transition-all duration-200 border border-transparent ${
                      isActive ? "bg-[#EFF6FF] border-[#BFDBFE] shadow-sm" : "hover:bg-[#F8FAFC]"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-[12px] font-semibold ${isActive ? "text-[#1D4ED8]" : "text-[#64748B]"}`}
                      >
                        {String(groupIndex + 1).padStart(2, "0")}
                      </span>
                      <div className="flex-1 min-w-0">
                        <h3
                          className={`truncate text-[13px] font-semibold ${
                            isActive ? "text-[#1D4ED8]" : "text-[#0F172A] group-hover:text-[#3B82F6]"
                          }`}
                        >
                          {formatSectionName(group.deckName)}
                        </h3>
                      </div>
                      {isActive ? <div className="w-2 h-2 rounded-full bg-[#3B82F6] shrink-0 animate-pulse" /> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

        </aside>

        <section className="flex flex-col h-full gap-3 relative overflow-hidden">
          <div className="flex shrink-0 justify-end">
            <div className="inline-flex rounded-full border border-[#E2E8F0] bg-white p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("slides")}
                className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
                  viewMode === "slides" ? "bg-[#3B82F6] text-white" : "text-[#475569] hover:bg-[#F8FAFC]"
                }`}
              >
                Slides
              </button>
              <button
                type="button"
                onClick={() => setViewMode("docs")}
                className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
                  viewMode === "docs" ? "bg-[#3B82F6] text-white" : "text-[#475569] hover:bg-[#F8FAFC]"
                }`}
              >
                Documentation
              </button>
            </div>
          </div>

          {error ? (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 rounded-full border border-red-200 bg-white/90 px-6 py-2 text-[13px] font-medium text-red-600 shadow-xl backdrop-blur-md">
              {error}
            </div>
          ) : null}

          <div className="relative flex-1 min-h-0 rounded-[1.5rem] flex flex-col overflow-hidden">
            {/* Very faint background decoration */}
            <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-blue-50/50 rounded-full blur-[100px] pointer-events-none -z-10"></div>

            {viewMode === "slides" ? (
              <>
                <div className="absolute left-3 top-1/2 -translate-y-1/2 z-20">
                  <button
                    type="button"
                    onClick={() => {
                      const prevIndex = activeModuleIndexes[activeSlideIndexInModule - 1];
                      if (prevIndex !== undefined) {
                        setActiveSlideIndex(prevIndex);
                      }
                    }}
                    disabled={activeSlideIndexInModule <= 0}
                    className="w-11 h-11 flex items-center justify-center rounded-full bg-white/95 shadow-[0_4px_20px_rgb(0,0,0,0.08)] text-[#64748B] hover:text-[#0F172A] disabled:opacity-0 transition-all border border-[#F1F5F9]"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" /></svg>
                  </button>
                </div>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 z-20">
                  <button
                    type="button"
                    onClick={() => {
                      const nextIndex = activeModuleIndexes[activeSlideIndexInModule + 1];
                      if (nextIndex !== undefined) {
                        setActiveSlideIndex(nextIndex);
                      }
                    }}
                    disabled={activeSlideIndexInModule >= activeModuleIndexes.length - 1}
                    className="w-11 h-11 flex items-center justify-center rounded-full bg-white/95 shadow-[0_4px_20px_rgb(0,0,0,0.08)] text-[#64748B] hover:text-[#0F172A] disabled:opacity-0 transition-all border border-[#F1F5F9]"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
                  </button>
                </div>
              </>
            ) : null}

            {viewMode === "slides" ? (
              <SlideCanvas
                module={activeModule}
                currentSlideNumber={activeSlideIndexInModule + 1}
                totalSlides={activeModuleIndexes.length}
              />
            ) : (
              <DocsPreview markdown={activeDocForModule?.markdown ?? null} />
            )}
          </div>

          <div className="shrink-0 flex items-center justify-center gap-5 pt-2">
            <button
              type="button"
              onClick={onToggleListening}
              className={`h-11 w-11 flex items-center justify-center rounded-full border transition ${
                isListening
                  ? "bg-[#EF4444] text-white border-[#EF4444]"
                  : "bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#0F172A] hover:border-[#CBD5E1]"
              }`}
              title={isListening ? "Stop Microphone" : "Start Microphone"}
            >
              <svg className={`w-5 h-5 ${isListening ? "animate-pulse" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </button>

            <button
              type="button"
              onClick={onToggleSlideNarration}
              className="h-12 min-w-[120px] px-5 inline-flex items-center justify-center gap-2 rounded-full bg-[#3B82F6] text-white text-[13px] font-semibold shadow-md shadow-blue-500/20 transition hover:bg-[#2563EB]"
              title={isNarratingSlides ? "Stop narration" : "Play narration"}
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                  clipRule="evenodd"
                />
              </svg>
              {isNarratingSlides ? "Stop" : "Play"}
            </button>

            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined" && "speechSynthesis" in window) {
                  window.speechSynthesis.cancel();
                }
                stopMicrophoneStreaming();
                setIsListening(false);
                closeGeminiLive();
                setIsNarratingSlides(false);
                narrationRef.current = false;
              }}
              className="h-11 w-11 flex items-center justify-center rounded-full border border-[#E2E8F0] bg-white text-[#64748B] transition hover:text-[#0F172A] hover:border-[#CBD5E1]"
              title="Stop voice output"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M11 5 6 9H3v6h3l5 4V5Z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M19 9v6M16 7v10" />
              </svg>
            </button>

            <button
              type="button"
              onClick={onTestSpeaker}
              className="rounded-full border border-[#E2E8F0] bg-white px-3 py-2 text-[11px] font-medium text-[#64748B] transition hover:border-[#CBD5E1] hover:text-[#0F172A]"
              title="Play a short tone and spoken phrase to verify audio"
            >
              Test speaker
            </button>
          </div>

          {liveAnswer ? (
            <div className="shrink-0 rounded-2xl border border-[#E2E8F0] bg-white px-4 py-3 text-[13px] text-[#334155] shadow-sm">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">
                CodeStory Voice Reply
              </p>
              {liveAnswer}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeSectionKey(value: string): string {
  return normalizeLookupKey(value).replace(/^\d+/, "").replace(/(documentation|docs|section|module)$/i, "");
}

function formatSectionName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

type GeminiLivePart = {
  text?: string;
  inlineData?: {
    mimeType?: string;
    mime_type?: string;
    data?: string;
  };
  inline_data?: {
    mimeType?: string;
    mime_type?: string;
    data?: string;
  };
};

type GeminiLivePayload = {
  generationComplete?: boolean;
  serverContent?: {
    turnComplete?: boolean;
    modelTurn?: {
      parts?: GeminiLivePart[];
    };
  };
  server_content?: {
    turn_complete?: boolean;
    model_turn?: {
      parts?: GeminiLivePart[];
    };
  };
};

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function float32ToPcm16Bytes(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, Math.round(int16), true);
  }
  return bytes;
}

function parseSampleRateFromMime(mimeType: string): number {
  const match = mimeType.match(/rate=(\d+)/i);
  const parsed = match?.[1] ? Number.parseInt(match[1], 10) : 24000;
  return Number.isFinite(parsed) ? parsed : 24000;
}

function pcm16ToAudioBuffer(
  audioContext: AudioContext,
  bytes: Uint8Array,
  sampleRate: number,
): AudioBuffer {
  const frameCount = Math.floor(bytes.length / 2);
  const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
  const channelData = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < frameCount; index += 1) {
    const sample = view.getInt16(index * 2, true);
    channelData[index] = sample / 32768;
  }
  return buffer;
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

function buildSlideNarration(
  module: NonNullable<WalkthroughContentResponse["deck"]>["modules"][number],
): string {
  const sectionNarration = module.sections
    .map((section) => {
      const title = section.title ? `${section.title}. ` : "";

      if (section.type === "bullets" && section.items.length) {
        return `${title}${section.items.join(". ")}`;
      }

      if (section.type === "code" && section.code) {
        return `${title}Code snippet: ${section.code.slice(0, 500)}`;
      }

      if (section.type === "mermaid" && section.code) {
        return `${title}Diagram explanation section.`;
      }

      if (section.type === "text" && section.text) {
        return `${title}${section.text}`;
      }

      if (section.type === "image" && section.urls.length) {
        return `${title}Visual reference slide with supporting image.`;
      }

      return title.trim();
    })
    .filter(Boolean)
    .join(". ");

  const speakerNotes = module.speaker_notes ? `Speaker notes: ${module.speaker_notes}` : "";
  return [module.title, module.subtitle, sectionNarration, speakerNotes].filter(Boolean).join(". ");
}
