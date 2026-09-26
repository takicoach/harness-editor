import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learnStart, learnFinish } from './learn';
import { loadStore } from './store';

let storeHome: string;
let root: string;
const originalHome = process.env.SUPERMOVIE_LEARNING_HOME;

const baseline = JSON.stringify({
  segments: [
    { text: 'ゼロ式ドリル', start: 0, end: 1 },
    { text: '1の肩', start: 2, end: 3 },
  ],
});
const final = JSON.stringify({
  segments: [
    { text: '零式ドリル', start: 0, end: 1 },
    { text: '壱の型', start: 2, end: 3 },
  ],
});

beforeEach(() => {
  storeHome = mkdtempSync(join(tmpdir(), 'sm-store-'));
  root = mkdtempSync(join(tmpdir(), 'sm-proj-'));
  process.env.SUPERMOVIE_LEARNING_HOME = storeHome;
});
afterEach(() => {
  rmSync(storeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.SUPERMOVIE_LEARNING_HOME;
  else process.env.SUPERMOVIE_LEARNING_HOME = originalHome;
});

describe('learnStart + learnFinish', () => {
  it('ベースライン→編集→finish で語句辞書へ自動昇格する', () => {
    writeFileSync(join(root, 'transcript_fixed.json'), baseline);
    learnStart(root);
    writeFileSync(join(root, 'transcript_fixed.json'), final); // ユーザー編集

    const summary = learnFinish(root, 'drill-01');
    expect(summary.autoPromoted).toEqual([
      { before: 'ゼロ', after: '零' },
      { before: '1の肩', after: '壱の型' },
    ]);
    expect(loadStore().typoDict.replace).toEqual({ ゼロ: '零', '1の肩': '壱の型' });
  });

  it('finish は修正履歴を .learning/history へ残す', () => {
    writeFileSync(join(root, 'transcript_fixed.json'), baseline);
    learnStart(root);
    writeFileSync(join(root, 'transcript_fixed.json'), final);
    learnFinish(root, 'drill-01');
    expect(readdirSync(join(root, '.learning/history'))).toHaveLength(1);
  });

  it('ベースライン未取得なら finish は空サマリーを返す', () => {
    writeFileSync(join(root, 'transcript_fixed.json'), final);
    const summary = learnFinish(root, 'drill-01');
    expect(summary.autoPromoted).toEqual([]);
    expect(summary.skippedConflicts).toEqual([]);
  });

  it('最終ファイルが壊れていればパス付きエラーを投げる', () => {
    writeFileSync(join(root, 'transcript_fixed.json'), baseline);
    learnStart(root);
    writeFileSync(join(root, 'transcript_fixed.json'), 'not valid json');
    expect(() => learnFinish(root, 'drill-01')).toThrow(/transcript_fixed\.json/);
  });

  it('差分が無くても修正履歴は残る', () => {
    writeFileSync(join(root, 'transcript_fixed.json'), baseline);
    learnStart(root);
    // 編集せず（baseline と同一内容のまま）finish
    const summary = learnFinish(root, 'drill-01');
    expect(summary.autoPromoted).toEqual([]);
    expect(readdirSync(join(root, '.learning/history'))).toHaveLength(1);
  });

  it('競合ルールは skippedConflicts に入り、ストアは最初のマッピングを保持する', () => {
    // プロジェクト1: 「ゼロ」→「零」を昇格（ゼロ式ドリル→零式ドリル の差分）
    const proj1 = mkdtempSync(join(tmpdir(), 'sm-proj1-'));
    const seg1baseline = JSON.stringify({ segments: [{ text: 'ゼロ式ドリル', start: 0, end: 1 }] });
    const seg1final = JSON.stringify({ segments: [{ text: '零式ドリル', start: 0, end: 1 }] });
    writeFileSync(join(proj1, 'transcript_fixed.json'), seg1baseline);
    learnStart(proj1);
    writeFileSync(join(proj1, 'transcript_fixed.json'), seg1final);
    const summary1 = learnFinish(proj1, 'drill-01');
    // diff が抽出する最小差分は「ゼロ」→「零」
    expect(summary1.autoPromoted).toEqual([{ before: 'ゼロ', after: '零' }]);
    expect(summary1.skippedConflicts).toEqual([]);
    expect(loadStore().typoDict.replace['ゼロ']).toBe('零');

    // プロジェクト2: 同じ「ゼロ」を別の「after」へ修正 → 競合（ゼロ式ドリル→ZERO式ドリル）
    const proj2 = mkdtempSync(join(tmpdir(), 'sm-proj2-'));
    const seg2baseline = JSON.stringify({ segments: [{ text: 'ゼロ式ドリル', start: 0, end: 1 }] });
    const seg2final = JSON.stringify({ segments: [{ text: 'ZERO式ドリル', start: 0, end: 1 }] });
    writeFileSync(join(proj2, 'transcript_fixed.json'), seg2baseline);
    learnStart(proj2);
    writeFileSync(join(proj2, 'transcript_fixed.json'), seg2final);
    const summary2 = learnFinish(proj2, 'drill-02');
    // diff が抽出する最小差分は「ゼロ」→「ZERO」（同じ before、別の after → 競合）
    expect(summary2.autoPromoted).toEqual([]);
    expect(summary2.skippedConflicts).toEqual([{ before: 'ゼロ', after: 'ZERO' }]);
    // ストアは最初のマッピング（零）を保持する
    expect(loadStore().typoDict.replace['ゼロ']).toBe('零');

    rmSync(proj1, { recursive: true, force: true });
    rmSync(proj2, { recursive: true, force: true });
  });
});
