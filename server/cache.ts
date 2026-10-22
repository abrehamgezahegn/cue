import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './config';
import type { Transcript } from '../src/shared/types';

// Captions barely change once a video is published, and every fetch costs a request
// YouTube may refuse. Transcripts are kept on disk so a re-watch is free.
const directory = process.env.CUE_CACHE_DIR || join(root, '.cache/transcripts');
export const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

const file = (key: string) => join(directory, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
export interface CachedTranscript { data: Transcript; savedAt: number }

export async function readCached(key: string): Promise<CachedTranscript | null> {
  try {
    const parsed = JSON.parse(await readFile(file(key), 'utf8'));
    if (!Array.isArray(parsed?.data?.segments) || !parsed.data.segments.length || typeof parsed.savedAt !== 'number') return null;
    return { data: parsed.data as Transcript, savedAt: parsed.savedAt };
  } catch { return null; }
}

export async function writeCached(key: string, data: Transcript): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file(key), JSON.stringify({ savedAt: Date.now(), data }), 'utf8');
  } catch { /* a cache that cannot write must not break the answer */ }
}
