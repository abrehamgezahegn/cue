import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { root, cookiesFrom, cookiesFile } from './config';
import { parseCaptions } from '../src/shared/transcript';
import type { Transcript } from '../src/shared/types';

// Order of preference: an explicit override, the copy bundled with this project, then PATH.
export function ytDlpBinary(): string | null {
  const explicit = [process.env.CUE_YTDLP, join(root, 'bin/yt-dlp'), join(root, 'bin/yt-dlp.exe')];
  for (const path of explicit) if (path && existsSync(path)) return path;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const path = resolve(dir, 'yt-dlp');
    if (existsSync(path)) return path;
  }
  return null;
}

export const hasYtDlp = () => ytDlpBinary() !== null;

function run(args: string[], timeout: number): Promise<void> {
  return new Promise((accept, reject) => {
    execFile(ytDlpBinary()!, args, { timeout, maxBuffer: 8_000_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) { accept(); return; }
      const detail = String(stderr || '').split('\n').map(line => line.trim())
        .filter(line => line.startsWith('ERROR') || line.includes('Error')).at(-1) || error.message;
      reject(new Error(detail.replace(/^ERROR:\s*/, '').slice(0, 200) || 'yt-dlp failed.'));
    });
  });
}

// yt-dlp handles the signature and PO-token work that plain timedtext requests no longer get for free.
// Captions are written as json3 by the tool itself, then parsed with the same parser the rest of Cue uses.
export async function fetchTranscriptWithYtDlp(videoId: string, language = 'en', timeout = 75_000): Promise<Transcript> {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid YouTube video.');
  if (!ytDlpBinary()) throw new Error('yt-dlp is not installed.');
  const directory = await mkdtemp(join(tmpdir(), 'cue-captions-'));
  // One track at a time: asking for "en,en-orig" makes yt-dlp download a multi-megabyte
  // caption file twice, which is where the long videos were timing out.
  const download = (lang: string) => run([
    '--skip-download', '--write-subs', '--write-auto-subs',
    '--sub-langs', lang, '--sub-format', 'json3',
    '--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '10', '--retries', '1',
    ...(cookiesFrom ? ['--cookies-from-browser', cookiesFrom] : []),
    ...(cookiesFile ? ['--cookies', cookiesFile] : []),
    '-P', directory, '-o', '%(id)s.%(ext)s', `https://www.youtube.com/watch?v=${videoId}`,
  ], timeout);
  try {
    await download(language);
    if (!(await readdir(directory)).some(name => name.endsWith('.json3'))) await download(`${language}-orig`);
    const files = (await readdir(directory)).filter(name => name.endsWith('.json3'));
    const preferred = [`${videoId}.${language}.json3`, `${videoId}.${language}-orig.json3`];
    const ordered = [...preferred.filter(name => files.includes(name)), ...files.filter(name => !preferred.includes(name))];
    let best: Transcript | null = null;
    for (const name of ordered) {
      const segments = parseCaptions(await readFile(join(directory, name), 'utf8'));
      if (!segments.length) continue;
      const candidate: Transcript = { videoId, segments, source: 'ytdlp', language: name.split('.').slice(1, -1).join('.') || language };
      if (!best || candidate.segments.length > best.segments.length) best = candidate;
      if (name === preferred[0]) break;
    }
    if (!best) throw new Error('YouTube returned no captions for this video.');
    return best;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
