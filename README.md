# SONIVOX Live Chat Test

Voice-first AI chat test application. The primary experience is microphone input and spoken AI replies; text input is available as a secondary fallback.

## Environment configuration

Configure these variables in **Vercel → Project Settings → Environment Variables**. Add credentials to Preview for testing; keep them server-side and never prefix them with `NEXT_PUBLIC_`.

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | AI text generation |
| `OPENROUTER_MODEL` | No | Defaults to `openrouter/auto` |
| `SONIVOX_API_URL` | Yes | Defaults to `https://sonivox.onrender.com` |
| `SONIVOX_API_KEY` | Yes | SONIVOX speech authentication |
| `SONIVOX_VOICE_MODE` | No | `preset` by default; `legacy` for keys without a linked preset |
| `SONIVOX_VOICE_ID` | Conditional | Required only when `SONIVOX_VOICE_MODE=legacy` |

### Preset-linked API key (recommended)

Set `SONIVOX_VOICE_MODE=preset`. The API key's linked voice preset is used; no explicit voice ID is sent.

### Legacy API key

Only when the key has no linked preset, set:

```env
SONIVOX_VOICE_MODE=legacy
SONIVOX_VOICE_ID=your_voice_id
```

Do not put real credentials in `.env.example`, source files, browser code, screenshots, or logs. After changing Vercel environment variables, create a new Preview deployment so the new values are loaded.

## Speech behavior

- Text responses are committed to the conversation before speech starts.
- Long replies are split into requests of at most 1,000 JavaScript string code units.
- Speech is generated and played one chunk at a time.
- Ending voice mode cancels speech work but does not cancel an in-flight AI text response.
- Failed chunks can be retried without replaying completed chunks.
