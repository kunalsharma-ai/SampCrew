/** A colour pair for a card, picked from its key so it keeps its colour. */
const TONES: [string, string][] = [
  ['#6366f1', '#a855f7'], ['#0ea5e9', '#22d3ee'], ['#10b981', '#84cc16'], ['#f59e0b', '#f97316'], ['#ec4899', '#f43f5e'], ['#8b5cf6', '#6366f1'], ['#14b8a6', '#0ea5e9'],
];
export const toneFor = (key: string) => TONES[[...key].reduce((n, c) => n + c.charCodeAt(0), 0) % TONES.length]!;
