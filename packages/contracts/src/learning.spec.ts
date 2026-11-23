import { describe, expect, it } from 'vitest';
import {
  blockIssues, contentBlock, dueState, embedUrl, formatOf, gradeQuiz, learnerQuestion, learnerStatus, legacyCourseBlocks, mediaComplete,
  moduleProgress, moduleScore, quizSettings, seededShuffle, type ContentBlock, type QuizBlock,
} from './learning';

const quiz = (questions: unknown[], settings: Record<string, unknown> = {}) =>
  contentBlock.parse({ id: 'quiz', kind: 'quiz', title: 'Check', settings: quizSettings.parse(settings), questions }) as QuizBlock;

describe('learning quizzes', () => {
  const q = quiz([
    { id: 'q1', type: 'single', text: 'Exit?', options: [{ id: 'a', text: 'Stairs' }, { id: 'b', text: 'Lift' }], correct: ['a'] },
    { id: 'q2', type: 'multiple', text: 'PPE?', options: [{ id: 'a', text: 'Helmet' }, { id: 'b', text: 'Gloves' }, { id: 'c', text: 'Tie' }], correct: ['a', 'b'] },
    { id: 'q3', type: 'true_false', text: 'Use lifts in a fire', correct: ['false'] },
    { id: 'q4', type: 'exact', text: 'Emergency number', accepted: ['112'] },
    { id: 'q5', type: 'matching', text: 'Match', pairs: [{ left: 'Red', right: 'Stop' }, { left: 'Green', right: 'Safe' }], marks: 2 },
  ]);

  it('marks every automatic question type, with proportional marks for matching', () => {
    const r = gradeQuiz(q, { q1: ['a'], q2: ['b', 'a'], q3: ['false'], q4: '  112 ', q5: ['stop', 'Wrong'] });
    expect(r.questions.map((x) => x.earned)).toEqual([1, 1, 1, 1, 1]);
    expect(r).toMatchObject({ earned: 5, total: 6, percent: 83.3, passed: true, pendingReview: false });
    // Multiple select needs exactly the right options.
    expect(gradeQuiz(q, { q2: ['a', 'b', 'c'] }).questions[1]!.earned).toBe(0);
    expect(gradeQuiz(q, {})).toMatchObject({ percent: 0, passed: false });
  });

  it('waits for a reviewer on written answers, then uses the marks given', () => {
    const w = quiz([
      { id: 'q1', type: 'true_false', text: 'Safe?', correct: ['true'] },
      { id: 'q2', type: 'long', text: 'Describe a hazard', marks: 4 },
    ], { passPercent: 60 });
    const pending = gradeQuiz(w, { q1: ['true'], q2: 'A loose cable' });
    expect(pending).toMatchObject({ percent: null, passed: null, pendingReview: true });
    expect(gradeQuiz(w, { q1: ['true'], q2: 'A loose cable' }, { q2: 3 })).toMatchObject({ earned: 4, total: 5, percent: 80, passed: true });
    // A blank written answer earns nothing and needs no review.
    expect(gradeQuiz(w, { q1: ['true'], q2: '  ' })).toMatchObject({ pendingReview: false, percent: 20 });
  });

  it('never shows the learner the answers', () => {
    const shown = q.questions.map((x) => learnerQuestion(x));
    const text = JSON.stringify(shown);
    expect(text).not.toMatch(/"correct"|"accepted"|"explanation"|"pairs"/);
    expect(shown[2]!.options.map((o) => o.id)).toEqual(['true', 'false']);
    expect(shown[4]).toMatchObject({ left: ['Red', 'Green'], right: ['Stop', 'Safe'] });
  });

  it('shuffles the same way for the same seed', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(seededShuffle(items, 'attempt-1')).toEqual(seededShuffle(items, 'attempt-1'));
    expect(seededShuffle(items, 'attempt-1').sort((a, b) => a - b)).toEqual(items);
  });
});

describe('learning content checks', () => {
  it('flags questions without a correct answer and impossible rules', () => {
    const blocks = [
      contentBlock.parse({ id: 'q', kind: 'quiz', title: 'Q', questions: [{ id: 'q1', type: 'single', text: 'Pick', options: [{ id: 'a', text: 'A' }] }] }),
      contentBlock.parse({ id: 'v', kind: 'video', title: 'V', source: { type: 'url', url: 'https://youtu.be/abc123' }, completion: 'full' }),
      contentBlock.parse({ id: 'a', kind: 'assignment', title: 'A', settings: { instructions: 'Do it', maxScore: 10, passScore: 20 } }),
    ] as ContentBlock[];
    const paths = blockIssues(blocks).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['blocks.1.completion', 'blocks.2.settings.passScore']));
    expect(paths.some((p) => p.startsWith('blocks.0'))).toBe(true);
  });

  it('turns YouTube and Vimeo links into privacy-friendly players and leaves other links alone', () => {
    expect(embedUrl('https://www.youtube.com/watch?v=abc123')).toBe('https://www.youtube-nocookie.com/embed/abc123');
    expect(embedUrl('https://youtu.be/abc123')).toBe('https://www.youtube-nocookie.com/embed/abc123');
    expect(embedUrl('https://vimeo.com/76979871')).toBe('https://player.vimeo.com/video/76979871');
    expect(embedUrl('https://example.com/video.mp4')).toBeNull();
  });

  it('names the format from the content', () => {
    expect(formatOf([{ kind: 'video' }, { kind: 'quiz' }])).toBe('video');
    expect(formatOf([{ kind: 'video' }, { kind: 'document' }])).toBe('mixed');
    expect(formatOf([])).toBe('online');
  });

  it('turns an old one-link course into a single item', () => {
    const [b] = legacyCourseBlocks({ title: 'Ethics', format: 'online', content_url: 'https://example.com/ethics' });
    expect(b).toMatchObject({ id: 'course', kind: 'external', url: 'https://example.com/ethics' });
  });
});

describe('learning progress', () => {
  it('counts watch rules, allowing the last moments of a video', () => {
    expect(mediaComplete('full', 90, 118, 120)).toBe(true);
    expect(mediaComplete('full', 90, 100, 120)).toBe(false);
    expect(mediaComplete('percent', 50, 60, 120)).toBe(true);
    expect(mediaComplete('manual', 50, 120, 120)).toBe(false);
  });

  it('works out progress from required items and the module score', () => {
    const blocks = [
      contentBlock.parse({ id: 't', kind: 'text', title: 'Read', required: false }),
      contentBlock.parse({ id: 'q', kind: 'quiz', title: 'Q', questions: [{ id: 'q1', type: 'true_false', text: 'Ok', correct: ['true'] }] }),
      contentBlock.parse({ id: 'a', kind: 'assignment', title: 'A', settings: { instructions: 'Do it', maxScore: 10, passScore: 5 } }),
    ] as ContentBlock[];
    expect(moduleProgress(blocks, { t: { done: true } })).toMatchObject({ percent: 0, complete: false });
    expect(moduleProgress(blocks, { q: { done: true } })).toMatchObject({ percent: 50, remaining: ['a'] });
    expect(moduleProgress(blocks, { q: { done: true }, a: { done: true } }).complete).toBe(true);
    expect(moduleScore(blocks, { q: { done: true, bestPercent: 90 } }, { a: 8 })).toBe(85);
    expect(moduleScore(blocks, {})).toBeNull();
  });

  it('knows when learning is due soon or overdue', () => {
    expect(dueState('2026-11-24', '2026-11-21')).toEqual({ state: 'due_soon', daysLeft: 3 });
    expect(dueState('2026-11-30', '2026-11-21').state).toBe('on_track');
    expect(dueState('2026-11-20', '2026-11-21').state).toBe('overdue');
    expect(dueState('2026-11-20', '2026-11-21', true).state).toBe('none');
    expect(learnerStatus('in_progress', '2026-11-20', '2026-11-21')).toBe('overdue');
    expect(learnerStatus('completed', '2026-11-20', '2026-11-21')).toBe('completed');
    expect(learnerStatus('assigned', null, '2026-11-21')).toBe('not_started');
  });
});
