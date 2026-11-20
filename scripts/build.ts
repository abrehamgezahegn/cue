import '../server/config';
import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

await viteBuild();
await build({ entryPoints: ['src/extension/background.ts', 'src/extension/content.ts', 'src/extension/page.ts'], outdir: 'outputs/extension', bundle: true, minify: true, target: 'chrome120', format: 'iife' });
await mkdir('outputs/extension/icons', { recursive: true });
await writeFile('outputs/extension/manifest.json', JSON.stringify({
  manifest_version: 3, name: 'Cue · YouTube assistant', version: '0.1.0', minimum_chrome_version: '120',
  description: 'Ask the video. Find the moment. Transcript-grounded answers with clickable timestamps.',
  permissions: ['sidePanel', 'storage', 'activeTab'],
  host_permissions: ['https://www.youtube.com/*', 'https://m.youtube.com/*', 'http://127.0.0.1:4317/*'],
  background: { service_worker: 'background.js' },
  action: { default_title: 'Open Cue', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' } },
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  side_panel: { default_path: 'index.html' },
  content_scripts: [
    { matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'], js: ['page.js'], run_at: 'document_start', world: 'MAIN' },
    { matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'], js: ['content.js'], run_at: 'document_start' },
  ],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; connect-src http://127.0.0.1:4317; img-src 'self' https://i.ytimg.com; style-src 'self' 'unsafe-inline'; font-src 'self'" },
}, null, 2));
// Small dependency-free PNG encoder for the extension's play-and-bracket mark.
const { deflateSync } = await import('node:zlib');
function crc(buffer: Buffer) { let c = 0xffffffff; for (const n of buffer) { c ^= n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) { const t = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([length, t, data, checksum]); }
for (const size of [16, 32, 48, 128]) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = x / size, b = y / size;
    const bracket = a > .19 && a < .26 && b > .24 && b < .76 || a > .19 && a < .35 && (b > .24 && b < .30 || b > .70 && b < .76);
    const play = a > .44 && a < .80 && Math.abs(b - .5) < (.80 - a) * .70;
    const on = bracket || play;
    const p = y * (size * 4 + 1) + 1 + x * 4;
    rows.set([on ? 255 : 24, on ? 255 : 24, on ? 255 : 24, 255], p);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  await writeFile(`outputs/extension/icons/${size}.png`, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}
console.log('Load outputs/extension in Chrome. The DeepInfra key stays in .env.local.');
