import { describe, it, expect } from 'vitest';
import { importSummary, isFolderCandidate, planHomeDrop, uniqueProjectName } from './homeDropPlan';

const item = (name: string, type = '', isDirectory: boolean | null = null) => ({ name, type, isDirectory });

describe('isFolderCandidate', () => {
  it('webkitGetAsEntry の判定があればそれに従う', () => {
    expect(isFolderCandidate(item('素材', '', true))).toBe(true);
    // 拡張子の無い動画ファイルでも、ファイルと分かっていればファイル扱い。
    expect(isFolderCandidate(item('clip', '', false))).toBe(false);
  });

  it('判定が無い時は MIME と拡張子から推定する', () => {
    expect(isFolderCandidate(item('撮影素材'))).toBe(true);
    expect(isFolderCandidate(item('clip.mp4', 'video/mp4'))).toBe(false);
    expect(isFolderCandidate(item('clip.mp4'))).toBe(false);
    // 「2026.11.04 撮影」のようにドットを含むフォルダ名は拡張子に見えない。
    expect(isFolderCandidate(item('2026.11.04 撮影'))).toBe(true);
  });
});

describe('planHomeDrop', () => {
  it('フォルダとファイルに分け、受け取った順を保つ', () => {
    const { folders, files } = planHomeDrop([
      item('素材A', '', true),
      item('clip1.mp4', 'video/mp4', false),
      item('素材B', '', true),
      item('clip2.mp4', 'video/mp4', false),
    ]);
    expect(folders.map((entry) => entry.name)).toEqual(['素材A', '素材B']);
    expect(files.map((entry) => entry.name)).toEqual(['clip1.mp4', 'clip2.mp4']);
  });
});

describe('uniqueProjectName', () => {
  it('既存とぶつかったら連番を足し、作ったぶんも覚える', () => {
    const taken = new Set(['2026-11-04-clip']);
    expect(uniqueProjectName('2026-11-04-clip', taken)).toBe('2026-11-04-clip 2');
    expect(uniqueProjectName('2026-11-04-clip', taken)).toBe('2026-11-04-clip 3');
    expect(uniqueProjectName('別の名前', taken)).toBe('別の名前');
  });
});

describe('importSummary', () => {
  it('成功だけ・失敗つき・全部失敗で文を変える', () => {
    expect(importSummary('ファイル', ['a', 'b'], [])).toBe('ファイルから 2 件作成しました: a、b');
    expect(importSummary('フォルダ', ['a'], ['b.mp4: 理由'])).toBe(
      'フォルダから 1 件作成しました: a（失敗 1 件 — b.mp4: 理由）',
    );
    expect(importSummary('フォルダ', [], ['x: 理由'])).toBe('フォルダから作成できませんでした（失敗 1 件 — x: 理由）');
  });
});
