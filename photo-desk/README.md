# Photo Desk

Upload photos → each one gets **reviewed**, **classified**, and **written up**: a category, a
quality score with concrete fixes, five headlines in different tones, a caption, tags, alt text
and privacy flags. Then export the whole batch as CSV.

Zero npm dependencies. Everything runs on your machine.

```bash
cd photo-desk
node server.js            # → http://localhost:3000
```

Works **immediately with no setup**: on-device mode measures the photo (sharpness, exposure,
contrast, colourfulness, clutter, dominant colours) and writes from those measurements.
Nothing is uploaded anywhere.

---

## Two modes

| | On-device (default, free) | Smart (needs a vision API key) |
|---|---|---|
| Setup | none | one key in `.env` |
| Privacy | nothing leaves the browser | each photo is sent to the provider |
| Recognises objects | only with the optional CLIP model | yes, accurately |
| Writes headlines | from templates + measurements | from what it actually sees |
| Cost | free | ~a fraction of a cent per photo |

The app tells you which mode you are in, top right. If a key is missing mid-run it degrades to
on-device instead of failing.

### Turning on smart mode

```bash
cd photo-desk
cp .env.example .env
# paste ONE key into .env, then restart: node server.js
```

- **Gemini** — has a free tier: <https://aistudio.google.com/apikey>
- **OpenAI** — <https://platform.openai.com/api-keys>
- **Claude** — <https://console.anthropic.com/settings/keys>

You can also paste a key into **Settings** in the UI. It stays in that browser's `localStorage`
and is only ever sent to your own Photo Desk server.

### Optional: object recognition with no key

In **Settings**, turn on *Smart on-device classification*. It downloads a CLIP model into the
browser once (~90 MB, cached afterwards) and then classifies photos locally — still no key, still
no upload. It is off by default because of the download.

---

## What you get per photo

- **Category** — one of the categories you list in Settings, chosen per photo.
- **Subject** — what is actually in the picture, in a sentence.
- **Quality review** — a 0–100 score, the specific problems, and how to fix them next time.
- **Headlines** — one per tone you selected: Scroll-stopper, Short & punchy, Funny, Professional,
  Question, Story, How-to, Bold claim. Click any headline to copy it.
- **Caption, tags, hashtags, alt text** — ready to paste.
- **Flags** — privacy and sensitivity warnings (readable text, faces, logos, documents).

**Export CSV** gives one row per photo: `file, category, confidence, quality_score, subject,
headline_1…n, caption, alt_text, hashtags, tags, issues, improvements, flags`.

## Settings

| Setting | What it does |
|---|---|
| Vision provider | Auto uses `.env` if present, otherwise falls back to on-device |
| API key | Per-browser key, overrides nothing server-side |
| Model | Override the provider default |
| What is this for? | e.g. "listing photos for a furniture shop" — steers headlines and caption |
| Categories | The list each photo is sorted into |
| Headlines per photo | 1–8 |
| Tones | Which headline styles to write |

Settings persist in `localStorage`. Add photos by dragging, clicking, or pasting from the clipboard.

## Layout

```
photo-desk/
  server.js              zero-dependency HTTP server, static files + /api/analyze
  public/
    index.html
    css/styles.css
    js/app.js            UI: queue, cards, copy, CSV export, CLIP loader
    js/analyze.js        the offline engine (pure functions, no DOM)
  test/analyze.test.mjs  runs the engine on synthetic images
```

```bash
npm test        # or: node test/analyze.test.mjs
```

## API

`POST /api/analyze`

```json
{
  "image": "data:image/jpeg;base64,…",
  "categories": ["food", "person"],
  "tones": ["Funny", "Professional"],
  "count": 5,
  "goal": "Instagram post for a coffee shop",
  "provider": "gemini",          // optional if set in .env
  "apiKey": "…",                 // optional, browser-supplied
  "model": "gemini-2.5-flash"    // optional
}
```

Returns `{ result: { category, subject, confidence, tags, headlines, caption, alt_text, hashtags, review, flags }, meta: { provider, model, ms } }`.
Errors: `409 no-provider` when no key is configured anywhere, `413` for images over 30 MB, `502` when the provider fails.

`GET /api/status` → which provider `.env` has, the supported providers, the default tones.

## Caveats

- Photos are resized to 1024 px (JPEG q0.85) before being sent to a provider; the on-device
  measurements run on a 512 px copy.
- HEIC (iPhone) files decode in Safari only; everything else handles JPG, PNG and WebP.
- The on-device mode does not *see* objects without the CLIP option — it measures the image and
  says so, rather than inventing a subject.
- Quality metrics are heuristics. They are good at catching blur, bad exposure, flat contrast,
  low resolution and cluttered frames; they are not a substitute for a human eye.
