// Vercel entry point: every /api/* request is routed here (see vercel.json).
// The pages in public/ are served by Vercel directly.
import { handleApi, json } from '../src/app.js';

export default async function handler(req, res) {
  if (!(await handleApi(req, res))) json(res, 404, { error: 'not_found' });
}
