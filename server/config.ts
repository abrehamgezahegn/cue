import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(join(root, '.env.local')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
const tokenPath = join(root, '.cue-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
export const token = readFileSync(tokenPath, 'utf8').trim();
export const model = process.env.DEEPINFRA_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';
// The DeepInfra models the picker offers. Each was probed for strict json_schema output and speed
// (1–2s on a short answer); Qwen3-235B-A22B (70s+) and gpt-oss-120b (always reasons, 5–14s) were left out.
// Override with a comma-separated DEEPINFRA_MODELS in .env.local.
const defaultCloudModels = [
  'deepseek-ai/DeepSeek-V4-Flash',
  'Qwen/Qwen3-32B',
  'deepseek-ai/DeepSeek-V4.1-Flash',
  'zai-org/GLM-5.3-Flash',
  'google/gemma-4-31B-it-turbo',
  'deepseek-ai/DeepSeek-V4-Pro',
];
const listed = (process.env.DEEPINFRA_MODELS || '').split(',').map(m => m.trim()).filter(Boolean);
export const cloudModels = [...new Set([model, ...(listed.length ? listed : defaultCloudModels)])];
export const apiKey = process.env.DEEPINFRA_API_KEY || '';
export const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
// Opt in by setting CUE_COOKIES_FROM=chrome (or safari, firefox, edge, brave) in .env.local.
// A signed-in client is treated far better by YouTube than an anonymous one.
const browsers = ['chrome', 'chromium', 'safari', 'firefox', 'edge', 'brave'];
export const cookiesFrom = browsers.includes((process.env.CUE_COOKIES_FROM || '').toLowerCase()) ? (process.env.CUE_COOKIES_FROM || '').toLowerCase() : '';
export const cookiesFile = process.env.CUE_COOKIES_FILE || '';
export const port = 4317;
