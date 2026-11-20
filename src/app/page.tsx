"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

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
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionRef = useRef(false);
  const busyRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {});

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
      audioRef.current?.pause();
    };
  }, []);

  const playReply = async (text: string) => {
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang: "en" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Speech generation failed.");
    if (!data.audioUrl) throw new Error("Sonivox did not return an audio URL.");

    const audio = audioRef.current;
    if (!audio) throw new Error("Audio player is unavailable.");
    audio.src = data.audioUrl;
    await audio.play();
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
    });
  };

  const sendMessage = useCallback(async (rawText: string) => {
    const content = rawText.trim();
    if (!content || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    recognitionRef.current?.stop();
    setListening(false);

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

      try {
        await playReply(assistantMessage.content);
      } catch (speechError) {
        const reason = speechError instanceof Error ? speechError.message : "Speech service failed.";
        setNotice(`AI replied, but voice playback failed: ${reason}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Something went wrong.";
      setNotice(reason);
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (sessionRef.current) window.setTimeout(resumeListening, 550);
    }
  }, [resumeListening]);

  useEffect(() => { sendRef.current = sendMessage; }, [sendMessage]);

  const toggleVoice = () => {
    if (voiceSession) {
      sessionRef.current = false;
      setVoiceSession(false);
      recognitionRef.current?.stop();
      audioRef.current?.pause();
      setListening(false);
      setBusy(false);
      busyRef.current = false;
      setStatus("Voice session ended");
      return;
    }
    if (!recognitionRef.current) {
      setNotice("Your browser does not support speech recognition. Try Chrome on Android or use text mode.");
      return;
    }
    setNotice("");
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
      <audio ref={audioRef} className="hidden-audio" />
    </main>
  );
}
