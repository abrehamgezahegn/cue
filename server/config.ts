import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(join(root, '.env.local')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
const tokenPath = join(root, '.cue-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
export const token = readFileSync(tokenPath, 'utf8').trim();
export const model = process.env.DEEPINFRA_MODEL || 'Qwen/Qwen3-32B';
export const apiKey = process.env.DEEPINFRA_API_KEY || '';
export const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
// Opt in by setting CUE_COOKIES_FROM=chrome (or safari, firefox, edge, brave) in .env.local.
// A signed-in client is treated far better by YouTube than an anonymous one.
const browsers = ['chrome', 'chromium', 'safari', 'firefox', 'edge', 'brave'];
export const cookiesFrom = browsers.includes((process.env.CUE_COOKIES_FROM || '').toLowerCase()) ? (process.env.CUE_COOKIES_FROM || '').toLowerCase() : '';
export const cookiesFile = process.env.CUE_COOKIES_FILE || '';
export const port = 4317;
