import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCutLearningFiles, loadCutLearningRecords, runAggregateCli } from './aggregateCutLearning';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sme-agg-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 集約に通る最小の正常レコード。 */
function validRecord(): unknown {
  return {
    schemaVersion: 1,
    savedAt: '2026-05-30T00:00:00.000Z',
    video: { file: 'v.mp4', fps: 30, durationFrames: 60 },
    autoCutRegions: [],
    finalCutRegions: [],
    delta: { addedRegions: [], restoredRegions: [] },
    words: [],
    ruleSummary: { keptByAutoCutByHuman: [], cutByAutoKeptByHuman: [] },
    transcriptDrifted: false,
  };
}

describe('findCutLearningFiles', () => {
  it('ネストを再帰し node_modules/.git を降りず basename 厳密一致のみ集める', () => {
    const root = tempDir();
    mkdirSync(join(root, 'proj-a'), { recursive: true });
    writeFileSync(join(root, 'proj-a', 'cutLearning.json'), JSON.stringify(validRecord()));
    mkdirSync(join(root, 'nested', 'proj-b'), { recursive: true });
    writeFileSync(join(root, 'nested', 'proj-b', 'cutLearning.json'), JSON.stringify(validRecord()));
    // 集めないもの:
    writeFileSync(join(root, 'cutLearning-aggregated.json'), '{}'); // 集約出力（別名）
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'x', 'cutLearning.json'), JSON.stringify(validRecord()));
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'cutLearning.json'), JSON.stringify(validRecord()));

    const found = findCutLearningFiles(root);
    expect(found).toEqual([
      join(root, 'nested', 'proj-b', 'cutLearning.json'),
      join(root, 'proj-a', 'cutLearning.json'),
    ]);
  });

  it('対象が無ければ空配列', () => {
    expect(findCutLearningFiles(tempDir())).toEqual([]);
  });
});

describe('loadCutLearningRecords', () => {
  it('壊れ JSON / schema 不一致をスキップし正常分だけ返す', () => {
    const root = tempDir();
    mkdirSync(join(root, 'ok'), { recursive: true });
    writeFileSync(join(root, 'ok', 'cutLearning.json'), JSON.stringify(validRecord()));
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'cutLearning.json'), '{ not json');
    mkdirSync(join(root, 'badschema'), { recursive: true });
    writeFileSync(join(root, 'badschema', 'cutLearning.json'), JSON.stringify({ schemaVersion: 2 }));

    const items = loadCutLearningRecords(root);
    expect(items).toHaveLength(1);
    expect(items[0]!.path).toBe(join(root, 'ok', 'cutLearning.json'));
  });
});

describe('runAggregateCli', () => {
  it('集約 JSON を書き出しランキングを返す（code 0）', () => {
    const root = tempDir();
    mkdirSync(join(root, 'p1'), { recursive: true });
    writeFileSync(
      join(root, 'p1', 'cutLearning.json'),
      JSON.stringify({
        ...(validRecord() as object),
        ruleSummary: { keptByAutoCutByHuman: [{ text: 'えー', count: 4 }], cutByAutoKeptByHuman: [] },
      }),
    );
    const out = join(root, 'agg.json');
    const result = runAggregateCli(['--root', root, '--out', out]);
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    expect(written.projectCount).toBe(1);
    expect(written.ruleSummary.keptByAutoCutByHuman).toEqual([{ text: 'えー', count: 4 }]);
    expect(typeof written.generatedAt).toBe('string');
    expect(result.message).toContain('えー');
  });

  it('0 件でも code 0 で案内を返し、ファイルは書かない', () => {
    const root = tempDir();
    const out = join(root, 'agg.json');
    const result = runAggregateCli(['--root', root, '--out', out]);
    expect(result.code).toBe(0);
    expect(result.message).toContain('見つかりませんでした');
    expect(existsSync(out)).toBe(false);
  });

  it('--out が走査対象パスと一致しても自己取り込みしない', () => {
    const root = tempDir();
    mkdirSync(join(root, 'p1'), { recursive: true });
    writeFileSync(
      join(root, 'p1', 'cutLearning.json'),
      JSON.stringify({
        ...(validRecord() as object),
        ruleSummary: { keptByAutoCutByHuman: [{ text: 'えー', count: 4 }], cutByAutoKeptByHuman: [] },
      }),
    );
    // 出力先を root 直下の cutLearning.json にして再走査リスクを作る。
    const out = join(root, 'cutLearning.json');
    const result = runAggregateCli(['--root', root, '--out', out]);
    expect(result.code).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    // p1 の 1 件のみ。出力ファイル自身は集約対象から除外される。
    expect(written.projectCount).toBe(1);
    expect(written.ruleSummary.keptByAutoCutByHuman).toEqual([{ text: 'えー', count: 4 }]);
  });
});
