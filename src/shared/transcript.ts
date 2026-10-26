import { XMLParser } from 'fast-xml-parser';
import type { Segment } from './types';

export const videoIdFromUrl = (raw: string): string | null => {
  try {
    const u = new URL(raw);
    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'].includes(u.hostname)) return null;
    const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.pathname === '/watch' ? u.searchParams.get('v') : u.pathname.match(/^\/(shorts|live|embed)\/([^/]+)/)?.[2];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
};

export function normalizeSegments(rows: unknown[]): Segment[] {
  const clean: Omit<Segment, 'id'>[] = [];
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue;
    const r = value as Record<string, unknown>;
    const start = Number(r.start), duration = Number(r.duration ?? 0);
    const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim().slice(0, 10000) : '';
    if (!text || !Number.isFinite(start) || start < 0 || start > 604800 || !Number.isFinite(duration) || duration < 0) continue;
    clean.push({ start, duration: Math.min(duration, 3600), text });
  }
  clean.sort((a, b) => a.start - b.start);
  return clean.filter((r, i) => !i || r.text !== clean[i - 1].text || r.start - clean[i - 1].start > 2)
    .slice(0, 30000).map((r, id) => ({ ...r, id }));
}

// A caption segment is a few words; a cited moment needs the stretch of speech around it to mean anything.
// Speakers set up a point and then make it, so the window reaches further forward than back.
export function passageAround(segments: Segment[], starts: number[], options: { before?: number; after?: number; max?: number } = {}): string {
  const before = options.before ?? 20, after = options.after ?? 100, max = options.max ?? 3000;
  const times = [...new Set(starts.filter(Number.isFinite))].sort((a, b) => a - b);
  if (!times.length) return '';
  const inside = (start: number) => times.some(time => start >= time - before && start <= time + after);
  const text = segments.filter(segment => inside(segment.start)).map(segment => segment.text).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return text.slice(0, cut > max * 0.8 ? cut : max);
}

export function parseCaptions(raw: string | object): Segment[] {
  let data: any = raw;
  if (typeof raw === 'string') {
    if (raw.length > 8_000_000) throw new Error('Caption file is too large.');
    const text = raw.trim();
    if (text.startsWith('{') || text.startsWith('[')) data = JSON.parse(text);
    else if (text.startsWith('<')) data = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', trimValues: false }).parse(text);
    else return [];
  }
  if (data.events) return normalizeSegments(data.events.filter((e: any) => e.segs && e.tStartMs != null).map((e: any) => ({
    start: Number(e.tStartMs) / 1000, duration: Number(e.dDurationMs || 0) / 1000, text: e.segs.map((s: any) => s.utf8 || '').join(''),
  })));
  const xml = data.transcript?.text;
  if (xml) return normalizeSegments((Array.isArray(xml) ? xml : [xml]).map((r: any) => ({ start: r['@_start'], duration: r['@_dur'], text: String(r['#text'] ?? '') })));
  const paragraphs = data.timedtext?.body?.p;
  if (paragraphs) return normalizeSegments((Array.isArray(paragraphs) ? paragraphs : [paragraphs]).map((p: any) => ({
    start: Number(p['@_t']) / 1000, duration: Number(p['@_d'] || 0) / 1000,
    text: p.s ? (Array.isArray(p.s) ? p.s : [p.s]).map((s: any) => typeof s === 'object' ? s['#text'] : s).join('') : String(p['#text'] || ''),
  })));
  const rows: unknown[] = [];
  function walk(node: any, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 30) return;
    if (node.transcriptSegmentRenderer) {
      const r = node.transcriptSegmentRenderer;
      rows.push({ start: Number(r.startMs) / 1000, duration: (Number(r.endMs) - Number(r.startMs)) / 1000 || 0,
        text: r.snippet?.runs?.map((s: any) => s.text || '').join('') ?? r.snippet?.simpleText ?? '' });
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  }
  walk(data);
  return normalizeSegments(rows);
}

// Total words across all segments. A word is a run of letters or digits.
export function wordCount(segments: Segment[]): number {
  let count = 0;
  for (const segment of segments) count += (segment.text.match(/[\p{L}\p{N}]+/gu) || []).length;
  return count;
}

export function formatTime(seconds: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
