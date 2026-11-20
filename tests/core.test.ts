import './env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, normalizeSegments, parseCaptions, passageAround, videoIdFromUrl } from '../src/shared/transcript';
import type { QuizQuestion } from '../src/shared/types';
import { answerQuestion, coalesceCitations, parseModelJson, selectContext, validateAnswer } from '../server/answer';
import { apiKey } from '../server/config';
import { requestFailureMessage } from '../src/shared/errors';
import { buildGradeMessages, shorten, validateGrade } from '../server/grade';
import { applyAudit, asksForLabel, asksForNumber, quotesItsSource, verifySupport } from '../server/quiz';

test('parses JSON3 captions with correct millisecond conversion and line joins', () => {
  const rows = parseCaptions(JSON.stringify({ events: [{ tStartMs: 12345, dDurationMs: 2000, segs: [{ utf8: 'A question\n' }, { utf8: 'and answer' }] }, { tStartMs: 0 }] }));
  assert.deepEqual(rows, [{ id: 0, start: 12.345, duration: 2, text: 'A question and answer' }]);
});
test('parses legacy and srv3 XML captions including entities', () => {
  assert.deepEqual(parseCaptions('<transcript><text start="2.5" dur="3">Tom &amp; Jerry &quot;hello&quot;</text></transcript>'), [{ id: 0, start: 2.5, duration: 3, text: 'Tom & Jerry "hello"' }]);
  assert.equal(parseCaptions('<timedtext><body><p t="1250" d="2000"><s>hello </s><s>world</s></p></body></timedtext>')[0].text, 'hello world');
});
test('parses the YouTube transcript endpoint renderer', () => {
  const data = { actions: [{ updateEngagementPanelAction: { content: { transcriptSegmentRenderer: { startMs: '60000', endMs: '62000', snippet: { runs: [{ text: 'One minute in.' }] } } } } }] };
  assert.equal(parseCaptions(data)[0].start, 60);
});
test('normalizes unsorted data, removes invalid starts and near duplicates', () => {
  assert.deepEqual(normalizeSegments([{ start: 5, text: ' later ' }, { start: 0, text: 'First' }, { start: -1, text: 'bad' }, { start: Infinity, text: 'bad' }, { start: 5.2, text: 'later' }]).map(s => [s.id, s.start, s.text]), [[0, 0, 'First'], [1, 5, 'later']]);
});
test('only accepts actual YouTube video URLs', () => {
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ']) assert.equal(videoIdFromUrl(url), 'dQw4w9WgXcQ');
  for (const url of ['https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=bad', 'not a URL', 'https://www.youtube.com/']) assert.equal(videoIdFromUrl(url), null);
});
test('formats long video timestamps and invalid values safely', () => {
  assert.equal(formatTime(3605.9), '1:00:05'); assert.equal(formatTime(65), '1:05'); assert.equal(formatTime(NaN), '0:00');
});
const segments = normalizeSegments([{ start: 134, duration: 20, text: 'Put your phone in another room.' }, { start: 244, text: 'Take a break.' }]);
test('timestamps and source text come from the transcript, not model values', () => {
  const result = validateAnswer({ notFound: false, parts: [{ text: 'Move the phone.', segmentIds: [0], start: 999 }] }, segments, 'full', 'test');
  assert.equal(result.parts[0].citations[0].start, 134);
  assert.equal(result.parts[0].citations[0].text, segments[0].text);
});
test('rejects invented citations and uncited claims', () => {
  // Numeric strings are accepted and duplicates collapse, but an id that was never supplied is a hard error.
  const coerced = validateAnswer({ notFound: false, parts: [{ text: 'A claim.', segmentIds: ['0', 0] }] }, segments, 'full', 'test');
  assert.equal(coerced.parts[0].citations.length, 1);
  assert.equal(coerced.parts[0].citations[0].segmentId, 0);
  assert.throws(() => validateAnswer({ notFound: false, parts: [{ text: 'A claim.', segmentIds: [0, 9] }] }, segments, 'full', 'test'), /outside the transcript/);
  assert.throws(() => validateAnswer({ notFound: false, parts: [{ text: 'A claim.', segmentIds: [] }] }, segments, 'full', 'test'));
  assert.throws(() => validateAnswer({ notFound: false, parts: [] }, segments, 'full', 'test'));
});
test('not-found responses cannot smuggle unsupported model claims', () => {
  const result = validateAnswer({ notFound: true, parts: [{ text: 'An unsupported claim.', segmentIds: [] }] }, segments, 'full', 'test');
  assert.equal(result.parts[0].citations.length, 0); assert.ok(!result.parts[0].text.includes('unsupported'));
});
test('long transcripts include relevant late passages and stay within the byte budget', () => {
  const rows = normalizeSegments(Array.from({ length: 1000 }, (_, i) => ({ start: i * 10, text: i === 973 ? 'The rare aardvark answer is here.' : `Ordinary passage ${i}. This discussion has many segments.` })));
  const context = selectContext(rows, 'Where is the rare aardvark?', 5000);
  assert.equal(context.coverage, 'selected'); assert.ok(context.segments.some(s => s.id === 973));
  assert.ok(Buffer.byteLength(context.segments.map(s => JSON.stringify({ id: s.id, text: s.text })).join('\n')) <= 5000);
});
test('a failed request explains which of the three failures happened', () => {
  assert.match(requestFailureMessage({ timedOut: true, reachable: true }), /took too long/);
  assert.match(requestFailureMessage({ timedOut: false, reachable: true }), /dropped the connection/);
  assert.match(requestFailureMessage({ timedOut: false, reachable: false }), /cannot reach its local service/);
});

test('short answers are marked by a model, with the video context attached', () => {
  const messages = buildGradeMessages({ question: 'Why post-train?', given: 'to make an assistant', reference: 'to turn the base model into an assistant', accept: ['to make it chat'], context: 'Post-training turns the base model into an assistant.' });
  const user = String(messages[1].content);
  assert.match(user, /Reference answer \(written by a model, may be incomplete\): to turn/);
  assert.match(user, /Also accepted: to make it chat/);
  assert.match(user, /Why the reference is right: Post-training/);
  assert.match(String(messages[0].content), /spelling mistakes/);
  assert.deepEqual(validateGrade({ correct: true, reason: 'Same meaning.' }, 'm'), { correct: true, reason: 'Same meaning.', model: 'm' });
  assert.throws(() => validateGrade({ reason: 'no verdict' }, 'm'), /unreadable verdict/);
});

test('the grader treats the transcript as the authority and the rubric as a model guess', () => {
  // No context: the rubric used to vanish from the prompt whenever the explanation was empty.
  const messages = buildGradeMessages({ question: 'Why can RLHF go wrong?', given: 'the model games the reward model', reference: 'It optimises a simulation.', rubric: ['simulation of humans', 'RL games it'], passage: 'a lossy simulation of humans ... RL is extremely good at discovering a way to game the simulation' });
  const user = String(messages[messages.length - 1].content);
  assert.match(user, /What the video says \(transcript, the authority\): a lossy simulation/);
  assert.match(user, /Points a good answer might make \(written by a model, may be wrong\): simulation of humans; RL games it/);
  assert.match(String(messages[0].content), /follow the transcript/);
  assert.ok(messages.some(message => /does not need every listed point/.test(String(message.content))), 'long answers are judged on the main idea');
  assert.ok(user.indexOf('What the video says') < user.indexOf('Reference answer'), 'the transcript comes before the model-written reference');
});

test('grader reasons end on a word, never mid-word', () => {
  const long = 'Your answer mentions human bias but does not address that reward models focus on majority preferences rather than individual preferences in every case';
  const short = shorten(long, 120);
  assert.ok(short.length <= 120);
  assert.match(short, /…$/);
  assert.ok(long.startsWith(short.slice(0, -1)) && long[short.length - 1] === ' ', `cut at a word boundary: "${short}"`);
  assert.equal(shorten('Fine as is.', 120), 'Fine as is.');
  assert.ok(validateGrade({ correct: false, reason: 'x '.repeat(400) }, 'm').reason.length <= 320);
});

test('a cited moment becomes the stretch of speech around it', () => {
  const segments = Array.from({ length: 100 }, (_, id) => ({ id, start: id * 2, duration: 2, text: `w${id}` }));
  const passage = passageAround(segments, [100], { before: 10, after: 20 });
  assert.equal(passage, Array.from({ length: 16 }, (_, i) => `w${45 + i}`).join(' '));
  // Two citations: their windows merge, no segment repeats.
  const both = passageAround(segments, [100, 110], { before: 10, after: 20 }).split(' ');
  assert.equal(new Set(both).size, both.length);
  assert.equal(both[0], 'w45'); assert.equal(both[both.length - 1], 'w65');
  assert.ok(passageAround(segments, [100], { before: 100, after: 100, max: 20 }).length <= 20);
  assert.equal(passageAround(segments, []), '');
});

test('the support audit trims rubric points the passage never makes', () => {
  const base = { prompt: 'p', explanation: 'e', citations: [{ segmentId: 0, start: 0, text: 't' }] };
  const questions: QuizQuestion[] = [
    { ...base, id: 0, type: 'long', answer: 'a', rubric: ['real one', 'invented', 'real two'] },
    { ...base, id: 1, type: 'choice', answer: 0, options: ['x', 'y'] },
    { ...base, id: 2, type: 'long', answer: 'a', rubric: ['real', 'invented', 'also invented'] },
    { ...base, id: 3, type: 'long', answer: 'a', rubric: ['kept', 'kept too'] },
    { ...base, id: 4, type: 'boolean', answer: true },
  ];
  const kept = applyAudit(questions, { supported: new Set([0, 1, 2, 3]), points: new Map([[0, [0, 2]], [2, [0]]]) });
  // q2 keeps one point (too few), q3 has no backed points at all, q4 failed the audit.
  assert.deepEqual(kept.map(question => question.id), [0, 1], 'renumbered after drops');
  assert.deepEqual(kept[0].rubric, ['real one', 'real two'], 'unsupported point removed');
  assert.equal(kept[1].type, 'choice');
  assert.deepEqual(applyAudit(questions, { supported: new Set([0]), points: null })[0].rubric, questions[0].rubric, 'no point verdicts at all is not a verdict');
});

test('a rubric point survives the audit only with a real, specific quote', async () => {
  const segments = [
    { id: 0, start: 0, duration: 5, text: 'the reward model is a lossy simulation of humans' },
    { id: 1, start: 5, duration: 5, text: 'and RL is extremely good at discovering a way to game the simulation' },
    { id: 2, start: 10, duration: 5, text: 'so we are going to train the model on this' },
  ];
  const question: QuizQuestion = { id: 0, type: 'long', prompt: 'Why can RLHF mislead?', answer: 'a', explanation: 'e', citations: [{ segmentId: 0, start: 0, text: segments[0].text }], rubric: ['simulation', 'gaming', 'majority opinion', 'sampled data'] };
  const reply = { supported: [0], points: [
    { id: 0, point: 0, quote: 'a lossy simulation of humans' },
    { id: 0, point: 1, quote: 'Discovering a way to GAME the simulation!' },
    { id: 0, point: 2, quote: 'it focuses on what the majority prefers' },
    { id: 0, point: 3, quote: 'train the model on this' },
    { id: 0, point: 2, quote: 'train the model on this' },
  ] };
  let sent: any;
  const fetcher = (async (_url: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] })); }) as typeof fetch;
  const audit = await verifySupport({ provider: 'deepinfra', model: 'Qwen/Qwen3-32B' }, [question], segments, AbortSignal.timeout(5000), fetcher);
  assert.deepEqual(audit.points?.get(0), [0, 1, 3], 'invented quote rejected; a reused quote backs only the first point it was given to');
  assert.match(String(sent.messages[1].content), /game the simulation/, 'the audit reads the speech around the citation, not the citation alone');
  assert.equal(sent.chat_template_kwargs.enable_thinking, true);
});

test('asking for a figure is recall, not comprehension', () => {
  assert.equal(asksForNumber('What is the approximate size of the vocabulary?'), true);
  assert.equal(asksForNumber('How many web pages did Common Crawl index in 2024?'), true);
  assert.equal(asksForNumber('Why does the vocabulary size limit what the model can say?'), false);
});

test('a definition lookup is not a comprehension question', () => {
  assert.equal(asksForLabel('What is the process of converting words into tokens called?'), true);
  assert.equal(asksForLabel('Which term describes the model holding context?'), true);
  assert.equal(asksForLabel('Why does tokenization split on word boundaries?'), false);
});

test('a question quoting its own passage is treated as recall', () => {
  const passage = 'so the tokenization outcome of hello space world is two tokens';
  assert.equal(quotesItsSource("What is the tokenization outcome of 'hello space world'?", passage), true);
  assert.equal(quotesItsSource('Why does tokenization split on word boundaries rather than characters?', passage), false);
  assert.equal(quotesItsSource('What does \u201ctwo tokens\u201d imply about the context window?', passage), true);
  assert.equal(quotesItsSource('Is that fast?', passage), false);
});

test('citations inside the same moment collapse into one chip', () => {
  const cite = (start: number) => ({ segmentId: start, start, text: `at ${start}` });
  assert.deepEqual(coalesceCitations([cite(62), cite(64), cite(67)]).map(c => c.start), [62]);
  assert.deepEqual(coalesceCitations([cite(120), cite(30), cite(100)]).map(c => c.start), [30, 100, 120]);
  assert.deepEqual(coalesceCitations([cite(0), cite(8), cite(17)]).map(c => c.start), [0, 17], 'just outside the window stays');
  assert.deepEqual(coalesceCitations([]), []);
});

test('model output is read even when it is fenced, padded or cut off', () => {
  const body = { notFound: false, parts: [{ text: 'A claim.', segmentIds: [0] }] };
  assert.deepEqual(parseModelJson(JSON.stringify(body)), body);
  assert.deepEqual(parseModelJson('```json\n' + JSON.stringify(body) + '\n```'), body);
  assert.deepEqual(parseModelJson('Sure! Here it is: ' + JSON.stringify(body) + ' Hope that helps.'), body);

  // truncated mid-second-part: the complete parts survive
  const truncated = '{"notFound":false,"parts":[{"text":"First.","segmentIds":[0]},{"text":"Second is cut';
  const repaired = parseModelJson(truncated);
  assert.ok(repaired, 'a truncated answer should be repaired');
  assert.equal(repaired.parts.length, 1);
  assert.equal(repaired.parts[0].text, 'First.');

  assert.equal(parseModelJson('I cannot help with that.'), null);
});

test('a prose reply is retried once before giving up', async () => {
  const calls: any[] = [];
  const mock = (async (_url: any, options: any) => {
    const body = JSON.parse(options.body);
    calls.push(body.messages.at(-1).content);
    const content = calls.length === 1
      ? 'Here is a summary of the video in plain words.'
      : JSON.stringify({ notFound: false, parts: [{ text: 'Put your phone away.', segmentIds: [0] }] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
  const result = await answerQuestion({ question: 'How can I avoid distractions?', segments }, { provider: 'deepinfra', model: 'Qwen/Qwen3-32B' }, new AbortController().signal, mock);
  assert.equal(calls.length, 2);
  assert.match(String(calls[1]), /only the JSON object/);
  assert.equal(result.parts[0].text, 'Put your phone away.');
});

test('an unreadable reply names the model that produced it', async () => {
  const mock = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'no json here' } }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    answerQuestion({ question: 'test', segments }, { provider: 'deepinfra', model: 'Qwen/Qwen3-32B' }, new AbortController().signal, mock),
    /Qwen\/Qwen3-32B did not return a readable answer/,
  );
});

test('DeepInfra adapter sends a schema and private authorization, then validates returned citations', async () => {
  const mock = (async (url: any, options: any) => {
    assert.equal(url, 'https://api.deepinfra.com/v1/openai/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_schema');
    assert.match(body.messages[0].content, /untrusted quoted data/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ notFound: false, parts: [{ text: 'Put your phone away.', segmentIds: [0] }] }) } }] }), { status: 200 });
  }) as typeof fetch;
  const result = await answerQuestion({ question: 'How can I avoid distractions?', segments }, { provider: 'deepinfra', model: 'Qwen/Qwen3-32B' }, new AbortController().signal, mock);
  assert.equal(result.parts[0].citations[0].start, 134);
});
test('Ollama adapter stays local: no authorization header, schema passed as format', async () => {
  const mock = (async (url: any, options: any) => {
    assert.match(String(url), /\/api\/chat$/);
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.stream, false);
    assert.equal(body.format.type, 'object');
    assert.match(body.messages[0].content, /untrusted quoted data/);
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ notFound: false, parts: [{ text: 'Local answer.', segmentIds: [0] }] }) } }), { status: 200 });
  }) as typeof fetch;
  const result = await answerQuestion({ question: 'How can I avoid distractions?', segments }, { provider: 'ollama', model: 'llama3.2:latest' }, new AbortController().signal, mock);
  assert.equal(result.parts[0].citations[0].start, 134);
  assert.equal(result.model, 'llama3.2:latest');
});
test('provider failures do not echo provider bodies or secrets', async () => {
  const mock = (async () => new Response('Secret upstream error with credential', { status: 401 })) as typeof fetch;
  await assert.rejects(answerQuestion({ question: 'test', segments }, { provider: 'deepinfra', model: 'test' }, new AbortController().signal, mock), /did not accept the API key/);
});
