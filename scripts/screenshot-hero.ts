// Regenerates docs/screenshots/hero.png: a real YouTube watch page beside the Cue panel.
// Chrome's side panel can't be captured by Playwright, so the panel is opened as a tab bound to
// the same window, both are captured at the same height, and the two are placed side by side.
// Needs `npm run build`, `npm start`, a working model, and Chrome for Testing (see AGENTS.md).
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const videoId = process.argv[2] || '7xTGNNLPyMI';
const question = process.argv[3] || 'Why are language models bad at spelling?';
const executablePath = process.env.CUE_CHROME || `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const extension = resolve('outputs/extension');
const height = 900, videoWidth = 1100, panelWidth = 400;

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'cue-hero-')), {
  executablePath, headless: true, viewport: { width: videoWidth, height }, deviceScaleFactor: 2, reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--mute-audio'],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;

  const video = await context.newPage();
  await video.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await video.waitForSelector('video', { timeout: 45000 });
  await video.waitForTimeout(4000);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: panelWidth, height });
  await panel.goto(`chrome-extension://${extensionId}/index.html`);
  await video.bringToFront();
  await panel.locator('.composer textarea:not([disabled])').waitFor({ timeout: 120000 });
  await panel.getByRole('button', { name: 'Focus mode' }).click();
  await panel.locator('#question').fill(question);
  await panel.getByRole('button', { name: 'Send question' }).click();
  await panel.locator('.assistant-message .time-link').first().waitFor({ timeout: 120000 });
  await panel.locator('.assistant-message .time-link').first().click();
  await video.waitForTimeout(2500);
  await video.evaluate('document.querySelector("video")?.pause()');
  await video.mouse.move(videoWidth / 2, height - 20);
  await video.waitForTimeout(600);
  await panel.mouse.move(0, 0);

  const left = (await video.screenshot()).toString('base64');
  const right = (await panel.screenshot()).toString('base64');
  const canvas = await context.newPage();
  await canvas.setViewportSize({ width: videoWidth + panelWidth + 1, height });
  await canvas.setContent(`<body style="margin:0;display:flex;background:#d4d4d4;gap:1px">
    <img src="data:image/png;base64,${left}" style="width:${videoWidth}px;height:${height}px">
    <img src="data:image/png;base64,${right}" style="width:${panelWidth}px;height:${height}px"></body>`);
  await canvas.screenshot({ path: 'docs/screenshots/hero.png' });
  console.log('docs/screenshots/hero.png');
} finally { await context.close(); }
