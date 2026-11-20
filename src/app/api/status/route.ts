import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const speechMode = (process.env.SONIVOX_VOICE_MODE || "preset").toLowerCase();
  const validMode = speechMode === "preset" || speechMode === "legacy";
  const speechConfigured = Boolean(
    process.env.SONIVOX_API_KEY &&
    process.env.SONIVOX_API_URL &&
    validMode &&
    (speechMode !== "legacy" || process.env.SONIVOX_VOICE_ID)
  );

  return NextResponse.json({
    chatConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    speechConfigured,
    speechMode: validMode ? speechMode : "invalid",
    voiceIdConfigured: Boolean(process.env.SONIVOX_VOICE_ID),
    model: process.env.OPENROUTER_MODEL || "openrouter/auto",
    speechEndpointConfigured: Boolean(process.env.SONIVOX_API_URL),
  });
}
