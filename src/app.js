// The API, shared by the local server (server.js) and Vercel (api/index.js).
// Stateless: the browser keeps the conversation `state` and sends it back with every
// request, so any server instance can answer any turn. Nothing is stored on the server.
//
//   POST /api/session  {}                          -> greeting + state
//   POST /api/message  { text, state }             -> reply + new state
//   POST /api/audio    { audio, mime, state }      -> transcript + reply + new state (Sarvam only)
//   POST /api/end      { state }                   -> goodbye + summary
//   POST /api/tts      { text }                    -> base64 MP3 of one sentence (Sarvam only)
//   GET  /api/graph, /api/health
import { KnowledgeGraph } from './knowledgeGraph.js';
import { Tutor } from './tutor.js';
import { ClaudeClient } from './claude.js';
import { SarvamClient } from './providers/sarvam.js';
import { say } from './messages.js';

const RATE_WINDOW_MS = 5 * 60 * 1000;

const graph = KnowledgeGraph.load();
// Sarvam (if SARVAM_API_KEY) is the brain AND the voice. Otherwise Claude (if ANTHROPIC_API_KEY)
// is the brain and the browser does the voice. With neither, the built-in rules tutor runs.
const env = process.env;
const sarvam = env.SARVAM_API_KEY
  ? new SarvamClient({
    apiKey: env.SARVAM_API_KEY,
    model: env.SARVAM_MODEL || undefined,
    ttsModel: env.SARVAM_TTS_MODEL || undefined,
    speaker: env.SARVAM_SPEAKER || undefined,
  })
  : null;
const brain = sarvam
  || (env.ANTHROPIC_API_KEY ? new ClaudeClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || undefined }) : null);
const tutor = new Tutor(graph, { brain });
export const engine = brain ? brain.name : 'rules';
export const voice = sarvam ? 'sarvam' : 'browser';

// Per-IP limits. In memory, so on Vercel each instance counts separately (a soft limit).
const hits = new Map();
const ttsHits = new Map(); // speech requests (several per reply) have their own, higher limit

/** Handles /api/* requests. Returns false if the path is not an API route. */
export async function handleApi(req, res) {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (!p.startsWith('/api/')) return false;
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, engine, voice, topics: graph.nodes.size });
    if (p === '/api/graph' && req.method === 'GET') return json(res, 200, { nodes: graph.summary() });
    if (req.method !== 'POST') return json(res, 404, { error: 'not_found' });

    // Sarvam voice for one sentence. The browser asks for each sentence of a reply in parallel.
    if (p === '/api/tts') {
      if (!sarvam) return json(res, 400, { error: 'voice_not_enabled' });
      if (rateLimited(req, ttsHits, 300)) return json(res, 429, { error: 'too_many_requests' });
      const { text } = await readJson(req);
      if (typeof text !== 'string' || !text.trim() || text.length > 600) return json(res, 400, { error: 'bad_text' });
      const audio = await speech(text.trim());
      return audio ? json(res, 200, { audio }) : json(res, 502, { error: 'tts_failed' });
    }

    if (p === '/api/session') {
      return json(res, 201, { ...tutor.greeting(), engine, voice, state: tutor.newSession() });
    }

    if (p === '/api/end') {
      const { state } = await readJson(req);
      return json(res, 200, { reply_hi: say.goodbye, summary: tutor.summary(tutor.restore(state)) });
    }

    if (p === '/api/message' || p === '/api/audio') {
      if (rateLimited(req, hits, 60)) return json(res, 429, { error: 'too_many_requests' });

      // Spoken turn: browser recording -> Sarvam speech-to-text -> tutor.
      if (p === '/api/audio') {
        if (!sarvam) return json(res, 400, { error: 'voice_not_enabled' });
        const body = await readJson(req, 3_000_000);
        const s = tutor.restore(body.state);
        const audio = Buffer.from(typeof body.audio === 'string' ? body.audio : '', 'base64');
        if (!audio.length) return json(res, 400, { error: 'empty_audio' });
        const transcript = await sarvam.speechToText(audio, body.mime);
        if (!transcript) return json(res, 200, { transcript: '', heard: false, state: s });
        const out = await tutor.handle(s, transcript);
        return json(res, 200, { transcript, heard: true, ...out, state: s });
      }

      const body = await readJson(req);
      const s = tutor.restore(body.state);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return json(res, 400, { error: 'empty_message' });
      const out = await tutor.handle(s, text);
      return json(res, 200, { ...out, state: s });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    if (!err.status) console.error(err);
    return json(res, err.status || 500, { error: err.status ? err.message : 'server_error' });
  }
}

export function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body_too_large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 100_000) {
  const buf = await readBody(req, limit);
  try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

/** Sarvam voice for a sentence (base64 MP3), or null so the browser speaks it instead. */
const speechCache = new Map(); // repeated sentences (greeting, goodbye, off-topic) are made once
async function speech(text) {
  if (!sarvam || !text) return null;
  if (speechCache.has(text)) return speechCache.get(text);
  try {
    const audio = await sarvam.textToSpeech(text);
    if (speechCache.size >= 50) speechCache.delete(speechCache.keys().next().value);
    speechCache.set(text, audio);
    return audio;
  } catch (err) {
    console.warn('[voice] Sarvam text-to-speech failed, browser will speak:', err.message);
    return null;
  }
}

function rateLimited(req, bucket, max) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  if (bucket.size > 5000) bucket.clear(); // keep memory bounded
  const recent = (bucket.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  bucket.set(ip, recent);
  return recent.length > max;
}
