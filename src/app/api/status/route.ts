import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    chatConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    speechConfigured: Boolean(process.env.SONIVOX_API_KEY && process.env.SONIVOX_API_URL),
    model: process.env.OPENROUTER_MODEL || "openrouter/auto",
    speechEndpointConfigured: Boolean(process.env.SONIVOX_API_URL),
  });
}
