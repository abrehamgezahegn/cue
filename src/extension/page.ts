import { parseCaptions } from '../shared/transcript';
// Runs in YouTube's page world. Only caption/player responses are observed.
// No cookies, headers, account data, or unrelated response bodies leave the page.
(() => {
  const w = window as any;
  if (w.__cueInstalled) return;
  w.__cueInstalled = true;
  // Focus mode hides the rail's recommendations but keeps chapters usable, so the
  // chapters panel is opened once when the mode turns on. Closing it afterwards stays closed.
  const CHAPTERS = 'engagement-panel-macro-markers-description-chapters';
  function openChapters(tries = 0) {
    if (!document.documentElement.classList.contains('cue-focus')) return;
    const panel = document.querySelector(`ytd-engagement-panel-section-list-renderer[target-id="${CHAPTERS}"]`) as any;
    if (panel && document.querySelector('ytd-macro-markers-list-item-renderer')) {
      if (panel.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') { try { panel.visibility = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'; } catch {} }
      return;
    }
    if (tries < 24) setTimeout(() => openChapters(tries + 1), 500);
  }
  let focusWasOn = document.documentElement.classList.contains('cue-focus');
  new MutationObserver(() => {
    const focusIsOn = document.documentElement.classList.contains('cue-focus');
    if (focusIsOn === focusWasOn) return;
    focusWasOn = focusIsOn;
    if (focusIsOn) openChapters();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  if (focusWasOn) openChapters();

  const captured = new Map<string, { raw: string; language: string }>();
  const nativeFetch = window.fetch.bind(window);
  function hasCaptions(raw: string) { try { return parseCaptions(raw).length > 0; } catch { return false; } }
  const currentId = () => new URL(location.href).searchParams.get('v') || location.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1] || '';
  const send = (data: object) => window.postMessage({ source: 'cue:page', ...data }, location.origin);
  const captionUrl = (raw: string) => {
    try { const u = new URL(raw, location.href); return u.origin === location.origin && u.pathname === '/api/timedtext' ? u : null; } catch { return null; }
  };
  function observe(raw: string, url: string, requestVideoId: string) {
    if (!raw || raw.length > 6_000_000 || !hasCaptions(raw)) return;
    const u = new URL(url, location.href);
    const videoId = u.searchParams.get('v') || requestVideoId;
    if (!/^[\w-]{11}$/.test(videoId)) return;
    if (u.pathname === '/api/timedtext' || u.pathname === '/youtubei/v1/get_transcript') {
      if (captured.size >= 5) captured.delete(captured.keys().next().value!);
      const value = { raw, language: u.searchParams.get('lang') || 'auto' };
      captured.set(videoId, value);
      send({ type: 'CAPTIONS', videoId, ...value });
    }
  }
  const relevant = (url: string) => {
    try { const u = new URL(url, location.href); return u.origin === location.origin && ['/api/timedtext', '/youtubei/v1/get_transcript'].includes(u.pathname); } catch { return false; }
  };
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
    const videoId = currentId();
    const response = await nativeFetch(...args);
    if (relevant(url) && response.ok) response.clone().text().then(raw => observe(raw, url, videoId)).catch(() => {});
    return response;
  };
  const open = XMLHttpRequest.prototype.open;
  const requests = new WeakMap<XMLHttpRequest, { url: string; videoId: string }>();
  XMLHttpRequest.prototype.open = function (...args: any[]) {
    const url = String(args[1]);
    if (relevant(url)) requests.set(this, { url, videoId: currentId() });
    else requests.delete(this);
    return (open as any).apply(this, args);
  };
  const sendXHR = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const request = requests.get(this);
    if (request) this.addEventListener('load', () => {
      try { if (this.status === 200) observe(this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText, request.url, request.videoId); } catch {}
    }, { once: true });
    return sendXHR.apply(this, args);
  };
  async function load(videoId: string, language: string) {
    if (currentId() !== videoId) throw new Error('The video changed. Try again.');
    const known = captured.get(videoId);
    if (known) return known;
    const player = document.getElementById('movie_player') as any;
    const response = player?.getPlayerResponse?.() || w.ytInitialPlayerResponse;
    if (response?.videoDetails?.videoId !== videoId) throw new Error('The video is still loading. Try again.');
    // Use the same endpoint that YouTube's Show transcript button invokes.
    // Its params come from this video's page data, never from a guessed request.
    function findEndpoint(root: any) {
      const seen = new WeakSet(); let count = 0;
      function visit(node: any, depth = 0): any {
        if (!node || typeof node !== 'object' || depth > 30 || count++ > 50000 || seen.has(node)) return null;
        seen.add(node);
        if (typeof node.getTranscriptEndpoint?.params === 'string') return node.getTranscriptEndpoint;
        for (const value of Object.values(node)) { const found = visit(value, depth + 1); if (found) return found; }
        return null;
      }
      return visit(root);
    }
    const watchData = (document.querySelector('ytd-watch-flexy') as any)?.data;
    const data = watchData?.currentVideoEndpoint?.watchEndpoint?.videoId === videoId ? watchData
      : w.ytInitialPlayerResponse?.videoDetails?.videoId === videoId ? w.ytInitialData : null;
    const endpoint = findEndpoint(data);
    const context = w.ytcfg?.get?.('INNERTUBE_CONTEXT');
    if (endpoint && context) {
      try {
        const url = new URL('/youtubei/v1/get_transcript', location.origin);
        url.searchParams.set('prettyPrint', 'false');
        const key = w.ytcfg.get('INNERTUBE_API_KEY');
        if (key) url.searchParams.set('key', key);
        const res = await nativeFetch(url.href, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context, params: endpoint.params }), signal: AbortSignal.timeout(5000) });
        const raw = await res.text();
        if (res.ok && hasCaptions(raw)) return { raw, language: 'auto' };
      } catch {}
    }
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const sorted = [...tracks].sort((a: any, b: any) => ((b.languageCode?.startsWith(language) ? 10 : 0) + (b.kind !== 'asr' ? 1 : 0)) - ((a.languageCode?.startsWith(language) ? 10 : 0) + (a.kind !== 'asr' ? 1 : 0)));
    for (const track of sorted.slice(0, 2)) {
      const url = captionUrl(track.baseUrl);
      if (!url) continue;
      url.searchParams.set('fmt', 'json3');
      try {
        const res = await nativeFetch(url.href, { credentials: 'same-origin', signal: AbortSignal.timeout(3000) });
        const raw = await res.text();
        if (res.ok && hasCaptions(raw)) return { raw, language: track.languageCode || 'auto' };
      } catch {}
    }
    // Reuse a caption request made before the content script connected.
    const entries = performance.getEntriesByType('resource').map(e => captionUrl(e.name)).filter((u): u is URL => Boolean(u && u.searchParams.get('v') === videoId));
    for (const url of entries.slice(-2)) {
      try {
        const res = await nativeFetch(url.href, { credentials: 'same-origin', signal: AbortSignal.timeout(2000) });
        const raw = await res.text();
        if (res.ok && hasCaptions(raw)) return { raw, language: url.searchParams.get('lang') || 'auto' };
      } catch {}
    }
    throw new Error('Turn on captions or open YouTube’s transcript, then try again.');
  }
  // Seeks go through the player when it exposes seekTo, which is what compressed streams expect.
  window.addEventListener('message', event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.source !== 'cue:extension' || m.type !== 'SEEK' || typeof m.requestId !== 'string') return;
    const reply = (data: object) => window.postMessage({ source: 'cue:page', ...data }, location.origin);
    const player = document.getElementById('movie_player') as any;
    const video = document.querySelector('video');
    try {
      if (player && typeof player.seekTo === 'function') player.seekTo(Number(m.seconds), true);
      else if (video) video.currentTime = Number(m.seconds);
      else throw new Error('The player is not ready.');
      if (m.play && video?.paused) video.play().catch(() => {});
      reply({ type: 'SEEK_RESULT', requestId: m.requestId, ok: true, time: video?.currentTime ?? Number(m.seconds) });
    } catch (error: any) {
      reply({ type: 'SEEK_RESULT', requestId: m.requestId, ok: false, error: error?.message || 'The seek failed.' });
    }
  });
  window.addEventListener('message', event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.source !== 'cue:extension' || m.type !== 'GET_TRANSCRIPT' || typeof m.requestId !== 'string') return;
    load(m.videoId, String(m.language || 'en')).then(data => send({ type: 'RESULT', requestId: m.requestId, videoId: m.videoId, ...data }))
      .catch(error => send({ type: 'RESULT', requestId: m.requestId, error: error.message }));
  });
})();
