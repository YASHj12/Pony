#!/usr/bin/env node
'use strict';
/**
 * Photo Desk server — zero npm dependencies.
 *
 *   node server.js            → http://localhost:3000
 *   PORT=8080 node server.js
 *
 * Vision providers (optional; pick whichever key you have):
 *   GEMINI_API_KEY=...        (has a free tier)
 *   OPENAI_API_KEY=...
 *   ANTHROPIC_API_KEY=...
 *
 * No key? The app still works: the browser does the analysis on-device.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 30 * 1024 * 1024; // 30 MB per image request

/* ------------------------------------------------------------------ *
 * .env loading (no dependency)
 * ------------------------------------------------------------------ */
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnvFile();

const PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini', env: 'GEMINI_API_KEY', defaultModel: 'gemini-2.5-flash' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic Claude', env: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-5' },
];

function envProvider() {
  for (const p of PROVIDERS) {
    if (process.env[p.env]) return { ...p, model: process.env[`${p.id.toUpperCase()}_MODEL`] || p.defaultModel };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */
const TONES = ['Scroll-stopper', 'Short & punchy', 'Funny', 'Professional', 'Question', 'Story'];

function buildPrompt({ categories, tones, count, goal }) {
  const cats = categories?.length ? categories.join(', ') : 'pick the most accurate single word or two';
  const heads = (tones?.length ? tones : TONES).join(', ');
  return `You are a photo editor and social media strategist. Look at the image carefully and return ONLY JSON.

Classify the image into one category. Allowed categories: ${cats}.

Write ${count || 5} headlines, one per tone, in this order: ${heads}.
Every headline must be specific to what is actually visible in THIS photo — mention real objects, colours or details. No generic filler, no emoji spam (at most one emoji total across all headlines).

Also review the photo's quality honestly: framing, sharpness, lighting, exposure, distractions.
${goal ? `The photo will be used for: ${goal}. Tailor the headlines and caption to that.` : ''}

Return JSON in exactly this shape:
{
  "category": "one allowed category",
  "subject": "what is in the photo, one specific sentence",
  "confidence": 0-100,
  "tags": ["5-8 short lowercase tags"],
  "headlines": [{"tone": "tone name", "text": "headline"}],
  "caption": "one or two sentences ready to post",
  "alt_text": "accessibility description",
  "hashtags": ["#upto8"],
  "review": {
    "score": 0-100,
    "summary": "one sentence verdict on the photo quality",
    "issues": ["concrete problems, empty array if none"],
    "tips": ["concrete improvements"]
  },
  "flags": ["privacy or sensitivity warnings, e.g. readable text, faces, logos; empty array if none"]
}`;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    subject: { type: 'string' },
    confidence: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
    headlines: {
      type: 'array',
      items: { type: 'object', properties: { tone: { type: 'string' }, text: { type: 'string' } }, required: ['tone', 'text'] },
    },
    caption: { type: 'string' },
    alt_text: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    review: {
      type: 'object',
      properties: {
        score: { type: 'number' },
        summary: { type: 'string' },
        issues: { type: 'array', items: { type: 'string' } },
        tips: { type: 'array', items: { type: 'string' } },
      },
      required: ['score', 'summary', 'issues', 'tips'],
    },
    flags: { type: 'array', items: { type: 'string' } },
  },
  required: ['category', 'subject', 'headlines', 'caption', 'alt_text', 'review'],
};

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */
function splitDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new HttpError(400, 'image must be a base64 data URL');
  return { mime: m[1], base64: m[2] };
}

async function callGemini({ apiKey, model, prompt, mime, base64 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0.9, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, json?.error?.message || `Gemini error ${res.status}`);
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || '';
  if (!text) throw new HttpError(502, json?.candidates?.[0]?.finishReason === 'SAFETY' ? 'The model refused this image (safety filter).' : 'Empty response from Gemini');
  return text;
}

async function callOpenAI({ apiKey, model, prompt, mime, base64, baseUrl }) {
  const root = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      max_tokens: 1600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a precise photo analyst. Reply with JSON only.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, json?.error?.message || `OpenAI error ${res.status}`);
  return json?.choices?.[0]?.message?.content || '';
}

async function callAnthropic({ apiKey, model, prompt, mime, base64 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 1600,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, json?.error?.message || `Anthropic error ${res.status}`);
  return json?.content?.map((c) => c.text).filter(Boolean).join('') || '';
}

async function callProvider(provider, opts) {
  switch (provider) {
    case 'gemini': return callGemini(opts);
    case 'openai': return callOpenAI(opts);
    case 'anthropic': return callAnthropic(opts);
    default: throw new HttpError(400, `Unknown provider "${provider}"`);
  }
}

function parseModelJson(text) {
  if (!text) throw new HttpError(502, 'The model returned nothing');
  let cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* try to salvage the first JSON object */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new HttpError(502, 'Could not parse JSON from the model response');
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Image too large (30 MB max per photo)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'Body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found', path: rel });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': rel === 'index.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/status' && req.method === 'GET') {
      const env = envProvider();
      return sendJson(res, 200, {
        envProvider: env ? { id: env.id, label: env.label, model: env.model } : null,
        providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, defaultModel: p.defaultModel })),
        tones: TONES,
        maxBodyMB: MAX_BODY / 1024 / 1024,
      });
    }

    if (pathname === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const { image, categories, tones, count, goal } = body;

      // A key can come from .env (preferred) or from the browser settings panel.
      const requested = body.provider;
      const key = body.apiKey || null;
      const meta = PROVIDERS.find((p) => p.id === requested);
      const env = envProvider();

      let provider, apiKey, model;
      if (key && meta) {
        provider = meta.id; apiKey = key; model = body.model || meta.defaultModel;
      } else if (env) {
        provider = env.id; apiKey = process.env[env.env]; model = env.model;
      } else {
        return sendJson(res, 409, { error: 'no-provider', message: 'No API key configured — use on-device mode.' });
      }

      const { mime, base64 } = splitDataUrl(image);
      const prompt = buildPrompt({ categories, tones, count, goal });
      const started = Date.now();
      const text = await callProvider(provider, { apiKey, model, prompt, mime, base64, baseUrl: body.baseUrl });
      const raw = parseModelJson(text);
      return sendJson(res, 200, { result: raw, meta: { provider, model, ms: Date.now() - started } });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[error]', err.message);
    sendJson(res, status, { error: err.message || 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  const env = envProvider();
  console.log(`Photo Desk running on http://localhost:${PORT}`);
  console.log(env ? `Vision provider: ${env.label} (${env.model})` : 'Vision provider: none — app runs in on-device mode (add a key to .env for smart mode)');
});
