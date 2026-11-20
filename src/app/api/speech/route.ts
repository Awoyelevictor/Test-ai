import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const key = process.env.SONIVOX_API_KEY;
  const baseUrl = process.env.SONIVOX_API_URL;
  if (!key || !baseUrl) {
    return NextResponse.json({ error: "Sonivox speech API credentials are not configured in Vercel." }, { status: 503 });
  }

  let body: { text?: string; lang?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const lang = typeof body.lang === "string" ? body.lang : "en";
  if (!text) return NextResponse.json({ error: "Text is required for speech generation." }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: "Speech text is limited to 2,000 characters." }, { status: 413 });

  try {
    const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/speech`;
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
      cache: "no-store",
    });

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail = result?.detail || result?.error || result?.message || `Speech API returned HTTP ${upstream.status}.`;
      return NextResponse.json({ error: String(detail) }, { status: upstream.status });
    }

    const audioUrl = result?.audio_url || result?.audioUrl || result?.url;
    if (typeof audioUrl !== "string" || !audioUrl) {
      return NextResponse.json({ error: "Sonivox API responded, but did not return an audio URL." }, { status: 502 });
    }
    return NextResponse.json({ audioUrl });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown network error.";
    return NextResponse.json({ error: `Could not reach Sonivox speech API: ${detail}` }, { status: 502 });
  }
}
