import type { AnswerVisual } from './types';

type Diagram = Extract<AnswerVisual, { kind: 'diagram' }>;

// A flow is a diagram with one arrow between each pair of neighbouring steps.
export function asDiagram(visual: Extract<AnswerVisual, { kind: 'flow' | 'diagram' }>): Diagram {
  if (visual.kind === 'diagram') return visual;
  const nodes = visual.steps.map((label, i) => ({ id: `s${i + 1}`, label }));
  return { kind: 'diagram', title: visual.title, direction: 'TD', nodes, edges: nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id, label: '' })) };
}

// Mermaid source built from validated data, never from model text directly: ids are rewritten to
// n1, n2…, and labels are quoted with Mermaid's entity codes so no label can change the graph.
export function mermaidSource(diagram: Diagram): string {
  const ids = new Map(diagram.nodes.map((node, i) => [node.id, `n${i + 1}`]));
  const text = (value: string) => `"${value.replace(/[&"<>#;`|[\]{}()]/g, char => `#${char.charCodeAt(0)};`)}"`;
  return [
    `flowchart ${diagram.direction}`,
    ...diagram.nodes.map(node => `  ${ids.get(node.id)}[${text(node.label)}]`),
    ...diagram.edges.map(edge => `  ${ids.get(edge.from)} -->${edge.label ? `|${text(edge.label)}|` : ''} ${ids.get(edge.to)}`),
  ].join('\n');
}

// Plain-text form of a visual, for "Copy answer" and for the history a follow-up question is sent with.
export function visualText(visual: AnswerVisual): string {
  const head = visual.title ? `${visual.title}\n` : '';
  if (visual.kind === 'flow' || visual.kind === 'diagram') {
    const diagram = asDiagram(visual);
    const label = new Map(diagram.nodes.map(node => [node.id, node.label]));
    return head + diagram.edges.map(edge => `${label.get(edge.from)} →${edge.label ? ` (${edge.label})` : ''} ${label.get(edge.to)}`).join('\n');
  }
  if (visual.kind === 'table') return head + [['', ...visual.columns], ...visual.rows].map(row => row.join(' | ')).join('\n');
  return head + visual.lines.join('\n');
}
