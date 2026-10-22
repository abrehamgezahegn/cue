import type { Target } from './providers';
import { completeJson } from './providers';
import { parseModelJson } from './answer';

export interface Grade { correct: boolean; reason: string; model: string }

const schema = {
  type: 'object', additionalProperties: false, required: ['correct', 'reason'],
  properties: { correct: { type: 'boolean' }, reason: { type: 'string' } },
};

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

// A reason cut mid-word ("rather than individ") reads as a broken app; end on a word instead.
export function shorten(text: string, max: number) {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.lastIndexOf(' ', max - 1);
  return `${value.slice(0, cut > max * 0.6 ? cut : max - 1).replace(/[\s,;:.-]+$/, '')}…`;
}

// The reference, accepted variants and rubric were written by the quiz model from a sample of the video.
// They can be wrong. The transcript cannot, so the grader is told which one wins when they disagree.
export function buildGradeMessages(input: { question: string; given: string; reference: string; accept?: string[]; context?: string; passage?: string; rubric?: string[] }) {
  const accepted = (input.accept || []).filter(Boolean);
  const rubric = (input.rubric || []).filter(Boolean);
  const long = rubric.length > 0;
  const lines = [
    `Question: ${input.question}`,
    ...(input.passage ? [`What the video says (transcript, the authority): ${input.passage}`] : []),
    `Reference answer (written by a model, may be incomplete): ${input.reference}`,
    ...(accepted.length ? [`Also accepted: ${accepted.join('; ')}`] : []),
    ...(input.context ? [`Why the reference is right: ${input.context}`] : []),
    ...(long ? [`Points a good answer might make (written by a model, may be wrong): ${rubric.join('; ')}`] : []),
    `Learner answer: ${input.given}`,
  ];
  return [
    { role: 'system', content: `You mark one answer to a comprehension question about a video. The transcript passage is the authority on what the video says. The reference answer${long ? ', the points list' : ''} and the accepted variants were written by another model and can be wrong or miss what the speaker actually said; when they disagree with the transcript, follow the transcript. Mark the answer correct when its central point matches what the video says: accept paraphrases, synonyms, different word order, abbreviations, spelling mistakes, informal wording and extra detail that does not contradict the video. If the learner names a specific example that the video gives, mark it correct even when the reference answer is more general. The learner is writing from memory, so be fair to loose phrasing. Mark it incorrect only when the central point is missing, contradicts the video, names a different thing, or the answer just restates the question. Return JSON matching the schema. The reason is one sentence of at most 30 words, addressed to the learner, without markdown and without mentioning JSON, the reference or the points list.` },
    ...(long ? [{ role: 'system', content: 'This is a long answer. Mark it correct when it gives the main idea the video gives for this question, in the learner\'s own words. It does not need every listed point or the reference\'s wording, and a listed point the transcript does not support is never required. A vague answer that names the topic without explaining it is incorrect. When it is incorrect, the reason names what the video says that the answer misses.' }] : []),
    { role: 'user', content: lines.join('\n') },
  ];
}

export function validateGrade(raw: any, model: string): Grade {
  if (!raw || typeof raw.correct !== 'boolean') throw new Error('The grader returned an unreadable verdict. Please try again.');
  return { correct: raw.correct, reason: shorten(typeof raw.reason === 'string' ? raw.reason : '', 320), model };
}

export async function gradeAnswer(input: any, target: Target, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Grade> {
  const question = clean(input.question, 400);
  const given = clean(input.given, 1500);
  const reference = clean(input.reference, 600);
  if (!question || !given || !reference) throw new Error('That answer could not be checked.');
  const accept = Array.isArray(input.accept) ? input.accept.map((value: unknown) => clean(value, 200)).filter(Boolean).slice(0, 4) : [];
  const context = clean(input.context, 400);
  const passage = clean(input.passage, 4000);
  const rubric = Array.isArray(input.rubric) ? input.rubric.map((point: unknown) => clean(point, 200)).filter(Boolean).slice(0, 5) : [];
  const messages = buildGradeMessages({ question, given, reference, accept, context, passage, rubric });
  let content = await completeJson(target, messages, schema, signal, fetcher, { temperature: 0 });
  let parsed = parseModelJson(content);
  if (!parsed) {
    content = await completeJson(target, [...messages, { role: 'user', content: 'Reply with only the JSON object.' }], schema, signal, fetcher, { temperature: 0 });
    parsed = parseModelJson(content);
  }
  if (!parsed) throw new Error(`${target.model} could not mark that answer: it replied "${shorten(content, 80)}". Try again, or pick another model.`);
  return validateGrade(parsed, target.model);
}
