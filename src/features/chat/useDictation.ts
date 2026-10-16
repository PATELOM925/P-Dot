"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// Minimal typings for the browser's Web Speech API (not in the TypeScript DOM lib).
interface SpeechResultAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  0: SpeechResultAlternative;
}
interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const subscribeNothing = () => () => {};

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in your browser settings to dictate.",
  "service-not-allowed": "Microphone access was blocked. Allow it in your browser settings to dictate.",
  "no-speech": "No speech was heard. Try again.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs an internet connection.",
};

/**
 * Speech-to-text in English using the browser's own speech recognition. Final
 * phrases are passed to `onText`; the user reviews and sends the message
 * themselves. P-Dot's servers never receive the audio (the browser vendor's
 * speech service may process it).
 */
export function useDictation(onText: (text: string) => void) {
  const supported = useSyncExternalStore(subscribeNothing, () => getCtor() !== null, () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onTextRef = useRef(onText);

  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  useEffect(() => () => recognitionRef.current?.abort(), []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const Ctor = getCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result?.isFinal) text += result[0].transcript;
      }
      if (text.trim()) onTextRef.current(text.trim());
    };
    recognition.onerror = (event) => {
      setError(ERROR_MESSAGES[event.error] ?? "Dictation stopped unexpectedly.");
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    setError(null);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setError("Dictation could not start. Try again.");
    }
  }, []);

  return { supported, listening, error, toggle };
}
