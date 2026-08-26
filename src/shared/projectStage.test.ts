import { describe, it, expect } from 'vitest';
import {
  DISPLAY_STATUSES,
  STATUS_LABEL,
  isDisplayStatus,
  parseProjectStage,
  statusColorClass,
} from './projectStage';

describe('projectStage（共有状態ドメイン）', () => {
  it('6値を工程順に定義する', () => {
    expect(DISPLAY_STATUSES).toEqual([
      'idle',
      'transcribe',
      'cut',
      'telop',
      'audio',
      'rendered',
    ]);
  });

  it('全6値に日本語ラベルがある', () => {
    expect(DISPLAY_STATUSES.map((s) => STATUS_LABEL[s])).toEqual([
      '未着手',
      '文字起こし',
      'カット',
      'テロップ',
      'SE・BGM',
      '書き出し済',
    ]);
  });

  it('isDisplayStatus は6値のみ受理する', () => {
    for (const s of DISPLAY_STATUSES) expect(isDisplayStatus(s)).toBe(true);
    expect(isDisplayStatus('done')).toBe(false);
    expect(isDisplayStatus(null)).toBe(false);
    expect(isDisplayStatus(1)).toBe(false);
  });

  it('parseProjectStage は不正値・未知値を null にする（全6値を受理）', () => {
    expect(parseProjectStage('idle')).toBe('idle');
    expect(parseProjectStage('transcribe')).toBe('transcribe');
    expect(parseProjectStage('cut')).toBe('cut');
    expect(parseProjectStage('telop')).toBe('telop');
    expect(parseProjectStage('audio')).toBe('audio');
    expect(parseProjectStage('rendered')).toBe('rendered');
    expect(parseProjectStage('draft')).toBe(null);
    expect(parseProjectStage(undefined)).toBe(null);
    expect(parseProjectStage(null)).toBe(null);
  });

  it('廃止した旧 stage 値（editing/review/published）は未知値として null に落ちる', () => {
    // 旧バージョンが書いた .sme/status.json を開いても壊れず、自動判定へフォールバックする。
    expect(parseProjectStage('editing')).toBe(null);
    expect(parseProjectStage('review')).toBe(null);
    expect(parseProjectStage('published')).toBe(null);
  });

  it('statusColorClass は status- プレフィックスを返す', () => {
    expect(statusColorClass('telop')).toBe('status-telop');
  });
});
