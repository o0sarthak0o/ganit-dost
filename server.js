// Ganit Dost — local server (Node 18+, no packages). Run: npm start
// Serves the pages in public/ and the API from src/app.js (Vercel uses api/index.js instead).
import './src/loadEnv.js'; // must come first: the API reads process.env when it loads
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, json, engine, voice } from './src/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  if (await handleApi(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
  return serveStatic(res, new URL(req.url, 'http://localhost').pathname);
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

server.listen(PORT, () => {
  console.log(`Ganit Dost running at http://localhost:${PORT}  (brain: ${engine}, voice: ${voice})`);
});
