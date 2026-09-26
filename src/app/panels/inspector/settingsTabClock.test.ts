/**
 * status-ia-8: インスペクタの見出しの時計を、入力欄と同じ再生（カット後）基準へ。
 * 原本（カット前）は基準を明示して併記し、同じなら併記しない。
 */
import { describe, it, expect } from 'vitest';
import { telopClockCaption, telopHeadingLabel } from './SettingsTab';

describe('telopClockCaption（status-ia-8）', () => {
  it('カットが無ければ再生基準だけ（併記しない）', () => {
    const c = telopClockCaption(300, 600, 300, 600, 30);
    expect(c.playback).toBe('0:10 〜 0:20');
    expect(c.original).toBeNull();
  });

  it('カットで前倒しされたら再生基準を主にし、原本を併記する', () => {
    // 原本 0:20〜0:30 のテロップが、手前のカットで再生上は 0:10〜0:20 に来る。
    const c = telopClockCaption(300, 600, 600, 900, 30);
    expect(c.playback).toBe('0:10 〜 0:20');
    expect(c.original).toBe('0:20 〜 0:30');
  });

  it('端がカット区間に落ちたら再生基準を出さず理由を返す（サイクル 3 Important）', () => {
    // 原本 2790（=1:33）がカット内・3000（=1:40）はカット外。
    // shownStart は原本フレームのままなので、再生基準として出すと座標系が混ざる。
    const c = telopClockCaption(2790, 250, 2790, 3000, 30, false);
    expect(c.playback).toBeNull();
    expect(c.original).toBe('1:33 〜 1:40');
    expect(c.note).toContain('確定できません');
  });
});

describe('telopHeadingLabel（status-ia-9）', () => {
  it('内部 id ではなく本文の先頭を出す', () => {
    expect(telopHeadingLabel('挫折した人向け?')).toBe('挫折した人向け?');
  });

  it('長い本文は先頭 N 文字＋…に畳む', () => {
    expect(telopHeadingLabel('あいうえおかきくけこさしすせそたちつてと', 14)).toBe('あいうえおかきくけこさしすせ…');
  });

  it('改行やタブは 1 つの空白に潰す', () => {
    expect(telopHeadingLabel('前半\n  後半')).toBe('前半 後半');
  });

  it('本文が空でも内部 id を出さない', () => {
    expect(telopHeadingLabel('   ')).toBe('（文字なしのテロップ）');
  });
});
