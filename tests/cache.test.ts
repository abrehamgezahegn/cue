import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'cue-cache-'));
process.env.CUE_CACHE_DIR = directory;
const { readCached, writeCached, CACHE_TTL } = await import('../server/cache');

const transcript = {
  videoId: 'abcdefghijk', language: 'en', source: 'ytdlp' as const,
  segments: [{ id: 0, start: 1.5, duration: 2, text: 'Hello there' }],
};

test('a miss returns null instead of throwing', async () => {
  assert.equal(await readCached('abcdefghijk:en'), null);
});

test('a written transcript reads back intact', async () => {
  await writeCached('abcdefghijk:en', transcript);
  const stored = await readCached('abcdefghijk:en');
  assert.ok(stored);
  assert.deepEqual(stored!.data.segments, transcript.segments);
  assert.equal(stored!.data.source, 'ytdlp');
  assert.ok(Date.now() - stored!.savedAt < 5000);
  assert.ok(CACHE_TTL > 6 * 24 * 60 * 60 * 1000, 'a week long cache is the point');
});

test('an empty or corrupt file is treated as a miss', async () => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'empty_en.json'), JSON.stringify({ savedAt: Date.now(), data: { segments: [] } }));
  assert.equal(await readCached('empty:en'), null);
  await writeFile(join(directory, 'broken_en.json'), '{not json');
  assert.equal(await readCached('broken:en'), null);
});

test('an old entry is still readable, so the caller can serve it while refreshing', async () => {
  const savedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await writeFile(join(directory, 'old_en.json'), JSON.stringify({ savedAt, data: transcript }));
  const stored = await readCached('old:en');
  assert.ok(stored);
  assert.ok(Date.now() - stored!.savedAt > CACHE_TTL, 'older than the ttl');
  assert.equal(stored!.data.segments.length, 1);
});

test('keys with colons and slashes cannot escape the cache directory', async () => {
  await writeCached('a:b/c:d', transcript);
  const entries = await readFile(join(directory, 'a_b_c_d.json'), 'utf8');
  assert.match(entries, /Hello there/);
});
