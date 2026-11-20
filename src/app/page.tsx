"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type SpeechChunk = { id: string; index: number; text: string };

// SONIVOX currently validates JavaScript string.length (UTF-16 code units).
// Segment by sentence/word first, then by grapheme as the last resort.
function splitSpeechText(text: string, limit = 1000): SpeechChunk[] {
  if (!text) return [];
  const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const words = new Intl.Segmenter(undefined, { granularity: "word" });
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const output: string[] = [];
  let current = "";

  const append = (piece: string) => {
    if (current.length + piece.length <= limit) {
      current += piece;
      return;
    }
    if (current) output.push(current);
    current = "";
    if (piece.length <= limit) {
      current = piece;
      return;
    }
    let fragment = "";
    for (const item of graphemes.segment(piece)) {
      if (fragment.length + item.segment.length > limit) {
        if (fragment) output.push(fragment);
        fragment = "";
      }
      fragment += item.segment;
    }
    current = fragment;
  };

  for (const sentence of sentences.segment(text)) {
    if (current.length + sentence.segment.length <= limit) {
      current += sentence.segment;
      continue;
    }
    if (current) {
      output.push(current);
      current = "";
    }
    for (const word of words.segment(sentence.segment)) append(word.segment);
  }
  if (current) output.push(current);
  return output.map((value, index) => ({ id: `chunk-${index}`, index, text: value }));
}

type ChatMessage = { role: "user" | "assistant"; content: string; id: number };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceSession, setVoiceSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const [status, setStatus] = useState("Connecting services…");
  const [chatReady, setChatReady] = useState(false);
  const [speechReady, setSpeechReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [lastHeard, setLastHeard] = useState("");
  const [retryChunk, setRetryChunk] = useState<{
    chunks: SpeechChunk[];
    index: number;
    responseId: string;
    sessionId: number | null;
    lang: string;
    audioUrl?: string;
  } | null>(null);
  const [audioNeedsGesture, setAudioNeedsGesture] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionRef = useRef(false);
  const busyRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {});
  const voiceSessionIdRef = useRef(0);
  const speechControllersRef = useRef(new Map<string, { controller: AbortController; sessionId: number | null }>());
  const activeSpeechIdRef = useRef<string | null>(null);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { sessionRef.current = voiceSession; }, [voiceSession]);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  const resumeListening = useCallback(() => {
    if (!sessionRef.current || busyRef.current || !recognitionRef.current) return;
    try { recognitionRef.current.start(); } catch { /* already starting */ }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/status").then((r) => r.json()).then((data) => {
      if (!alive) return;
      setChatReady(Boolean(data.chatConfigured));
      setSpeechReady(Boolean(data.speechConfigured));
      setStatus(data.chatConfigured && data.speechConfigured
        ? "Both AI services are configured"
        : data.chatConfigured ? "AI ready · speech setup needs attention"
        : "Add your API keys in Vercel");
    }).catch(() => alive && setStatus("Could not check service setup"));

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Recognition) {
      const recognition = new Recognition();
      recognition.lang = "en-US";
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onstart = () => setListening(true);
      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results as ArrayLike<any>)
          .slice(event.resultIndex || 0)
          .filter((result: any) => result.isFinal)
          .map((result: any) => result[0]?.transcript || "")
          .join(" ").trim();
        if (transcript) {
          setLastHeard(transcript);
          void sendRef.current(transcript);
        }
      };
      recognition.onerror = (event: any) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setNotice("Microphone permission was blocked. Allow microphone access in your browser settings.");
          setVoiceSession(false);
          sessionRef.current = false;
        } else if (event.error !== "no-speech" && event.error !== "aborted") {
          setNotice(`Microphone error: ${event.error}`);
        }
      };
      recognition.onend = () => {
        setListening(false);
        if (sessionRef.current && !busyRef.current) {
          window.setTimeout(() => {
            if (sessionRef.current && !busyRef.current) {
              try { recognition.start(); } catch { /* browser is still resetting */ }
            }
          }, 450);
        }
      };
      recognitionRef.current = recognition;
    }

    return () => {
      alive = false;
      sessionRef.current = false;
      recognitionRef.current?.abort();
      for (const entry of speechControllersRef.current.values()) entry.controller.abort();
      speechControllersRef.current.clear();
      audioRef.current?.pause();
    };
  }, []);

  const playAudioUrl = useCallback((url: string, signal: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const audio = audioRef.current;
      if (!audio) return reject(new Error("Audio player is unavailable."));
      if (signal.aborted) return reject(new DOMException("Playback cancelled", "AbortError"));

      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio.src = url;

      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const onEnded = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("Audio could not be loaded or decoded.")); };
      const onAbort = () => {
        audio.pause();
        cleanup();
        reject(new DOMException("Playback cancelled", "AbortError"));
      };

      audio.addEventListener("ended", onEnded, { once: true });
      audio.addEventListener("error", onError, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      audio.play().catch((error: unknown) => { cleanup(); reject(error); });
    });
  }, []);

  const runSpeech = useCallback(async (
    task: { chunks: SpeechChunk[]; responseId: string; sessionId: number | null; lang: string },
    startIndex = 0,
  ) => {
    if (activeSpeechIdRef.current && activeSpeechIdRef.current !== task.responseId) {
      speechControllersRef.current.get(activeSpeechIdRef.current)?.controller.abort();
    }
    audioRef.current?.pause();

    const controller = new AbortController();
    speechControllersRef.current.set(task.responseId, { controller, sessionId: task.sessionId });
    activeSpeechIdRef.current = task.responseId;

    for (let index = startIndex; index < task.chunks.length; index += 1) {
      const chunk = task.chunks[index];
      let audioUrl: string | undefined;
      try {
        if (controller.signal.aborted) throw new DOMException("Speech cancelled", "AbortError");
        if (task.sessionId !== null &&
          (!sessionRef.current || voiceSessionIdRef.current !== task.sessionId)) {
          throw new DOMException("Voice session ended", "AbortError");
        }

        // Just-in-time generation avoids keeping signed URLs waiting in a long queue.
        const response = await fetch("/api/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunk.text, lang: task.lang }),
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Speech request failed (HTTP ${response.status}).`);
        }
        const audioBlob = await response.blob();
        if (!audioBlob.size || !audioBlob.type.toLowerCase().startsWith("audio/")) {
          throw new Error("SONIVOX returned an empty or unsupported audio file.");
        }
        audioUrl = URL.createObjectURL(audioBlob);
        await playAudioUrl(audioUrl, controller.signal);
        URL.revokeObjectURL(audioUrl);
        audioUrl = undefined;
        setRetryChunk(null);
        setAudioNeedsGesture(false);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          return;
        }
        const reason = error instanceof Error ? error.message : "Speech playback failed.";
        setRetryChunk({ ...task, index, audioUrl });
        const blocked = error instanceof DOMException && error.name === "NotAllowedError";
        setAudioNeedsGesture(blocked);
        setNotice(blocked
          ? "Audio is ready, but your browser blocked automatic playback. Tap “Play / retry audio”."
          : `AI replied, but voice chunk ${index + 1} failed: ${reason}`);
        return;
      }
    }

    setRetryChunk(null);
    setAudioNeedsGesture(false);
    if (activeSpeechIdRef.current === task.responseId) activeSpeechIdRef.current = null;
    speechControllersRef.current.delete(task.responseId);
  }, [playAudioUrl]);

  const retryFailedSpeech = async () => {
    const task = retryChunk;
    if (!task) return;
    setNotice("");
    if (task.audioUrl) {
      const controller = new AbortController();
      try {
        // Invoked directly by the user's tap for mobile autoplay compatibility.
        await playAudioUrl(task.audioUrl, controller.signal);
        URL.revokeObjectURL(task.audioUrl);
        setRetryChunk(null);
        setAudioNeedsGesture(false);
        await runSpeech(task, task.index + 1);
        return;
      } catch {
        // The signed URL may have expired; regenerate only the failed chunk.
      }
    }
    await runSpeech(task, task.index);
  };

  const sendMessage = useCallback(async (rawText: string) => {
    const content = rawText.trim();
    if (!content || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    recognitionRef.current?.stop();
    setListening(false);

    // Chat generation is intentionally independent of voice-session cancellation.
    const responseSessionId = sessionRef.current ? voiceSessionIdRef.current : null;
    const userMessage: ChatMessage = { role: "user", content, id: Date.now() };
    const nextMessages = [...messagesRef.current, userMessage];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setInput("");

    try {
      const chatResponse = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.slice(-20).map(({ role, content: text }) => ({ role, content: text })),
        }),
      });
      const chatData = await chatResponse.json();
      if (!chatResponse.ok) throw new Error(chatData.error || "AI chat request failed.");

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: chatData.reply,
        id: Date.now() + 1,
      };
      const updated = [...nextMessages, assistantMessage];
      messagesRef.current = updated;
      setMessages(updated);

      // If voice ended while AI was thinking, show the text but do not start stale speech.
      const sessionStillActive = responseSessionId === null ||
        (sessionRef.current && voiceSessionIdRef.current === responseSessionId);
      if (sessionStillActive) {
        const chunks = splitSpeechText(assistantMessage.content);
        if (chunks.length) {
          await runSpeech({
            chunks,
            responseId: String(assistantMessage.id),
            sessionId: responseSessionId,
            lang: "eng",
          });
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (sessionRef.current) window.setTimeout(resumeListening, 550);
    }
  }, [resumeListening, runSpeech]);

  useEffect(() => { sendRef.current = sendMessage; }, [sendMessage]);

  const toggleVoice = () => {
    if (voiceSession) {
      const endingSessionId = voiceSessionIdRef.current;
      sessionRef.current = false;
      setVoiceSession(false);
      recognitionRef.current?.stop();
      for (const [id, entry] of speechControllersRef.current.entries()) {
        if (entry.sessionId === endingSessionId) {
          entry.controller.abort();
          speechControllersRef.current.delete(id);
        }
      }
      audioRef.current?.pause();
      audioRef.current?.removeAttribute("src");
      audioRef.current?.load();
      setRetryChunk((current) => current?.sessionId === endingSessionId ? null : current);
      setListening(false);
      // Do not reset busy: pending AI text generation must finish normally.
      setStatus("Voice session ended");
      return;
    }
    if (!recognitionRef.current) {
      setNotice("Your browser does not support speech recognition. Try Chrome on Android or use text mode.");
      return;
    }
    setNotice("");
    voiceSessionIdRef.current += 1;
    sessionRef.current = true;
    setVoiceSession(true);
    setStatus("Voice session active · speak naturally");
    try { recognitionRef.current.start(); }
    catch { setNotice("Microphone is starting. Tap again in a moment if it does not activate."); }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(input);
  };

  const clearConversation = () => {
    for (const entry of speechControllersRef.current.values()) entry.controller.abort();
    speechControllersRef.current.clear();
    activeSpeechIdRef.current = null;
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
    audioRef.current?.load();
    setRetryChunk(null);
    messagesRef.current = [];
    setMessages([]);
    setLastHeard("");
    setNotice("");
  };

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Sonivox home">
          <span className="brand-mark"><span /></span>
          <span>SONIVOX<small>LIVE VOICE LAB</small></span>
        </a>
        <div className="top-actions">
          <span className={chatReady && speechReady ? "service-pill ready" : "service-pill"}>
            <i /> {chatReady && speechReady ? "SERVICES CONNECTED" : "SETUP CHECK"}
          </span>
          <button className="icon-button" onClick={clearConversation} title="Clear conversation" aria-label="Clear conversation">↺</button>
        </div>
      </header>

      <section className="workspace">
        <div className="eyebrow"><span className="pulse-dot" /> VOICE-FIRST AI EXPERIMENT</div>
        <h1>Talk naturally.<br /><em>Hear intelligence.</em></h1>
        <p className="intro">A live voice conversation powered by OpenRouter and Sonivox speech.</p>

        <div className={`orb-stage ${listening ? "is-listening" : ""} ${busy ? "is-thinking" : ""}`}>
          <div className="orb-halo halo-one" />
          <div className="orb-halo halo-two" />
          <div className="voice-orb">
            <div className="orb-core"><span className="sound-wave"><i /><i /><i /><i /><i /></span></div>
          </div>
          <div className="orb-caption">{busy ? "THINKING / SPEAKING" : listening ? "I’M LISTENING" : voiceSession ? "READY FOR YOUR VOICE" : "READY WHEN YOU ARE"}</div>
        </div>

        <div className="main-controls">
          <button className={`mic-button ${voiceSession ? "active" : ""}`} onClick={toggleVoice} disabled={busy && !voiceSession} aria-label={voiceSession ? "End voice session" : "Start voice chat"}>
            {voiceSession ? <span className="stop-icon" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7" /></svg>}
          </button>
          <div className="control-label">{voiceSession ? "END VOICE CHAT" : "START VOICE CHAT"}</div>
          <div className="control-hint">{voiceSession ? "Speak naturally · tap to end" : "Tap the microphone and start talking"}</div>
        </div>

        <div className="service-row">
          <div className="service-item"><span className={chatReady ? "check-dot on" : "check-dot"} /> <span>AI BRAIN</span><b>{chatReady ? "READY" : "CHECK KEY"}</b></div>
          <div className="service-divider" />
          <div className="service-item"><span className={speechReady ? "check-dot on" : "check-dot"} /> <span>SONIVOX VOICE</span><b>{speechReady ? "READY" : "CHECK KEY"}</b></div>
        </div>

        {lastHeard && <div className="heard-line"><span>YOU SAID</span> “{lastHeard}”</div>}
        {notice && <div className="notice" role="status">{notice}</div>}
        {retryChunk && (
          <button className="audio-retry" type="button" onClick={() => void retryFailedSpeech()}>
            {audioNeedsGesture ? "Play / retry audio" : `Retry voice from chunk ${retryChunk.index + 1}`}
          </button>
        )}

        <section className="conversation">
          <div className="conversation-head"><span>CONVERSATION</span><span>{messages.length} MESSAGES</span></div>
          {messages.length === 0 ? (
            <div className="empty-state"><span className="empty-spark">✳</span><p>Your conversation will appear here.</p><small>Start a voice session to begin.</small></div>
          ) : (
            <div className="message-list">
              {messages.slice(-8).map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <span className="message-role">{message.role === "user" ? "YOU" : "SONIVOX"}</span>
                  <p>{message.content}</p>
                </article>
              ))}
              {busy && <div className="thinking-line"><span /><span /><span /> Sonivox is thinking…</div>}
            </div>
          )}
        </section>

        <div className="text-mode-toggle">
          <button onClick={() => setTextMode((value) => !value)}>{textMode ? "− Hide text input" : "+ Use text instead"}</button>
          <span>VOICE IS THE PRIMARY EXPERIENCE</span>
        </div>
        {textMode && (
          <form className="text-composer" onSubmit={handleSubmit}>
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Type a message…" aria-label="Type a message" />
            <button type="submit" disabled={!input.trim() || busy}>Send</button>
          </form>
        )}
      </section>

      <footer className="footer"><span>SONIVOX LIVE CHAT TEST</span><span>MICROPHONE · AI · SPEAKER</span></footer>
      <audio ref={audioRef} className="hidden-audio" preload="none" playsInline />
    </main>
  );
}
