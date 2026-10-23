import type { Quiz, QuizQuestion, Segment } from '../src/shared/types';
import { completeJson, type Target } from './providers';
import { coalesceCitations, parseModelJson, selectContext } from './answer';
import { passageAround } from '../src/shared/transcript';

const schema = {
  type: 'object', additionalProperties: false, required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'prompt', 'explanation', 'segmentIds', 'options', 'answerIndex', 'answerBool', 'answerText', 'accept', 'rubric', 'evidence'],
        properties: {
          type: { type: 'string', enum: ['choice', 'boolean', 'short', 'long'] },
          prompt: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answerIndex: { type: 'integer' },
          answerBool: { type: 'boolean' },
          answerText: { type: 'string' },
          accept: { type: 'array', items: { type: 'string' } },
          rubric: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
          explanation: { type: 'string' },
          segmentIds: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
};

// A long answer is the slowest to write, so it never dominates a run.
export function typeMix(count: number) {
  const long = count >= 9 ? 3 : count >= 6 ? 2 : 1;
  const boolean = count >= 6 ? 2 : 1;
  const short = Math.max(1, Math.floor(count / 4));
  const choice = Math.max(1, count - long - boolean - short);
  const total = long + boolean + short + choice;
  return { choice: choice + (count - total), boolean, short, long };
}

export const LEVELS = ['easy', 'medium', 'hard', 's'] as const;
export type Level = typeof LEVELS[number];

const LEVEL_GUIDANCE: Record<Level, string> = {
  easy: 'Ask about facts stated plainly: what something is, what it is called, what happens first. A careful viewer who watched once should get these right.',
  medium: 'Test understanding, not recall. Ask why something is the case, what follows from it, what distinguishes two similar things, or how the idea would apply to a case the video does not spell out. The answer must require thinking about the material, not remembering a sentence.',
  hard: 'Test reasoning: implications, limits, trade-offs, what would change under a different condition, which of two similar ideas applies here, why a common assumption is wrong. Assume the reader remembers the video and is now being asked to think with it.',
  s: 'This is the hardest tier: questions that require combining several parts of the video, not just one. Ask for a prediction about a case the video never shows, a counterfactual (what breaks if one premise is dropped), a quantitative consequence of a stated number, the strongest objection to the speaker\'s claim, or a distinction between two things the video treats as similar. A careful viewer who understood everything should still have to think hard; someone who merely remembers the video should fail. Every question must remain answerable from the transcript.',
};

export function makeSeed() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}
function hash(seed: string) {
  let value = 2166136261;
  for (const character of seed) { value ^= character.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}
function shuffled<T>(items: T[], seed: string): T[] {
  const out = [...items];
  let state = hash(seed);
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const LENSES = [
  'a sceptical viewer checking whether each claim actually holds',
  'someone who intends to use this tomorrow and needs it to be practical',
  'a teacher who wants to know whether the idea really landed',
  'an engineer debugging a system that behaves this way',
  'a newcomer who has the words but not yet the intuition',
  'a reader arguing with the video and looking for its weak points',
];

const ANGLES = [
  'what follows if the claim is true',
  'why it is that way rather than another way',
  'what would break or falsify it',
  'how it compares with the nearest similar idea',
  'which exception the speaker allows',
  'what the reader should do differently because of it',
  'what assumption the claim rests on',
  'what the example is an example of',
  'what changes at the edges of the claim',
  'what the speaker leaves unsaid but implies',
  'how the parts fit together into one story',
  'which consequence is easy to miss',
];

// S tier gets its own angles: a general instruction was not enough to make the questions harder.
const S_ANGLES = [
  'a counterfactual: what breaks if one premise is dropped',
  // Handed out blind, this angle made the model invent a figure for a window that had none
  // ("handles numbers up to 1000 digits" for a passage that says big numbers make it fail).
  'a quantitative consequence of a number the video states — only if its window states one; otherwise a counterfactual',
  "the strongest objection to the speaker's claim, and what would answer it",
  'a prediction about a case the video never shows',
  'a distinction between two things the video treats as similar',
  "what would have to be true for the speaker's claim to fail",
  'how two claims made minutes apart fit together, or do not',
  'which of two stated mechanisms explains a third observation',
];

const FOCUS = ['definitions and terms', 'numbers and measurements', 'examples the speaker gives', 'reasons and causes', 'steps and their order', 'comparisons and contrasts', 'limits, warnings and failure cases'];

export function windows(count: number, segments: Segment[]): string {
  if (!segments.length) return '';
  const last = Math.max(...segments.map(segment => segment.start));
  const label = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  return Array.from({ length: count }, (_, index) => {
    const from = (last / count) * index;
    const to = (last / count) * (index + 1);
    const ids = segments.filter(segment => segment.start >= from && segment.start < to).map(segment => segment.id);
    const range = ids.length ? ` (segment ids ${ids[0]}–${ids[ids.length - 1]})` : '';
    return `Q${index + 1} ${label(from)}–${label(to)}${range}`;
  }).join('; ');
}

export function buildQuizMessages(count: number, context: { segments: Segment[]; coverage: 'full' | 'selected' }, title: string, level: Level = 'medium', avoid: string[] = [], only: string[] = [], seed = makeSeed()) {
  return [
    { role: 'system', content: `You write comprehension quizzes about a YouTube video, for someone who just watched it. Use ONLY the transcript below. Return JSON matching the schema. Write exactly ${count} questions about different parts of the video, in the order the material appears. Spread them across the whole video using these target windows, one question per window, in order: ${windows(count, context.segments)}. Each question must be answered by something said inside its own window, and must cite a segment id from that window's range. Difficulty: ${level === 's' ? 'S tier (the hardest)' : level}. ${LEVEL_GUIDANCE[level]} This run, lean on ${FOCUS[Math.floor(Math.random() * FOCUS.length)]}. Run seed ${seed}: approach the material as ${shuffled(LENSES, seed)[0]}, and give each question its own angle in order — ${shuffled(level === 's' ? S_ANGLES : ANGLES, seed + 'a').slice(0, count).join('; ')}. Do not mention the seed, the lens or the angles in the questions.${avoid.length ? ` Do not repeat or rephrase any of these questions that were already asked: ${avoid.slice(0, 8).map(q => `"${q.slice(0, 90)}"`).join('; ')}.` : ''} ${only.length ? `All ${count} questions must be of type ${only.map(type => `"${type}"`).join(' or ')}.` : `The mix must be exactly ${typeMix(count).choice} of type "choice", ${typeMix(count).boolean} of type "boolean", ${typeMix(count).short} of type "short" and ${typeMix(count).long} of type "long".`} A question of another type does not count:
- "choice": four options, exactly one correct, three plausible distractors that are wrong but related. answerIndex is the 0-based index of the correct option.
- "boolean": a claim that is either clearly true or clearly false according to the transcript. answerBool is the verdict.
- "long": an open question that requires explaining or connecting something — why something happens, how two ideas relate, what would follow. rubric lists 2-4 short points a good answer must contain, each one something the speaker actually says in the cited passages — never general knowledge or your own inference; answerText is a model answer of one to three sentences built from those points. Never ask a long question whose answer is a single fact.
- "short": a question whose answer is at most five words. answerText is the canonical answer; accept lists 2-3 alternative spellings or paraphrases that mean the same thing. The answer must be a specific fact from the video — a name, a number, an example, an action, a cause. It must never restate the question or repeat the question's own premise: "What is the main limitation?" cannot be answered "it has limitations". If the only answer you can find is a restatement, ask a different question that has a concrete answer.
Every question cites 1-3 segmentIds, and evidence is a verbatim quote of at most 120 characters copied exactly from one of those segments that settles the answer: the sentence stating the fact, or the sentence that contradicts a false claim. The explanation says why the answer is right in one sentence, without referring to segment numbers. A claim is never false just because the sampled transcript does not mention it — the transcript here is a sample of a long video, so silence proves nothing. Mark a boolean false only when the quoted passage contradicts the claim, and true only when it states it. The explanation says why the answer is right in one sentence, without referring to segment numbers. Never ask two questions about the same fact, and never ask the same thing twice in different words. Ask about quantities only when the reasoning matters (why the size is what it is, what follows from it), never as a figure to recall. Every number in a correct option, a true claim, a short answer, a model answer or a rubric point must be a number the speaker says in the cited passage — never invent or extrapolate a figure; if the passage gives no number, ask about the idea instead. Never test memorisation: do not ask for the outcome of one specific worked example, for a name or label the video mentions in passing, for a number quoted once, or for anything answerable by repeating a sentence. Ask about the idea, not the illustration of it. Never about trivia such as the speaker's clothing, and never about what the video does not say. No markdown. Video title for context only: ${title || 'unknown'}. Transcript coverage: ${context.coverage}.` },
    { role: 'user', content: `Transcript data:\n${context.segments.map(s => JSON.stringify({ id: s.id, text: s.text })).join('\n')}` },
  ];
}

const words = (text: string) => new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []));
// "How many tokens in the vocabulary?" rewards having noted a figure, not understanding it.
export function asksForNumber(prompt: string) {
  return /\b(how (many|much|long|big|large)|what is the (approximate |exact |typical )?(size|number|count|length|amount|value))\b/i.test(prompt);
}

// "What is the process of turning text into tokens called?" is a glossary lookup, not comprehension.
export function asksForLabel(prompt: string) {
  return /\b(what|which)\b[^?]{0,60}\b(called|name|term|word for|known as)\b/i.test(prompt);
}

const promptWords = (prompt: string) => new Set(prompt.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
function overlaps(one: Set<string>, other: Set<string>) {
  const shared = [...one].filter(word => other.has(word)).length;
  return shared / Math.max(1, Math.min(one.size, other.size));
}

// A question that quotes its source passage is asking the reader to have memorised that sentence.
// Easy questions are allowed to do it; anything harder is not.
export function quotesItsSource(prompt: string, passage: string) {
  const quoted = [...prompt.matchAll(/["'\u2018\u2019\u201c\u201d]([^"\u2018\u2019\u201c\u201d]{4,60})["'\u2018\u2019\u201c\u201d]/g)].map(match => match[1].toLocaleLowerCase().trim());
  if (!quoted.length) return false;
  const source = passage.toLocaleLowerCase();
  return quoted.some(phrase => source.includes(phrase));
}

// An answer made mostly of the question's own words tests nothing; drop it rather than ask it.
export function echoesQuestion(prompt: string, answer: string) {
  const asked = words(prompt);
  const said = [...words(answer)];
  if (!said.length) return true;
  return said.filter(word => asked.has(word)).length / said.length >= 0.7;
}

// A quiz whose questions all cite the first ten minutes is not a quiz about the video.
// Coverage is the share of the video's four quarters that at least one question comes from.
export function coverageOfVideo(quiz: Quiz, lastStart: number): number {
  if (lastStart <= 0) return 1;
  const quarters = new Set<number>();
  for (const question of quiz.questions) {
    const start = question.citations[0]?.start;
    if (typeof start !== 'number') continue;
    quarters.add(Math.min(3, Math.floor((start / lastStart) * 4)));
  }
  return quarters.size / 4;
}

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
// Quotes are compared without case or punctuation: captions and models disagree on both.
const normal = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, trillion: 1e12,
};
const SCALE_WORDS = new Set(['hundred', 'thousand', 'million', 'billion', 'trillion']);

// The figures a piece of text states, as canonical strings: "1,000", "1000" and "thousand(s)" are all "1000".
// Claims only count digits and scale words — "one example" is not a figure — while a passage counts every
// number word, because captions spell small numbers out ("five is actually not correct").
export function figuresIn(text: string, every = false): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(value)) found.add(String(value));
  }
  // Runs of number words are read whole too: "forty-five" is 45 and "two hundred" is 200, not just 40 and 5.
  let total = 0, current = 0, inRun = false;
  const close = () => { if (inRun && every) found.add(String(total + current)); total = 0; current = 0; inRun = false; };
  for (const match of text.toLocaleLowerCase().matchAll(/[a-z]+/g)) {
    const word = match[0].replace(/s$/, '');
    if (!(word in NUMBER_WORDS)) { if (!(inRun && word === 'and')) close(); continue; }
    const value = NUMBER_WORDS[word];
    if (every || SCALE_WORDS.has(word)) found.add(String(value));
    if (value === 100) current = (current || 1) * 100;
    else if (value >= 1000) { total += (current || 1) * value; current = 0; }
    else current += value;
    inRun = true;
  }
  close();
  return found;
}

// A figure in the answer that the passage never says was made up. The evidence quote cannot catch this:
// it proves the topic is there ("if the numbers get really big"), not the number ("up to 1000 digits").
export function inventsFigure(claim: string, passage: string): string | null {
  const said = figuresIn(passage, true);
  return [...figuresIn(claim)].find(figure => !said.has(figure)) ?? null;
}

// How the auditor reads an answer.
function answerText(question: QuizQuestion): string {
  if (question.type === 'choice') return `${question.options?.[question.answer as number] || ''} (options: ${(question.options || []).join(' | ')})`;
  if (question.type === 'boolean') return question.answer ? 'True: the statement in the question holds' : 'False: the passage contradicts the statement in the question';
  return String(question.answer);
}

// What a question asserts as true: the words a learner is told are right.
function claimOf(question: QuizQuestion): string {
  if (question.type === 'choice') return question.options?.[question.answer as number] || '';
  if (question.type === 'boolean') return question.answer === true ? question.prompt : '';
  return [String(question.answer), ...(question.rubric || [])].join(' ');
}

export function validateQuiz(raw: any, segments: Segment[], model: string, expected: number, level: Level = 'medium', full: Segment[] = segments): Quiz {
  if (!raw || !Array.isArray(raw.questions)) throw new Error('The model returned an unreadable quiz. Please try again.');
  const byId = new Map(segments.map(s => [s.id, s]));
  const questions: QuizQuestion[] = [];
  // Checked against the full transcript around the citation, not the sample the generator saw.
  const keep = (question: QuizQuestion) => {
    const passage = passageAround(full, question.citations.map(citation => citation.start)) || question.citations.map(citation => citation.text).join(' ');
    const invented = inventsFigure(claimOf(question), passage);
    if (invented) { if (process.env.CUE_DEBUG_QUIZ) console.error(`[quiz] dropped invented figure ${invented}: ${question.prompt.slice(0, 80)}`); return; }
    questions.push(question);
  };
  const askedWords: Set<string>[] = [];
  for (const item of raw.questions) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type;
    const prompt = clean(item.prompt, 300);
    const explanation = clean(item.explanation, 400);
    const ids = Array.isArray(item.segmentIds)
      ? [...new Set(item.segmentIds.map((id: unknown) => typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id))]
        .filter((id: unknown): id is number => typeof id === 'number' && Number.isInteger(id) && byId.has(id))
      : [];
    if (!prompt || !explanation || !ids.length) continue;
    // These guards need material to work with; a ten-segment clip has no room for another kind of question.
    const strict = level !== 'easy' && segments.length >= 30;
    if (strict && quotesItsSource(prompt, byId.get(ids[0])!.text)) continue;
    if (strict && asksForLabel(prompt)) continue;
    if (strict && asksForNumber(prompt)) continue;
    // Two questions about the same fact is one question asked twice.
    const words = promptWords(prompt);
    if (askedWords.some(existing => overlaps(existing, words) >= 0.6)) continue;
    askedWords.push(words);
    // The question must be pinned to a quote that really exists in what the model was given.
    // If the quote lives in a neighbouring segment rather than the cited one, cite that segment instead.
    const quote = normal(clean(item.evidence, 220));
    if (quote.length < 12) continue;
    const citedIds = ids.filter(id => normal(byId.get(id)!.text).includes(quote));
    const holder = citedIds.length ? null : segments.find(segment => normal(segment.text).includes(quote));
    const support = citedIds.length ? ids : holder ? [holder.id] : [];
    if (!support.length) continue;
    const citations = coalesceCitations(support.map(id => { const s = byId.get(id)!; return { segmentId: id, start: s.start, text: s.text }; }));
    const base = { id: questions.length, prompt, explanation, citations, evidence: clean(item.evidence, 220) };

    if (type === 'choice') {
      const options = Array.isArray(item.options) ? item.options.map((o: unknown) => clean(o, 160)).filter(Boolean) : [];
      const answer = Number(item.answerIndex);
      if (options.length < 2 || options.length > 6 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) continue;
      keep({ ...base, type, options, answer });
    } else if (type === 'boolean') {
      if (typeof item.answerBool !== 'boolean') continue;
      keep({ ...base, type, answer: item.answerBool });
    } else if (type === 'long') {
      const answerText = clean(item.answerText, 600);
      const rubric = Array.isArray(item.rubric) ? item.rubric.map((point: unknown) => clean(point, 160)).filter(Boolean).slice(0, 4) : [];
      if (!answerText || rubric.length < 2) continue;
      keep({ ...base, type, answer: answerText, rubric });
    } else if (type === 'short') {
      const answerText = clean(item.answerText, 120);
      const accept = Array.isArray(item.accept) ? item.accept.map((a: unknown) => clean(a, 120)).filter(Boolean).slice(0, 4) : [];
      if (!answerText || echoesQuestion(prompt, answerText)) continue;
      keep({ ...base, type, answer: answerText, accept });
    }
  }
  if (questions.length < Math.min(3, expected)) throw new Error('The model could not write enough grounded questions about this video. Try again.');
  return { questions: questions.slice(0, expected), model };
}

const supportSchema = {
  type: 'object', additionalProperties: false, required: ['supported', 'points'],
  properties: {
    supported: { type: 'array', items: { type: 'integer' } },
    points: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'point', 'quote'],
        properties: { id: { type: 'integer' }, point: { type: 'integer' }, quote: { type: 'string' } },
      },
    },
  },
};

// points: per question, the rubric indexes backed by a quote that really is in the passage.
// null when the model gave no point verdicts at all — that is an ignored instruction, not a verdict.
export interface SupportAudit { supported: Set<number>; points: Map<number, number[]> | null }

const asInt = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
const ints = (values: unknown) => (Array.isArray(values) ? values : []).map(asInt).filter((value: unknown): value is number => typeof value === 'number' && Number.isInteger(value));

// The quote check proves a passage exists; it does not prove the passage answers the question.
// This pass is the difference between "cited" and "supported". It reads the stretch of speech around each
// citation, not the citation alone: auto-captions split a video into ~40-character segments, and one of
// those cannot support or refute anything. Long answers get their rubric checked point by point, because
// the grader marks against it — a rubric point the video never makes ("focuses on majority opinion")
// turns a correct answer into "Not quite". With thinking off, Qwen3-32B kept every invented point and dropped
// the real one, even when asked for a quote per point (it found loosely related ones). With thinking on it
// keeps the real point and drops the invented ones. The quote is still required and checked here.
export async function verifySupport(target: Target, questions: QuizQuestion[], segments: Segment[], signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<SupportAudit> {
  const items = questions.map(question => ({
    // The answer as words. A choice answer is stored as an index, and an audit shown "answer: 0" passed a
    // made-up "handles numbers up to 1000 digits" because it never saw what it was approving.
    id: question.id, question: question.prompt, answer: answerText(question),
    // A synthesis question is settled by its passages together, not by one quote.
    evidence: question.evidence || '',
    passages: passageAround(segments, question.citations.map(citation => citation.start), { max: 1600 }) || question.citations.map(citation => citation.text).join(' ').slice(0, 700),
    ...(question.type === 'long' && question.rubric ? { points: question.rubric.map((point, index) => `${index}: ${point}`) } : {}),
  }));
  const messages = [
    { role: 'system', content: `You audit quiz questions against the passage they cite. For each item, decide whether a reader could reach the stated answer from the quoted passages. When several passages are given, they count together. Pass the item when the passage states the fact, or when it gives enough to conclude it in the answer's own words; different wording is fine. Fail the item only when the passage is about something else, contradicts the answer, or does not contain the information at all — a passing mention of the topic is not enough. Fail it too when the answer states a number, quantity or limit the passage never says. Some items list numbered points an answer is expected to make. Check each point on its own. For a point the passage states or directly supports, add {"id", "point", "quote"} to "points", where quote is copied word for word from that item's passages (at most 120 characters) and says what the point says. Add nothing for a point that is general knowledge, speculation, or something the speaker does not say — a quote that is merely on the same topic does not count. Return JSON matching the schema: the ids that pass in "supported", and the quoted points in "points".` },
    { role: 'user', content: items.map(item => JSON.stringify(item)).join('\n') },
  ];
  // Thinking is what makes the point check work: without it the model anchors on the points it is shown.
  // It costs seconds, so it gets a budget of its own inside the request's 175s.
  const started = Date.now();
  const content = await completeJson(target, messages, supportSchema, AbortSignal.any([signal, AbortSignal.timeout(45_000)]), fetcher, { temperature: 0, think: true });
  const parsed = parseModelJson(content);
  if (process.env.CUE_DEBUG_QUIZ) console.error(`[quiz] audit ${((Date.now() - started) / 1000).toFixed(1)}s raw:`, content.slice(0, process.env.CUE_DEBUG_QUIZ === 'full' ? 6000 : 400));
  const passages = new Map(items.map(item => [item.id, normal(item.passages)]));
  const entries = Array.isArray(parsed?.points) ? parsed.points : [];
  let points: Map<number, number[]> | null = null;
  if (entries.length) {
    points = new Map();
    // One quote backs one point. A generic line pinned to every point ("so we're going to train the model
    // on") then supports a single point, and a rubric needs two.
    const used = new Set<string>();
    for (const entry of entries) {
      // Models like to answer with strings; an id is an id.
      const id = asInt(entry?.id), point = asInt(entry?.point);
      const quote = normal(clean(entry?.quote, 200));
      if (typeof id !== 'number' || typeof point !== 'number' || quote.length < 12) continue;
      if (!passages.get(id)?.includes(quote) || used.has(`${id}:${quote}`)) continue;
      used.add(`${id}:${quote}`);
      points.set(id, [...new Set([...(points.get(id) || []), point])]);
    }
  }
  return { supported: new Set(ints(parsed?.supported)), points };
}

// Keep what the audit passed. A long question keeps only the rubric points the passage supports, and is
// dropped when fewer than two survive: one point is a short question, and an unsupported point is a trap.
export function applyAudit(questions: QuizQuestion[], audit: SupportAudit): QuizQuestion[] {
  const kept: QuizQuestion[] = [];
  for (const question of questions) {
    if (!audit.supported.has(question.id)) continue;
    if (question.type === 'long' && question.rubric) {
      // No point verdicts anywhere means the model skipped that part; it is not a verdict against them.
      const keep = audit.points ? audit.points.get(question.id) || [] : null;
      const rubric = keep ? question.rubric.filter((_, index) => keep.includes(index)) : question.rubric;
      if (rubric.length < 2) continue;
      kept.push({ ...question, rubric });
    } else kept.push(question);
  }
  return kept.map((question, index) => ({ ...question, id: index }));
}

export async function createQuiz(input: any, target: Target, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Quiz> {
  const all = Array.isArray(input.segments) ? input.segments : [];
  // Marked questions ask for a deeper pass over the moments they came from, not for the whole video again.
  const focus = Array.isArray(input.focus)
    ? input.focus.slice(0, 6).map((entry: any) => ({
      prompt: clean(entry?.prompt, 200),
      ids: Array.isArray(entry?.segmentIds) ? entry.segmentIds.filter((id: unknown) => Number.isInteger(id)).slice(0, 3) as number[] : [],
    })).filter((entry: any) => entry.ids.length)
    : [];
  const focusSegments = focus.length
    ? all.filter((segment: Segment) => {
      const nearest = focus.some((entry: any) => entry.ids.some((id: number) => Math.abs(segment.id - id) <= 3));
      return nearest;
    })
    : [];
  const segments = focusSegments.length
    ? focusSegments
    : selectContext(all, 'quiz questions covering the whole video', 20000, { even: true }).segments;
  if (process.env.CUE_DEBUG_QUIZ) console.error('[quiz] focus', focus.length, 'ids', JSON.stringify(focus.map((entry: { ids: number[] }) => entry.ids)), '→ context segments', segments.length, 'first', segments[0]?.id, 'last', segments[segments.length - 1]?.id);
  if (!segments.length) throw new Error('Load the transcript before starting a quiz.');
  // A deeper pass can ask for more than one question per marked passage, so its count is the caller's.
  const expected = focus.length
    ? Math.min(Math.max(Math.round(Number(input.count)) || focus.length, 1), 10)
    : Math.min(Math.max(Math.round(Number(input.count)) || 6, 3), 10);
  const level: Level = focus.length ? 'hard' : LEVELS.includes(String(input.difficulty) as Level) ? String(input.difficulty) as Level : 'medium';
  const avoid = Array.isArray(input.avoid) ? input.avoid.map((value: unknown) => clean(value, 140)).filter(Boolean).slice(0, 10) : [];
  const seed = makeSeed();
  // Ask for a couple more than needed: the evidence, label, number and duplicate guards each drop items,
  // so requesting exactly the target guarantees coming up short.
  const ask = Math.min(10, expected + 2);
  const messages = buildQuizMessages(ask, { segments, coverage: segments.length === all.length ? 'full' : 'selected' }, clean(input.title, 120), level, avoid, [], seed);
  if (process.env.CUE_DEBUG_QUIZ) console.error('[quiz] seed', seed);
  if (focus.length) {
    messages[0] = { role: 'system', content: `${messages[0].content}\nThis run goes deeper on passages the reader already found interesting. Write ${expected} question${expected === 1 ? '' : 's'} spread across the marked passages below, and make each one harder than the question it came from: ask what follows, why it is that way, what would break the claim, how it compares with something else in the video, or which exception the speaker allows. Never repeat the marked question or restate it.${focus.map((entry: { prompt: string }, index: number) => `\nMarked passage ${index + 1}: "${entry.prompt}"`).join('')}` };
  }
  let sawJson = false;
  async function attemptWith(promptMessages: any[], want = expected): Promise<Quiz | null> {
    let content = await completeJson(target, promptMessages, schema, signal, fetcher, { temperature: 0.8 });
    let parsed = parseModelJson(content);
    if (!parsed) {
      content = await completeJson(target, [...promptMessages, { role: 'user', content: 'Reply with only the JSON object. No prose, no code fences.' }], schema, signal, fetcher, { temperature: 0.8 });
      parsed = parseModelJson(content);
    }
    if (!parsed) return null;
    sawJson = true;
    if (process.env.CUE_DEBUG_QUIZ) {
      const types = (parsed.questions || []).map((q: any) => `${q.type}(opts:${(q.options || []).length},rubric:${(q.rubric || []).length},ids:${(q.segmentIds || []).length})`);
      console.error('[quiz] raw types', types.join(' '));
    }
    try { return validateQuiz(parsed, segments, target.model, want, level, all); }
    catch (error: any) { if (process.env.CUE_DEBUG_QUIZ) console.error('[quiz] rejected:', error.message); return null; }
  }
  const attempt = () => attemptWith(messages);

  const lastStart = segments.reduce((latest: number, segment: Segment) => Math.max(latest, segment.start), 0);
  let quiz = await attempt();
  // Ask again when the first run came back short, or when every question came from one stretch of the video.
  // "All types" is part of the deal, so a run that forgot one is worth asking for again.
  // A ten-segment clip cannot carry four question types; asking for them just burns retries.
  const typesAvailable = Math.min(4, expected, Math.max(1, Math.floor(segments.length / 8)));
  const missingType = (candidate: Quiz) => new Set(candidate.questions.map(question => question.type)).size < typesAvailable;
  // Short material: one generation is all it gets, or the retries chain into a timeout.
  const small = segments.length < 30;
  const thin = (candidate: Quiz | null) => !candidate || (!small && (candidate.questions.length < expected || missingType(candidate) || (!focus.length && coverageOfVideo(candidate, lastStart) < 0.5)));
  if (thin(quiz)) {
    const second = await attempt();
    if (second) {
      const score = (candidate: Quiz) => candidate.questions.length * 2 + (missingType(candidate) ? 0 : 5) + (focus.length ? 0 : coverageOfVideo(candidate, lastStart) * 6);
      if (!quiz || score(second) > score(quiz)) quiz = second;
    }
  }
  if (quiz) {
    const audit = await verifySupport(target, quiz.questions, all, signal, fetcher).catch(() => null);
    if (audit) {
      const kept = applyAudit(quiz.questions, audit);
      if (process.env.CUE_DEBUG_QUIZ) console.error('[quiz] support audit kept', kept.length, 'of', quiz.questions.length);
      if (kept.length >= Math.min(3, expected) || (focus.length && kept.length)) quiz = { ...quiz, questions: kept };
      else if (kept.length === 0) { /* the audit disagreed with everything: retry below, but do not ship nothing */ }
      else {
        const second = await attempt();
        if (second) {
          const secondAudit = await verifySupport(target, second.questions, all, signal, fetcher).catch(() => null);
          const secondKept = secondAudit ? applyAudit(second.questions, secondAudit) : second.questions;
          if (secondKept.length > quiz.questions.length) quiz = { ...second, questions: secondKept };
        }
      }
    }
  }
  if (!quiz) {
    throw new Error(sawJson
      ? 'No question could be pinned to a quote from the transcript. Try again, or pick another model.'
      : `${target.model} did not return a readable quiz. Try again, or pick another model.`);
  }

  // One type missing should cost one small request, not another whole quiz.
  const wanted = typeMix(expected);
  const present = new Set(quiz.questions.map(question => question.type));
  const missing = (['choice', 'boolean', 'short', 'long'] as const).filter(type => (wanted as any)[type] > 0 && !present.has(type));
  if (missing.length && !focus.length && !small) {
    const need = Math.min(4, missing.reduce((total, type) => total + Math.max(1, Math.floor((wanted as any)[type])), 0));
    try {
      const extra = await attemptWith(buildQuizMessages(need, { segments, coverage: segments.length === all.length ? 'full' : 'selected' }, clean(input.title, 120), level, quiz.questions.map(question => question.prompt), missing), need);
      if (extra) {
        // A top-up is held to the same audit as the quiz it joins.
        const extraAudit = await verifySupport(target, extra.questions, all, signal, fetcher).catch(() => null);
        const audited = extraAudit ? applyAudit(extra.questions, extraAudit) : extra.questions;
        const seen = new Set(quiz.questions.map(question => question.prompt.toLocaleLowerCase()));
        const added = audited.filter(question => !seen.has(question.prompt.toLocaleLowerCase())).slice(0, need);
        if (added.length) {
          quiz = { ...quiz, questions: [...quiz.questions, ...added].map((question, index) => ({ ...question, id: index })).slice(0, Math.max(expected, quiz.questions.length)) };
          if (process.env.CUE_DEBUG_QUIZ) console.error('[quiz] topped up', added.map(question => question.type).join(','));
        }
      }
    } catch { /* the quiz we have is still usable */ }
  }
  return quiz;
}
