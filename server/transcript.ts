import ytdl from 'ytdl-core';
import { parseCaptions } from '../src/shared/transcript';
import { fetchTranscriptWithYtDlp, hasYtDlp } from './ytdlp';
import { readCached, writeCached, CACHE_TTL } from './cache';
import type { Transcript } from '../src/shared/types';

const cache = new Map<string, { expires: number; data: Transcript }>();
function remember(key: string, data: Transcript) {
  if (cache.size >= 50) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 600_000, data });
}

// yt-dlp is the primary reader: it keeps up with YouTube's caption endpoint changes.
// ytdl-core is the fallback for when the binary is missing or refused.
async function viaYtDlp(videoId: string, language: string): Promise<Transcript> {
  if (!hasYtDlp()) throw new Error('yt-dlp is not installed. Run npm run install:ytdlp.');
  return fetchTranscriptWithYtDlp(videoId, language);
}

async function viaYtdlCore(videoId: string, language: string): Promise<Transcript> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        const info = await ytdl.getBasicInfo(videoId, { requestOptions: { timeout: 6000 } });
        const tracks = (info.player_response as any)?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const track = [...tracks].sort((a: any, b: any) => score(b) - score(a))[0];
        function score(t: any) { return (t.languageCode === language ? 10 : t.languageCode?.split('-')[0] === language ? 8 : 0) + (t.kind !== 'asr' ? 1 : 0); }
        if (!track?.baseUrl) throw new Error('No caption track found.');
        const url = new URL(track.baseUrl);
        if (!['www.youtube.com', 'youtube.com'].includes(url.hostname) || url.protocol !== 'https:' || url.pathname !== '/api/timedtext') throw new Error('Invalid caption URL.');
        url.searchParams.set('fmt', 'json3');
        const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) throw new Error('YouTube did not return captions.');
        const segments = parseCaptions(await response.text());
        if (!segments.length) throw new Error('Caption track is empty.');
        return { videoId, segments, source: 'ytdl', language: track.languageCode || language } satisfies Transcript;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('YouTube lookup timed out.')), 10_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function refresh(key: string, videoId: string, language: string): Promise<Transcript> {
  const failures: string[] = [];
  let data: Transcript | null = null;
  try { data = await viaYtDlp(videoId, language); }
  catch (error: any) { failures.push(`yt-dlp: ${error.message}`); }
  if (!data) {
    try { data = await viaYtdlCore(videoId, language); }
    catch (error: any) { failures.push(`ytdl-core: ${error.message}`); }
  }
  if (!data) throw new Error(failures.join(' · ') || 'No captions found for this video.');
  await writeCached(key, data);
  remember(key, data);
  return data;
}

const pending = new Map<string, Promise<Transcript>>();
function refreshOnce(key: string, videoId: string, language: string): Promise<Transcript> {
  const running = pending.get(key);
  if (running) return running;
  const promise = refresh(key, videoId, language).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export async function fetchTranscript(videoId: string, language = 'en'): Promise<Transcript> {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid YouTube video.');
  const key = `${videoId}:${language}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  const stored = await readCached(key);
  if (stored && Date.now() - stored.savedAt < CACHE_TTL) { remember(key, stored.data); return stored.data; }
  if (stored) {
    // An older copy still answers questions, so serve it now and refresh behind the scenes.
    remember(key, stored.data);
    void refreshOnce(key, videoId, language).catch(() => {});
    return stored.data;
  }
  return refreshOnce(key, videoId, language);
}
