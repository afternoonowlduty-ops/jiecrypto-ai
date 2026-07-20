# ⚡ Pesles.ai

Free ChatGPT-style AI web app — **text chat, image generation, and video generation** — powered by the free [Agnes AI](https://agnes-ai.com) API.

| Mode | Model | Endpoint |
|---|---|---|
| 💬 Chat (streaming) | `agnes-2.0-flash` | `POST /v1/chat/completions` |
| 🎨 Image | `agnes-image-2.1-flash` | `POST /v1/images/generations` |
| 🎬 Video (async) | `agnes-video-v2.0` | `POST /v1/videos` + polling |

All three models are currently **$0** (promotional pricing). Free tier: 20 requests/min for text, 1/min for video.

## Setup

1. **Get a free API key** (no credit card): sign up at [platform.agnes-ai.com](https://platform.agnes-ai.com) → API Keys → create key.

2. **Configure:**
   ```bash
   cp .env.example .env
   ```
   Then add your key(s) as numbered variables — add as many as you want,
   the server detects them all automatically:
   ```
   AGNES_API_KEY_1=sk-...
   AGNES_API_KEY_2=sk-...
   AGNES_API_KEY_3=sk-...
   # ...just keep numbering to add more
   ```
   (Comma-separated `AGNES_API_KEYS` and single `AGNES_API_KEY` also work.)

   **Key pool:** the server rotates keys round-robin and fails over
   automatically — a key that hits the rate limit (429) is benched for 60 s,
   one that runs out of quota (402) for 1 hour, and an invalid key (401) is
   disabled permanently. Video status polling always uses the same key that
   created the task, since tasks are account-scoped. The frontend never sees
   keys, provider names, or technical error details — those go to the server
   console only.

3. **Install & run:**
   ```bash
   npm install
   npm start
   ```

4. Open **http://localhost:3000**

## How it works

- `server.js` — Express server. Serves the frontend from `public/` and proxies three endpoints to Agnes so **your API key never reaches the browser**:
  - `POST /api/chat` — forwards messages with `stream: true` and pipes the SSE token stream back to the client.
  - `POST /api/image` — forwards prompt + size/ratio (`response_format` correctly nested in `extra_body`, per Agnes docs) and returns the image URL.
  - `POST /api/video` + `GET /api/video/:id` — creates the async video task, then the client polls every 5 s until `status: completed` returns the mp4 URL.
- `public/` — vanilla HTML/CSS/JS single-page app, ChatGPT-style dark UI with mode switcher, streaming text rendering, image gallery, and a video progress bar.
- **Uploads:** the paperclip (or paste / drag-and-drop) attaches files per mode — Chat accepts images (vision) and text files (contents are inlined into the prompt); Image mode accepts images for image-to-image transformation (`extra_body.image`); Video mode accepts 1 image for image-to-video or 2+ for keyframe animation (`extra_body.image` + `mode: "keyframes"`). Images are downscaled client-side (max 2048 px) and sent as base64 data URIs; only tiny thumbnails are persisted to localStorage.

## Notes & limits (from Agnes docs)

- **Rate limit:** free tier is 20 RPM (HTTP 429 → wait a minute).
- **Video:** max 441 frames (~18 s @ 24 fps); `num_frames` must satisfy the 8n+1 rule (the server snaps this automatically). Resolutions are normalized to 480p/720p/1080p tiers.
- **Image:** sizes are tiers `1K`–`4K` combined with a `ratio`; exact pixel dims are normalized by Agnes.
- Generated media URLs have no documented expiry — download anything you want to keep.
- The $0 pricing is promotional and may change; check the [Agnes docs](https://agnes-ai.com/en/docs) for current pricing.

## Deploying to Pesles.ai

This is a plain Node app — deploy anywhere Node 18+ runs (Render, Railway, Fly.io, a VPS…). Set `AGNES_API_KEY` as an environment variable on the host, point the `Pesles.ai` DNS A/CNAME record at it, and enable HTTPS.
