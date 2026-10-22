import { normalizeSegments, parseCaptions, videoIdFromUrl } from '../shared/transcript';
import type { Transcript, Video } from '../shared/types';

// Focus mode clears the watch page down to the player, the title, and the ask panel.
// The flag lives in this tab's session storage so a reload keeps the state it was left in.
const FOCUS_STYLE_ID = 'cue-focus-style';
const FOCUS_CSS = `
html.cue-focus #masthead-container,
html.cue-focus ytd-comments,
html.cue-focus ytd-merch-shelf-renderer,
html.cue-focus ytd-horizontal-card-list-renderer,
html.cue-focus ytd-rich-shelf-renderer,
html.cue-focus ytd-shorts,
html.cue-focus #chat-container,
html.cue-focus ytd-live-chat-frame,
html.cue-focus .ytp-ce-element,
html.cue-focus .ytp-ce-covering-overlay,
html.cue-focus .ytp-cards-teaser,
html.cue-focus .ytp-cards-button,
html.cue-focus .ytp-endscreen-content,
html.cue-focus .ytp-pause-overlay,
html.cue-focus .ytp-suggestion-set,
html.cue-focus .ytp-suggested-action,
html.cue-focus .ytp-featured-product,
html.cue-focus .iv-branding,
html.cue-focus .ytp-watermark { display: none !important; }
/* Recommendations always go. The rail itself stays whenever the video has chapters to browse,
   or a panel is open, so the chapters and transcript UI keeps working; otherwise its width goes back to the player. */
html.cue-focus #related,
html.cue-focus ytd-watch-next-secondary-results-renderer { display: none !important; }
html.cue-focus #secondary:not(:has(ytd-macro-markers-list-item-renderer)):not(:has(ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"])) { display: none !important; }
html.cue-focus #guide,
html.cue-focus ytd-mini-guide-renderer { display: none !important; }
html.cue-focus #page-manager { margin-top: 0 !important; margin-left: 0 !important; }
html.cue-focus #columns { justify-content: center !important; }
`;
function applyFocus(enabled: boolean) {
  const root = document.documentElement;
  if (!root) return;
  root.classList.toggle('cue-focus', enabled);
  let style = document.getElementById(FOCUS_STYLE_ID) as HTMLStyleElement | null;
  if (enabled) {
    if (!style) { style = document.createElement('style'); style.id = FOCUS_STYLE_ID; style.textContent = FOCUS_CSS; }
    if (!style.isConnected) (document.head || root).append(style);
  } else style?.remove();
  try { sessionStorage.setItem('cue-focus', enabled ? '1' : '0'); } catch { /* storage can be blocked; the toggle still works for this page view. */ }
}
try { if (sessionStorage.getItem('cue-focus') === '1') applyFocus(true); } catch {}

const cache = new Map<string, Transcript>();
const pending = new Map<string, { resolve: (value: Transcript) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; videoId: string }>();
const seekPending = new Map<string, (result: { ok: boolean; error?: string; time?: number }) => void>();
window.addEventListener('message', event => {
  const m = event.data;
  if (event.source !== window || event.origin !== location.origin || m?.source !== 'cue:page') return;
  let transcript: Transcript | undefined;
  try {
    if (typeof m.raw === 'string' && /^[\w-]{11}$/.test(m.videoId)) {
      const segments = parseCaptions(m.raw);
      if (segments.length) {
        transcript = { videoId: m.videoId, segments, source: 'browser', language: String(m.language || 'auto').slice(0, 30) };
        if (cache.size >= 5) cache.delete(cache.keys().next().value!);
        cache.set(m.videoId, transcript);
      }
    }
  } catch {}
  if (m.type === 'SEEK_RESULT') {
    const settle = seekPending.get(m.requestId);
    if (!settle) return;
    seekPending.delete(m.requestId);
    settle({ ok: Boolean(m.ok), error: m.error, time: m.time });
    return;
  }
  if (m.type === 'RESULT') {
    const p = pending.get(m.requestId);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.requestId);
    if (transcript && transcript.videoId === p.videoId) p.resolve(transcript);
    else p.reject(new Error(m.error || 'No captions yet. Turn on captions or open YouTube’s transcript, then try again.'));
  }
});

function videoState(): Video | null {
  const id = videoIdFromUrl(location.href);
  if (!id) return null;
  const video = document.querySelector('video');
  return { id, title: document.querySelector('ytd-watch-metadata h1, #title h1, h1.ytd-watch-metadata')?.textContent?.trim() || document.title.replace(/ - YouTube$/, ''),
    channel: document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a')?.textContent?.trim() || '',
    duration: Number.isFinite(video?.duration) ? video!.duration : 0, currentTime: video?.currentTime || 0 };
}
// The player's own error screen is the only reliable signal that this browser cannot play the video.
// YouTube now renders that as a yt-interstitial-view-model; older players use .ytp-error.
function playbackState() {
  for (const node of document.querySelectorAll('yt-interstitial-view-model, .ytp-error')) {
    if (getComputedStyle(node).display === 'none') continue;
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || !/unavailable|can'?t play|cannot play|went wrong|try again|sign in to confirm/i.test(text)) continue;
    const detail = node.querySelector('.interstitialViewModelTextDescription')?.textContent?.trim();
    return { ok: false, reason: (detail || text).replace(/\s+/g, ' ').slice(0, 160) };
  }
  return { ok: true, reason: '' };
}
// YouTube renders its transcript twice over now: the older ytd-transcript-segment-renderer rows
// and the newer transcript-segment-view-model ones. Read whichever the page is showing.
function transcriptRows() {
  return [...document.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model')];
}
function fromDOM(videoId: string): Transcript | null {
  const rows = transcriptRows().map(node => {
    const stamp = node.querySelector('.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp')?.textContent?.trim() || '';
    const body = node.querySelector('span.ytAttributedStringHost, .segment-text')?.textContent
      || node.querySelector('.ytwTranscriptSegmentViewModelTimestamp + span')?.textContent || '';
    const parts = stamp.split(':').map(Number);
    const start = parts.length && !parts.some(Number.isNaN) ? parts.reduce((total, part) => total * 60 + part, 0) : NaN;
    return { start, duration: 0, text: body };
  });
  const segments = normalizeSegments(rows);
  return segments.length ? { videoId, segments, source: 'browser', language: 'auto' } : null;
}

// Opening YouTube's own transcript panel makes the page fetch and render the transcript itself,
// with the session it already has. No cookies leave the browser.
let openedTranscriptPanel = false;
function openTranscriptPanel(): boolean {
  if (transcriptRows().length) return true;
  const button = [...document.querySelectorAll('button, tp-yt-paper-button')].find(node =>
    /show transcript|open transcript/i.test((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')));
  if (!button) return false;
  (button as HTMLElement).click();
  openedTranscriptPanel = true;
  return true;
}
// Leave the page as it was found: close the panel only if Cue is the one that opened it.
function closeTranscriptPanel() {
  if (!openedTranscriptPanel) return;
  openedTranscriptPanel = false;
  const expanded = document.querySelector('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]');
  const button = expanded?.querySelector('button[aria-label="Close"], button[aria-label^="Close" i], tp-yt-paper-button[aria-label^="Close" i]');
  (button as HTMLElement | null)?.click();
}
async function getTranscript(videoId: string): Promise<Transcript> {
  if (videoIdFromUrl(location.href) !== videoId) throw new Error('The video changed. Try again.');
  const known = cache.get(videoId);
  if (known) return known;
  try {
    return await new Promise<Transcript>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Turn on captions or open YouTube’s transcript, then try again.')); }, 18000);
      pending.set(requestId, { resolve, reject, timer, videoId });
      window.postMessage({ source: 'cue:extension', type: 'GET_TRANSCRIPT', requestId, videoId, language: 'en' }, location.origin);
    });
  } catch (error) {
    const existing = fromDOM(videoId);
    if (existing && videoIdFromUrl(location.href) === videoId) return existing;
    if (openTranscriptPanel()) {
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 400));
        if (videoIdFromUrl(location.href) !== videoId) break;
        const scraped = fromDOM(videoId);
        if (scraped && scraped.segments.length > 2) { closeTranscriptPanel(); return scraped; }
      }
    }
    const late = fromDOM(videoId);
    closeTranscriptPanel();
    if (late && videoIdFromUrl(location.href) === videoId) return late;
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'CUE_FOCUS') { applyFocus(Boolean(message.on)); respond({ ok: true, focus: document.documentElement.classList.contains('cue-focus') }); return; }
  if (message?.type === 'CUE_STATE') { respond({ video: videoState(), playback: playbackState(), focus: document.documentElement.classList.contains('cue-focus') }); return; }
  if (message?.type === 'CUE_SEEK') {
    const video = document.querySelector('video');
    if (videoIdFromUrl(location.href) !== message.videoId || !video || !Number.isFinite(message.seconds) || message.seconds < 0) { respond({ error: 'This video is no longer open in that tab.' }); return; }
    const playback = playbackState();
    if (!playback.ok) { respond({ error: playback.reason }); return; }
    const seconds = Math.min(message.seconds, Number.isFinite(video.duration) ? video.duration : message.seconds);
    // Compressed streams (SABR) expect seeks through the player, so the page world tries that first.
    const directly = () => { video.currentTime = seconds; if (message.play) video.play().catch(() => {}); respond({ ok: true }); };
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { seekPending.delete(requestId); directly(); }, 900);
    seekPending.set(requestId, result => {
      clearTimeout(timer);
      if (result?.ok) respond({ ok: true, time: result.time });
      else directly();
    });
    window.postMessage({ source: 'cue:extension', type: 'SEEK', requestId, videoId: message.videoId, seconds, play: Boolean(message.play) }, location.origin);
    return true;
  }
  if (message?.type === 'CUE_TRANSCRIPT') {
    getTranscript(message.videoId).then(transcript => respond({ transcript })).catch(error => respond({ error: error.message }));
    return true;
  }
});
