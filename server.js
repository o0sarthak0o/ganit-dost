// Ganit Dost — zero-dependency Node server (Node 18+). Run: npm start
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeGraph } from './src/knowledgeGraph.js';
import { Tutor } from './src/tutor.js';
import { ClaudeClient } from './src/claude.js';
import { SarvamClient } from './src/providers/sarvam.js';
import { say } from './src/messages.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 60 * 60 * 1000;
const RATE_LIMIT = { windowMs: 5 * 60 * 1000, max: 60 }; // messages per IP per window

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
const engine = brain ? brain.name : 'rules';
const voice = sarvam ? 'sarvam' : 'browser';
const sessions = new Map();
const hits = new Map();
const ttsHits = new Map(); // speech requests (several per reply) have their own, higher limit

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/health') return json(res, 200, { ok: true, engine, voice, topics: graph.nodes.size });
    if (p === '/api/graph' && req.method === 'GET') return json(res, 200, { nodes: graph.summary() });

    // Sarvam voice for one sentence. The browser asks for each sentence of a reply in parallel.
    if (p === '/api/tts' && req.method === 'POST') {
      if (!sarvam) return json(res, 400, { error: 'voice_not_enabled' });
      if (rateLimited(req, ttsHits, 300)) return json(res, 429, { error: 'too_many_requests' });
      const { text } = await readJson(req);
      if (typeof text !== 'string' || !text.trim() || text.length > 600) return json(res, 400, { error: 'bad_text' });
      const audio = await speech(text.trim());
      return audio ? json(res, 200, { audio }) : json(res, 502, { error: 'tts_failed' });
    }

    if (p === '/api/session' && req.method === 'POST') {
      const s = tutor.newSession();
      sessions.set(s.id, s);
      const hello = tutor.greeting();
      return json(res, 201, { sessionId: s.id, ...hello, engine, voice });
    }

    const m = p.match(/^\/api\/session\/([\w-]{36})\/(message|audio|end)$/);
    if (m && req.method === 'POST') {
      const s = sessions.get(m[1]);
      if (!s) return json(res, 404, { error: 'session_not_found' });
      if (m[2] === 'end') {
        sessions.delete(s.id);
        return json(res, 200, { reply_hi: say.goodbye, summary: tutor.summary(s) });
      }
      if (rateLimited(req)) return json(res, 429, { error: 'too_many_requests' });

      // Spoken turn: browser recording -> Sarvam speech-to-text -> tutor -> spoken reply.
      if (m[2] === 'audio') {
        if (!sarvam) return json(res, 400, { error: 'voice_not_enabled' });
        const audio = await readBody(req, 2_000_000);
        if (!audio.length) return json(res, 400, { error: 'empty_audio' });
        const transcript = await sarvam.speechToText(audio, req.headers['content-type']);
        if (!transcript) return json(res, 200, { transcript: '', heard: false });
        const out = await tutor.handle(s, transcript);
        return json(res, 200, { transcript, heard: true, ...out });
      }

      const body = await readJson(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return json(res, 400, { error: 'empty_message' });
      return json(res, 200, await tutor.handle(s, text));
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
    return serveStatic(res, p);
  } catch (err) {
    console.error(err);
    return json(res, err.status || 500, { error: err.status ? err.message : 'server_error' });
  }
});

async function serveStatic(res, pathname) {
  const pub = path.join(ROOT, 'public');
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(pub, rel);
  if (!file.startsWith(pub + path.sep)) return json(res, 403, { error: 'forbidden' });
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    json(res, 404, { error: 'not_found' });
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
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

async function readJson(req, limit = 10_000) {
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

function rateLimited(req, bucket = hits, max = RATE_LIMIT.max) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const recent = (bucket.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  bucket.set(ip, recent);
  return recent.length > max;
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Forget idle sessions (no memory layer by design).
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastActive < cutoff) sessions.delete(id);
  for (const bucket of [hits, ttsHits]) {
    for (const [ip, list] of bucket) if (!list.some((t) => Date.now() - t < RATE_LIMIT.windowMs)) bucket.delete(ip);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Ganit Dost running at http://localhost:${PORT}  (brain: ${engine}, voice: ${voice})`);
});
