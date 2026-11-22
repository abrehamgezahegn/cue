// Browser QA for the panel itself, against the standalone preview on :4317.
import { chromium } from 'playwright';

const results: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, run: () => Promise<string | void>) {
  try { const detail = await run(); results.push({ name, ok: true, detail: detail || '' }); }
  catch (error: any) { results.push({ name, ok: false, detail: error.message.split('\n')[0].slice(0, 160) }); }
}
function fail(message: string): never { throw new Error(message); }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 860 }, reducedMotion: 'reduce' });
const consoleErrors: string[] = [];
page.on('pageerror', error => consoleErrors.push(error.message));
let answeredBy = '';
page.on('response', async response => {
  if (!response.url().includes('/api/ask')) return;
  try { const body: any = await response.json(); answeredBy = body.model || body.error || ''; } catch {}
});

await page.goto('http://127.0.0.1:4317');
await page.getByRole('button', { name: 'Give me the key takeaways' }).waitFor();

await check('empty panel shows questions and no status rows', async () => {
  const text = await page.locator('.app').innerText();
  for (const banned of ['Ready to ask', 'Every answer takes you back', 'What would you like to know', 'Grounded in the transcript', 'This video only', 'Made for the curious']) {
    if (text.includes(banned)) fail(`still shows "${banned}"`);
  }
  if (await page.locator('.suggestions button').count() !== 3) fail('expected 3 suggestions');
});

await check('title chevron sits on the title line', async () => {
  const title = await page.locator('.video-details h1').boundingBox();
  const chevron = await page.locator('.video-title-button svg').boundingBox();
  if (!title || !chevron) fail('missing title or chevron');
  const centred = Math.abs((title.y + title.height / 2) - (chevron.y + chevron.height / 2));
  if (centred > 12) fail(`chevron is ${Math.round(centred)}px off the title line`);
  return `chevron ${Math.round(centred)}px from the title centre`;
});

await check('ask returns a grounded answer', async () => {
  await page.locator('#question').fill('How can I reduce distractions?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await page.locator('.assistant-message .time-link').first().waitFor({ timeout: 90000 });
  const citations = await page.locator('.time-link').count();
  if (!citations) fail('no citations');
  return `${citations} citation(s), model ${answeredBy || 'unknown'}`;
});

await check('copy action is hidden until the answer is hovered', async () => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const before = await page.locator('.answer-actions').first().evaluate(el => getComputedStyle(el).opacity);
  await page.locator('.assistant-message').first().hover();
  await page.waitForTimeout(300);
  const after = await page.locator('.answer-actions').first().evaluate(el => getComputedStyle(el).opacity);
  if (Number(before) !== 0) fail(`visible without hover (opacity ${before})`);
  if (Number(after) < 0.9) fail(`did not appear on hover (opacity ${after})`);
  return `${before} → ${after}`;
});

await check('citation jumps and reports it', async () => {
  await page.locator('.time-link').first().click();
  await page.locator('.toast.visible').waitFor({ timeout: 5000 });
  const toast = await page.locator('.toast').innerText();
  if (!/Preview jumped to/.test(toast)) fail(`toast said "${toast}"`);
  return toast.trim();
});

await check('answer citations open the transcript around them and its rows seek', async () => {
  const toggle = page.locator('.assistant-message .cited-passage-toggle').first();
  const label = (await toggle.innerText()).trim();
  await toggle.click();
  const rows = page.locator('.assistant-message .cited-passage-rows .transcript-row');
  const shown = await rows.count();
  if (!shown) fail('the passage did not open');
  if (!(await page.locator('.assistant-message .cited-passage-rows .transcript-row.cited').count())) fail('the cited line is not marked');
  await page.locator('.toast.visible').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  await rows.last().click();
  await page.locator('.toast.visible').waitFor({ timeout: 5000 });
  const toast = (await page.locator('.toast').innerText()).trim();
  if (!/Preview jumped to/.test(toast)) fail(`toast said "${toast}"`);
  await toggle.click();
  if (await page.locator('.assistant-message .cited-passage-rows').count()) fail('the passage did not close');
  return `${label}, ${shown} rows, ${toast}`;
});

await check('transcript search narrows to matching passages', async () => {
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search transcript' }).fill('phone');
  await page.waitForTimeout(200);
  const rows = await page.locator('.transcript-row').count();
  if (rows !== 1) fail(`expected 1 match, got ${rows}`);
  await page.getByRole('button', { name: 'Clear search' }).click();
});

await check('model picker lists local and cloud models and switches', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const groups = await page.locator('select[aria-label="Model"] optgroup').evaluateAll(gs => gs.map(g => (g as HTMLOptGroupElement).label));
  if (!groups.includes('This computer')) fail(`no local group: ${groups.join(', ')}`);
  if (!groups.includes('DeepInfra')) fail(`no cloud group: ${groups.join(', ')}`);
  await page.getByLabel('Model').selectOption('ollama:llama3.2:latest');
  await page.waitForTimeout(200);
  const help = await page.locator('.settings-help').first().innerText();
  if (!/Runs on this computer/.test(help)) fail(`help text did not change: ${help}`);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.locator('#question').fill('What should I do with my phone?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await page.locator('.assistant-message').nth(1).waitFor({ timeout: 120000 });
  if (answeredBy !== 'llama3.2:latest') fail(`answered by ${answeredBy || 'nothing'}`);
  // Switch back: the quiz check needs the cloud model, and a small local one writes the quiz slowly.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Model').selectOption({ index: 0 });
  await page.getByRole('button', { name: 'Close settings' }).click();
  return `groups ${groups.join(' + ')}, answered by ${answeredBy}`;
});

await check('quiz runs all question types, scores itself and links to the video', async () => {
  await page.getByRole('button', { name: 'Quiz', exact: true }).click();
  await page.getByLabel('Number of questions').selectOption('4');
  await page.getByRole('button', { name: 'Start quiz' }).click();
  await page.locator('.quiz-prompt').waitFor({ timeout: 180000 });
  // asking what a question means must work before answering, and must not give the answer away
  await page.getByRole('button', { name: 'What is this asking?' }).first().click();
  await page.locator('.quiz-clarify').waitFor({ timeout: 90000 });
  if (!(await page.locator('.quiz-clarify').innerText()).trim()) fail('empty clarification');
  if (await page.locator('.quiz-verdict').count()) fail('clarification revealed the answer');

  const seen = new Set<string>();
  for (let step = 0; step < 12; step++) {
    if (await page.locator('.quiz-summary').count()) break;
    if (await page.locator('.quiz-long').count()) {
      await page.locator('.quiz-long textarea').fill('Focus needs one clear outcome, a short block of time, and the distractions removed from the room before you start.');
      await page.getByRole('button', { name: 'Check' }).click();
      seen.add('long');
    } else if (await page.locator('.quiz-short').count()) {
      await page.locator('.quiz-short input').fill('forty five minutes');
      await page.getByRole('button', { name: 'Check' }).click();
      seen.add('short');
    } else {
      const first = page.locator('.quiz-options button').first();
      const label = (await first.innerText()).trim();
      await first.click();
      seen.add(/^[TF]\s/.test(label) ? 'boolean' : 'choice');
    }
    await page.locator('.quiz-feedback').waitFor({ timeout: 5000 });
    if (!(await page.locator('.quiz-feedback .time-link').count())) fail('a question with no citation');
    if (step === 0) {
      // the passage around the citation opens inline, highlights the cited lines and its rows are seekable
      await page.locator('.cited-passage-toggle').click();
      if (!(await page.locator('.cited-passage-rows .transcript-row').count())) fail('the cited passage did not open');
      if (!(await page.locator('.cited-passage-rows .transcript-row.cited').count())) fail('the cited line is not marked in the passage');
      await page.locator('.cited-passage-toggle').click();
      if (await page.locator('.cited-passage-rows').count()) fail('the passage did not close');
      // back and forth: the answered question must still be there when you return
      const prompt = await page.locator('.quiz-prompt').innerText();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      if ((await page.locator('.quiz-prompt').innerText()) === prompt) fail('next did not move on');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      if ((await page.locator('.quiz-prompt').innerText()) !== prompt) fail('back did not return to the same question');
      if (!(await page.locator('.quiz-verdict').count())) fail('the verdict was lost when going back');
    }
    await page.getByRole('button', { name: /^(Next|See results)$/ }).click();
    await page.waitForTimeout(300);
  }
  const score = (await page.locator('.quiz-score').innerText()).trim();
  const rows = await page.locator('.quiz-review-row').count();
  const ticks = await page.locator('.quiz-tick.correct').count();
  if (rows < 3 || rows > 6) fail(`expected 3-6 grounded questions, got ${rows}`);
  if (score !== `${ticks} of ${rows} correct`) fail(`score "${score}" disagrees with ${ticks} ticks`);
  if (seen.size < 3) fail(`only saw ${[...seen].join(', ')}`);
  await page.setViewportSize({ width: 320, height: 860 });
  if (await page.locator('body').evaluate(el => el.scrollWidth > innerWidth)) fail('quiz overflows at 320px');
  await page.setViewportSize({ width: 400, height: 860 });
  await page.locator('.quiz-review-link .time-link').first().click();
  await page.locator('.toast.visible').waitFor({ timeout: 5000 });
  return `types ${[...seen].join('+')}, ${score}, clarification shown`;
});

await check('dark theme survives a reload', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await page.locator('.composer textarea:not([disabled])').waitFor({ timeout: 60000 });
  const theme = await page.locator('html').getAttribute('data-theme');
  if (theme !== 'dark') fail(`theme after reload: ${theme}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('light');
  await page.getByRole('button', { name: 'Close settings' }).click();
});

await check('conversation survives a reload', async () => {
  const messages = await page.locator('.assistant-message').count();
  if (messages < 2) fail(`only ${messages} answers after reload`);
  return `${messages} answers restored`;
});

await check('no horizontal overflow at 320, 390 and 768', async () => {
  const widths: string[] = [];
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 860 });
    const overflow = await page.locator('body').evaluate(el => el.scrollWidth > innerWidth);
    if (overflow) fail(`overflow at ${width}px`);
    widths.push(String(width));
  }
  await page.setViewportSize({ width: 400, height: 860 });
  return widths.join(', ');
});

await check('no page errors', async () => {
  if (consoleErrors.length) fail(consoleErrors[0]);
  return 'clean';
});

await page.screenshot({ path: 'work/screenshots/qa-preview.png' });
await browser.close();

const failed = results.filter(r => !r.ok);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ' — ' + result.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
