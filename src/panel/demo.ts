import type { Transcript, Video } from '../shared/types';
// Explicitly labeled sample material for the standalone preview. Never used in a YouTube tab.
export const demoVideo: Video = { id: 'cue-preview', title: 'Make room for focused work', channel: 'Cue sample video', duration: 420, currentTime: 0 };
export const demoTranscript: Transcript = { videoId: 'cue-preview', language: 'en', source: 'browser', segments: [
  { id: 0, start: 0, duration: 28, text: 'Today we are talking about making room for focused work. The goal is not to fill every hour. It is to protect a small amount of time for the work that matters.' },
  { id: 1, start: 28, duration: 34, text: 'Start by choosing one concrete outcome. Instead of saying work on the project, decide to finish a first draft or solve one specific problem.' },
  { id: 2, start: 62, duration: 39, text: 'Put a short block on your calendar. Forty-five minutes is a useful starting point. Choose a time when you normally have energy, and treat it as an appointment.' },
  { id: 3, start: 101, duration: 33, text: 'Before you start, make the next action obvious. Open the document, gather the material, and write one sentence about what done will look like.' },
  { id: 4, start: 134, duration: 42, text: 'Remove the easy distractions. Put your phone in another room, close tabs you do not need, and turn off notifications. You are changing the environment so focus requires less effort.' },
  { id: 5, start: 176, duration: 38, text: 'When an unrelated thought appears, write it on a piece of paper and return to your task. You do not need to solve every new thought immediately.' },
  { id: 6, start: 214, duration: 41, text: 'Take a real break after the session. Stand up, get water, or walk outside. Reaching for a second screen can make it harder to feel rested.' },
  { id: 7, start: 255, duration: 42, text: 'At the end of the day, review what you actually finished. Track the completed draft or solved problem, not just the number of hours you spent at a desk.' },
  { id: 8, start: 297, duration: 44, text: 'If a session does not go well, make the next one smaller. Start with fifteen minutes and one clear action. A repeatable routine matters more than a perfect day.' },
  { id: 9, start: 341, duration: 79, text: 'The practical takeaway is to choose one outcome, reserve a short block, remove distractions, and review the result. Try one session tomorrow and adjust it based on what you learn.' },
] };
