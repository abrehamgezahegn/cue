import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ArrowUpRight, ArrowRight, Check, ChevronDown, Copy, FileText, MessageCircle, Plus, RefreshCw, Search, Settings2, Square, X, Play, Download, LoaderCircle, AlertCircle, Focus, Undo2, ListChecks, ChevronsDown, Check as CheckMark, X as CrossMark, RotateCcw } from 'lucide-react';
import '@fontsource-variable/geist';
import './style.css';
import { api, isExtension, readSaved, rememberVideo, save } from './api';
import { demoTranscript, demoVideo } from './demo';
import { formatTime, formatDuration, passageAround, readingTimeMinutes, videoIdFromUrl, wordCount } from '../shared/transcript';
import type { ChatMessage, Citation, Health, ProviderId, Quiz, QuizQuestion, Transcript, Video } from '../shared/types';

declare const __CUE_BUILT__: string;

const preview = !isExtension;
function Mark({ small = false }: { small?: boolean }) {
  return <svg width={small ? 20 : 26} height={small ? 20 : 26} viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M10 5H5v18h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="m14 7 10 7-10 7V7Z" fill="currentColor"/></svg>;
}
const id = () => crypto.randomUUID();
type Mode = 'loading' | 'ready' | 'missing' | 'no-video';
function App() {
  const [video, setVideo] = useState<Video | null>(preview ? demoVideo : null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(preview ? demoTranscript : null);
  const [mode, setMode] = useState<Mode>(preview ? 'ready' : 'loading');
  const [loadLabel, setLoadLabel] = useState('Finding the transcript…');
  const [error, setError] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [playback, setPlayback] = useState<{ ok: boolean; reason: string } | null>(null);
  const [checkpoint, setCheckpoint] = useState<number | null>(null);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizAnswers, setQuizAnswers] = useState<({ correct: boolean; given: string; note?: string } | null)[]>([]);
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizError, setQuizError] = useState('');
  const [quizDone, setQuizDone] = useState(false);
  const [quizChecking, setQuizChecking] = useState(false);
  const [quizGradeError, setQuizGradeError] = useState<{ index: number; message: string } | null>(null);
  const [quizCount, setQuizCount] = useState(6);
  const [quizLevel, setQuizLevel] = useState('medium');
  const [quizMarked, setQuizMarked] = useState<number[]>([]);
  const [quizDeeper, setQuizDeeper] = useState(false);
  const [quizConfirm, setQuizConfirm] = useState(false);
  const [quizClarify, setQuizClarify] = useState<Record<number, string>>({});
  const [quizRequested, setQuizRequested] = useState(6);
  const [deeperOpen, setDeeperOpen] = useState(false);
  const [deeperCount, setDeeperCount] = useState(3);
  const [quizClarifyBusy, setQuizClarifyBusy] = useState(false);
  const [quizDrafts, setQuizDrafts] = useState<Record<number, string>>({});
  const [tab, setTab] = useState<'ask' | 'transcript' | 'quiz'>('ask');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [busySeconds, setBusySeconds] = useState(0);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState(false);
  const [playOnJump, setPlayOnJump] = useState(true);
  const [choice, setChoice] = useState<{ provider: ProviderId; model: string } | null>(null);
  const [focus, setFocus] = useState(false);
  const [theme, setTheme] = useState('light');
  const [toast, setToast] = useState('');
  const [copied, setCopied] = useState('');
  const [clearConfirm, setClearConfirm] = useState(false);
  const [videoDetails, setVideoDetails] = useState(false);
  const current = useRef('');
  const focusRef = useRef(false);
  const checkpointRef = useRef<number | null>(null);
  const lastPosition = useRef<{ t: number; at: number } | null>(null);
  const ignoreJumpsUntil = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const answerController = useRef<AbortController | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const draftBeforeAsk = useRef('');
  const storageKey = useRef('');
  // The video whose saved drafts have been read back. Until then nothing is written for it, or the
  // empty state of the first paint would overwrite what the person typed before a reload.
  const restored = useRef('');

  const checkHealth = useCallback(async () => {
    try { setHealth(await api.health()); setConnectionError(''); }
    catch (e: any) { setHealth(null); setConnectionError(e.message); }
  }, []);
  useEffect(() => { void checkHealth(); }, [checkHealth]);
  useEffect(() => {
    readSaved('preferences', { playOnJump: true, theme: 'light', focus: false, choice: null, quizCount: 6, quizLevel: 'medium' }).then(p => { setPlayOnJump(p.playOnJump); setTheme(p.theme); setFocus(Boolean(p.focus)); setChoice(p.choice ?? null); setQuizCount(Number(p.quizCount) || 6); setQuizLevel(String(p.quizLevel || 'medium')); });
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (settings) settingsDialog.current?.showModal(); else settingsDialog.current?.close();
  }, [settings]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 2800); return () => clearTimeout(t); } }, [toast]);
  useEffect(() => { focusRef.current = focus; }, [focus]);
  useEffect(() => {
    if (!busy) { setBusySeconds(0); return; }
    const started = Date.now();
    const timer = setInterval(() => setBusySeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => { checkpointRef.current = checkpoint; }, [checkpoint]);
  useEffect(() => {
    // Never write null here: on first paint there is no quiz yet, and it would erase the saved one
    // before the restore below has read it.
    if (!video || !quiz) return;
    void save(`quiz:${video.id}`, { videoId: video.id, quiz, index: quizIndex, answers: quizAnswers, done: quizDone, marked: quizMarked, clarify: quizClarify });
  }, [video?.id, quiz, quizIndex, quizAnswers, quizDone, quizMarked, quizClarify]);
  // Anything typed is saved as it is typed: a reload, a closed panel or a browser restart keeps it.
  useEffect(() => {
    if (!video || restored.current !== video.id) return;
    void save(`draft:${video.id}`, draft || null);
  }, [video?.id, draft]);
  useEffect(() => {
    if (!video || restored.current !== video.id) return;
    const kept = Object.fromEntries(Object.entries(quizDrafts).filter(([, text]) => text));
    void save(`quiz-drafts:${video.id}`, Object.keys(kept).length ? kept : null);
  }, [video?.id, quizDrafts]);
  useEffect(() => {
    if (!video || restored.current !== video.id) return;
    void save(`view:${video.id}`, { tab, query });
  }, [video?.id, tab, query]);
  useEffect(() => {
    const latestQuestion = [...document.querySelectorAll('.user-message')].at(-1);
    latestQuestion?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [messages.length, busy]);

  const loadTranscript = useCallback(async (nextVideo: Video, nextTabId: number | null) => {
    loadController.current?.abort();
    const controller = new AbortController(); loadController.current = controller;
    setMode('loading'); setTranscript(null); setError(''); setLoadLabel('Finding the transcript…');
    try {
      let result: Transcript;
      if (preview) result = demoTranscript;
      else {
        // The open tab already holds a signed-in player session, so ask it first and briefly.
        // Only fall back to the local service, which has to impersonate a client, when that fails.
        const fromTab = await Promise.race([
          chrome.tabs.sendMessage(nextTabId!, { type: 'CUE_TRANSCRIPT', videoId: nextVideo.id }),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 8000)),
        ]).catch(() => null);
        if (controller.signal.aborted) return;
        const scraped = fromTab?.transcript;
        // YouTube's transcript panel virtualises long videos, so a scraped copy can stop early.
        // Only trust it when it reaches the end; otherwise the service's complete file wins.
        const reachesEnd = scraped && nextVideo.duration > 0
          ? scraped.segments[scraped.segments.length - 1].start >= nextVideo.duration * 0.9 - 5
          : Boolean(scraped);
        if (scraped && reachesEnd) result = scraped;
        else {
          setLoadLabel('Reading captions…');
          try { result = await api.transcript(nextVideo.id, controller.signal); }
          catch (e: any) {
            if (controller.signal.aborted) return;
            if (scraped) result = scraped;            // partial beats nothing
            else throw new Error(fromTab?.error || e.message);
          }
        }
      }
      if (controller.signal.aborted) return;
      if (result.videoId !== nextVideo.id || !result.segments?.length) throw new Error('The transcript does not match this video. Try again.');
      setTranscript(result); setMode('ready');
    } catch (e: any) {
      if (controller.signal.aborted) return;
      setMode('missing'); setError(e.message?.includes('Receiving end') ? 'Refresh the YouTube tab to connect Cue, then try again.' : e.message);
    }
  }, []);

  useEffect(() => {
    let closed = false, polling = false;
    async function sync() {
      if (polling) return; polling = true;
      try {
        let nextVideo: Video | null = preview ? demoVideo : null;
        let nextTabId: number | null = null;
        let pageFocus: boolean | null = null;
        let nextPlayback: { ok: boolean; reason: string } | null = null;
        if (!preview) {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          const nextId = active?.url ? videoIdFromUrl(active.url) : null;
          if (nextId && active?.id != null) {
            nextTabId = active.id;
            try {
              const state = await chrome.tabs.sendMessage(active.id, { type: 'CUE_STATE' });
              nextVideo = state.video;
              if (typeof state.focus === 'boolean') pageFocus = state.focus;
              if (state.playback) nextPlayback = state.playback;
            } catch { nextVideo = { id: nextId, title: active.title?.replace(/ - YouTube$/, '') || 'YouTube video', channel: '', currentTime: 0, duration: 0 }; }
          }
        }
        if (closed) return;
        const nextKey = nextVideo ? `${nextTabId}:${nextVideo.id}` : 'none';
        if (current.current === nextKey) {
          if (nextVideo && !preview) { setVideo(nextVideo); trackPosition(nextVideo); }
          return;
        }
        current.current = nextKey;
        restored.current = '';
        answerController.current?.abort(); loadController.current?.abort();
        setBusy(false); setVideo(nextVideo); setTabId(nextTabId); setMessages([]); setDraft(''); setQuery(''); setError(''); setClearConfirm(false); setPlayback(null);
        lastPosition.current = nextVideo ? { t: nextVideo.currentTime, at: Date.now() } : null;
        setQuiz(null); setQuizIndex(0); setQuizAnswers([]); setQuizDone(false); setQuizError(''); setQuizBusy(false); setQuizDrafts({}); setQuizChecking(false); setQuizGradeError(null); setQuizMarked([]); setQuizDeeper(false); setQuizConfirm(false); setQuizClarify({}); setQuizClarifyBusy(false);
        storageKey.current = nextVideo ? `chat:${nextVideo.id}` : '';
        setCheckpoint(null);
        if (!nextVideo) { setTranscript(null); setMode('no-video'); return; }
        // The page owns the focus state; the panel adopts it so the button never lies.
        if (pageFocus !== null) { setFocus(pageFocus); focusRef.current = pageFocus; }
        setPlayback(nextPlayback);
        const saved = await readSaved<ChatMessage[]>(storageKey.current, []);
        const savedCheckpoint = await readSaved<number | null>(`checkpoint:${nextVideo.id}`, null);
        if (closed || current.current !== nextKey) return;
        setMessages(Array.isArray(saved) ? saved.slice(-40) : []);
        setCheckpoint(typeof savedCheckpoint === 'number' ? savedCheckpoint : null);
        const savedQuiz = await readSaved<any>(`quiz:${nextVideo.id}`, null);
        if (closed || current.current !== nextKey) return;
        if (savedQuiz?.videoId === nextVideo.id && savedQuiz.quiz?.questions?.length) {
          setQuiz(savedQuiz.quiz); setQuizIndex(Number(savedQuiz.index) || 0);
          setQuizAnswers(Array.isArray(savedQuiz.answers) ? savedQuiz.answers : []);
          setQuizDone(Boolean(savedQuiz.done));
          setQuizMarked(Array.isArray(savedQuiz.marked) ? savedQuiz.marked.filter((value: unknown) => typeof value === 'number') : []);
          setQuizClarify(savedQuiz.clarify && typeof savedQuiz.clarify === 'object' ? savedQuiz.clarify : {});
        }
        const [savedDraft, savedQuizDrafts, savedView] = await Promise.all([
          readSaved<string>(`draft:${nextVideo.id}`, ''),
          readSaved<Record<number, string> | null>(`quiz-drafts:${nextVideo.id}`, null),
          readSaved<{ tab?: string; query?: string } | null>(`view:${nextVideo.id}`, null),
        ]);
        if (closed || current.current !== nextKey) return;
        if (typeof savedDraft === 'string') setDraft(savedDraft);
        if (savedQuizDrafts && typeof savedQuizDrafts === 'object') setQuizDrafts(savedQuizDrafts);
        if (savedView?.tab === 'ask' || savedView?.tab === 'transcript' || savedView?.tab === 'quiz') setTab(savedView.tab);
        if (typeof savedView?.query === 'string') setQuery(savedView.query);
        restored.current = nextVideo.id;
        void rememberVideo(nextVideo.id);
        void loadTranscript(nextVideo, nextTabId);
      } finally { polling = false; }
    }
    void sync();
    // Poll only page identity/playhead; transcripts are loaded once per video.
    const interval = preview ? undefined : setInterval(() => void sync(), 1500);
    return () => { closed = true; clearInterval(interval); answerController.current?.abort(); loadController.current?.abort(); };
  }, [loadTranscript]);

  // Only a question sent from the composer empties it. A suggestion or a retry leaves the draft alone.
  async function ask(raw: string, previous = messages, fromComposer = false) {
    const question = raw.trim();
    if (!question || busy || !transcript || mode !== 'ready') return;
    const controller = new AbortController(); answerController.current = controller;
    const key = storageKey.current;
    const user: ChatMessage = { id: id(), role: 'user', text: question };
    const next = [...previous, user].slice(-40);
    draftBeforeAsk.current = question;
    setMessages(next); if (fromComposer) setDraft(''); setBusy(true); setError(''); setTab('ask');
    await save(key, next);
    try {
      const answer = await api.ask(question, transcript, previous, model, controller.signal);
      if (controller.signal.aborted) return;
      const finished: ChatMessage[] = [...next, { id: id(), role: 'assistant', text: answer.parts.map(p => p.text).join('\n\n'), answer }];
      setMessages(finished); await save(key, finished);
      setHealth(await api.health()); setConnectionError('');
    } catch (e: any) { if (!controller.signal.aborted) setError(e.message); }
    finally { if (answerController.current === controller) { setBusy(false); input.current?.focus(); } }
  }
  function stop() { answerController.current?.abort(); setBusy(false); setToast('Answer stopped'); }
  // The unanswered question is the last message: after a reload, a closed panel or Stop, it is all that is left.
  async function retry() {
    const last = messages.at(-1);
    if (last?.role === 'user') return ask(last.text, messages.slice(0, -1));
    await ask(draftBeforeAsk.current, messages);
  }
  // The checkpoint is where you were before your own last navigation in the player.
  // Scrub, click the progress bar or pick a chapter: the playhead jumps, the place it left is kept.
  // Cue's own jumps are handled in seekSeconds; this catches navigation Cue never sees.
  function trackPosition(next: Video) {
    const previous = lastPosition.current;
    lastPosition.current = { t: next.currentTime, at: Date.now() };
    if (!previous || Date.now() < ignoreJumpsUntil.current) return;
    const moved = next.currentTime - previous.t;
    const elapsed = (Date.now() - previous.at) / 1000;
    if (Math.abs(moved) < 3 || Math.abs(moved - elapsed) < 3 || previous.t < 0.5) return;
    checkpointRef.current = previous.t;
    setCheckpoint(previous.t);
    void save(`checkpoint:${next.id}`, previous.t);
  }
  async function seekSeconds(seconds: number, options: { remember?: boolean } = {}) {
    if (!video) return;
    // Every deliberate jump keeps the place it left — including the ones Cue makes for you.
    if (options.remember !== false) {
      const at = video.currentTime;
      if (at > 0.5 && Math.abs(at - seconds) > 1) {
        checkpointRef.current = at;
        setCheckpoint(at);
        void save(`checkpoint:${video.id}`, at);
      }
    }
    ignoreJumpsUntil.current = Date.now() + 3000;
    lastPosition.current = { t: seconds, at: Date.now() };
    if (preview) { setVideo(v => v && { ...v, currentTime: seconds }); setToast(`Preview jumped to ${formatTime(seconds)}`); return; }
    try {
      const result = await chrome.tabs.sendMessage(tabId!, { type: 'CUE_SEEK', videoId: video.id, seconds, play: playOnJump });
      if (!result?.ok) throw new Error(result?.error || 'Could not find the video.');
      setToast(`Jumped to ${formatTime(seconds)}`);
    } catch (e: any) { setToast(e.message || 'Refresh the YouTube tab and try again.'); }
  }
  function seek(citation: Citation) { return seekSeconds(citation.start); }
  function backToHeld() {
    if (checkpoint === null) return;
    // A return is not navigation: it must not overwrite the spot it returns to.
    return seekSeconds(checkpoint, { remember: false });
  }

  const normalizeAnswer = (value: string) => value.toLocaleLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  // "New quiz" returns to the setup screen: the count and difficulty are a choice, not a memory test.
  function openQuizSetup() {
    if (video) void save(`quiz:${video.id}`, null);
    setQuiz(null); setQuizAnswers([]); setQuizIndex(0); setQuizDone(false); setQuizMarked([]);
    setQuizDrafts({}); setQuizError(''); setQuizBusy(false); setQuizChecking(false); setQuizConfirm(false); setQuizDeeper(false); setQuizClarify({}); setQuizRequested(quizCount); setDeeperOpen(false);
  }
  async function startQuiz() {
    if (!transcript) return;
    const controller = new AbortController(); answerController.current = controller;
    setQuizBusy(true); setQuizError(''); setQuiz(null); setQuizIndex(0); setQuizAnswers([]); setQuizDone(false); setQuizDrafts({}); setQuizChecking(false); setQuizGradeError(null); setQuizMarked([]); setQuizDeeper(false); setQuizConfirm(false); setQuizClarify({}); setQuizClarifyBusy(false);
    try {
      const result = await api.quiz(transcript, { title: video?.title || '', count: quizCount, difficulty: quizLevel, avoid: quiz ? quiz.questions.map(question => question.prompt) : [] }, model, controller.signal);
      if (controller.signal.aborted) return;
      setQuiz(result); setQuizAnswers(new Array(result.questions.length).fill(null));
    } catch (e: any) { if (!controller.signal.aborted) setQuizError(e.message); }
    finally { if (answerController.current === controller) setQuizBusy(false); }
  }
  function gradeShort(question: QuizQuestion, given: string) {
    const value = normalizeAnswer(given);
    if (!value) return false;
    return [String(question.answer), ...(question.accept || [])].some(candidate => normalizeAnswer(candidate) === value);
  }
  function recordAnswer(correct: boolean, given: string, note?: string) {
    setQuizAnswers(previous => { const next = [...previous]; next[quizIndex] = { correct, given, note }; return next; });
  }
  // String comparison is the fast path; a model marks the answer when the words differ but the meaning may not.
  async function submitWrittenAnswer() {
    const question = quiz?.questions[quizIndex];
    const given = (quizDrafts[quizIndex] || '').trim();
    if (!question || !given || quizAnswer || quizChecking) return;
    if (gradeShort(question, given)) { recordAnswer(true, given, 'Same as the expected answer.'); return; }
    const controller = new AbortController(); answerController.current = controller;
    const index = quizIndex;
    setQuizChecking(true); setQuizGradeError(null);
    // One caption segment is a few words; the grader needs the stretch of speech the question is about.
    const cited = question.citations.map(citation => citation.start);
    const passage = (transcript && passageAround(transcript.segments, cited)) || question.citations.map(citation => citation.text).join(' ');
    try {
      const verdict = await api.grade({ prompt: question.prompt, answer: question.answer, accept: question.accept, explanation: question.explanation, passage, rubric: question.rubric }, given, model, controller.signal);
      if (controller.signal.aborted) return;
      recordAnswer(verdict.correct, given, verdict.reason);
    } catch (e: any) {
      // A failed call is not a wrong answer. The string match above already ran; say what broke and keep the draft.
      if (!controller.signal.aborted) setQuizGradeError({ index, message: e?.message || 'That answer could not be marked.' });
    } finally { if (answerController.current === controller) setQuizChecking(false); }
  }
  // The clarification never sees the answer, so it cannot give it away.
  async function askClarification() {
    if (!quizQuestion || quizClarifyBusy || quizClarify[quizIndex]) return;
    const controller = new AbortController(); answerController.current = controller;
    setQuizClarifyBusy(true);
    try {
      const result = await api.clarify({ prompt: quizQuestion.prompt, type: quizQuestion.type, passage: quizQuestion.citations[0]?.text || '' }, model, controller.signal);
      if (controller.signal.aborted) return;
      setQuizClarify(previous => ({ ...previous, [quizIndex]: result.text }));
    } catch (e: any) {
      if (!controller.signal.aborted) setQuizClarify(previous => ({ ...previous, [quizIndex]: e.message || 'Could not ask for a clarification.' }));
    } finally { if (answerController.current === controller) setQuizClarifyBusy(false); }
  }
  function toggleMark(index: number) {
    setQuizMarked(previous => previous.includes(index) ? previous.filter(value => value !== index) : [...previous, index]);
  }
  // Deeper questions are appended to the quiz being taken, so the run continues instead of restarting.
  async function goDeeper() {
    if (!quiz || !transcript || !quizMarked.length || quizDeeper) return;
    const controller = new AbortController(); answerController.current = controller;
    const focus = quizMarked.filter(index => quiz.questions[index]).map(index => ({
      prompt: quiz.questions[index].prompt,
      segmentIds: quiz.questions[index].citations.map(citation => citation.segmentId),
    }));
    const existing = quiz.questions.length;
    setQuizDeeper(true);
    try {
      const result = await api.quiz(transcript, { title: video?.title || '', count: deeperCount, difficulty: 'hard', avoid: quiz.questions.map(question => question.prompt), focus }, model, controller.signal);
      if (controller.signal.aborted) return;
      setQuiz(current => current ? { ...current, questions: [...current.questions, ...result.questions.map((question, index) => ({ ...question, id: existing + index }))] } : current);
      setQuizAnswers(previous => [...previous, ...result.questions.map(() => null)]);
      setQuizMarked([]); setQuizDone(false); setQuizIndex(existing); setDeeperOpen(false);
      setToast(`${result.questions.length} deeper question${result.questions.length === 1 ? '' : 's'} added`);
    } catch (e: any) {
      if (!controller.signal.aborted) setToast(e.message || 'Could not write deeper questions.');
    } finally { if (answerController.current === controller) setQuizDeeper(false); }
  }
  function nextQuestion() {
    if (!quiz) return;
    if (quizIndex + 1 >= quiz.questions.length) { setQuizDone(true); return; }
    setQuizIndex(index => index + 1);
  }
  function previousQuestion() {
    if (quizIndex === 0) return;
    setQuizIndex(index => index - 1);
  }
  function openQuestion(index: number) {
    setQuizIndex(index); setQuizDone(false);
  }
  function TimeLink({ citation }: { citation: Citation }) {
    return <button className="time-link" title={citation.text} onClick={() => void seek(citation)} aria-label={`Jump to ${formatTime(citation.start)}: ${citation.text}`}><Play size={10} fill="currentColor" />{formatTime(citation.start)}</button>;
  }
  async function copy(message: ChatMessage) {
    const text = message.answer ? message.answer.parts.map(p => `${p.text}${p.citations.map(c => ` [${formatTime(c.start)}]`).join('')}`).join('\n\n') : message.text;
    try { await navigator.clipboard.writeText(text); setCopied(message.id); setTimeout(() => setCopied(''), 2000); }
    catch { setToast('Could not copy. Select the answer text to copy it.'); }
  }
  function download() {
    if (!transcript || !video) return;
    const text = `${video.title}\n\n${transcript.segments.map(s => `${formatTime(s.start)}  ${s.text}`).join('\n\n')}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = `cue-${video.id}-transcript.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function updatePreferences(p: { playOnJump?: boolean; theme?: string; focus?: boolean; choice?: { provider: ProviderId; model: string } | null; quizCount?: number; quizLevel?: string }) {
    const next = { playOnJump, theme, focus, choice, quizCount, quizLevel, ...p };
    setPlayOnJump(next.playOnJump); setTheme(next.theme); setFocus(next.focus); setChoice(next.choice ?? null); setQuizCount(next.quizCount); setQuizLevel(next.quizLevel);
    void save('preferences', next);
  }
  async function toggleFocus() {
    const next = !focus;
    updatePreferences({ focus: next });
    if (preview) { setToast(next ? 'On YouTube this hides the recommendations and comments' : 'Focus mode off'); return; }
    try {
      const result = await chrome.tabs.sendMessage(tabId!, { type: 'CUE_FOCUS', on: next, videoId: video?.id });
      if (!result?.ok) throw new Error('no answer');
      setToast(next ? 'Focus mode on' : 'Focus mode off');
    } catch { setToast('Refresh the YouTube tab to connect Cue, then try again.'); }
  }
  const segments = transcript?.segments.filter(s => s.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || [];
  const currentSegment = transcript?.segments.findLast(s => s.start <= (video?.currentTime || 0));
  const ready = mode === 'ready' && Boolean(transcript);
  const localModels = health?.providers?.ollama.models ?? [];
  const cloudModels = health?.providers?.deepinfra.models ?? [];
  const model: { provider: ProviderId; model: string } | null = choice ?? (health ? { provider: health.provider, model: health.model } : null);
  const modelValue = model ? `${model.provider}:${model.model}` : '';
  const chosenLocal = model?.provider === 'ollama';
  const quizQuestion = quiz?.questions[quizIndex] ?? null;
  const quizAnswer = quizAnswers[quizIndex] ?? null;
  const quizCorrect = quizAnswers.filter(answer => answer?.correct).length;
  return <div className="app">
    <header className="topbar"><div className="brand"><Mark /><span>Cue</span>{preview && <span className="preview-chip" title="Sample video, live answers from the local service">Preview</span>}</div><div className="top-actions">
      {video && <button className={`icon-button ${focus ? 'is-on' : ''}`} aria-pressed={focus} aria-label="Focus mode" title={focus ? 'Turn focus mode off' : 'Focus mode: hide recommendations and comments'} onClick={() => void toggleFocus()}><Focus size={18}/></button>}
      {messages.length > 0 && <button className="icon-button" aria-label="New conversation" title="New conversation" onClick={() => setClearConfirm(true)}><Plus size={18}/></button>}
      <button className="icon-button" aria-label="Settings" title="Settings" onClick={() => setSettings(true)}><Settings2 size={18}/></button>
    </div></header>
    {clearConfirm && <div className="clear-confirm"><p>Clear this video's conversation?</p><button onClick={() => setClearConfirm(false)}>Keep it</button><button className="text-strong" onClick={() => { answerController.current?.abort(); setBusy(false); setMessages([]); setError(''); void save(storageKey.current, []); setClearConfirm(false); }}>Clear</button></div>}
    {video && <section className="video-context" aria-label="Current video">
      <div className="thumbnail">{preview ? <div className="sample-cover"><span>Make<br/>room.</span><Play size={12} fill="currentColor"/></div> : <img src={`https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`} alt=""/>}</div>
      {checkpoint !== null && <button className="checkpoint-chip" title={`Back to where you were: ${formatTime(checkpoint)}`} onClick={() => void backToHeld()} aria-label={`Back to ${formatTime(checkpoint)}`}><Undo2 size={13}/>{formatTime(checkpoint)}</button>}
      <div className="video-details"><button className="video-title-button" aria-expanded={videoDetails} aria-label="Video details" onClick={() => setVideoDetails(v => !v)}><h1 title={video.title}>{video.title}</h1><ChevronDown size={13} className={videoDetails ? 'expanded' : ''}/></button>{videoDetails && <p>{video.channel || 'YouTube'}{video.duration > 0 && <><span className="separator">·</span><span>{formatTime(video.duration)}</span></>}</p>}</div>
    </section>}
    {video && <nav className="tabs" aria-label="Video assistant"><button className={tab === 'ask' ? 'selected' : ''} onClick={() => setTab('ask')} aria-current={tab === 'ask' ? 'page' : undefined}><MessageCircle size={15}/>Ask</button><button className={tab === 'transcript' ? 'selected' : ''} onClick={() => setTab('transcript')} aria-current={tab === 'transcript' ? 'page' : undefined}><FileText size={15}/>Transcript</button><button className={tab === 'quiz' ? 'selected' : ''} onClick={() => setTab('quiz')} aria-current={tab === 'quiz' ? 'page' : undefined}><ListChecks size={15}/>Quiz</button><span className="tab-spacer"/>{tab === 'transcript' && ready && <button className="icon-button" title="Download transcript" aria-label="Download transcript" onClick={download}><Download size={15}/></button>}</nav>}
    <main className={`main ${tab === 'transcript' ? 'transcript-main' : ''}`}>
      {playback && !playback.ok && video && <div className="playback-notice" role="status"><AlertCircle size={15}/><div><p>YouTube can't play this video in this browser.</p><span>{playback.reason}</span><button onClick={() => { if (!preview) void chrome.tabs.reload(tabId!); }}><RefreshCw size={12}/>Reload the page</button></div></div>}
      {mode === 'no-video' && <div className="empty-state no-video"><Mark /><h1>A question for your video.</h1><p>Open a YouTube video, then come back to Cue.</p><a className="primary-button" href="https://www.youtube.com" target="_blank" rel="noreferrer">Open YouTube <ArrowUpRight size={16}/></a></div>}
      {mode === 'loading' && <div className="loading-state" role="status"><LoaderCircle className="spin" size={18}/><h2>{loadLabel}</h2></div>}
      {mode === 'missing' && <div className="empty-state"><FileText size={26}/><h2>No transcript yet</h2><p>{error}</p><button className="secondary-button" onClick={() => video && void loadTranscript(video, tabId)}><RefreshCw size={14}/>Try again</button><p className="small-note">Some videos don't have captions available.</p></div>}
      {ready && tab === 'ask' && <>
        {messages.length === 0 ? <div className="welcome"><div className="suggestions">{['Give me the key takeaways', 'Explain the main idea simply', 'What can I put into practice?'].map(suggestion => <button key={suggestion} onClick={() => void ask(suggestion)}><span>{suggestion}</span><ArrowUpRight size={14}/></button>)}</div></div> : <div className="messages" role="log" aria-label="Conversation">{messages.map(m => m.role === 'user' ? <div className="user-message" key={m.id}>{m.text}</div> : <article className="assistant-message" key={m.id}>{m.answer?.parts.map((p, i) => <div className="answer-part" key={i}><p>{p.text}</p>{p.citations.length > 0 && <div className="citations">{p.citations.map(c => <TimeLink key={c.segmentId} citation={c}/>)}</div>}</div>)}{m.answer?.coverage === 'selected' && <p className="coverage-note">Based on selected passages from this long video.</p>}<div className="answer-actions"><button className="icon-button" title="Copy answer" aria-label="Copy answer" onClick={() => void copy(m)}>{copied === m.id ? <Check size={14}/> : <Copy size={14}/>}</button>{copied === m.id && <span>Copied</span>}</div></article>)}</div>}
        {busy && <div className="thinking" role="status"><Mark small/><span>Finding the right moments</span><span className="thinking-dots">···</span>{busySeconds >= 5 && <span className="thinking-time">{busySeconds}s</span>}</div>}
        {error && !busy && <div className="inline-error" role="alert"><AlertCircle size={16}/><div><p>{error}</p><button onClick={() => void retry()}>Try again <RefreshCw size={12}/></button></div></div>}
        {!error && !busy && messages.at(-1)?.role === 'user' && <div className="inline-error unanswered" role="status"><div><p>No answer to this question yet.</p><button onClick={() => void retry()}>Ask again <RefreshCw size={12}/></button></div></div>}
        <div ref={chatEnd}/>
      </>}
      {ready && tab === 'transcript' && <>
        <div className="transcript-tools"><label className="search"><Search size={15}/><input aria-label="Search transcript" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find in transcript…"/>{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={14}/></button>}</label><div className="transcript-meta"><span>{query ? `${segments.length} matching passages · ${wordCount(segments)} words` : `${transcript!.segments.length} passages · ${wordCount(transcript!.segments)} words · ${formatDuration(readingTimeMinutes(wordCount(transcript!.segments)))} read`}</span><button onClick={() => video && void loadTranscript(video, tabId)} title="Refresh transcript"><RefreshCw size={12}/>Refresh</button></div></div>
        <div className="transcript-list">{segments.map(s => <button key={s.id} className={`transcript-row ${currentSegment?.id === s.id ? 'current' : ''}`} onClick={() => void seek({ segmentId: s.id, start: s.start, text: s.text })}><time>{formatTime(s.start)}</time><span>{s.text}</span></button>)}{segments.length === 0 && <p className="no-results">No passages match "{query}".</p>}</div>
      </>}
      {ready && tab === 'quiz' && <>
        {!quiz && !quizBusy && !quizError && <div className="quiz-intro">
          <h2>A quiz on this video</h2>
          <p>Multiple choice, true or false, and short answers. Every answer shows the moment it comes from.</p>
          <div className="quiz-setup">
            <label><span>Questions</span><select aria-label="Number of questions" value={quizCount} onChange={event => updatePreferences({ quizCount: Number(event.target.value) })}>{[4, 6, 8, 10].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
            <label><span>Difficulty</span><select aria-label="Difficulty" value={quizLevel} onChange={event => updatePreferences({ quizLevel: event.target.value })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option><option value="s">S tier</option></select></label>
          </div>
          <button className="primary-button" onClick={() => void startQuiz()}><ListChecks size={15}/>Start quiz</button>
        </div>}
        {quizBusy && <div className="thinking" role="status"><Mark small/><span>Writing questions…</span><span className="thinking-dots">···</span>{busySeconds >= 5 && <span className="thinking-time">{busySeconds}s</span>}</div>}
        {quizError && !quizBusy && <div className="inline-error" role="alert"><AlertCircle size={16}/><div><p>{quizError}</p><button onClick={() => void startQuiz()}>Try again <RefreshCw size={12}/></button></div></div>}
        {quiz && !quizDone && quizQuestion && <>
          <div className="quiz-progress">
            <span>Question {quizIndex + 1} of {quiz.questions.length}</span>
            <span className="quiz-progress-right">
              <span>{quizCorrect} correct</span>
              <button className={`quiz-mark ${quizMarked.includes(quizIndex) ? 'on' : ''}`} onClick={() => toggleMark(quizIndex)} aria-pressed={quizMarked.includes(quizIndex)} aria-label={quizMarked.includes(quizIndex) ? 'Remove from the deeper pass' : 'Mark for a deeper pass'} title={quizMarked.includes(quizIndex) ? 'Included in the deeper pass' : 'Mark for a deeper pass — ask a harder question about this moment'}>
                <ChevronsDown size={14} />
              </button>
              <button className="quiz-restart" onClick={() => setQuizConfirm(true)} aria-expanded={quizConfirm}>New quiz</button>
            </span>
          </div>
          {quizConfirm && <div className="quiz-confirm">
            <p>Start a new quiz? This one is discarded, and you pick the settings next.</p>
            <div className="quiz-setup">
              <label><span>Questions</span><select aria-label="Number of questions" value={quizCount} onChange={event => updatePreferences({ quizCount: Number(event.target.value) })}>{[4, 6, 8, 10].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
              <label><span>Difficulty</span><select aria-label="Difficulty" value={quizLevel} onChange={event => updatePreferences({ quizLevel: event.target.value })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option><option value="s">S tier</option></select></label>
            </div>
            <div className="quiz-confirm-actions">
              <button className="secondary-button" onClick={() => setQuizConfirm(false)}>Keep going</button>
              <button className="primary-button" onClick={openQuizSetup}>New quiz</button>
            </div>
          </div>}
          <p className="quiz-prompt">{quizQuestion.prompt}</p>
          {quizClarify[quizIndex]
            ? <p className="quiz-clarify">{quizClarify[quizIndex]}</p>
            : <button className="quiz-clarify-button" onClick={() => void askClarification()} disabled={quizClarifyBusy}>{quizClarifyBusy ? 'Asking…' : "What is this asking?"}</button>}
          {quizQuestion.type === 'long' ? <form className="quiz-short quiz-long" onSubmit={event => { event.preventDefault(); void submitWrittenAnswer(); }}>
            <textarea aria-label="Your answer" rows={4} value={quizDrafts[quizIndex] || ''} disabled={Boolean(quizAnswer) || quizChecking} placeholder="Write a few sentences…" onChange={event => setQuizDrafts(drafts => ({ ...drafts, [quizIndex]: event.target.value }))} />
            <button className="secondary-button" type="submit" disabled={Boolean(quizAnswer) || quizChecking || !(quizDrafts[quizIndex] || '').trim()}>{quizChecking ? 'Marking…' : 'Check'}</button>
          </form> : quizQuestion.type === 'short' ? <form className="quiz-short" onSubmit={event => { event.preventDefault(); void submitWrittenAnswer(); }}>
            <input aria-label="Your answer" value={quizDrafts[quizIndex] || ''} disabled={Boolean(quizAnswer) || quizChecking} placeholder="A word or two…" onChange={event => setQuizDrafts(drafts => ({ ...drafts, [quizIndex]: event.target.value }))} />
            <button className="secondary-button" type="submit" disabled={Boolean(quizAnswer) || quizChecking || !(quizDrafts[quizIndex] || '').trim()}>{quizChecking ? 'Checking…' : 'Check'}</button>
          </form> : <div className="quiz-options">
            {(quizQuestion.type === 'boolean' ? ['True', 'False'] : quizQuestion.options || []).map((option, index) => {
              const value = quizQuestion.type === 'boolean' ? index === 0 : index;
              const isCorrect = quizQuestion.type === 'boolean' ? quizQuestion.answer === value : quizQuestion.answer === index;
              const chosen = quizAnswer?.given === String(index);
              const state = quizAnswer ? (isCorrect ? 'correct' : chosen ? 'wrong' : '') : '';
              return <button key={option} className={state} disabled={Boolean(quizAnswer)} onClick={() => recordAnswer(isCorrect, String(index))}>
                <span className="quiz-letter">{quizQuestion.type === 'boolean' ? (index === 0 ? 'T' : 'F') : 'ABCD'[index]}</span>
                <span>{option}</span>
                {quizAnswer && isCorrect && <CheckMark size={14}/>}
                {quizAnswer && chosen && !isCorrect && <CrossMark size={14}/>}
              </button>;
            })}
          </div>}
          {!quizAnswer && quizGradeError?.index === quizIndex && <div className="inline-error" role="alert"><AlertCircle size={16}/><div><p>{quizGradeError.message}</p><button onClick={() => void submitWrittenAnswer()}>Try again <RefreshCw size={12}/></button></div></div>}
          {quizAnswer && <div className="quiz-feedback">
            <p className={`quiz-verdict ${quizAnswer.correct ? 'correct' : 'wrong'}`}>{quizAnswer.correct ? 'Correct' : 'Not quite'}</p>
            {quizAnswer.note && <p className="quiz-grader">{quizAnswer.note}</p>}
            <p>{quizQuestion.explanation}</p>
            {quizQuestion.type === 'long' && quizQuestion.rubric && <div className="quiz-rubric"><p>An answer needed:</p><ul>{quizQuestion.rubric.map(point => <li key={point}>{point}</li>)}</ul><p className="quiz-model-answer">{String(quizQuestion.answer)}</p></div>}
            {quizQuestion.type === 'short' && !quizAnswer.correct && <p className="quiz-expected">The video says: <strong>{String(quizQuestion.answer)}</strong></p>}
            <div className="citations">{quizQuestion.citations.map(citation => <TimeLink key={citation.segmentId} citation={citation}/>)}</div>
          </div>}
          {deeperOpen && <div className="quiz-confirm">
            <p>Deeper on {quizMarked.length} marked {quizMarked.length === 1 ? 'passage' : 'passages'}. How many questions?</p>
            <div className="quiz-setup">
              <label><span>Questions</span><select aria-label="Deeper question count" value={deeperCount} onChange={event => setDeeperCount(Number(event.target.value))}>{[2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
            </div>
            <div className="quiz-confirm-actions">
              <button className="secondary-button" onClick={() => setDeeperOpen(false)}>Cancel</button>
              <button className="primary-button" onClick={() => void goDeeper()} disabled={quizDeeper}>{quizDeeper ? 'Writing…' : 'Generate'}</button>
            </div>
          </div>}
          <div className="quiz-nav">
            <button className="secondary-button" onClick={previousQuestion} disabled={quizIndex === 0}><ArrowRight size={14} className="flip" />Back</button>
            {quizMarked.length > 0 && <button className="secondary-button quiz-deeper" onClick={() => { setDeeperCount(Math.min(6, Math.max(2, quizMarked.length * 2))); setDeeperOpen(true); }} disabled={quizDeeper}>{quizDeeper ? 'Writing…' : `Deeper on ${quizMarked.length} marked`}</button>}
            <button className="primary-button" onClick={nextQuestion}>{quizIndex + 1 >= quiz.questions.length ? 'See results' : 'Next'}<ArrowRight size={14}/></button>
          </div>
        </>}
        {quiz && quizDone && <div className="quiz-summary">
          <p className="quiz-score">{quizCorrect} of {quiz.questions.length} correct</p>
          {quiz.questions.length < quizRequested && <p className="quiz-hint">Asked for {quizRequested}; {quiz.questions.length} could be pinned to a quote in the transcript.</p>}
          {quizMarked.length > 0 && <p className="quiz-hint">{quizMarked.length} marked for a deeper pass — go deeper on {quizMarked.length === 1 ? 'it' : 'them'}, or start fresh.</p>}
          <div className="quiz-review">{quiz.questions.map((question, index) => <div className="quiz-review-row" key={question.id}>
            <button className={`quiz-tick ${quizAnswers[index]?.correct ? 'correct' : 'wrong'}`} onClick={() => openQuestion(index)} aria-label={`Open question ${index + 1}`}>{quizAnswers[index]?.correct ? <CheckMark size={13}/> : <CrossMark size={13}/>}</button>
            <button className="quiz-review-prompt" onClick={() => openQuestion(index)}>{question.prompt}</button>
            <span className="quiz-review-link">{question.citations.slice(0, 1).map(citation => <TimeLink key={citation.segmentId} citation={citation}/>)}</span>
          </div>)}</div>
          <div className="quiz-summary-actions">
            <button className="secondary-button" onClick={openQuizSetup}><RotateCcw size={14}/>New quiz</button>
            {quizMarked.length > 0 && <button className="secondary-button" onClick={() => { setDeeperCount(Math.min(6, Math.max(2, quizMarked.length * 2))); setDeeperOpen(true); }} disabled={quizDeeper}>{quizDeeper ? 'Writing…' : `Deeper on ${quizMarked.length} marked`}</button>}
          </div>
        </div>}
      </>}
    </main>
    {video && tab === 'ask' && <footer className="composer-area">{(connectionError || health?.configured === false) && <button className="connection-notice" onClick={() => setSettings(true)}><AlertCircle size={13}/>{health?.configured === false ? 'No model available — start Ollama or add a key' : 'Local service is offline'}<ArrowRight size={13}/></button>}<form className={`composer ${busy ? 'is-busy' : ''}`} onSubmit={e => { e.preventDefault(); void ask(draft, messages, true); }}><label className="sr-only" htmlFor="question">Ask about this video</label><textarea id="question" ref={input} rows={2} maxLength={2000} value={draft} disabled={!ready} onChange={e => setDraft(e.target.value)} placeholder={messages.length ? 'Ask a follow-up…' : 'Ask about this video…'} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft, messages, true); } }}/><div className="composer-bottom">{busy && <span>Reading the transcript</span>}{busy ? <button className="send-button" type="button" onClick={stop} aria-label="Stop answer"><Square size={13} fill="currentColor"/></button> : <button className="send-button" type="submit" disabled={!ready || !draft.trim()} aria-label="Send question"><ArrowUp size={18}/></button>}</div></form></footer>}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status">{toast}</div>
    <dialog ref={settingsDialog} className="settings-dialog" onCancel={() => setSettings(false)} onClick={e => { if (e.target === settingsDialog.current) setSettings(false); }}><div className="settings-inner"><div className="settings-header"><h2>Settings</h2><button className="icon-button" aria-label="Close settings" onClick={() => setSettings(false)}><X size={18}/></button></div><section className="setting-section"><div className="setting-title"><span>Model</span><span className={`connection-status ${health?.configured ? 'connected' : ''}`}>{health?.configured ? 'Connected' : 'Offline'}</span></div><label className="model-row"><span className="sr-only">Model</span><select aria-label="Model" value={modelValue} disabled={!localModels.length && !cloudModels.length} onChange={e => { const raw = e.target.value; const cut = raw.indexOf(':'); updatePreferences({ choice: { provider: raw.slice(0, cut) as ProviderId, model: raw.slice(cut + 1) } }); }}>{localModels.length > 0 && <optgroup label="This computer">{localModels.map(m => <option key={`ollama:${m}`} value={`ollama:${m}`}>{m}</option>)}</optgroup>}{cloudModels.length > 0 && <optgroup label="DeepInfra">{cloudModels.map(m => <option key={`deepinfra:${m}`} value={`deepinfra:${m}`}>{m}</option>)}</optgroup>}</select></label><p className="settings-help">{chosenLocal ? 'Runs on this computer. Nothing leaves the machine.' : 'Transcript passages go to DeepInfra for each question.'}</p>{connectionError && <p className="settings-help">{connectionError}</p>}{health && !health.configured && <p className="settings-help">Start Ollama with "ollama serve", or add DEEPINFRA_API_KEY to .env.local.</p>}<button className="text-button" onClick={() => void checkHealth()}><RefreshCw size={13}/>Rescan models</button></section><section className="setting-section"><label className="setting-row"><span><span className="setting-title">Play after jumping</span><span className="settings-help">Resume the video at a cited moment.</span></span><input className="switch" type="checkbox" checked={playOnJump} onChange={e => updatePreferences({ playOnJump: e.target.checked })}/></label><label className="setting-row appearance"><span>Appearance</span><select value={theme} onChange={e => updatePreferences({ theme: e.target.value })}><option value="light">Light</option><option value="dark">Dark</option></select></label></section><section className="setting-section privacy-note"><p>Your API key stays in the local service. Questions and transcript passages go to DeepInfra only when a cloud model is selected.</p><p>Conversations, drafts and quiz progress are saved in this browser for your last 150 videos.</p></section><div className="settings-footer"><span>Cue <span>0.1</span></span><span title={new Date(__CUE_BUILT__).toISOString()}>built {new Date(__CUE_BUILT__).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div></div></dialog>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
