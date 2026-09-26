/**
 * 自己書込ウィンドウの writerId 対応（監査 data-safety-5・既知起票 16）。
 * 「別の画面の保存は自分の書込ではない＝外部変更として通知される」ことを固定する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSelfWrite,
  isSelfWriteContent,
  isSelfWriting,
  markSelfWrite,
  recordSelfWriteContent,
  selfWriteRemainingMs,
} from './selfWrite';

const PROJECT = 'p1';

afterEach(() => {
  clearSelfWrite(PROJECT);
});

describe('isSelfWriting — writerId 照合', () => {
  it('自分の書込は suppress される', () => {
    markSelfWrite(PROJECT, 'writer-A');
    expect(isSelfWriting(PROJECT, 'writer-A')).toBe(true);
  });

  it('別の画面（別 writerId）の保存は suppress されない＝外部変更として通知される', () => {
    markSelfWrite(PROJECT, 'writer-A');
    expect(isSelfWriting(PROJECT, 'writer-B')).toBe(false);
    expect(selfWriteRemainingMs(PROJECT, 'writer-B')).toBe(0);
  });

  it('書いた側に writerId が無ければ従来どおり projectId 単位で suppress する（旧クライアント）', () => {
    markSelfWrite(PROJECT);
    expect(isSelfWriting(PROJECT, 'writer-B')).toBe(true);
    expect(isSelfWriting(PROJECT)).toBe(true);
  });

  it('見る側に writerId が無ければ従来どおり suppress する（旧 /api/watch 互換）', () => {
    markSelfWrite(PROJECT, 'writer-A');
    expect(isSelfWriting(PROJECT)).toBe(true);
  });

  it('マークが無ければ suppress しない', () => {
    expect(isSelfWriting(PROJECT, 'writer-A')).toBe(false);
    expect(selfWriteRemainingMs(PROJECT, 'writer-A')).toBe(0);
  });

  it('自分の書込の残り時間は正で、ウィンドウ幅（1500ms）以内', () => {
    markSelfWrite(PROJECT, 'writer-A');
    const remaining = selfWriteRemainingMs(PROJECT, 'writer-A');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(1500);
  });
});

/**
 * 内容による自己書込判定（サイクル 2 レビュー Important）。
 *
 * data-safety-6 で suppress を「破棄」から「先送り」に変えた結果、ウィンドウが明けた
 * 時点では自己書込か外部書込かを見分ける材料がどこにも無く、**自分で保存しただけで
 * 自分の画面に「外部で更新されました」が出る**ようになっていた。
 * 保存後にディスクの指紋を記録し、再評価時にそれと一致するなら自分の書込と判定する。
 */
describe('isSelfWriteContent — 保存した内容とディスクの一致で判定', () => {
  it('保存直後（記録した指紋と一致）は自分の書込', () => {
    markSelfWrite(PROJECT, 'writer-A');
    recordSelfWriteContent(PROJECT, 'sig-1');
    expect(isSelfWriteContent(PROJECT, 'writer-A', 'sig-1')).toBe(true);
  });

  it('保存後に外部が書き換えた（指紋が違う）なら自分の書込ではない', () => {
    markSelfWrite(PROJECT, 'writer-A');
    recordSelfWriteContent(PROJECT, 'sig-1');
    expect(isSelfWriteContent(PROJECT, 'writer-A', 'sig-2')).toBe(false);
  });

  it('別の画面（別 writerId）から見れば自分の書込ではない（data-safety-5 を壊さない）', () => {
    markSelfWrite(PROJECT, 'writer-A');
    recordSelfWriteContent(PROJECT, 'sig-1');
    expect(isSelfWriteContent(PROJECT, 'writer-B', 'sig-1')).toBe(false);
  });

  it('指紋の記録が無ければ判定しない（従来どおり通知する）', () => {
    markSelfWrite(PROJECT, 'writer-A');
    expect(isSelfWriteContent(PROJECT, 'writer-A', 'sig-1')).toBe(false);
  });

  it('新しい保存のマークは前回の指紋を捨てる（古い記録で誤判定しない）', () => {
    markSelfWrite(PROJECT, 'writer-A');
    recordSelfWriteContent(PROJECT, 'sig-1');
    markSelfWrite(PROJECT, 'writer-A');
    expect(isSelfWriteContent(PROJECT, 'writer-A', 'sig-1')).toBe(false);
  });

  it('ウィンドウが切れていても指紋が一致するなら自分の書込（先送り再評価は窓明けに走る）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-07T00:00:00Z'));
      markSelfWrite(PROJECT, 'writer-A');
      recordSelfWriteContent(PROJECT, 'sig-1');
      // 自己書込ウィンドウ（1500ms）を超えて時計を進める。
      vi.setSystemTime(new Date('2026-09-07T00:00:05Z'));
      expect(isSelfWriting(PROJECT, 'writer-A')).toBe(false);
      expect(isSelfWriteContent(PROJECT, 'writer-A', 'sig-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearSelfWrite で記録も消える', () => {
    markSelfWrite(PROJECT, 'writer-A');
    recordSelfWriteContent(PROJECT, 'sig-1');
    clearSelfWrite(PROJECT);
    expect(isSelfWriteContent(PROJECT, 'writer-A', 'sig-1')).toBe(false);
  });
});
