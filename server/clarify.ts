import { completeText, type Target } from './providers';

// The clarification deliberately never sees the answer, the accepted variants or the rubric:
// it cannot leak what it was not given.
export function buildClarifyMessages(input: { prompt: string; passage: string; type: string }) {
  return [
    { role: 'system', content: `A learner is looking at a quiz question about a video they watched and does not understand what it is asking. Rephrase the question in plainer words and say what kind of answer it wants, in at most two short sentences. Never answer it, never hint at the answer, never mention the options, and never state the fact the question is testing — if you feel the urge to explain the topic, describe the shape of a good answer instead. Write to the learner, without preamble or markdown.` },
    { role: 'user', content: `Question type: ${input.type}\nQuestion: ${input.prompt}\nPassage it comes from: ${input.passage}` },
  ];
}

export async function clarifyQuestion(input: any, target: Target, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{ text: string; model: string }> {
  const prompt = typeof input.prompt === 'string' ? input.prompt.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
  const passage = typeof input.passage === 'string' ? input.passage.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
  const type = typeof input.type === 'string' ? input.type.slice(0, 20) : 'question';
  if (!prompt) throw new Error('There is no question to clarify.');
  const text = await completeText(target, buildClarifyMessages({ prompt, passage, type }), signal, fetcher);
  return { text: text.slice(0, 600), model: target.model };
}
