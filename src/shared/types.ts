export interface Segment { id: number; start: number; duration: number; text: string }
export interface Video { id: string; title: string; channel: string; duration: number; currentTime: number }
export interface Transcript { segments: Segment[]; language: string; source: 'ytdlp' | 'ytdl' | 'browser'; videoId: string }
export interface Citation { segmentId: number; start: number; text: string }
// A part can carry one visual: a diagram, a small comparison table, or a worked example.
// Examples are labelled by where they come from, so an illustration is never passed off as the video's.
export type AnswerVisual =
  // A diagram is a small graph the panel draws with Mermaid: boxes, and arrows that may carry a label.
  | { kind: 'diagram'; title: string; direction: 'TD' | 'LR'; nodes: { id: string; label: string }[]; edges: { from: string; to: string; label: string }[] }
  // Answers saved before diagrams existed; drawn as a straight chain.
  | { kind: 'flow'; title: string; steps: string[] }
  // columns name the things compared; each row is [aspect, one value per column].
  | { kind: 'table'; title: string; columns: string[]; rows: string[][] }
  | { kind: 'example'; title: string; lines: string[]; source: 'video' | 'illustration' };
export interface AnswerPart { text: string; citations: Citation[]; visual?: AnswerVisual }
export interface Answer { parts: AnswerPart[]; notFound: boolean; coverage: 'full' | 'selected'; model: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; answer?: Answer }
export type ProviderId = 'deepinfra' | 'ollama';
export interface Target { provider: ProviderId; model: string }
export type QuizType = 'choice' | 'boolean' | 'short' | 'long';
export interface QuizQuestion {
  id: number;
  type: QuizType;
  prompt: string;
  options?: string[];
  answer: number | boolean | string;
  accept?: string[];
  rubric?: string[];
  evidence?: string;
  explanation: string;
  citations: Citation[];
}
export interface Quiz { questions: QuizQuestion[]; model: string }
export interface Grade { correct: boolean; reason: string; model: string }

export interface Health {
  configured: boolean;
  provider: ProviderId;
  model: string;
  providers: {
    /** prices: US dollars per million tokens; missing until DeepInfra's catalogue has loaded. */
    deepinfra: { configured: boolean; models: string[]; prices?: Record<string, { input: number; output: number }> };
    ollama: { available: boolean; url: string; models: string[] };
  };
}
