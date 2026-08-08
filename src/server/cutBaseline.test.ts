import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotBaselineIfAbsent, readCutBaseline } from './cutBaseline';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sme-baseline-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('cutBaseline', () => {
  const video = { file: 'video.mp4', fps: 30, durationFrames: 9000 };

  it('不在なら baseline を初回書込し、内容を読み出せる', () => {
    const dir = tempDir();
    snapshotBaselineIfAbsent(dir, [{ start: 120, end: 150 }], video, { durationMs: 300000, wordCount: 812 });
    expect(existsSync(join(dir, 'cut-baseline.json'))).toBe(true);
    const b = readCutBaseline(dir);
    expect(b?.autoCutRegions).toEqual([{ start: 120, end: 150 }]);
    expect(b?.video).toEqual(video);
  });

  it('既に存在する baseline は上書きしない（初期状態を守る）', () => {
    const dir = tempDir();
    snapshotBaselineIfAbsent(dir, [{ start: 0, end: 10 }], video, { durationMs: 1, wordCount: 1 });
    snapshotBaselineIfAbsent(dir, [{ start: 999, end: 1000 }], video, { durationMs: 1, wordCount: 1 });
    expect(readCutBaseline(dir)?.autoCutRegions).toEqual([{ start: 0, end: 10 }]);
  });

  it('壊れた baseline は null を返す（再スナップショットしない）', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cut-baseline.json'), '{ not json', 'utf8');
    expect(readCutBaseline(dir)).toBeNull();
  });

  it('スキーマ不正（autoCutRegions 欠落）は null を返す', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'cut-baseline.json'),
      JSON.stringify({ schemaVersion: 1, video: { file: 'video.mp4', fps: 30, durationFrames: 9000 } }),
      'utf8',
    );
    expect(readCutBaseline(dir)).toBeNull();
  });

  it('transcriptDigest 欠落の baseline は不正として null を返す（型と実体の乖離を防ぐ）', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'cut-baseline.json'),
      JSON.stringify({ schemaVersion: 1, capturedAt: '2026-05-30T00:00:00.000Z', video, autoCutRegions: [] }),
      'utf8',
    );
    expect(readCutBaseline(dir)).toBeNull();
  });
});
