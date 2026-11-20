import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Message = { role: "user" | "assistant"; content: string };

export async function POST(request: NextRequest) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return NextResponse.json({ error: "OpenRouter API key is not configured in Vercel." }, { status: 503 });

  let body: { messages?: Message[] };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
    return NextResponse.json({ error: "Send between 1 and 30 messages." }, { status: 400 });
  }

  const safeMessages = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (safeMessages.length !== messages.length) {
    return NextResponse.json({ error: "One or more messages have an invalid format." }, { status: 400 });
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "https://sonivox-live-chat-test.vercel.app",
        "X-OpenRouter-Title": "SONIVOX Live Voice Chat",
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || "openrouter/auto",
        messages: [
          {
            role: "system",
            content: "You are Sonivox, a natural, warm, intelligent voice conversation partner. Speak clearly and conversationally. Keep spoken replies concise unless the user asks for detail. Do not use markdown, bullet lists, or visual formatting in normal spoken replies. Answer the user directly."
          },
          ...safeMessages
        ],
        stream: false,
      }),
      cache: "no-store",
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || `OpenRouter returned HTTP ${response.status}.`;
      return NextResponse.json({ error: detail }, { status: response.status });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      return NextResponse.json({ error: "OpenRouter returned an empty reply." }, { status: 502 });
    }
    return NextResponse.json({ reply: reply.trim(), model: data?.model || process.env.OPENROUTER_MODEL || "openrouter/auto" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown network error.";
    return NextResponse.json({ error: `Could not reach OpenRouter: ${detail}` }, { status: 502 });
  }
}
