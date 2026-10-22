import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { apiKey, model, port, root, token } from './config';
import { fetchTranscript } from './transcript';
import { answerQuestion } from './answer';
import { createQuiz } from './quiz';
import { gradeAnswer } from './grade';
import { clarifyQuestion } from './clarify';
import { defaultTarget, listModels, resolveTarget } from './providers';

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
}
function authorized(req: IncomingMessage) {
  const received = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6_000_000) throw new Error('This transcript is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid request.'); }
}
let activeAnswers = 0;
const app = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host || '')) return json(res, 403, { error: 'Invalid host.' });
  const origin = req.headers.origin;
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(res, 403, { error: 'Origin is not allowed.' });
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req)) return json(res, 401, { error: 'Cue needs to reconnect. Rebuild and reload the extension.' });
    if (req.method === 'GET' && (url.pathname === '/api/health' || url.pathname === '/api/models')) {
      const models = await listModels();
      const target = defaultTarget(models);
      return json(res, 200, {
        configured: models.deepinfra.configured || models.ollama.available,
        provider: target.provider, model: target.model,
        providers: models,
        ...(url.pathname === '/api/models' ? { models: models } : {}),
      });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    try {
      const input = await body(req);
      if (url.pathname === '/api/transcript') {
        try { return json(res, 200, await fetchTranscript(String(input.videoId || ''), String(input.language || 'en').slice(0, 15))); }
        catch { return json(res, 422, { error: 'Trying captions from your YouTube tab.', fallback: true }); }
      }
      if (url.pathname === '/api/clarify') {
        const target = resolveTarget(input, await listModels());
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45_000);
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose);
        try { return json(res, 200, await clarifyQuestion(input, target, controller.signal)); }
        finally { clearTimeout(timer); res.off('close', onClose); }
      }
      if (url.pathname === '/api/grade') {
        const target = resolveTarget(input, await listModels());
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose);
        try { return json(res, 200, await gradeAnswer(input, target, controller.signal)); }
        finally { clearTimeout(timer); res.off('close', onClose); }
      }
      if (url.pathname === '/api/quiz') {
        if (activeAnswers >= 3) return json(res, 429, { error: 'Cue is finishing another answer. Try again in a moment.' });
        const target = resolveTarget(input, await listModels());
        activeAnswers++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 175_000);
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose);
        try { return json(res, 200, await createQuiz(input, target, controller.signal)); }
        finally { activeAnswers--; clearTimeout(timer); res.off('close', onClose); }
      }
      if (url.pathname === '/api/ask') {
        if (activeAnswers >= 3) return json(res, 429, { error: 'Cue is finishing another answer. Try again in a moment.' });
        const target = resolveTarget(input, await listModels());
        activeAnswers++;
        const controller = new AbortController();
        // Local models on a laptop can take a while; the client waits the same 3 minutes.
        const timer = setTimeout(() => controller.abort(), 175_000);
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose);
        try { return json(res, 200, await answerQuestion(input, target, controller.signal)); }
        finally { activeAnswers--; clearTimeout(timer); res.off('close', onClose); }
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (e: any) {
      // Without this the log says nothing when a request fails, which is how a silent restart looks.
      console.error(`[cue] ${req.method} ${url.pathname} — ${e.name || 'Error'}: ${e.message || e}`);
      return json(res, 400, { error: e.name === 'AbortError' ? 'The answer took too long. Try again.' : e.message || 'Something went wrong. Try again.' });
    }
  }
  if (!['GET', 'HEAD'].includes(req.method || '')) return json(res, 405, { error: 'Method not allowed.' });
  const base = resolve(root, 'outputs/extension');
  let path;
  try { path = resolve(base, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
  catch { return json(res, 400, { error: 'Invalid URL.' }); }
  if (!path.startsWith(base + sep)) return json(res, 403, { error: 'Not allowed.' });
  try {
    const data = await readFile(path);
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://i.ytimg.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { json(res, 404, { error: 'Run npm run build first.' }); }
});
app.requestTimeout = 70_000;
process.on('unhandledRejection', error => console.error('[cue] unhandled rejection:', error));
process.on('uncaughtException', error => console.error('[cue] uncaught exception:', error));
app.listen(port, '127.0.0.1', () => console.log(`Cue is ready at http://127.0.0.1:${port} • DeepInfra ${apiKey ? 'configured' : 'key missing'}`));
app.on('error', (e: any) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Cue may already be running.` : 'Could not start Cue.'); process.exitCode = 1; });
