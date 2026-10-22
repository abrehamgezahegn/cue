// Regenerates docs/screenshots/*.png from the standalone preview on :4317.
// Needs `npm run build`, `npm start`, a working model, and Chrome installed.
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';

const out = 'docs/screenshots';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function panel(theme: 'light' | 'dark') {
  const page = await browser.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:4317');
  await page.getByRole('button', { name: 'Give me the key takeaways' }).waitFor();
  if (theme === 'dark') {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption('dark');
    await page.getByRole('button', { name: 'Close settings' }).click();
  }
  return page;
}
async function ask(page: Page, question: string) {
  await page.locator('#question').fill(question);
  await page.getByRole('button', { name: 'Send question' }).click();
  await page.locator('.assistant-message .time-link').first().waitFor({ timeout: 90000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${out}/${name}.png` }).then(() => console.log(`${out}/${name}.png`));

const light = await panel('light');
await ask(light, 'How can I reduce distractions?');
await shot(light, 'ask');

await light.getByRole('button', { name: 'Transcript', exact: true }).click();
await light.getByRole('textbox', { name: 'Search transcript' }).fill('focus');
await light.waitForTimeout(300);
await shot(light, 'transcript');

await light.getByRole('button', { name: 'Quiz', exact: true }).click();
await light.getByLabel('Number of questions').selectOption('4');
await light.getByLabel('Difficulty').selectOption('medium');
await light.getByRole('button', { name: 'Start quiz' }).click();
await light.locator('.quiz-prompt').waitFor({ timeout: 180000 });
// Find a multiple-choice question and answer it, so the shot shows the verdict and its citation.
for (let step = 0; step < 6 && !(await light.locator('.quiz-options button').count()); step++) {
  const next = light.getByRole('button', { name: 'Next', exact: true });
  if (!(await next.count()) || await next.isDisabled()) break;
  await next.click();
  await light.waitForTimeout(200);
}
if (await light.locator('.quiz-options button').count()) {
  await light.locator('.quiz-options button').first().click();
  await light.locator('.quiz-feedback').waitFor({ timeout: 90000 });
}
await light.mouse.move(0, 0);
await light.waitForTimeout(300);
await shot(light, 'quiz');

const dark = await panel('dark');
await ask(dark, 'What should I do when an unrelated thought shows up?');
await shot(dark, 'ask-dark');

await browser.close();
