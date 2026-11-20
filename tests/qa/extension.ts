// Browser QA for the installed extension against real YouTube pages.
import { chromium, type Page } from 'playwright';
import { resolve } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, run: () => Promise<string | void>) {
  try { const detail = await run(); results.push({ name, ok: true, detail: detail || '' }); }
  catch (error: any) { results.push({ name, ok: false, detail: error.message.replace(/\s+/g, ' ').slice(0, 300) }); }
}
function fail(message: string): never { throw new Error(message); }

const executablePath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const extension = resolve('outputs/extension');
const context = await chromium.launchPersistentContext(resolve('work/qa-profile'), {
  executablePath, headless: true, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'],
});
const pageErrors: string[] = [];
context.on('page', page => page.on('pageerror', error => pageErrors.push(`${page.url().slice(0, 40)} :: ${error.message.slice(0, 90)}`)));
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
const extensionId = new URL(worker.url()).host;

async function openVideo(videoId: string) {
  const page = await context.newPage();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      break;
    } catch (error) {
      if (attempt === 3) throw new Error(`YouTube did not load ${videoId}: ${(error as Error).message.split('\n')[0]}`);
      await page.waitForTimeout(4000);
    }
  }
  await page.waitForSelector('video', { timeout: 45000 });
  await page.waitForTimeout(3000);
  return page;
}
async function openPanel(video: Page) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/index.html`);
  await video.bringToFront();
  return panel;
}
const time = (page: Page) => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement)?.currentTime ?? -1);
async function openTranscript(panel: Page) {
  await panel.getByRole('button', { name: 'Transcript', exact: true }).click();
  const search = panel.getByRole('textbox', { name: 'Search transcript' });
  if ((await search.inputValue()) !== '') { await search.fill(''); await panel.waitForTimeout(300); }
}
async function waitReady(panel: Page, timeout = 120000) {
  const ready = panel.locator('.composer textarea:not([disabled])');
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await ready.count()) return Math.round((Date.now() - started) / 1000);
    await panel.waitForTimeout(1000);
  }
  fail(`panel never became ready (${(await panel.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 120)})`);
}

// ---------------------------------------------------------------- long video
const LONG = '7xTGNNLPyMI';
const longVideo = await openVideo(LONG);
const longPanel = await openPanel(longVideo);
let answeredBy = '';
let requestedModel = '';
longPanel.on('request', request => {
  if (!request.url().includes('/api/ask')) return;
  try { requestedModel = JSON.parse(request.postData() || '{}').model || ''; } catch {}
});
longPanel.on('response', async response => {
  if (!response.url().includes('/api/ask')) return;
  try { const body: any = await response.json(); answeredBy = body.model || body.error || ''; } catch {}
});

await check('long video: transcript arrives through yt-dlp', async () => {
  const seconds = await waitReady(longPanel);
  const rows = await longPanel.locator('.transcript-row').count();
  return `ready in ${seconds}s`;
});

await check('long video: retrieval finds a rare word buried at 2:11:46', async () => {
  await longPanel.locator('#question').fill('what does exposition mean?');
  await longPanel.getByRole('button', { name: 'Send question' }).click();
  await longPanel.locator('.assistant-message').first().waitFor({ timeout: 150000 });
  const text = (await longPanel.locator('.assistant-message').first().innerText()).replace(/\s+/g, ' ');
  if (/could not find an answer/i.test(text)) fail('model still reports notFound');
  const starts = await longPanel.locator('.assistant-message').first().locator('.time-link').evaluateAll(els => els.map(el => el.textContent || ''));
  const seconds = (label: string) => label.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  const near = starts.filter(label => { const at = seconds(label); return at > 7800 && at < 11400; });
  if (!near.length) fail(`citations ${starts.join(', ') || 'none'} are not near the exposition passages`);
  return `${answeredBy} cited ${near.join(', ')}`;
});

await check('long video: transcript search and jump move the playhead', async () => {
  await longPanel.getByRole('button', { name: 'Transcript', exact: true }).click();
  await longPanel.getByRole('textbox', { name: 'Search transcript' }).fill('exposition');
  await longPanel.waitForTimeout(400);
  const rows = await longPanel.locator('.transcript-row').count();
  if (rows !== 5) fail(`expected 5 matches, got ${rows}`);
  await longPanel.locator('.transcript-row').nth(2).click();
  await longPanel.waitForTimeout(2500);
  const at = await time(longVideo);
  if (Math.abs(at - 7926) > 25) fail(`playhead at ${at.toFixed(0)}s instead of ~7926s`);
  return `${rows} matches, playhead ${at.toFixed(0)}s`;
});

await check('long video: checkpoint follows every deliberate jump and returns', async () => {
  // Earlier checks jumped too, so a chip may already exist: that is the point of this rule.
  const chip = longPanel.locator('.checkpoint-chip');
  // Pause first so the position the panel polls is stable, then scrub the way a mouse click on the bar does.
  await longVideo.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
  await longPanel.waitForTimeout(2500);
  const before = await time(longVideo);
  await longVideo.evaluate(target => { (document.querySelector('video') as HTMLVideoElement).currentTime = target; }, before > 900 ? 60 : before + 600);
  await longPanel.waitForTimeout(4500);
  if (!(await chip.count())) fail('scrubbing the player did not set a checkpoint');
  const held = (await chip.innerText()).trim();
  const heldSeconds = held.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  if (Math.abs(heldSeconds - before) > 30) fail(`checkpoint ${held} is not where playback was (${before.toFixed(0)}s)`);

  // A Cue jump also keeps the place it left, so the chip tracks the last deliberate jump.
  const beforeJump = await time(longVideo);
  await openTranscript(longPanel);
  await longPanel.locator('.transcript-row').nth(150).click();
  await longPanel.waitForTimeout(3000);
  const afterJump = (await chip.innerText()).trim();
  const expected = afterJump.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  if (Math.abs(expected - beforeJump) > 25) fail(`chip ${afterJump} does not match where the jump started (${beforeJump.toFixed(0)}s)`);

  await chip.click();
  await longPanel.waitForTimeout(3500);
  const back = await time(longVideo);
  if (Math.abs(back - expected) > 30) fail(`returned to ${back.toFixed(0)}s instead of ${expected}s`);
  if ((await chip.innerText()).trim() !== afterJump) fail('returning overwrote the checkpoint');
  await longPanel.getByRole('button', { name: 'Ask', exact: true }).click();
  return `held ${held}, jump kept ${afterJump}, returned to ${back.toFixed(0)}s`;
});

await check('long video: play-on-jump off leaves the video paused', async () => {
  await longPanel.getByRole('button', { name: 'Ask', exact: true }).click();
  await longPanel.getByRole('button', { name: 'Settings', exact: true }).click();
  await longPanel.locator('input.switch').first().uncheck({ timeout: 10000 });
  await longPanel.getByRole('button', { name: 'Close settings' }).click();
  await longVideo.evaluate(() => (document.querySelector('video') as HTMLVideoElement).pause());
  await openTranscript(longPanel);
  await longPanel.locator('.transcript-row').nth(8).click();
  await longPanel.waitForTimeout(2500);
  const paused = await longVideo.evaluate(() => (document.querySelector('video') as HTMLVideoElement).paused);
  await longPanel.getByRole('button', { name: 'Ask', exact: true }).click();
  await longPanel.getByRole('button', { name: 'Settings', exact: true }).click();
  await longPanel.locator('input.switch').first().check({ timeout: 10000 });
  await longPanel.getByRole('button', { name: 'Close settings' }).click();
  if (!paused) fail('the video started playing anyway');
  return 'stayed paused';
});

await check('long video: picker routes the ask to the local model, which fails loudly when it cannot cite', async () => {
  await longPanel.getByRole('button', { name: 'Ask', exact: true }).click();
  await longPanel.locator('.composer textarea:not([disabled])').waitFor({ timeout: 30000 });
  await longPanel.getByRole('button', { name: 'Settings', exact: true }).click();
  await longPanel.getByLabel('Model').selectOption('ollama:llama3.2:latest');
  await longPanel.getByRole('button', { name: 'Close settings' }).click();
  const before = await longPanel.locator('.assistant-message').count();
  await longPanel.locator('#question').fill('What is the answer at the end?');
  await longPanel.getByRole('button', { name: 'Send question' }).click();
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    if (await longPanel.locator('.inline-error').count()) break;
    if ((await longPanel.locator('.assistant-message').count()) > before) break;
    await longPanel.waitForTimeout(1000);
  }
  if (requestedModel !== 'llama3.2:latest') fail(`panel asked with "${requestedModel || 'nothing'}"`);
  const errored = await longPanel.locator('.inline-error').count();
  if (errored) {
    const message = (await longPanel.locator('.inline-error').innerText()).replace(/\s+/g, ' ');
    if (!/larger model|outside the transcript|incomplete/i.test(message)) fail(`unclear failure: ${message}`);
    // switch back to the cloud model so the rest of the run is deterministic
    await longPanel.getByRole('button', { name: 'Settings', exact: true }).click();
    await longPanel.getByLabel('Model').selectOption({ index: 0 });
    await longPanel.getByRole('button', { name: 'Close settings' }).click();
    return `routed to ${requestedModel}, refused with "${message.slice(0, 70)}"`;
  }
  const citations = await longPanel.locator('.assistant-message .time-link').count();
  if (!citations) fail('answer arrived without citations');
  return `routed to ${requestedModel}, ${citations} citation(s)`;
});

await check('long video: conversation survives a panel reload', async () => {
  const before = await longPanel.locator('.assistant-message').count();
  await longPanel.reload();
  await longPanel.locator('.composer textarea:not([disabled])').waitFor({ timeout: 90000 });
  const after = await longPanel.locator('.assistant-message').count();
  if (after !== before) fail(`${before} answers before reload, ${after} after`);
  return `${after} answers restored`;
});

await check('long video: focus mode keeps the chapters panel', async () => {
  await longPanel.getByRole('button', { name: 'Focus mode' }).click();
  await longPanel.waitForTimeout(2500);
  const state = await longVideo.evaluate(`(() => {
    const shown = s => { const el = document.querySelector(s); if (!el) return 'absent'; const st = getComputedStyle(el); return st.display === 'none' || el.getBoundingClientRect().width < 2 ? 'hidden' : 'visible'; };
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-description-chapters"]');
    return { related: shown('#related'), masthead: shown('#masthead-container'), rail: shown('#secondary'), chapters: panel?.getAttribute('visibility') ?? 'absent',
      rows: [...document.querySelectorAll('ytd-macro-markers-list-item-renderer')].filter(el => el.getBoundingClientRect().height > 8).length };
  })()`);
  const parsed: any = state;
  await longPanel.getByRole('button', { name: 'Focus mode' }).click();
  await longPanel.waitForTimeout(1500);
  if (parsed.related !== 'hidden' || parsed.masthead !== 'hidden') fail(`distractions still visible: ${JSON.stringify(parsed)}`);
  if (parsed.chapters !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' || parsed.rows < 3) fail(`chapters unusable: ${JSON.stringify(parsed)}`);
  return `${parsed.rows} chapter rows, rail ${parsed.rail}`;
});

// ------------------------------------------------------------ chapterless video
await check('video without chapters: focus mode gives the rail back to the player', async () => {
  const video = await openVideo('dQw4w9WgXcQ');
  const panel = await openPanel(video);
  await waitReady(panel);
  await panel.getByRole('button', { name: 'Focus mode' }).click();
  await panel.waitForTimeout(2500);
  const state: any = await video.evaluate(`(() => {
    const el = document.querySelector('#secondary');
    return { rail: !el || getComputedStyle(el).display === 'none' ? 'hidden' : 'visible', player: Math.round(document.querySelector('#player')?.getBoundingClientRect().width || 0) };
  })()`);
  await panel.getByRole('button', { name: 'Focus mode' }).click();
  await video.close(); await panel.close();
  if (state.rail !== 'hidden') fail(`rail still visible: ${JSON.stringify(state)}`);
  return `rail hidden, player ${state.player}px`;
});

// ------------------------------------------------------------ unplayable video
await check('unplayable video: panel names the reason and the jump fails honestly', async () => {
  const video = await openVideo('k7TloNg-Tk4');
  const panel = await openPanel(video);
  await panel.locator('.playback-notice').waitFor({ timeout: 60000 });
  const notice = (await panel.locator('.playback-notice').innerText()).replace(/\s+/g, ' ');
  const tab = await worker.evaluate(async videoId => (await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' })).find(t => t.url!.includes(videoId)), 'k7TloNg-Tk4');
  const seek: any = await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId!, { type: 'CUE_SEEK', videoId: 'k7TloNg-Tk4', seconds: 5, play: true }), tab!.id);
  await video.close(); await panel.close();
  if (!/can't play this video/i.test(notice)) fail(`notice said "${notice}"`);
  if (!seek?.error) fail(`seek returned ${JSON.stringify(seek)}`);
  return `${notice.slice(0, 60)} | ${seek.error.slice(0, 40)}`;
});

await check('no page errors across every page', async () => {
  if (pageErrors.length) fail(pageErrors[0]);
  return 'clean';
});

await longVideo.close();
await longPanel.close();
await context.close();

const failed = results.filter(r => !r.ok);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ' — ' + result.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
