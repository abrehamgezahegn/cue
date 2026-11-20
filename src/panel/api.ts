import type { Health, Transcript, Answer, ChatMessage, Grade, Quiz, Target } from '../shared/types';
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
  ask: (question: string, transcript: Transcript, history: ChatMessage[], target: Target | null, signal: AbortSignal) =>
    request<Answer>('/api/ask', { question, segments: transcript.segments, history, ...(target ? { provider: target.provider, model: target.model } : {}) }, signal),
};
export async function readSaved<T>(key: string, fallback: T): Promise<T> {
  try {
    if (isExtension) return ((await chrome.storage.session.get(key))[key] as T | undefined) ?? fallback;
    return JSON.parse(sessionStorage.getItem(key) || 'null') ?? fallback;
  } catch { return fallback; }
}
export async function save(key: string, value: unknown) {
  try {
    if (isExtension) await chrome.storage.session.set({ [key]: value });
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* The current conversation remains usable when storage is full. */ }
}
