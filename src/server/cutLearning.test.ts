import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCutLearning } from './cutLearning';
import type { CutLearningRecord } from '../core/cutLearning';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('writeCutLearning', () => {
  it('cutLearning.json を整形 JSON で書き出す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sme-learn-'));
    dirs.push(dir);
    const record: CutLearningRecord = {
      schemaVersion: 1,
      savedAt: '2026-05-29T11:30:00.000Z',
      video: { file: 'video.mp4', fps: 30, durationFrames: 30 },
      autoCutRegions: [],
      finalCutRegions: [{ start: 0, end: 30 }],
      delta: { addedRegions: [{ start: 0, end: 30 }], restoredRegions: [] },
      words: [{ text: 'えー', startFrame: 0, endFrame: 30, autoCut: false, finalCut: true }],
      ruleSummary: { keptByAutoCutByHuman: [{ text: 'えー', count: 1 }], cutByAutoKeptByHuman: [] },
      transcriptDrifted: false,
    };
    writeCutLearning(dir, record);
    const path = join(dir, 'cutLearning.json');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record);
  });
});
