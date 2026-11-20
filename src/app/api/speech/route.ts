import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const LANGUAGES = new Set(["eng", "yor", "hau", "ibo", "ful"]);
// Vercel route maxDuration is 60s; reserve ~5s for response serialization and cleanup.
const UPSTREAM_TIMEOUT_MS = 55_000;

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
      logSafe({ requestId, stage: "upstream_response", endpoint: endpoint.origin + endpoint.pathname, status: upstream.status, durationMs: Date.now() - startedAt });
      // Do not forward arbitrary upstream response bodies; they may contain sensitive diagnostics.
      const message = `SONIVOX returned HTTP ${upstream.status}.`;
      return NextResponse.json({ error: message, requestId }, { status: upstream.status });
    }

    const audioUrl = result?.audio_url || result?.audioUrl || result?.url;
    if (typeof audioUrl !== "string" || !audioUrl) {
      logSafe({ requestId, stage: "missing_audio_url", endpoint: endpoint.origin + endpoint.pathname, status: 502, durationMs: Date.now() - startedAt });
      return NextResponse.json({ error: "SONIVOX did not return an audio URL.", requestId }, { status: 502 });
    }

    // Fetch the signed media server-side and stream the bytes from this same-origin route.
    // This avoids mobile-browser CORS, storage-host and signed-URL playback failures.
    let mediaUrl: URL;
    try {
      mediaUrl = new URL(audioUrl);
      if (mediaUrl.protocol !== "https:" || mediaUrl.username || mediaUrl.password) {
        throw new Error("Invalid media URL");
      }
    } catch {
      logSafe({ requestId, stage: "invalid_audio_url", endpoint: endpoint.origin + endpoint.pathname, status: 502, durationMs: Date.now() - startedAt });
      return NextResponse.json({ error: "SONIVOX returned an invalid audio URL.", requestId }, { status: 502 });
    }

    const media = await fetch(mediaUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "audio/*, application/octet-stream" },
    });
    if (!media.ok) {
      logSafe({ requestId, stage: "audio_download_failed", endpoint: mediaUrl.origin, status: media.status, durationMs: Date.now() - startedAt });
      return NextResponse.json({ error: `SONIVOX audio download failed (HTTP ${media.status}).`, requestId }, { status: 502 });
    }

    const contentType = media.headers.get("content-type") || "audio/wav";
    if (!contentType.toLowerCase().startsWith("audio/") && !contentType.toLowerCase().includes("octet-stream")) {
      logSafe({ requestId, stage: "invalid_audio_content_type", endpoint: mediaUrl.origin, status: 502, durationMs: Date.now() - startedAt });
      return NextResponse.json({ error: "SONIVOX returned a non-audio file.", requestId }, { status: 502 });
    }

    const audioBytes = await media.arrayBuffer();
    if (!audioBytes.byteLength) {
      logSafe({ requestId, stage: "empty_audio", endpoint: mediaUrl.origin, status: 502, durationMs: Date.now() - startedAt });
      return NextResponse.json({ error: "SONIVOX returned an empty audio file.", requestId }, { status: 502 });
    }

    logSafe({ requestId, stage: "complete", endpoint: endpoint.origin + endpoint.pathname, status: 200, audioBytes: audioBytes.byteLength, durationMs: Date.now() - startedAt });
    return new Response(audioBytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(audioBytes.byteLength),
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-SONIVOX-Request-Id": requestId,
      },
    });
  } catch {
    if (request.signal.aborted) {
      logSafe({ requestId, stage: "client_cancelled", durationMs: Date.now() - startedAt });
      return new Response(null, { status: 499 });
    }
    if (timedOut) {
      logSafe({ requestId, stage: "upstream_timeout", endpoint: endpoint.origin + endpoint.pathname, status: 504, durationMs: Date.now() - startedAt });
      return NextResponse.json({ error: "SONIVOX request timed out. Retry this audio chunk.", requestId }, { status: 504 });
    }
    logSafe({ requestId, stage: "upstream_network_error", endpoint: endpoint.origin + endpoint.pathname, status: 502, durationMs: Date.now() - startedAt });
    return NextResponse.json({ error: "Could not reach SONIVOX. Retry this audio chunk.", requestId }, { status: 502 });
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromClient);
  }
}
