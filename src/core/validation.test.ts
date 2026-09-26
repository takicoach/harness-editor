import { describe, it, expect } from 'vitest';
import { validateProject } from './validation';
import type { EditorTelop } from './types';

const telops: EditorTelop[] = [{ id: 1, originalStart: 150, originalEnd: 250, text: 'a' }];

describe('validateProject', () => {
  it('independent captions are not hidden by cuts to their archived source anchors', () => {
    const result = validateProject({ originalTotalFrames: 1000, cutRegions: [{ start: 0, end: 200 }],
      telops: [{ id: 5, originalStart: 50, originalEnd: 150, text: 'x', timelinePlacement: { startFrame: 10, endFrame: 110 } }] });
    expect(result.warnings).toEqual([]);
  });
  it('カット後尺が原本の 50% 未満なら警告', () => {
    const result = validateProject({
      originalTotalFrames: 1000,
      cutRegions: [{ start: 0, end: 600 }],
      telops,
    });
    expect(result.warnings.some((w) => w.includes('カット'))).toBe(true);
  });

  it('カット控えめなら警告なし', () => {
    const result = validateProject({
      originalTotalFrames: 1000,
      cutRegions: [{ start: 0, end: 100 }],
      telops,
    });
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('カット区間に飲まれたテロップを警告に出す', () => {
    const result = validateProject({
      originalTotalFrames: 1000,
      cutRegions: [{ start: 0, end: 200 }],
      telops: [{ id: 5, originalStart: 50, originalEnd: 150, text: 'x' }],
    });
    expect(result.warnings.some((w) => w.includes('5'))).toBe(true);
  });
});
