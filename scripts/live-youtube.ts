import { chromium } from 'playwright';
import { resolve } from 'node:path';
const path = resolve('outputs/extension');
const context = await chromium.launchPersistentContext(resolve('work/live-browser-profile'), { channel: 'chromium', executablePath: process.argv[2] || undefined, headless: true,
  args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`] });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  page.on('response', async response => {
    if (response.url().includes('/youtubei/v1/')) console.log('YouTube endpoint path:', new URL(response.url()).pathname, response.status());
    if (!response.url().includes('/youtubei/v1/get_transcript')) return;
    try {
      const data = await response.json();
      console.log('Transcript endpoint:', { status: response.status(), keys: Object.keys(data), error: data.error?.message,
        captionKeys: [...new Set((JSON.stringify(data).match(/\w*[Tt]ranscript\w*/g) || []))].slice(0, 20) });
    } catch {}
  });
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean(document.querySelector('video') || document.querySelector('ytd-enforcement-message-view-model')), { timeout: 15000 }).catch(() => {});
  console.log('Live YouTube title:', await page.title());
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: 'https://www.youtube.com/watch*' }));
  console.log('Player metadata:', await page.evaluate(() => {
    const w = window as any, p = (document.getElementById('movie_player') as any)?.getPlayerResponse?.();
    const d = JSON.stringify(w.ytInitialData || {});
    return { videoId: p?.videoDetails?.videoId, captionTracks: p?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length || 0, transcriptEndpointPresent: d.includes('getTranscriptEndpoint') };
  }));
  let result = await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId!, { type: 'CUE_TRANSCRIPT', videoId: 'aircAruvnKk' }), tab.id);
  console.log(result.transcript ? `Live browser fallback retrieved ${result.transcript.segments.length} segments (${result.transcript.language}).` : `Live browser fallback: ${result.error}`);
  if (!result.transcript) {
    const captionRequest = page.waitForResponse(r => r.url().includes('/api/timedtext'), { timeout: 12000 });
    await page.locator('.ytp-subtitles-button').click();
    const response = await captionRequest.catch(() => null);
    console.log('Caption network request:', response ? { status: response.status(), length: (await response.text()).length } : 'No request observed');
    result = await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId!, { type: 'CUE_TRANSCRIPT', videoId: 'aircAruvnKk' }), tab.id);
    console.log(result.transcript ? `Live captured captions: ${result.transcript.segments.length} segments.` : `After enabling captions: ${result.error}`);
  }
  if (!result.transcript) {
    await page.locator('#description-inline-expander').click({ timeout: 5000 }).catch(() => {});
    await page.getByRole('button', { name: 'Show transcript', exact: true }).click({ timeout: 10000 }).catch(() => console.log('Show transcript button not available.'));
    await page.getByRole('textbox', { name: 'Search transcript' }).waitFor({ timeout: 10000 }).catch(() => {});
    console.log('Native transcript elements:', await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.tagName.toLowerCase().includes('transcript')).slice(0, 10).map(e => ({ tag: e.tagName, class: e.className, sample: e.outerHTML.slice(0, 2500) }))));
    result = await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId!, { type: 'CUE_TRANSCRIPT', videoId: 'aircAruvnKk' }), tab.id);
    console.log(result.transcript ? `Live native transcript: ${result.transcript.segments.length} segments.` : `Native transcript result: ${result.error}`);
  }
  await page.screenshot({ path: 'work/screenshots/live-youtube.png' });
} catch (error: any) { console.log('Live YouTube check could not complete:', error.message.split('\n')[0]); }
finally { await context.close(); }
