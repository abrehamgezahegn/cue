import type { Health, Transcript, Answer, AnswerVisual, ChatMessage, Grade, Quiz, Target } from '../shared/types';
export interface Clarification { text: string; model: string }
import { requestFailureMessage } from '../shared/errors';
declare const __CUE_TOKEN__: string;
export const isExtension = Boolean(globalThis.chrome?.runtime?.id);
const base = 'http://127.0.0.1:4317';
// A fresh, cheap request tells us whether the service is up now, independent of what just failed.
async function reachable(): Promise<boolean> {
  try {
    await fetch(base + '/api/health', { headers: { Authorization: `Bearer ${__CUE_TOKEN__}` }, signal: AbortSignal.timeout(2000) });
    return true;
  } catch { return false; }
}

async function request<T>(path: string, data?: object, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, { method: data ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${__CUE_TOKEN__}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(12000) });
  } catch (e: any) {
    if (signal?.aborted) throw e;
    const timedOut = (signal?.reason?.name || e?.name) === 'TimeoutError';
    throw new Error(requestFailureMessage({ timedOut, reachable: timedOut ? true : await reachable() }));
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Try again.');
  return result;
}
export const api = {
  health: () => request<Health>('/api/health'),
  transcript: (videoId: string, signal: AbortSignal) => request<Transcript>('/api/transcript', { videoId }, signal),
  clarify: (question: { prompt: string; type: string; passage: string }, target: Target | null, signal: AbortSignal) =>
    request<Clarification>('/api/clarify', { ...question, ...(target ? { provider: target.provider, model: target.model } : {}) }, signal),
  grade: (question: { prompt: string; answer: string | boolean | number; accept?: string[]; explanation?: string; passage?: string; rubric?: string[] }, given: string, target: Target | null, signal: AbortSignal) =>
    request<Grade>('/api/grade', { question: question.prompt, reference: String(question.answer), accept: question.accept || [], context: question.explanation || '', passage: question.passage || '', rubric: question.rubric || [], given, ...(target ? { provider: target.provider, model: target.model } : {}) }, signal),
  quiz: (transcript: Transcript, options: { title: string; count: number; difficulty: string; avoid?: string[]; focus?: { prompt: string; segmentIds: number[] }[] }, target: Target | null, signal: AbortSignal) =>
    request<Quiz>('/api/quiz', { segments: transcript.segments, ...options, ...(target ? { provider: target.provider, model: target.model } : {}) }, signal),
  visualize: (question: string, answer: Answer, transcript: Transcript, target: Target | null, signal: AbortSignal) =>
    request<{ visuals: (AnswerVisual | null)[]; model: string }>('/api/visualize', { question, segments: transcript.segments, parts: answer.parts.map(part => ({ text: part.text, segmentIds: part.citations.map(citation => citation.segmentId) })), ...(target ? { provider: target.provider, model: target.model } : {}) }, signal),
  ask: (question: string, transcript: Transcript, history: ChatMessage[], target: Target | null, signal: AbortSignal) =>
    request<Answer>('/api/ask', { question, segments: transcript.segments, history, ...(target ? { provider: target.provider, model: target.model } : {}) }, signal),
};
// What someone typed or earned outlives a reload, a closed panel and a browser restart, so it lives in
// local storage. Session storage was cleared with the browser and took half-written answers with it.
let carried: Promise<void> | null = null;
function carryOver() {
  return carried ??= (async () => {
    if (!isExtension) return;
    const old = await chrome.storage.session.get(null);
    const keys = Object.keys(old);
    if (!keys.length) return;
    const existing = await chrome.storage.local.get(keys);
    const missing = Object.fromEntries(keys.filter(key => existing[key] === undefined).map(key => [key, old[key]]));
    if (Object.keys(missing).length) await chrome.storage.local.set(missing);
    await chrome.storage.session.clear();
  })().catch(() => {});
}
export async function readSaved<T>(key: string, fallback: T): Promise<T> {
  try {
    if (isExtension) { await carryOver(); return ((await chrome.storage.local.get(key))[key] as T | undefined) ?? fallback; }
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch { return fallback; }
}
export async function save(key: string, value: unknown) {
  try {
    if (isExtension) {
      await carryOver();
      if (value == null) await chrome.storage.local.remove(key); else await chrome.storage.local.set({ [key]: value });
    } else if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* The current conversation remains usable when storage is full. */ }
}

// Per-video keys are `<kind>:<videoId>`. The most recently opened videos keep theirs; older ones are
// dropped so storage cannot grow without bound.
const keptVideos = 150;
const videoKinds = ['chat', 'checkpoint', 'quiz', 'draft', 'quiz-drafts', 'view'];
export async function rememberVideo(videoId: string) {
  const recent = { ...await readSaved<Record<string, number>>('recent-videos', {}), [videoId]: Date.now() };
  const ids = Object.keys(recent).sort((a, b) => recent[b] - recent[a]);
  if (ids.length <= keptVideos) { await save('recent-videos', recent); return; }
  const kept = new Set(ids.slice(0, keptVideos));
  await save('recent-videos', Object.fromEntries([...kept].map(id => [id, recent[id]])));
  try {
    const all = isExtension ? Object.keys(await chrome.storage.local.get(null)) : Object.keys(localStorage);
    const stale = all.filter(key => {
      const cut = key.indexOf(':');
      return cut > 0 && videoKinds.includes(key.slice(0, cut)) && !kept.has(key.slice(cut + 1));
    });
    if (!stale.length) return;
    if (isExtension) await chrome.storage.local.remove(stale); else stale.forEach(key => localStorage.removeItem(key));
  } catch { /* Pruning is housekeeping; a failure leaves everything in place. */ }
}
