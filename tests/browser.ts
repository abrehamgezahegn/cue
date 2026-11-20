import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { demoTranscript } from '../src/panel/demo';

await mkdir('work/screenshots', { recursive: true });
const extensionPath = resolve('outputs/extension');
const context = await chromium.launchPersistentContext(resolve('work/browser-profile'), { channel: 'chromium', executablePath: process.argv[2] || undefined, headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`], viewport: { width: 420, height: 860 }, reducedMotion: 'reduce' });
const errors: string[] = [];
context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
try {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4317');
  await page.getByRole('button', { name: 'Give me the key takeaways' }).waitFor();
  await page.screenshot({ path: 'work/screenshots/welcome.png' });
  assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search transcript' }).fill('phone');
  assert.equal(await page.locator('.transcript-row').count(), 1);
  await page.locator('.transcript-row').click();
  await page.getByText('Preview jumped to 2:14').waitFor();
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  // Exercise actual inference from the UI. The data is explicitly labeled sample material.
  await page.getByRole('textbox', { name: 'Ask about this video' }).fill('How can I reduce distractions?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await page.locator('.assistant-message').waitFor({ timeout: 65000 });
  assert.ok(await page.locator('.time-link').count());
  await page.locator('.toast.visible').waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'outputs/cue-preview.png' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.screenshot({ path: 'work/screenshots/dark.png' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('light');
  await page.getByRole('button', { name: 'Close settings' }).click();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 860 });
    assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true, `Overflow at ${width}`);
    await page.screenshot({ path: `work/screenshots/width-${width}.png` });
  }
  console.log('Preview: live answer, citation, transcript search, seek feedback, settings, themes, and four widths passed.');

  // Exercise the installed extension's actual page-world and isolated-world scripts.
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const videoId = 'abcdefghijk';
  const json3 = { events: demoTranscript.segments.map(s => ({ tStartMs: s.start * 1000, dDurationMs: s.duration * 1000, segs: [{ utf8: s.text }] })) };
  await context.route('https://www.youtube.com/**', async route => {
    if (route.request().url().includes('/api/timedtext')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(json3) });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Caption bridge fixture - YouTube</title></head><body><ytd-watch-metadata><h1>Caption bridge fixture</h1><ytd-channel-name><a>Test channel</a></ytd-channel-name></ytd-watch-metadata><div id="movie_player"></div><video></video><script>window.ytInitialPlayerResponse={videoDetails:{videoId:'${videoId}'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://www.youtube.com/api/timedtext?v=${videoId}&lang=en',languageCode:'en'}]}}};document.getElementById('movie_player').getPlayerResponse=()=>window.ytInitialPlayerResponse;Object.defineProperty(document.querySelector('video'),'duration',{get:()=>420});</script></body></html>` });
  });
  const youtube = await context.newPage();
  await youtube.goto(`https://www.youtube.com/watch?v=${videoId}`);
  const tab = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' }))[0]);
  const getState = async () => worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId!, { type: 'CUE_STATE' }), tab.id);
  let state;
  for (let i = 0; i < 20; i++) { try { state = await getState(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.equal(state.video.id, videoId);
  const fallback = await worker.evaluate(async ({ tabId, videoId }) => chrome.tabs.sendMessage(tabId!, { type: 'CUE_TRANSCRIPT', videoId }), { tabId: tab.id, videoId });
  assert.equal(fallback.transcript.segments.length, 10);
  assert.equal(fallback.transcript.source, 'browser');
  const seek = await worker.evaluate(async ({ tabId, videoId }) => chrome.tabs.sendMessage(tabId!, { type: 'CUE_SEEK', videoId, seconds: 134, play: false }), { tabId: tab.id, videoId });
  assert.equal(seek.ok, true);
  assert.equal(await youtube.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), 134);
  const wrongSeek = await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId!, { type: 'CUE_SEEK', videoId: 'wrongwrong1', seconds: 134 }), tab.id);
  assert.ok(wrongSeek.error);
  console.log('Installed extension: player caption fallback, actual video seek, and wrong-video rejection passed.');

  // Capture network captions for another video, then verify cache isolation on SPA navigation.
  await youtube.evaluate(async () => { history.pushState({}, '', '/watch?v=lmnopqrstuv'); await fetch('/api/timedtext?v=lmnopqrstuv&lang=en'); });
  const captured = await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId!, { type: 'CUE_TRANSCRIPT', videoId: 'lmnopqrstuv' }), tab.id);
  assert.equal(captured.transcript.videoId, 'lmnopqrstuv');
  const stale = await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId!, { type: 'CUE_TRANSCRIPT', videoId: 'abcdefghijk' }), tab.id);
  assert.ok(stale.error);
  console.log('Installed extension: network capture and SPA transcript isolation passed.');
  // The panel opened as a tab must truthfully show no active video.
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.bringToFront();
  await page.getByText('A question for your video.').waitFor();
  console.log('Installed panel: extension resources and empty state loaded without CSP errors.');
  assert.deepEqual(errors, []);
} finally { await context.close(); }
