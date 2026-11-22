import './env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatTime, normalizeSegments, parseCaptions, passageAround, readingTimeMinutes, videoIdFromUrl, wordCount } from '../src/shared/transcript';
import type { QuizQuestion } from '../src/shared/types';
import { mermaidSource } from '../src/shared/visual';
import { answerQuestion, coalesceCitations, parseModelJson, selectContext, validateAnswer } from '../server/answer';
import { groundVisual, validateVisual, validateVisuals, visualizeAnswer } from '../server/visualize';
import { apiKey } from '../server/config';
import { requestFailureMessage } from '../src/shared/errors';
import { buildGradeMessages, shorten, validateGrade } from '../server/grade';
import { applyAudit, asksForLabel, asksForNumber, coverageOfVideo, echoesQuestion, figuresIn, inventsFigure, quotesItsSource, typeMix, validateQuiz, verifySupport } from '../server/quiz';

// The passage behind a real fabricated question: no figure for "how big", only that big numbers fail.
const arithmetic = [
  { id: 0, start: 6880, duration: 4, text: 'so I said Emily buys 23 apples and 177 oranges and then I just made the numbers a bit bigger' },
  { id: 1, start: 6884, duration: 4, text: 'and here it gave me five and five is actually not correct' },
  { id: 2, start: 6950, duration: 4, text: 'especially if the numbers get really big there\'s no guarantee that the model will do this correctly' },
];

test('figures are read the way captions and models write them', () => {
  assert.deepEqual([...figuresIn('up to 1,000 digits')], ['1000']);
  assert.deepEqual([...figuresIn('a thousand digits, one example')], ['1000'], 'scale words count, "one" does not');
  assert.ok(figuresIn('five is not correct', true).has('5'), 'a passage counts spelled-out numbers');
  assert.ok(figuresIn('thousands of computers', true).has('1000'));
  // Captions spell compounds out; a correct "45 minutes" must not read as invented.
  assert.ok(figuresIn('Forty-five minutes is a useful starting point.', true).has('45'));
  assert.ok(figuresIn('two hundred and five tokens', true).has('205'));
  assert.ok(figuresIn('one thousand five hundred', true).has('1500'));
  assert.equal(inventsFigure('45 minutes', 'Forty-five minutes is a useful starting point.'), null);
  assert.equal(inventsFigure('The model can handle numbers up to 1000 digits long', arithmetic.map(s => s.text).join(' ')), '1000');
  assert.equal(inventsFigure('It answered 5, which was wrong', arithmetic.map(s => s.text).join(' ')), null);
  assert.equal(inventsFigure('Bigger numbers make it fail', 'nothing numeric here'), null);
});

test('a question whose correct answer invents a figure is dropped', () => {
  const evidence = "especially if the numbers get really big there's no guarantee";
  const raw = { questions: [
    { type: 'choice', prompt: "What quantitative consequence is mentioned regarding the model's ability to handle complex arithmetic problems?", explanation: 'e', segmentIds: [2], evidence, answerIndex: 0, options: ['The model can handle numbers up to 1000 digits long', 'up to 1000 steps', 'up to 1000 operations', 'numbers up to 1000 in size'] },
    { type: 'boolean', prompt: 'The model reliably does arithmetic on 500-digit numbers in one pass.', explanation: 'e', segmentIds: [2], evidence, answerBool: false },
    { type: 'short', prompt: 'Why should you ask for code when the arithmetic gets heavy?', explanation: 'e', segmentIds: [2], evidence, answerText: 'no guarantee of correctness', accept: [] },
  ] };
  const quiz = validateQuiz(raw, arithmetic, 'm', 2, 'medium', arithmetic);
  assert.deepEqual(quiz.questions.map(question => question.type), ['boolean', 'short'], 'a false claim may carry a wrong figure; a correct answer may not');
});

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

test('wordCount counts runs of letters and digits across segments', () => {
  const segs = normalizeSegments([{ start: 0, text: 'Hello world' }, { start: 5, text: 'It costs 25 dollars' }]);
  assert.equal(wordCount(segs), 6, 'punctuation is not a word, numbers are');
  assert.equal(wordCount([]), 0);
  assert.equal(wordCount(normalizeSegments([{ start: 0, text: '   ' }])), 0, 'whitespace only is zero words');
});

test('readingTimeMinutes is conservative and never returns zero', () => {
  assert.ok(readingTimeMinutes(0) >= 0.1, 'zero words still rounds up to a minimum');
  assert.ok(readingTimeMinutes(320) > 1.9 && readingTimeMinutes(320) < 2.1, '320 words ≈ 2 min at 160 wpm');
  assert.ok(readingTimeMinutes(1600) > 9.9 && readingTimeMinutes(1600) < 10.1, '1600 words ≈ 10 min');
});

test('formatDuration produces human-readable labels', () => {
  assert.equal(formatDuration(0), '<1 min');
  assert.equal(formatDuration(0.5), '<1 min');
  assert.equal(formatDuration(1), '1 min');
  assert.equal(formatDuration(3.4), '3 min');
  assert.equal(formatDuration(60), '1 hr');
  assert.equal(formatDuration(80), '1 hr 20 min');
  assert.equal(formatDuration(125), '2 hr 5 min');
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
test('visuals keep well-formed shapes and drop broken ones, one per paragraph', () => {
  const flow = { kind: 'flow', title: 'Focus routine', steps: ['Phone in another room', '  Work  ', 'Take a break'], columns: [], rows: [], lines: [], source: '' };
  const visuals = validateVisuals({ visuals: [
    flow,
    { kind: 'flow', title: '', steps: ['Only one'] },
    { kind: 'table', title: 'Phone vs paper', columns: ['Aspect', 'Phone nearby', 'Phone away'], rows: [
      ['Phone nearby', 'Phone away'], ['Checks', 'often', 'rarely', 'extra'], ['Focus', 'broken', ''], ['', 'a', 'b'],
    ] },
    { kind: 'chart' },
  ] }, ['passage', 'passage', 'passage', 'passage', 'passage']);
  assert.equal(visuals.length, 5, 'one entry per paragraph, even when the model returns fewer');
  // A flow becomes a straight-chain diagram.
  assert.deepEqual(visuals[0], { kind: 'diagram', title: 'Focus routine', direction: 'TD',
    nodes: [{ id: 's1', label: 'Phone in another room' }, { id: 's2', label: 'Work' }, { id: 's3', label: 'Take a break' }],
    edges: [{ from: 's1', to: 's2', label: '' }, { from: 's2', to: 's3', label: '' }] });
  assert.equal(visuals[1], null);
  // Columns are the things compared; a header-like "Aspect" column, a row repeating the header, a row
  // without an aspect and a row with one value are dropped, and extra cells are cut. "A vs B" says nothing.
  assert.deepEqual(visuals[2], { kind: 'table', title: '', columns: ['Phone nearby', 'Phone away'], rows: [['Checks', 'often', 'rarely']] });
  assert.deepEqual(visuals.slice(3), [null, null]);
  // A paragraph without a passage gets nothing to draw from.
  assert.deepEqual(validateVisuals({ visuals: [flow] }, ['']), [null]);
});
test('the visual call sends each paragraph with the transcript around its citations', async () => {
  const transcript = normalizeSegments([{ start: 0, text: 'First the query meets every key.' }, { start: 5, text: 'Then a softmax turns scores into weights.' }, { start: 600, text: 'Far away and unrelated.' }]);
  let sent: any = null;
  const fetcher = async (_url: unknown, init: any) => {
    sent = JSON.parse(init.body);
    const visuals = [{ kind: 'diagram', title: '', direction: 'TD', nodes: [{ id: 'q', label: 'Query meets keys' }, { id: 's', label: 'Softmax weights' }], edges: [{ from: 'q', to: 's', label: 'scores' }], columns: [], rows: [], lines: [], source: '' }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ visuals }) } }] }), { status: 200 });
  };
  const previous = process.env.DEEPINFRA_API_KEY; process.env.DEEPINFRA_API_KEY = previous || 'test';
  try {
    const result = await visualizeAnswer({ question: 'How does attention work?', segments: transcript, parts: [{ text: 'Queries meet keys.', segmentIds: [0] }] }, { provider: 'deepinfra', model: 'test' }, AbortSignal.timeout(5000), fetcher as typeof fetch);
    assert.equal(result.visuals[0]?.kind, 'diagram');
    const paragraphs = JSON.parse(sent.messages[1].content).paragraphs;
    assert.match(paragraphs[0].passage, /softmax/);
    assert.doesNotMatch(paragraphs[0].passage, /Far away/);
  } finally { if (previous === undefined) delete process.env.DEEPINFRA_API_KEY; else process.env.DEEPINFRA_API_KEY = previous; }
});
test('diagrams keep only arrows between real boxes, and only boxes an arrow touches', () => {
  const diagram = validateVisual({ kind: 'diagram', title: '', direction: 'LR', nodes: [
    { id: 'a', label: 'Query' }, { id: 'b', label: 'Key' }, { id: 'c', label: 'Dot product' }, { id: 'a', label: 'Duplicate id' }, { id: 'd', label: 'Unused' }, { id: 'e', label: '' },
  ], edges: [
    { from: 'a', to: 'c', label: 'compared' }, { from: 'b', to: 'c', label: '' }, { from: 'a', to: 'c', label: 'again' }, { from: 'c', to: 'zz', label: '' }, { from: 'c', to: 'c', label: '' },
  ] });
  assert.deepEqual(diagram, { kind: 'diagram', title: '', direction: 'LR',
    nodes: [{ id: 'a', label: 'Query' }, { id: 'b', label: 'Key' }, { id: 'c', label: 'Dot product' }],
    edges: [{ from: 'a', to: 'c', label: 'compared' }, { from: 'b', to: 'c', label: '' }] });
  assert.equal(validateVisual({ kind: 'diagram', title: '', direction: 'TD', nodes: [{ id: 'a', label: 'Alone' }], edges: [] }), undefined);
  // Side by side is only allowed for a few boxes.
  const wide = validateVisual({ kind: 'diagram', title: '', direction: 'LR', nodes: 'abcde'.split('').map(id => ({ id, label: id })), edges: 'abcd'.split('').map((id, i) => ({ from: id, to: 'bcde'[i], label: '' })) });
  assert.equal((wide as { direction: string }).direction, 'TD');
});
test('Mermaid source cannot be changed by what a label says', () => {
  const source = mermaidSource({ kind: 'diagram', title: '', direction: 'TD',
    nodes: [{ id: 'x"]; click x call alert(1); %%', label: 'say "hi" [then] -->|x| y; end' }, { id: 'b', label: 'Next' }],
    edges: [{ from: 'x"]; click x call alert(1); %%', to: 'b', label: 'a|b' }] });
  assert.equal(source.split('\n').length, 4);
  assert.match(source, /^flowchart TD\n {2}n1\["say #34;hi#34; #91;then#93; --#62;#124;x#124; y#59; end"\]\n {2}n2\["Next"\]\n {2}n1 -->\|"a#124;b"\| n2$/);
  assert.ok(!source.includes('alert'));
});
test('a visual cannot carry a figure the transcript does not say', () => {
  const tokens = { kind: 'example', title: '', lines: ['"hello" becomes token 123', '"world" becomes token 456'], source: 'video' };
  // Invented numbers turn the video's "example" into an illustration, and remove a flow or table outright.
  assert.equal((groundVisual(validateVisual(tokens), 'hello world is two tokens') as { source: string }).source, 'illustration');
  assert.equal((groundVisual(validateVisual(tokens), 'hello is 123 and world is 456') as { source: string }).source, 'video');
  assert.equal(groundVisual(validateVisual({ kind: 'flow', title: '', steps: ['Train for 3 months', 'Fine-tune'] }), 'train then fine-tune'), undefined);
  assert.ok(groundVisual(validateVisual({ kind: 'flow', title: '', steps: ['Train for three months', 'Fine-tune'] }), 'we train for three months then fine-tune'));
});
test('generic titles are dropped and a repeated visual is drawn once', () => {
  assert.equal(validateVisual({ kind: 'flow', title: 'Tokenization Process', steps: ['a', 'b'] })?.title, '');
  assert.equal(validateVisual({ kind: 'flow', title: 'How text becomes token IDs', steps: ['a', 'b'] })?.title, 'How text becomes token IDs');
  const table = { kind: 'table', title: '', columns: ['A', 'B'], rows: [['Data', 'x', 'y']] };
  assert.deepEqual(validateVisuals({ visuals: [table, { ...table, title: 'Same table' }] }, ['p', 'p']).map(Boolean), [true, false]);
});
test('examples say where they came from, and an answer carries at most two visuals', () => {
  assert.deepEqual(validateVisual({ kind: 'example', title: '', lines: ['Put it in another room.'], source: 'video' }), { kind: 'example', title: '', lines: ['Put it in another room.'], source: 'video' });
  // Anything not marked as the video's own example is shown as an illustration.
  assert.equal((validateVisual({ kind: 'example', title: '', lines: ['Say 3 checks an hour.'], source: '' }) as { source: string }).source, 'illustration');
  assert.equal(validateVisual(null), undefined);
  const example = (line: string) => ({ kind: 'example', title: '', lines: [line], source: 'video' });
  assert.deepEqual(validateVisuals({ visuals: ['One.', 'Two.', 'Three.'].map(example) }, ['p', 'p', 'p']).map(Boolean), [true, true, false]);
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

  // A choice answer is an index; the auditor must see the option it is approving, not "0".
  const choice: QuizQuestion = { id: 0, type: 'choice', prompt: 'p', answer: 1, options: ['wrong one', 'the right option'], explanation: 'e', citations: question.citations };
  await verifySupport({ provider: 'deepinfra', model: 'Qwen/Qwen3-32B' }, [choice], segments, AbortSignal.timeout(5000), fetcher);
  const item = JSON.parse(String(sent.messages[1].content));
  assert.match(item.answer, /^the right option/);
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

test('an answer that restates the question tests nothing', () => {
  // An answer made mostly of the question's own words is dropped, because it tests recall of the prompt, not understanding.
  assert.equal(echoesQuestion('What is the main limitation of this approach?', 'the main limitation of this approach'), true);
  assert.equal(echoesQuestion('What is the main limitation of this approach?', 'it overheats under sustained load'), false);
  // A few shared words are fine — the threshold is 70%.
  assert.equal(echoesQuestion('Why does the model fail on long inputs?', 'the context window is too small for long inputs'), false, 'shared words under 70% are not echoing');
  // An empty answer always echoes — there is nothing to mark.
  assert.equal(echoesQuestion('Any question?', ''), true);
});

test('a quiz clustered in one quarter covers less of the video', () => {
  const cite = (start: number) => ({ segmentId: 0, start, text: 't' });
  const make = (starts: number[]) => ({ questions: starts.map((start, id) => ({ id, type: 'choice' as const, prompt: `q${id}`, answer: 0, options: ['a', 'b'], explanation: 'e', citations: [cite(start)] })), model: 'test' });
  // Both questions in the first quarter of a 100-second video.
  assert.equal(coverageOfVideo(make([10, 20]), 100), 0.25);
  // Questions in the first and third quarters.
  assert.equal(coverageOfVideo(make([10, 60]), 100), 0.5);
  // One question in each quarter.
  assert.equal(coverageOfVideo(make([10, 35, 65, 90]), 100), 1.0);
  // A video with no duration is treated as fully covered.
  assert.equal(coverageOfVideo(make([10, 20]), 0), 1);
});

test('the type mix always includes all four types and sums to the count', () => {
  for (const count of [4, 6, 8, 10]) {
    const mix = typeMix(count);
    assert.equal(mix.choice + mix.boolean + mix.short + mix.long, count, `count ${count} should sum to ${count}`);
    assert.ok(mix.choice >= 1 && mix.boolean >= 1 && mix.short >= 1 && mix.long >= 1, `count ${count} needs at least one of each type`);
  }
  // A larger quiz gets more long questions.
  assert.ok(typeMix(10).long >= 3, 'ten questions get at least three long ones');
  assert.ok(typeMix(6).long >= 2, 'six questions get at least two long ones');
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
