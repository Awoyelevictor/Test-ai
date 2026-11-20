import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const LANGUAGES = new Set(["eng", "yor", "hau", "ibo", "ful"]);
const UPSTREAM_TIMEOUT_MS = 25_000;

function logSafe(event: Record<string, string | number>) {
  // Never log credentials, message text, raw upstream bodies, or signed audio URLs.
  console.error(JSON.stringify({ service: "sonivox-speech", ...event }));
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const key = process.env.SONIVOX_API_KEY;
  const baseUrl = process.env.SONIVOX_API_URL;
  const mode = (process.env.SONIVOX_VOICE_MODE || "preset").toLowerCase();
  const voiceId = process.env.SONIVOX_VOICE_ID;

  if (!key || !baseUrl) {
    return NextResponse.json({ error: "SONIVOX is not configured. Add SONIVOX_API_URL and SONIVOX_API_KEY to Vercel." }, { status: 503 });
  }
  if (mode !== "preset" && mode !== "legacy") {
    return NextResponse.json({ error: "Invalid SONIVOX_VOICE_MODE. Use preset or legacy." }, { status: 503 });
  }
  if (mode === "legacy" && !voiceId) {
    return NextResponse.json({ error: "Legacy keys require SONIVOX_VOICE_ID in the server environment." }, { status: 503 });
  }

  let body: { text?: string; lang?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request body.", requestId }, { status: 400 }); }

  const text = typeof body.text === "string" ? body.text : "";
  const requestedLang = typeof body.lang === "string" ? body.lang.trim().toLowerCase() : "eng";
  const lang = requestedLang === "en" ? "eng" : requestedLang;

  if (!text.trim()) return NextResponse.json({ error: "Text is required.", requestId }, { status: 400 });
  // The API currently validates JavaScript string.length, i.e. UTF-16 code units.
  if (text.length > 1000) return NextResponse.json({ error: "SONIVOX allows up to 1,000 characters per request.", requestId }, { status: 413 });
  if (!LANGUAGES.has(lang)) return NextResponse.json({ error: "Unsupported language. Use eng, yor, hau, ibo or ful.", requestId }, { status: 400 });

  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl.replace(/\/$/, "") + "/v1/speech");
    if (process.env.NODE_ENV === "production" && endpoint.protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    return NextResponse.json({ error: "SONIVOX_API_URL must be a valid HTTPS URL.", requestId }, { status: 503 });
  }

  const controller = new AbortController();
  let timedOut = false;
  const startedAt = Date.now();
  const abortFromClient = () => controller.abort();
  request.signal.addEventListener("abort", abortFromClient, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, UPSTREAM_TIMEOUT_MS);

  try {
    const payload: Record<string, string> = { text, lang };
    if (mode === "legacy" && voiceId) payload.voice_id = voiceId;

    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      logSafe({ requestId, stage: "upstream_response", status: upstream.status, durationMs: Date.now() - startedAt });
      const detail = result?.detail || result?.error || result?.message;
      const message = typeof detail === "string" && detail.length <= 200 ? detail : `SONIVOX returned HTTP ${upstream.status}.`;
      return NextResponse.json({ error: message, requestId }, { status: upstream.status });
    }

    const audioUrl = result?.audio_url || result?.audioUrl || result?.url;
    if (typeof audioUrl !== "string" || !audioUrl) {
      logSafe({ requestId, stage: "missing_audio_url", status: 502, durationMs: Date.now() - startedAt });
      return NextResponse.json({ error: "SONIVOX did not return an audio URL.", requestId }, { status: 502 });
    }

    logSafe({ requestId, stage: "complete", status: 200, durationMs: Date.now() - startedAt });
    return NextResponse.json({ audioUrl, requestId });
  } catch {
    if (request.signal.aborted) {
      logSafe({ requestId, stage: "client_cancelled", durationMs: Date.now() - startedAt });
      return new Response(null, { status: 499 });
    }
    if (timedOut) {
      logSafe({ requestId, stage: "upstream_timeout", status: 504, durationMs: Date.now() - startedAt });
      return NextResponse.json({ error: "SONIVOX request timed out. Retry this audio chunk.", requestId }, { status: 504 });
    }
    logSafe({ requestId, stage: "upstream_network_error", status: 502, durationMs: Date.now() - startedAt });
    return NextResponse.json({ error: "Could not reach SONIVOX. Retry this audio chunk.", requestId }, { status: 502 });
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromClient);
  }
}
