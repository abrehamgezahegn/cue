# AGENTS.md — Cue

Cue is a YouTube side panel: ask a question about the video, get an answer that cites
timestamps you can click. Chrome MV3 extension + a local Node service. No cloud storage.

## Run it

```bash
npm run build                      # vite (panel) + esbuild (content scripts) → outputs/extension
npm start                          # local service on 127.0.0.1:4317 (also: npm run dev)
npm run check                      # tsc --noEmit — must be clean before you claim anything works
npm test                           # node:test unit suite (transcript parsing, retrieval, providers, cache)
npm run qa:preview                 # panel QA against http://127.0.0.1:4317 (12 checks)
npm run qa:extension               # installed-extension QA against real YouTube (11 checks)
```

Load `outputs/extension` via `chrome://extensions` → Developer mode → Load unpacked.
The local service serves that same folder at `http://127.0.0.1:4317` as a standalone preview.

## Layout

```
src/panel/      React panel: main.tsx (all UI), api.ts, demo.ts, style.css (hand-written, one line)
src/extension/  content.ts (isolated world), page.ts (MAIN world), background.ts
src/shared/     transcript.ts (captions parsing, formatTime, videoIdFromUrl), types.ts
server/         index.ts (routes, auth, static), answer.ts (retrieval+prompt+validation),
                providers.ts (DeepInfra + Ollama), transcript.ts (source order+cache),
                ytdlp.ts (binary), cache.ts (disk), config.ts
scripts/        build.ts, install-ytdlp.ts, smoke.ts
tests/          core.test.ts, cache.test.ts, qa/preview.ts + qa/extension.ts (Playwright QA),
                browser.ts (legacy, needs an executablePath)
docs/screenshots/    README images. Regenerate with npm run screenshots (+ screenshot-hero.ts).
work/           scratch: probes, QA profiles, design.md. Gitignored.
outputs/extension/   the built extension. Gitignored. Never edit by hand.
bin/yt-dlp      downloaded binary (36 MB). Gitignored.
.cache/transcripts/  runtime cache. Gitignored.
```

## Non-negotiables

- **Every citation must come from a segment that was actually sent to the model.** `validateAnswer`
  rejects ids outside the context. Timestamps and source text always come from the transcript,
  never from model output.
- **The API key never reaches the browser.** Panels authenticate with the token in `.cue-token`
  (baked in at build time by `vite.config.ts`). The DeepInfra key stays in `.env.local`, server only.
- **Nothing a person types is ever lost.** The composer draft, quiz answers in progress, the open tab and
  the transcript search are saved per video as they change (`draft:`, `quiz-drafts:`, `view:` keys) in
  `chrome.storage.local` (preview: `localStorage`), so a reload, a closed panel or a browser restart keeps
  them. Session storage was cleared with the browser; it is migrated once and no longer written. Saves for
  a video wait until its saved state has been read back (`restored` ref), or the empty first paint would
  overwrite it. A suggestion click must not clear the composer. A question left unanswered (Stop, reload)
  shows "Ask again". The last 150 videos keep their state (`rememberVideo`).
- **No marketing copy in the UI.** No taglines, no "Ready to ask", no "Made for the curious".
  Labels either carry information or don't ship.
- **Never run a model larger than the machine can hold.** This is a 16 GB M2 Pro: keep local
  weights under ~9 GB, realistically 4–6 GB. `gemma4:26b` (17 GB) was deleted for this reason.
  Do not pull or test anything bigger.

## How captions are fetched (order matters)

1. **The open tab first** — the panel asks the content script, 8s budget. Two attempts inside it:
   capture of the player's own caption requests, then reading YouTube's transcript panel. If no rows
   exist, Cue clicks "Show transcript" so *YouTube* fetches the transcript with the session it already
   has, scrapes the rows (`.ytwTranscriptSegmentViewModelTimestamp` + `span.ytAttributedStringHost`),
   and closes the panel again — only if Cue opened it. No cookies leave the browser.
   A scraped copy is only trusted when it reaches ~90% of the video's duration; the panel virtualises
   long transcripts, so a short scrape falls through to the service's complete file.
2. **Local service** — `yt-dlp` (primary), then `ytdl-core`. `--sub-langs <one>` only: asking for
   `en,en-orig` downloads the file twice and long videos time out.
3. **Disk cache** — `.cache/transcripts/<video>_<lang>.json`, 7-day horizon. Fresh copies answer in
   milliseconds; stale copies are served immediately while a refresh runs behind them.

`yt-dlp` refuses politely: `200` with **0 bytes**, or `400 Precondition check failed`. Both mean the
client is untrusted (usually too much anonymous traffic), not that the URL is wrong.

## Panel behaviour worth knowing

- **Retrieval** (`selectContext`): under a 24 KB budget the whole transcript is sent. Above it, an
  even spread across the video plus rarity-weighted term matches (IDF) and their neighbours. Plain
  term counting filled the budget with "what/does/mean" and missed the one rare word — don't regress
  to it.
- **Focus mode** hides the masthead, guide, recommendations, comments, chat, shelves, end screens and
  watermark. `#secondary` is hidden only when the video has no chapters and no panel is open — the
  chapters panel is opened once from the page world via `panel.visibility`. Do not set layout
  properties on `#primary`/`#columns` beyond `justify-content: center`; YouTube recomputes its own
  sizing and hand-tuned values produce a 660px player.
- **Playback errors** are `yt-interstitial-view-model` now, not `.ytp-error`. When it is present the
  panel shows the reason and seeks refuse instead of pretending to jump.
- **Seeks** go through the page world to `movie_player.seekTo()` with a 900ms fallback to
  `currentTime`. Citations, transcript rows and returns share that path.
- **Checkpoint**: where you were before your last deliberate jump — **any** jump, including the ones Cue
  makes from a citation or a transcript row, and the ones YouTube makes when you scrub or pick a
  chapter. It overwrites on each one, so the chip `↩ 6:07` is always the place the most recent jump
  left. Returning does **not** overwrite it (that seek passes `remember: false`), and there is no manual
  pin and no clear button: jumping is the only thing that moves it. An earlier build exempted Cue's own
  jumps, which read as "it doesn't save the timestamp I click on".
- **Short answers are marked by a model, not by string comparison** (`server/grade.ts`, `POST /api/grade`).
  The grader gets the question, the reference answer, the accepted variants, the question's explanation,
  the rubric and the learner's words, and is told to accept loose phrasing, typos and synonyms. It also
  gets **the stretch of transcript around the citation** (`passageAround`: 20s before, 100s after, ≤3000
  chars), never just `citations[0].text` — auto-captions are ~40-character segments, and the grader once
  marked "reward models can be gamed by RL" wrong while holding only "system in rhf just discovers the
  kinds". The transcript is labelled the authority; the reference and rubric are labelled model-written
  and possibly wrong, and a long answer needs the video's main idea, not every rubric point. It returns
  `{correct, reason}`, shown under the verdict; reasons are cut on a word (`shorten`), never mid-word.
  The normalised string match runs first as a fast path. **If the model call fails, the panel shows the
  error and "Try again" — it never records a verdict.** A paragraph can't string-match, so falling back
  to "Not quite" blamed the learner for a dropped request. **There is no manual override — do not add one back.** A button that
  turns a wrong answer into a right one makes the score meaningless: the score must be earned by
  answering, not by clicking.
- **A question can be clarified** (`server/clarify.ts`, `POST /api/clarify`). "What is this asking?"
  rephrases the question and says what shape of answer it wants. The clarifier is given the question, its
  type and the passage — **never** the answer, the accepted variants or the rubric — so it cannot leak
  what it never saw. Clarifications persist per question with the rest of the quiz state.
- **A quiz can be restarted at any point.** A `New quiz` control sits in the progress row of every
  question; it opens an inline confirm, and confirming lands on the **setup screen** — count and
  difficulty are a choice to make, not a setting to remember. The same is true of "New quiz" on the
  summary. "Keep going" returns to the question you were on, untouched. Resetting also clears the saved
  quiz for that video, or a reload would resurrect the one you just discarded.
- **Every run is seeded.** `makeSeed()` produces a six-character string per request; it deterministically
  shuffles a list of lenses ("a sceptical viewer", "an engineer debugging this") and question angles
  ("what would break it", "which assumption it rests on") into the prompt. Two runs on the same video
  share no prompts — measured 15 unique out of 15. Combined with temperature 0.8 and the avoid list,
  repetition is gone; the seed is logged under `CUE_DEBUG_QUIZ` so a run can be reproduced.
- **Ask for a surplus.** Requesting exactly N guarantees coming up short, because the evidence, label,
  number and duplicate guards each drop items. The generator is asked for N+2 and the target is trimmed
  afterwards.
- **Marked questions go deeper** (`GET`-free: `POST /api/quiz` with `focus`). The star marks a question
  as interesting; "Deeper on N marked" then asks for harder questions about *those* passages only —
  the context becomes those segments and their neighbours, so the model cannot wander off. The button
  asks how many questions first (2–6, defaulting to two per marked passage) — one question per mark was
  too thin to be worth the round trip. Deeper questions are appended to the quiz being taken and marks
  clear afterwards.
  Marking is about generating from a passage, never about scoring.
- **A quote existing is not the same as a quote answering.** After validation, every quiz goes through a
  support audit (`verifySupport`): one batched call judges whether the quoted passage actually lets a
  reader reach the stated answer, and drops the pairs where it does not. This exists because a quiz
  shipped a long question about training on conversations citing 44:49, a passage about the forward pass
  and parameter counts — the quote check passed, the meaning did not. Audited runs return 3–5 questions
  where 5–6 were asked, and the summary states the shortfall rather than pretending.
  The audit reads `passageAround` the citations from the **full** transcript, and also checks each rubric
  point of a long question: a point survives only with a verbatim quote that the server finds in that
  passage, one quote backs one point, and a long question with fewer than two points left is dropped.
  This call runs with **Qwen thinking on** (`completeJson(..., { think: true })`, own 45s budget): with
  thinking off, Qwen3-32B kept every invented point ("majority opinion rather than individual
  preferences") and dropped the real one ("RL games the reward model"), even when asked for quotes.
  Top-up questions go through the same audit. The auditor sees a choice answer as the **option text**
  (plus the options), never the stored index — it once approved "answer: 0" for a made-up figure.
- **A figure in a correct answer must be said in the video** (`inventsFigure`, in `validateQuiz`). Every
  number in a correct option, a true claim, a short/long answer or a rubric point must appear in
  `passageAround` the citation in the full transcript ("1,000", "1000" and "thousand" match; spelled-out
  compounds like "forty-five" read whole). This exists because an S-tier quiz marked "the model can
  handle numbers up to 1000 digits" correct, citing a passage that says big numbers make it fail: the
  "quantitative consequence" angle was handed to a window with no number, so the model supplied one.
  That angle now applies only where the window states a number. False claims and distractors may
  carry wrong figures — that is what makes them wrong.
- **Every question must quote the passage that settles it.** The generator returns `evidence`, a verbatim
  quote of ≤120 characters, and the server verifies it exists in the cited segment — moving the citation
  to the segment that really contains it, or dropping the question. This exists because a quiz once
  contradicted the transcript: the generator saw a *sample* of a 3.5-hour video (346 of 5761 segments),
  found no link between tokenization and arithmetic, called the link false, and cited two segments that
  merely introduced tokenization. The Ask panel, sampling elsewhere, answered the opposite. **Silence in
  a sample is not evidence of absence**, so a claim now ships only with the words that settle it.
- **Questions test understanding, not recall.** Three structural guards reject, for medium/hard on
  transcripts of 30+ segments: a prompt that **quotes its own passage** (memorisation of a sentence),
  a prompt that **asks for a label** ("what is X called"), and a prompt that **asks for a figure** ("how
  many / what is the size"). A near-duplicate guard drops a second question about the same fact. The
  prompt tells the model to ask why, what follows, how it compares, how it applies — and that the
  reader already remembers the video and is being asked to think with it.
- **Four question types, and the mix is enforced.** `choice`, `boolean`, `short` (≤5 words) and `long`
  (a paragraph, marked against a 2–4 point rubric). The generator is given the exact counts, a retry
  when a type is missing, and a top-up request for just the missing type — a 1-question top-up must
  validate against 1, not against the full count, or it silently fails. Short material (<30 segments)
  gets a single pass: retries there chain into a timeout, and a ten-segment clip cannot carry four
  types anyway.
- **Quiz** (`server/quiz.ts`, `POST /api/quiz`, third tab): six questions asked, two each of
  `choice` (2–6 options, one correct), `boolean` and `short`. Difficulty is `easy | medium | hard | s`;
  **S tier** is not "hard with more words" — it has its own angle list (counterfactuals, quantitative
  consequences, the strongest objection, a case the video never shows), and the support audit is told
  that several cited passages count together, because synthesis questions cannot be settled by one
  quote. With one retry if the model returns fewer,
  and three accepted as a minimum — the count is whatever it can ground in the transcript. Every
  question must cite real segment ids. Navigation is free in both directions after that: Back/Next,
  answers lock once given, and the summary reopens any question. Grading happens in the panel: choice and boolean by index/verdict, short answers by normalised
  match against `answer` + `accept`, with an "I said that" self-override because a paraphrase cannot be
  graded by string comparison. Questions that fail validation are dropped, and a short result triggers
  one regeneration — never pad a quiz with ungrounded questions to reach the requested count.
- **Failures name the real cause.** A failed request probes `/api/health` before deciding what to say:
  timeout, "dropped the connection while answering", or "cannot reach its local service". The three
  look identical to `fetch`, and telling someone to run `npm start` when the service is up and merely
  restarted mid-request wastes their time. The panel also counts seconds while a request is in flight.
- **Model output is read tolerantly, never with a bare `JSON.parse`.** `parseModelJson` strips fences and
  preamble, and repairs truncated JSON by keeping the parts that finished. An unparseable reply is
  retried once with "Reply with only the JSON object", and the final error names the model and quotes
  what it said. The old dead end — "The answer was incomplete. Try a shorter question." — must not
  come back; it told the person nothing and blamed them for the model's failure.
- **Answers come with diagrams, drawn by a second request** (`server/visualize.ts`, `POST /api/visualize`).
  Once an answer is on screen the panel asks for visuals: per paragraph, null or one of a `diagram`
  (boxes and labelled arrows, branches allowed), a `table` (columns are the things compared, each row is
  an aspect then one value per column) or an `example` (labelled "Example from the video" or
  "Illustration"). The model gets each paragraph with `passageAround` its citations, never the whole
  video. **Do not move visuals back into the answer call**: asked for both at once, Qwen3-32B cited runs
  of 8–19 consecutive ids to "support" each box and failed the outside-the-context check on 3 of 5
  questions that answered cleanly without them. Here a failure costs a diagram, never the answer, and
  the panel stays quiet about it.
  The model returns structured nodes and edges, **never Mermaid code**: `mermaidSource` rewrites ids to
  `n1…` and entity-escapes labels, so no label can change the graph. Mermaid (`securityLevel: 'strict'`)
  is a lazy chunk loaded with the first diagram; the panel bundle does not grow, and the chunks contain
  no `eval`, which the extension CSP forbids. A figure in a visual must appear in its passage
  (`inventsFigure`): an example that invents one becomes an illustration, a diagram or table is dropped.
  The model once drew "hello" → ID 123 as "the video's own example". Generic titles ("X process",
  "A vs B") are removed, identical visuals are drawn once, and an answer carries two at most.
- **Models**: picker lists Ollama `/api/tags` live plus `cloudModels` (`server/config.ts`): the configured
  `DEEPINFRA_MODEL` (default DeepSeek V4 Flash: Qwen3-32B pricing, better quiz questions) and a curated DeepInfra list (Qwen3-32B, DeepSeek V4 Flash / V4.1 Flash / V4 Pro,
  GLM-5.3 Flash, Gemma 4 31B turbo), replaceable with `DEEPINFRA_MODELS`. Each was probed for strict
  `json_schema` output and a 1–2s short answer; Qwen3-235B-A22B (70s+) and gpt-oss-120b (always reasons)
  were left out. Prices under the picker come from DeepInfra's public `/models/list`, read once per run
  and never waited on for more than 1.5s; never hand-type a price. Reasoning is switched per family
  (`reasoningSwitch`): Qwen `enable_thinking`, DeepSeek `thinking`, and **never** on for Gemma 4 — with
  reasoning on it loops to `max_tokens` and returns broken JSON. Ollama is
  called on `/api/chat` with the JSON schema as `format` and **no** auth header. Small models that
  invent ids are rejected with "Try a larger model" — that refusal is correct, not a bug.

## Testing gotchas

- **Branded Chrome 157 ignores `--load-extension`.** Automated runs use Chrome for Testing at
  `~/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app`.
- **Playwright expects `chromium-1255`; the cache has 1243.** Always pass `executablePath`.
- **Pass `page.evaluate` bodies as strings when running under `tsx`.** esbuild's `keepNames` injects
  `__name`, which doesn't exist in the page and throws `ReferenceError: __name is not defined`.
- **The composer's accessible name changes** after the first message ("Ask about this video" →
  "Ask a follow-up"). Use `#question`.
- **Extension ids derive from the absolute folder path.** Moving the project means removing the
  extension from Chrome and loading `outputs/extension` again.
- **Rebuild after every `src/` change** and restart the service after every `server/` change; the
  preview at :4317 serves `outputs/extension`, not source.
- Use a fresh profile directory per QA run, or stale content scripts will test old code.

## Secrets and files that must never be committed

`.env.local`, `.cue-token`, `bin/`, `.cache/`, `work/`, `outputs/extension/`.

## Definition of done

`npm run check` clean, `npm test` green, both QA harnesses green, and the change verified in a
browser — not just in the type system.
